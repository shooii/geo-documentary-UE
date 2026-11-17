import { createHash } from 'node:crypto';
import type { TourPlan, TourStop } from '../packages/render-spec/tour-plan.js';

export type QaProfile = 'portrait' | 'landscape' | 'square';
export interface QaSample {
  name: string; time: number; captureTime?: number; stopId?: string; sceneId?: string; reason?: string;
  subtitleBounds?: { left: number; top: number; right: number; bottom: number };
  annotationWindows?: { sceneId: string; start: number; end: number }[];
}
export interface TargetShape { id: string; aspectRatio: number; polygonCount: number }
export function identity(value: unknown): string {
  const stable = (item: any): any => Array.isArray(item) ? item.map(stable) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export function targetShapes(collection: any): TargetShape[] {
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) throw new Error('--geometry必须为冻结目标GeoJSON FeatureCollection');
  return collection.features.map((feature: any) => {
    const points: number[][] = [];
    const visit = (coordinates: any): void => {
      if (!Array.isArray(coordinates)) return;
      if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') points.push(coordinates);
      else coordinates.forEach(visit);
    };
    visit(feature.geometry?.coordinates);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point[0]!); maxX = Math.max(maxX, point[0]!);
      minY = Math.min(minY, point[1]!); maxY = Math.max(maxY, point[1]!);
    }
    const dx = (maxX - minX) * Math.cos(((maxY + minY) / 2) * Math.PI / 180);
    const dy = maxY - minY;
    return { id: String(feature.properties?.id ?? feature.id ?? feature.properties?.adcode ?? ''), aspectRatio: points.length && dx > 0 && dy > 0 ? Math.max(dx / dy, dy / dx) : 0,
      polygonCount: feature.geometry?.type === 'MultiPolygon' ? feature.geometry.coordinates.length : feature.geometry?.type === 'Polygon' ? 1 : 0 };
  });
}
export function qaClock(region: any, returnDuration: number, tourEnd: number) {
  const opening = region?.openingDescent;
  const descentSeconds = !opening || opening.enabled === false ? 0 : Math.max(2, Math.min(16, Number(opening.seconds ?? 3)));
  const returnSeconds = Math.max(3.8, Math.min(5, returnDuration || 4.4));
  const returnStart = Math.max(tourEnd, Number(region?.tourReturnStart ?? region?.tourOutroStart ?? 0) || 0);
  if (![descentSeconds, returnSeconds, returnStart].every(Number.isFinite)) throw new Error('场景开场或收尾时钟无效');
  return { descentSeconds, returnSeconds, returnStart };
}
export function mapQaSamples(samples: QaSample[], clock: ReturnType<typeof qaClock>): QaSample[] {
  return samples.map(sample => ({ ...sample, captureTime: sample.time + clock.descentSeconds }));
}
export function qaProfileSupport(plan: TourPlan, profile: QaProfile) {
  const missing = plan.tourStops.filter(stop => !stop.cameraProfiles?.[profile]).map(stop => stop.id);
  return { status: missing.length ? 'unsupported' : 'supported', missingStopIds: missing };
}
export function buildQaSampling(plan: TourPlan, returnDuration: number, shapes: TargetShape[] = [], region: any = {}) {
  if (!plan.tourStops.length) throw new Error('项目无可捕获的巡游站点');
  if (!Number.isFinite(returnDuration) || returnDuration < 0) throw new Error('收尾时长必须为非负有限数');
  const stops = plan.tourStops;
  for (const stop of stops) if (![stop.start, stop.end, stop.flightDuration, stop.groundDistanceMeters, stop.visualReadySeconds].every(Number.isFinite) || stop.start < 0 || stop.end <= stop.start || stop.flightDuration < 0) throw new Error('冻结计划含无效站点时间或距离');
  const samples: QaSample[] = [];
  const add = (name: string, stop: TourStop, local: number, reason: string) => samples.push({ name, time: Math.min(stop.end, stop.start + Math.max(0, local)), stopId: stop.id, sceneId: stop.sceneId, reason });
  add('first-arrival', stops[0]!, stops[0]!.flightDuration, '首站抵达');
  const byDistance = [...stops].sort((a, b) => a.groundDistanceMeters - b.groundDistanceMeters || a.id.localeCompare(b.id));
  for (const [name, stop] of [['near-flight', byDistance[0]!], ['far-flight', byDistance.at(-1)!]] as const) {
    add(`${name}-start`, stop, 0, '航段起点'); add(`${name}-mid`, stop, stop.flightDuration / 2, '航段中点'); add(`${name}-end`, stop, stop.flightDuration, '航段终点');
  }
  const shortest = [...stops].sort((a, b) => (a.end - a.start - a.visualReadySeconds) - (b.end - b.start - b.visualReadySeconds) || a.id.localeCompare(b.id))[0]!;
  add('short-budget', shortest, shortest.visualReadySeconds, '最紧场景预算');
  for (const [name, fraction] of [['early', 0], ['middle', .5], ['late', 1]] as const) {
    const stop = stops[Math.floor((stops.length - 1) * fraction)]!;
    add(`labels-${name}`, stop, Math.min(stop.end - stop.start, stop.visualReadySeconds + .1), '累计标签');
  }
  const coverage: Record<string, string> = {};
  for (const kind of ['slender', 'multipart'] as const) {
    const candidates = shapes.filter(shape => stops.some(stop => stop.id === shape.id) && (kind === 'slender' ? shape.aspectRatio >= 3 : shape.polygonCount > 1))
      .sort((a, b) => (kind === 'slender' ? b.aspectRatio - a.aspectRatio : b.polygonCount - a.polygonCount) || a.id.localeCompare(b.id));
    const stop = stops.find(item => item.id === candidates[0]?.id);
    coverage[kind] = stop ? 'planned' : 'not-measured';
    if (stop) add(`target-${kind}`, stop, stop.visualReadySeconds, '冻结几何目标');
  }
  const end = Math.max(...stops.map(stop => stop.end));
  const clock = qaClock(region, returnDuration, end);
  samples.push({ name: 'closing-mid', time: clock.returnStart + clock.returnSeconds / 2, reason: '收尾中点' }, { name: 'closing-end', time: clock.returnStart + clock.returnSeconds, reason: '收尾终点' });
  const mapped = mapQaSamples(samples, clock);
  return { samples: mapped, coverage, clock, matrix: (['portrait', 'landscape', 'square'] as const).map(profile => ({ profile, ...qaProfileSupport(plan, profile), width: profile === 'landscape' ? 1920 : 1080, height: profile === 'portrait' ? 1920 : 1080, samples: mapped })) };
}
export function captureMetrics(renderer: any) {
  const status = renderer?.status ?? renderer;
  const mean = typeof status?.frameMs === 'number' && Number.isFinite(status.frameMs) && status.frameMs > 0 ? status.frameMs : null;
  return { ueSmoothedFrameMs: mean, ueFps: typeof status?.fps === 'number' && Number.isFinite(status.fps) ? status.fps : null,
    frameTimeSource: 'UE get-status AverageFrameMs（平滑均值，不是原始逐帧时间）',
    frameTimeP95: { status: 'not-measured', value: null }, frameTimeP99: { status: 'not-measured', value: null },
    ueMemoryBytes: { status: 'not-measured', value: null, reason: '现有UE状态接口未暴露进程内存' } };
}
export function comparableRuns(before: any, after: any): boolean {
  return Boolean(before.machine?.id && before.machine.id === after.machine?.id && before.width === after.width && before.height === after.height
    && before.profile === after.profile && before.planIdentity === after.planIdentity && before.imagery === after.imagery
    && before.samplingIdentity && before.samplingIdentity === after.samplingIdentity
    && before.renderSpecIdentity && before.renderSpecIdentity === after.renderSpecIdentity
    && before.geometryIdentity && before.geometryIdentity === after.geometryIdentity
    && before.sceneIdentity && before.sceneIdentity === after.sceneIdentity);
}
