import { fitBoundaryCamera, isAutomaticCamera, type FramedCamera } from '../geo-camera/index.js';
export const TOUR_PLAN_VERSION = "safe-frame-distance-v3";
export const TOUR_FILL_SECONDS = 1.15;
export const TOUR_SETTLE_SECONDS = 0.4;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export interface TourCamera extends FramedCamera {}
export interface TourScene {
  id: string; section?: string | undefined; childId?: string | undefined; childName?: string | undefined;
  title?: string | undefined; narration?: string | undefined; duration: number; camera?: TourCamera | undefined;
  timing?: { mapHoldSeconds?: number } | undefined;
}
export interface TourRange { sceneId: string; start: number; end: number }
export interface TourDiagnostic { sceneId: string; childId: string; code: "missing-camera" | "invalid-camera" | "short-cue" | "invalid-range" | "missing-range" | "duplicate-child" | "invalid-timing"; availableSeconds: number; requiredSeconds: number; message: string }
export interface TourStop {
  id: string; sceneId: string; name: string; start: number; end: number; flightDuration: number;
  groundDistanceMeters: number; requestedHoldSeconds: number; visualReadySeconds: number;
  cameraPreset: TourCamera; cameraProfiles: { portrait: TourCamera; landscape?: TourCamera; square?: TourCamera };
}
export interface TourPlan { version: typeof TOUR_PLAN_VERSION; parentCamera?: TourCamera; narrationOffsetSeconds: number; tourStops: TourStop[]; diagnostics: TourDiagnostic[] }
export function normalizeTourCamera(camera: TourCamera): TourCamera {
  return { longitude: camera.longitude, latitude: camera.latitude, height: camera.height, heading: camera.heading, pitch: camera.pitch, ...(camera.roll === undefined ? {} : { roll: camera.roll }), ...(camera.framing ? { framing: camera.framing } : {}) };
}
function validCamera(camera: TourCamera): boolean {
  return [camera.longitude, camera.latitude, camera.height, camera.heading, camera.pitch, camera.roll ?? 0].every(Number.isFinite)
    && Math.abs(camera.longitude) <= 180 && Math.abs(camera.latitude) <= 90 && camera.height > 0;
}
export function groundDistanceMeters(from: TourCamera, to: TourCamera): number {
  const radians = Math.PI / 180;
  const a = Math.sin((to.latitude - from.latitude) * radians / 2) ** 2
    + Math.cos(from.latitude * radians) * Math.cos(to.latitude * radians) * Math.sin((to.longitude - from.longitude) * radians / 2) ** 2;
  return 6378137 * 2 * Math.atan2(Math.sqrt(clamp(a, 0, 1)), Math.sqrt(1 - clamp(a, 0, 1)));
}
/** 图片不能盖住落地后的填色，名牌落稳与填色并行，最后保留阅读缓冲。 */
export function tourVisualReadySeconds(flight: number): number {
  return Math.max(flight + TOUR_FILL_SECONDS, flight * .55 + Math.max(.45, flight * .35)) + TOUR_SETTLE_SECONDS;
}
export interface TourOutput { profile: 'portrait' | 'landscape' | 'square'; width: number; height: number }
export function buildTourPlan(input: { scenes: readonly TourScene[]; ranges?: readonly TourRange[] | undefined; parentCamera?: TourCamera | undefined; narrationOffsetSeconds?: number; flightPreferenceSeconds?: number; output?: TourOutput | undefined }): TourPlan {
  const tourStops: TourStop[] = [];
  const diagnostics: TourDiagnostic[] = [];
  const report = (scene: Pick<TourScene, "id" | "childId">, code: TourDiagnostic["code"], message: string, availableSeconds = 0, requiredSeconds = 0) => diagnostics.push({ sceneId: scene.id, childId: scene.childId ?? "", code, availableSeconds, requiredSeconds, message: `[${scene.id}] ${message}` });
  const rawOffset = input.narrationOffsetSeconds ?? .35;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : .35;
  const preference = input.flightPreferenceSeconds ?? 4.2;
  if (offset !== rawOffset || !Number.isFinite(preference) || preference < 0) report({ id: "tour" }, "invalid-timing", "旁白偏移或飞行偏好必须为非负有限数");
  const parentCamera = input.parentCamera ?? input.scenes.find(scene => scene.section === "overview" && scene.camera)?.camera;
  let previous = parentCamera && validCamera(parentCamera) ? parentCamera : undefined;
  if (parentCamera && !previous) report({ id: "tour" }, "invalid-camera", "父级相机坐标无效");
  let cursor = 0;
  const childIds = new Set<string>();
  const rangeIds = new Set<string>();
  if (input.ranges) for (const range of input.ranges) {
    if (rangeIds.has(range.sceneId)) report({ id: range.sceneId }, "invalid-range", "cue场景范围重复");
    rangeIds.add(range.sceneId);
  }
  for (const scene of input.scenes) {
    if (scene.section === "cover") continue;
    const range = input.ranges?.find(item => item.sceneId === scene.id);
    const child = scene.section === "child" && Boolean(scene.childId);
    if (child && childIds.has(scene.childId!)) { report(scene, "duplicate-child", "巡游childId重复"); continue; }
    if (child) childIds.add(scene.childId!);
    // 只允许整份无ranges时估算；实测范围缺场景时禁止混拼旧时钟。
    if (input.ranges && !range) { if (child || scene.narration?.trim()) report(scene, "missing-range", "缺少实测cue范围"); continue; }
    const start = range?.start ?? cursor;
    const end = range?.end ?? start + scene.duration;
    if (![start, end].every(Number.isFinite) || start < 0 || end <= start || start < cursor - 1e-6) {
      report(scene, "invalid-range", "cue时间必须有限、非负、正向且不重叠"); continue;
    }
    cursor = end;
    if (!child) continue;
    const duration = end - start;
    if (!scene.camera) { report(scene, "missing-camera", "缺少巡游相机", duration); continue; }
    if (!validCamera(scene.camera)) { report(scene, "invalid-camera", "巡游相机坐标无效", duration); continue; }
    const configuredHold = scene.timing?.mapHoldSeconds ?? 2;
    if (!Number.isFinite(configuredHold) || configuredHold < 0) report(scene, "invalid-timing", "地图停留必须为非负有限数", duration);
    const hold = Math.max(TOUR_FILL_SECONDS + TOUR_SETTLE_SECONDS, Number.isFinite(configuredHold) && configuredHold >= 0 ? configuredHold : 2);
    const distance = previous ? groundDistanceMeters(previous, scene.camera) : 0;
    const distanceFlight = 3.2 + 2.2 * Math.sqrt(clamp(distance / 22000, 0, 1));
    const preferred = clamp(distanceFlight * .76 + (Number.isFinite(preference) && preference >= 0 ? preference : 4.2) * .24, 3.2, 5.4);
    // 不足预算的预览仍停在本场边界，诊断阻断正式导出，不扩张音画窗口。
    const flight = Math.min(duration, Math.max(2.4, Math.min(preferred, duration - hold)));
    const required = 2.4 + hold;
    if (duration + 1e-6 < required) report(scene, "short-cue", `${scene.title ?? scene.childId}旁白窗口${duration.toFixed(2)}秒不足：飞行、落稳及填色至少需要${required.toFixed(2)}秒`, duration, required);
    const cameraProfiles: TourStop['cameraProfiles'] = { portrait: normalizeTourCamera(scene.camera) };
    if (isAutomaticCamera(scene.camera)) {
      const framing = scene.camera.framing;
      try {
        if (input.output && (![input.output.width, input.output.height].every(Number.isFinite) || input.output.width <= 0 || input.output.height <= 0)) throw new Error('输出尺寸必须为正有限数');
        for (const [profile, defaultAspect] of [['portrait', 9 / 16], ['landscape', 16 / 9], ['square', 1]] as const) {
          const aspect = input.output?.profile === profile ? input.output.width / input.output.height : defaultAspect;
          const fitted = fitBoundaryCamera(scene.camera, framing.bounds, aspect, framing.points, framing.safeFrame);
          cameraProfiles[profile] = normalizeTourCamera({ ...fitted, framing: { ...framing, reference: normalizeTourCamera({ ...fitted, framing: undefined }) } });
        }
      } catch (error) {
        report(scene, 'invalid-camera', `自动取景失败：${error instanceof Error ? error.message : String(error)}`, duration);
        continue;
      }
    }
    tourStops.push({ id: scene.childId!, sceneId: scene.id, name: scene.childName ?? scene.title ?? scene.childId!, start: start + offset, end: end + offset, flightDuration: flight, groundDistanceMeters: Math.round(distance), requestedHoldSeconds: hold, visualReadySeconds: tourVisualReadySeconds(flight), cameraPreset: normalizeTourCamera(scene.camera), cameraProfiles });
    previous = scene.camera;
  }
  return { version: TOUR_PLAN_VERSION, ...(parentCamera && validCamera(parentCamera) ? { parentCamera: normalizeTourCamera(parentCamera) } : {}), narrationOffsetSeconds: offset, tourStops, diagnostics };
}
export function assertTourPlanExportable(plan: TourPlan): void {
  if (plan.diagnostics.length) throw new Error(`巡游计划不可导出：${plan.diagnostics.map(item => item.message).join("；")}`);
}
