import { Cartographic, EllipsoidGeodesic } from 'cesium';
import { tourHighlightStrength, tourLabelPresentationAt } from '../cesium-player/public/tour-presentation.js';
import type { MapView } from '../../packages/project-schema/index.js';
import { cloudStateAt } from './opening.js';
import { boundaryAnimation } from './boundary-style.js';

export const actions = new Set(['prepare-tour', 'play-opening', 'set-annotations', 'show-tour-frame', 'play-tour-segment', 'play-scene-range', 'stop-scene-playback', 'update-tour-labels', 'play-tour-outro', 'play-parent-overview', 'set-map-view']);
export const clamp = (x: number) => Math.max(0, Math.min(1, x));
export const smooth = (x: number) => { x = clamp(x); return x*x*x*(x*(x*6-15)+10); };
const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;
const wrapAngle = (angle: number) => ((angle + 180) % 360 + 360) % 360 - 180;

export function camera(p: any) {
  return { lon: Number(p.longitude ?? p.lon), lat: Number(p.latitude ?? p.lat), height: Number(p.height), heading: Number(p.heading ?? 0), pitch: Number(p.pitch ?? -64) };
}

type Camera = ReturnType<typeof camera>;
type LabelStyle = { alpha: number; scale: number; emphasis: number };
export type PreviewFlightOrigin = {
  camera: Camera;
  parentLabel: number;
  parentAccent: number;
  childReveal: number;
  labels: Record<string, LabelStyle>;
  accents: Record<string, number>;
};
let lastLeg: { key: string; geodesic: EllipsoidGeodesic } | undefined;

export function flight(from: Camera, to: Camera, progress: number): Camera {
  if (progress <= 0) return from;
  if (progress >= 1) return to;
  const key = [from.lon, from.lat, to.lon, to.lat].join('/');
  if (lastLeg?.key !== key) {
    lastLeg = { key, geodesic: new EllipsoidGeodesic(
      Cartographic.fromDegrees(from.lon, from.lat), Cartographic.fromDegrees(to.lon, to.lat)
    ) };
  }
  const eased = smooth(progress);
  const { geodesic } = lastLeg;
  const point = geodesic.interpolateUsingFraction(eased);
  const apex = Math.max(500, Math.min(2800, geodesic.surfaceDistance * .08));
  const headingDelta = wrapAngle(to.heading - from.heading);
  return {
    lon: point.longitude * 180 / Math.PI,
    lat: point.latitude * 180 / Math.PI,
    height: lerp(from.height, to.height, eased) + apex * Math.pow(Math.sin(Math.PI * eased), 1.35),
    heading: from.heading + headingDelta * eased,
    pitch: lerp(from.pitch, to.pitch, eased)
  };
}

function adjustView(pose: Camera, view: MapView | null | undefined, strength = 1): Camera {
  if (!view || strength <= 0) return pose;
  const lon = wrapAngle(pose.lon + view.longitudeOffset * strength);
  return {
    ...pose, lon,
    lat: Math.max(-85, Math.min(85, pose.lat + view.latitudeOffset * strength)),
    height: pose.height / Math.pow(view.zoom, strength),
    heading: pose.heading + view.headingOffset * strength,
    pitch: Math.max(-90, Math.min(-25, pose.pitch + view.pitchOffset * strength))
  };
}

export function frameAt(scene: any, stops: any[], time: number, profile: string, returnDuration: number, openingOnly = false, origin?: PreviewFlightOrigin, overviewProgress?: number, previewView?: MapView | null) {
  const region = scene.region;
  const preset = camera(region.cameraProfiles?.[profile] || region.cameraPreset);
  const overview = { ...preset, height: preset.height * (stops.length ? .9 : 1) };
  const labelReferenceDistance = preset.height / Math.max(.35, Math.sin(Math.abs(preset.pitch * Math.PI / 180)));
  const opening = region.openingDescent?.enabled === false ? null : region.openingDescent;
  const descent = opening ? Math.max(2, Math.min(16, Number(opening.seconds ?? 3))) : 0;
  const mapTime = Math.max(0, time - descent);
  let pose = overview;

  const index = openingOnly || time < descent ? -1 : stops.reduce(
    (active, item, candidate) => mapTime >= Number(item.start) ? candidate : active, -1
  );
  const stop = stops[index];
  const previous = stops[index - 1];
  const last = stops.at(-1);
  const flightDuration = Math.max(.001, Number(stop?.flightDuration) || .001);
  const rawProgress = stop ? clamp((mapTime - Number(stop.start)) / flightDuration) : 0;
  const tour = stop ? { index, current: stop, previous: previous ?? null, progress: smooth(rawProgress) } : null;
  const returnStart = Math.max(Number(last?.end ?? Infinity), Number(region.tourReturnStart ?? region.tourOutroStart ?? 0) || 0);
  const returnSeconds = Math.max(3.8, Math.min(5, returnDuration));
  const returnProgress = !openingOnly && stop && mapTime >= returnStart ? clamp((mapTime - returnStart) / returnSeconds) : null;
  const returning = returnProgress !== null ? { progress: smooth(returnProgress) } : null;

  const stopCamera = (item: any) => {
    const profilePreset = item.cameraProfiles?.[profile];
    const pose = camera(profilePreset || item.cameraPreset);
    if (!profilePreset && profile === 'portrait') pose.height *= Number(region.portraitChildCameraScale ?? 1);
    return pose;
  };
  if (time < descent) {
    const eased = smooth(time / descent);
    const startHeight = Math.max(800000, Number(opening.startHeightMeters ?? 900000));
    const approach = Math.max(.18, Math.min(.38, (startHeight - overview.height) / 2600000));
    const heading = overview.heading * Math.PI / 180;
    pose = {
      ...overview,
      lon: overview.lon - Math.sin(heading) * approach * (1 - eased),
      lat: overview.lat - Math.cos(heading) * approach * .62 * (1 - eased),
      height: lerp(startHeight, overview.height, Math.pow(eased, .86)),
      pitch: lerp(Number(opening.startPitchDegrees ?? -52), overview.pitch, eased)
    };
  } else if (origin && overviewProgress !== undefined) {
    pose = flight(origin.camera, overview, overviewProgress);
  } else if (returnProgress !== null) {
    pose = flight(origin?.camera ?? stopCamera(last), overview, returnProgress >= .999 ? 1 : returnProgress);
  } else if (tour) {
    pose = flight(origin?.camera ?? (previous ? stopCamera(previous) : overview), stopCamera(stop), rawProgress);
  }

  const current = stop ? String(stop.id) : '';
  const reveal = smooth((mapTime - .35) / 1.25);
  const sinceFirstVillage = mapTime - Number(stops[0]?.start ?? Infinity);
  const parentOverview = openingOnly ? 1 : 1 - smooth(sinceFirstVillage / .45);
  let childReveal = openingOnly ? 0 : smooth(sinceFirstVillage / .8);
  let parentLabel = .98 * parentOverview * smooth((mapTime - 1.16) / .48);
  let parentAccent = returning?.progress ?? parentOverview;
  const labels: Record<string, LabelStyle> = {};
  const accents: Record<string, number> = {};
  if (!openingOnly) {
    stops.forEach((item, stopIndex) => {
      const id = String(item.id);
      const label = tourLabelPresentationAt(mapTime, tour, returning, item, stopIndex);
      if (label.visible) labels[id] = {
        alpha: label.alpha, scale: label.scale * lerp(1, .68, returning?.progress ?? 0), emphasis: label.emphasis
      };
      const accent = tourHighlightStrength(tour, returning, id);
      if (accent > 0) accents[id] = accent;
    });
  }

  const transition = overviewProgress !== undefined ? smooth(overviewProgress) : returning?.progress ?? tour?.progress ?? 1;
  if (previewView !== undefined) {
    pose = adjustView(pose, previewView, origin ? transition : 1);
  } else if (Array.isArray(region.mapViewTrack)) {
    const track = region.mapViewTrack as { start: number; view: MapView | null }[];
    const index = track.reduce((active, entry, i) => mapTime >= entry.start ? i : active, -1);
    const entry = track[index];
    if (entry) {
      const blend = entry.start <= 0 ? 1 : smooth((mapTime - entry.start) / .75);
      const before = adjustView(pose, track[index - 1]?.view);
      const after = adjustView(pose, entry.view);
      pose = {
        lon: wrapAngle(before.lon + wrapAngle(after.lon - before.lon) * blend), lat: lerp(before.lat, after.lat, blend),
        height: lerp(before.height, after.height, blend), heading: before.heading + wrapAngle(after.heading - before.heading) * blend,
        pitch: lerp(before.pitch, after.pitch, blend)
      };
    }
  }
  if (origin && transition < 1) {
    parentLabel = lerp(origin.parentLabel, parentLabel, transition);
    parentAccent = lerp(origin.parentAccent, parentAccent, transition);
    childReveal = lerp(origin.childReveal, childReveal, transition);
    for (const id of new Set([...Object.keys(origin.labels), ...Object.keys(labels)])) {
      const start = origin.labels[id], end = labels[id];
      labels[id] = {
        alpha: lerp(start?.alpha ?? 0, end?.alpha ?? 0, transition),
        scale: lerp(start?.scale ?? end!.scale, end?.scale ?? start!.scale, transition),
        emphasis: lerp(start?.emphasis ?? 0, end?.emphasis ?? 0, transition)
      };
    }
    for (const id of new Set([...Object.keys(origin.accents), ...Object.keys(accents)])) {
      accents[id] = lerp(origin.accents[id] ?? 0, accents[id] ?? 0, transition);
    }
  }

  const focusId = Object.keys(accents).reduce((best, id) => accents[id]! > (accents[best] ?? parentAccent) ? id : best, '');
  const nextAccent = Math.max(focusId ? parentAccent : 0, ...Object.entries(accents).filter(([id]) => id !== focusId).map(([, value]) => value));
  const focus = ((accents[focusId] ?? parentAccent) - nextAccent) * smooth((mapTime - .18) / 1.15);
  const traceStart = stop ? Number(stop.start) + flightDuration * .75 : .35;
  return {
    camera: pose, time, mapTime, current, progress: returning ? 1 - returning.progress : tour?.progress ?? 0,
    visited: Object.keys(labels).filter(id => labels[id]!.alpha > .01),
    parentReveal: reveal, childReveal, parentLabel, parentAccent,
    labels, accents, labelReferenceDistance, focusId, focus,
    clouds: cloudStateAt(time, opening, pose.height),
    trace: boundaryAnimation(mapTime, traceStart, current)
  };
}
