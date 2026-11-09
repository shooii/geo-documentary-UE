import { Cartographic, EllipsoidGeodesic } from 'cesium';
import { tourHighlightStrength, tourLabelPresentationAt } from '../cesium-player/public/tour-presentation.js';
import type { MapView } from '../../packages/project-schema/index.js';
import { cloudStateAt } from './opening.js';
import { boundaryAnimation } from './boundary-style.js';

export const actions = new Set(['prepare-tour', 'play-opening', 'set-annotations', 'show-tour-frame', 'play-tour-segment', 'play-scene-range', 'stop-scene-playback', 'update-tour-labels', 'play-tour-outro', 'play-parent-overview', 'preview-child-camera', 'set-map-view', 'switch-imagery']);
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

// Scene 2 choreography shared by the exporter, the studio preview and the
// standalone capture: the town settles first, the county is traced while the
// camera pulls back, then the shot settles back on the town.
const CONTEXT_INTRO = { town: 2.4, out: 3.2, hold: 1.9, lean: .8, back: 3, total: 10.5 };
function openingSeconds(scene: any) {
  const opening = scene?.region?.openingDescent;
  if (!opening || opening.enabled === false) return 0;
  return Math.max(2, Math.min(16, Number(opening.seconds ?? 3)));
}
export function contextIntroSeconds(scene: any) {
  const hasCounty = Boolean(scene?.context?.cameraProfiles?.['portrait'] || scene?.context?.cameraPreset);
  return hasCounty ? openingSeconds(scene) + CONTEXT_INTRO.total : 0;
}

export function frameAt(scene: any, stops: any[], time: number, profile: string, returnDuration: number, openingOnly = false, origin?: PreviewFlightOrigin, overviewProgress?: number, previewView?: MapView | null, contextIntroEnabled?: boolean) {
  const region = scene.region;
  const preset = camera(region.cameraProfiles?.[profile] || region.cameraPreset);
  const contextPreset = scene.context?.cameraProfiles?.[profile] || scene.context?.cameraPreset;
  const contextPose = contextPreset ? camera(contextPreset) : undefined;
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
  const tourStart = Number(stops[0]?.start ?? Infinity);
  // The county only ever appears on the shot that introduces the town. Once the
  // village tour has started (`mapTime` reached the first stop) the context must
  // never take the camera away from a village preview.
  // Only the shot that introduces the town shows the county: the standalone capture
  // (no tour stops) always does, the studio asks for it explicitly on `play-opening`,
  // and a village preview never does.
  const contextPending = (contextIntroEnabled ?? stops.length === 0) &&
    (!Number.isFinite(tourStart) || mapTime < tourStart);
  const contextIntro = contextPose && contextPending ? descent + CONTEXT_INTRO.total : 0;
  if (time < descent) {
    // The shot always arrives from the sky, county or not. The rim only starts
    // drawing once the camera has landed, so no dim outline hangs in mid-air.
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
  } else if (contextPose && contextPending && time < contextIntro) {
    // 1. the town boundary finishes drawing, 2. the camera eases back while a wipe
    // front travels across the county, 3. the full county holds long enough to read
    // where the town sits inside it, 4. the front rewinds as the camera settles back
    // on the town. `lean` keeps the camera parked on the county for the first beat of
    // the rewind, so the erase is actually watched instead of happening mid-flight.
    const drawn = descent + CONTEXT_INTRO.town;
    const wide = drawn + CONTEXT_INTRO.out;
    const held = wide + CONTEXT_INTRO.hold;
    if (time < drawn) pose = overview;
    else if (time < wide) pose = flight(overview, contextPose, smooth((time - drawn) / CONTEXT_INTRO.out));
    else
      pose = flight(contextPose, overview,
        smooth((time - held - CONTEXT_INTRO.lean) / (CONTEXT_INTRO.back - CONTEXT_INTRO.lean)));
  } else if (origin && overviewProgress !== undefined) {
    pose = flight(origin.camera, overview, overviewProgress);
  } else if (returnProgress !== null) {
    pose = flight(origin?.camera ?? stopCamera(last), overview, returnProgress >= .999 ? 1 : returnProgress);
  } else if (tour) {
    pose = flight(origin?.camera ?? (previous ? stopCamera(previous) : overview), stopCamera(stop), rawProgress);
  }

  const current = stop ? String(stop.id) : '';
  // County choreography. The county used to bloom outward from the town centre;
  // it now arrives as a PPT-style wipe — a straight front travels across the
  // shape, and nothing ahead of it is drawn. After the full county has been on
  // screen for `hold`, the same front rewinds while the camera flies home, so the
  // county is erased back down to 迈陈镇, which sits at its west end.
  const countyIn = descent + CONTEXT_INTRO.town;
  const countyHeld = countyIn + CONTEXT_INTRO.out + CONTEXT_INTRO.hold;
  const countyActive = Boolean(contextPose && contextPending);
  // The rewind is front-loaded on purpose: `smooth` kept the county intact for the
  // first half-second of the flight, so the erase was never actually watched. A
  // power curve pulls most of the county away while the shot is still wide and lets
  // the last sliver, which is 迈陈镇, linger until the camera lands.
  const contextWipe = !countyActive ? 0
    : time < countyHeld
      ? smooth((time - countyIn) / (CONTEXT_INTRO.out * .92))
      : 1 - Math.pow(clamp((time - countyHeld) / (CONTEXT_INTRO.back * .9)), .75);
  const contextErasing = countyActive && time >= countyHeld ? 1 : 0;
  // `contextReveal` is the wipe front position now: 0 = nothing drawn, 1 = the
  // whole county. Everything downstream (fill, rim, county name) keys off it.
  const contextReveal = contextWipe;
  // The front itself clears the last sliver, so this only softens the very end.
  const contextOpacity = countyActive ? smooth(contextWipe / .06) : 0;
  const reveal = smooth((mapTime - .35) / 1.25);
  // The opening has to read as one gesture: the camera drops out of the deck, the
  // rim is traced by the light beam, and only then may a name or a pin appear.
  // Anything drawn while the camera is still inside the cloud breaks the shot, so
  // every label on the opening shot is gated by this single ramp. The beam fades
  // out at mapTime 1.45; the gate opens just behind it.
  const openingShot = openingOnly || stops.length === 0 ||
    (Boolean(contextPose && contextPending) && time < contextIntro);
  // The beam sweeps for 1.25 s starting at 0.35 s after the descent ends. The name used
  // to wait for the beam to fade out entirely (1.45 s); it now starts at the halfway
  // point of the sweep and lands just as the beam goes, so the two read as one beat.
  const labelsReveal = openingShot && descent > 0 ? smooth((mapTime - .98) / .5) : 1;
  const parentOverview = openingOnly ? 1 : 1 - smooth((mapTime - Number(stops[0]?.start ?? Infinity)) / .45);
  let parentLabel = .98 * parentOverview * smooth((mapTime - .95) / .45) * labelsReveal;
  let parentAccent = returning?.progress ?? parentOverview;
  const labels: Record<string, LabelStyle> = {};
  const accents: Record<string, number> = {};
  if (!openingOnly) {
    stops.forEach((item, stopIndex) => {
      const id = String(item.id);
      const label = tourLabelPresentationAt(mapTime, tour, returning, item, stopIndex);
      if (label.visible) labels[id] = {
        alpha: label.alpha * labelsReveal, scale: label.scale * lerp(1, .68, returning?.progress ?? 0), emphasis: label.emphasis
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
    parentReveal: reveal, childReveal: smooth((mapTime - 3.15) / 1.35), parentLabel, parentAccent, contextReveal, contextOpacity, contextErasing,
    labels, accents, labelReferenceDistance, focusId, focus, labelsReveal,
    // Villages the tour has already reached. UE keeps their plate painted, so the
    // map accumulates colour the way the reference reel does.
    visitedIds: stops.filter(item => mapTime >= Number(item.start)).map(item => String(item.id)),
    clouds: cloudStateAt(time, opening, pose.height),
    trace: boundaryAnimation(mapTime, traceStart, current)
  };
}
