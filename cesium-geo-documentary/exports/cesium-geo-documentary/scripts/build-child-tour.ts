import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SceneTimelineSchema } from "../../../../packages/timeline-schema/index.js";
import { normalizeTourReturnSeconds, parseSrt } from "./narration-timing.js";

interface ChildRegion {
  id: string;
  name: string;
  labelPoint: [number, number];
  bbox: [number, number, number, number];
  cameraPreset: { longitude: number; latitude: number; height: number; heading: number; pitch: number; roll: number };
}
interface RegionRecord {
  id: string;
  childIds: string[];
  tourChildIds?: string[];
  childRegions: ChildRegion[];
  cameraPreset: ChildRegion["cameraPreset"];
  coverageManifestPath?: string;
  [key: string]: unknown;
}
interface TourContent {
  tourOrder: string[];
  tourIntroSentences: number;
  tourFlightSeconds?: number;
  tourReturnSeconds?: number;
}

interface OutroPauseMetadata {
  applied?: boolean;
  mode?: string;
  requestedSeconds?: number;
  insertedSeconds?: number;
  lastChildNarrationEndSeconds?: number;
  outroNarrationStartSeconds?: number;
  returnWindowSeconds?: number;
}

const root = resolve(process.cwd());
const args = process.argv.slice(2);
const regionIndex = args.indexOf("--region");
const regionId = regionIndex >= 0 ? args[regionIndex + 1] : undefined;
if (!regionId) throw new Error("--region is required");
const FLIGHT_MIN_SECONDS = 3.2;
const FLIGHT_MAX_SECONDS = 5.4;
const SETTLE_SECONDS = 0.9;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function groundDistanceMeters(
  from: ChildRegion["cameraPreset"],
  to: ChildRegion["cameraPreset"]
): number {
  const radius = 6_378_137;
  const latitude1 = from.latitude * Math.PI / 180;
  const latitude2 = to.latitude * Math.PI / 180;
  const deltaLatitude = latitude2 - latitude1;
  const deltaLongitude = (to.longitude - from.longitude) * Math.PI / 180;
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const contentIndex = JSON.parse(await readFile(resolve(root, "content/regions.zh-CN.json"), "utf8")) as Record<string, TourContent>;
const content = contentIndex[regionId];
if (!content?.tourOrder?.length) throw new Error(`Region ${regionId} has no tourOrder`);
const regionPath = resolve(root, `data/regions/${regionId}.json`);
const region = JSON.parse(await readFile(regionPath, "utf8")) as RegionRecord;
const childMap = new Map(region.childRegions.map((child) => [String(child.id), child]));
const coverageIds = new Set((region.tourChildIds ?? region.childIds).map(String));
if (content.tourOrder.length !== coverageIds.size || content.tourOrder.some((id) => !coverageIds.has(String(id)))) {
  throw new Error(`tourOrder must contain every direct child exactly once for ${regionId}`);
}
if (new Set(content.tourOrder).size !== content.tourOrder.length) throw new Error(`tourOrder contains duplicate IDs for ${regionId}`);

const rawCues = parseSrt(await readFile(resolve(root, `assets/audio/${regionId}/narration-edge.srt`), "utf8"));
const introCount = content.tourIntroSentences;
if (!Number.isInteger(introCount) || introCount < 0) {
  throw new Error(`tourIntroSentences must be a non-negative integer for ${regionId}`);
}
const outroCueIndex = introCount + content.tourOrder.length;
if (rawCues.length <= outroCueIndex) {
  throw new Error(`Narration has ${rawCues.length} sentence cues; expected at least ${outroCueIndex + 1}, including an outro cue`);
}
const durationPath = resolve(root, `assets/audio/${regionId}/duration.json`);
const durationData = JSON.parse(await readFile(durationPath, "utf8")) as {
  durationSeconds: number;
  timelineDurationSeconds?: number;
  outroPause?: OutroPauseMetadata | null;
};
const timelineDuration = Math.ceil(durationData.durationSeconds + 3);
const tourStops = content.tourOrder.map((id, index) => {
  const child = childMap.get(String(id));
  if (!child) throw new Error(`Missing child camera metadata for ${id}`);
  const cue = rawCues[introCount + index];
  if (!cue) throw new Error(`Missing narration cue for child ${id}`);
  const cueDuration = cue.end - cue.start;
  const previousCamera = index === 0
    ? region.cameraPreset
    : childMap.get(String(content.tourOrder[index - 1]))?.cameraPreset ?? region.cameraPreset;
  const distanceMeters = groundDistanceMeters(previousCamera, child.cameraPreset);
  const distanceDuration = FLIGHT_MIN_SECONDS
    + (FLIGHT_MAX_SECONDS - FLIGHT_MIN_SECONDS) * Math.sqrt(clamp(distanceMeters / 22_000, 0, 1));
  const editorialPreference = content.tourFlightSeconds ?? 4.2;
  const adaptiveDuration = distanceDuration * 0.76 + editorialPreference * 0.24;
  const availableDuration = Math.max(FLIGHT_MIN_SECONDS, cueDuration - SETTLE_SECONDS);
  return {
    id: child.id,
    name: child.name,
    start: cue.start,
    end: cue.end,
    flightDuration: Math.min(availableDuration, clamp(adaptiveDuration, FLIGHT_MIN_SECONDS, FLIGHT_MAX_SECONDS)),
    groundDistanceMeters: Math.round(distanceMeters),
    cameraPreset: child.cameraPreset,
    narration: cue.text
  };
});

const finalChildEnd = tourStops.at(-1)?.end;
const outroStart = rawCues[outroCueIndex]?.start;
if (finalChildEnd === undefined || outroStart === undefined) {
  throw new Error(`Could not derive parent-return timing for ${regionId}`);
}
const pauseMetadata = durationData.outroPause;
if (!pauseMetadata?.applied || pauseMetadata.mode !== "parent-child-tour") {
  throw new Error(`Narration for ${regionId} has no parent-return silence metadata; run generate-narration first`);
}
if (pauseMetadata.outroNarrationStartSeconds !== undefined
  && Math.abs(pauseMetadata.outroNarrationStartSeconds - outroStart) > 0.08) {
  throw new Error(`Narration SRT and parent-return silence metadata are out of sync for ${regionId}`);
}
const requestedReturnSeconds = normalizeTourReturnSeconds(
  pauseMetadata.insertedSeconds ?? content.tourReturnSeconds
);
const returnWindowSeconds = outroStart - finalChildEnd;
if (returnWindowSeconds + 0.08 < requestedReturnSeconds) {
  throw new Error(`Parent-return window is only ${returnWindowSeconds.toFixed(3)}s; expected at least ${requestedReturnSeconds.toFixed(3)}s`);
}
const returnFlightSeconds = Math.min(requestedReturnSeconds, returnWindowSeconds);

region.presentationMode = "parent-child-tour";
region.tourIntroEnd = introCount > 0 ? rawCues[introCount - 1]?.end ?? 0 : tourStops[0]?.start ?? 0;
region.tourReturnStart = finalChildEnd;
region.tourReturnDuration = returnFlightSeconds;
region.tourReturnWindowSeconds = returnWindowSeconds;
region.tourOutroStart = outroStart;
region.tourReturn = {
  action: "pullBackToParent",
  target: regionId,
  start: finalChildEnd,
  duration: returnFlightSeconds,
  windowEnd: outroStart,
  easing: "sineInOut"
};
region.tourStops = tourStops;
await writeFile(regionPath, JSON.stringify(region, null, 2), "utf8");

const parentHoldStart = finalChildEnd + returnFlightSeconds;
const actions = [
  { id: "camera-overview-hold", time: 0, duration: Math.max(0.1, Number(region.tourIntroEnd)), type: "holdRegionCamera", target: regionId, easing: "linear" },
  { id: "parent-outline", time: 0.35, duration: 3.0, type: "revealParentBoundary", target: regionId, easing: "sineInOut" },
  { id: "child-boundaries", time: 3.15, duration: 1.35, type: "fadeChildBoundaries", target: regionId, easing: "sineInOut" },
  { id: "selected-fill", time: 3.55, duration: 1.25, type: "fadeSelectedFill", target: regionId, easing: "sineInOut" },
  ...tourStops.flatMap((stop, index) => [
    { id: `tour-flight-${index + 1}`, time: stop.start, duration: stop.flightDuration, type: "flyToRegion", target: stop.id, easing: "sineInOut" },
    { id: `tour-hold-${index + 1}`, time: stop.start + stop.flightDuration, duration: Math.max(0, stop.end - stop.start - stop.flightDuration), type: "holdRegionCamera", target: stop.id, easing: "linear" }
  ]),
  { id: "tour-return-parent", time: finalChildEnd, duration: returnFlightSeconds, type: "pullBackToParent", target: regionId, easing: "sineInOut" },
  { id: "tour-parent-outro-hold", time: parentHoldStart, duration: Math.max(0, timelineDuration - parentHoldStart), type: "holdRegionCamera", target: regionId, easing: "linear" }
];
const timeline = { duration: timelineDuration, actions };
SceneTimelineSchema.parse(timeline);
await writeFile(resolve(root, `data/regions/${regionId}.timeline.json`), JSON.stringify(timeline, null, 2), "utf8");
durationData.timelineDurationSeconds = timelineDuration;
await writeFile(durationPath, JSON.stringify(durationData, null, 2), "utf8");

const storyboardPath = resolve(root, `content/storyboards/${regionId}.json`);
try {
  const storyboard = JSON.parse(await readFile(storyboardPath, "utf8")) as {
    duration?: number;
    scenes?: Array<Record<string, unknown>>;
  };
  const scenes = storyboard.scenes ?? [];
  const firstChildSceneIndex = scenes.findIndex((scene) => Boolean(scene.childId));
  if (firstChildSceneIndex === introCount) {
    for (let index = 0; index < introCount; index += 1) {
      const cue = rawCues[index];
      if (!cue) continue;
      scenes[index] = { ...scenes[index], start: cue.start, end: cue.end, duration: cue.end - cue.start };
    }
  }
  const stopById = new Map(tourStops.map((stop) => [String(stop.id), stop]));
  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index]!;
    const childId = String(scene.childId ?? "");
    const stop = stopById.get(childId);
    if (stop) {
      scenes[index] = { ...scene, start: stop.start, end: stop.end, duration: stop.end - stop.start };
      continue;
    }
    if (scene.cameraAction === "return-to-parent-overview") {
      scenes[index] = { ...scene, start: finalChildEnd, end: outroStart, duration: returnFlightSeconds };
      continue;
    }
    if (index > 0 && scenes[index - 1]?.cameraAction === "return-to-parent-overview") {
      scenes[index] = { ...scene, start: outroStart, end: timelineDuration, duration: timelineDuration - outroStart };
    }
  }
  storyboard.duration = timelineDuration;
  storyboard.scenes = scenes;
  await writeFile(storyboardPath, JSON.stringify(storyboard, null, 2), "utf8");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const visualManifestPath = resolve(root, `content/visuals/${regionId}.json`);
try {
  const visualManifest = JSON.parse(await readFile(visualManifestPath, "utf8")) as {
    clips?: Array<Record<string, unknown> & { narrationCueIndex?: number }>;
  };
  visualManifest.clips = (visualManifest.clips ?? []).map((clip) => {
    const cueIndex = Number(clip.narrationCueIndex);
    const cue = Number.isInteger(cueIndex) ? rawCues[cueIndex] : undefined;
    return cue ? { ...clip, start: cue.start, end: cue.end } : clip;
  });
  await writeFile(visualManifestPath, JSON.stringify(visualManifest, null, 2), "utf8");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

if (region.coverageManifestPath) {
  const coveragePath = resolve(root, String(region.coverageManifestPath));
  const coverage = JSON.parse(await readFile(coveragePath, "utf8")) as { children: Array<Record<string, unknown>>; [key: string]: unknown };
  const orderMap = new Map(content.tourOrder.map((id, index) => [String(id), index + 1]));
  coverage.children = coverage.children.map((child) => ({ ...child, editorialOrder: orderMap.get(String(child.id)) }));
  coverage.narrationCoverage = tourStops.map((stop) => ({ id: stop.id, start: stop.start, end: stop.end, camera: true, highlight: true }));
  await writeFile(coveragePath, JSON.stringify(coverage, null, 2), "utf8");
}

process.stdout.write(`CHILD_TOUR_READY ${regionId} ${tourStops.length} ${timelineDuration}s return=${returnFlightSeconds.toFixed(2)}s outro=${outroStart.toFixed(2)}s\n`);
