import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SceneTimelineSchema } from "../../../../packages/timeline-schema/index.js";
import { normalizeTourReturnSeconds, parseSrt } from "./narration-timing.js";
import { portraitChildCameraPreset, type GeoBounds } from "../../../../packages/geo-camera/index.js";

interface ChildRegion {
  id: string;
  name: string;
  labelPoint: [number, number];
  bbox: GeoBounds;
  cameraPreset: { longitude: number; latitude: number; height: number; heading: number; pitch: number; roll: number };
  cameraProfiles?: { portrait?: ChildRegion["cameraPreset"] };
}
interface RegionRecord {
  id: string;
  childIds: string[];
  tourChildIds?: string[];
  childRegions: ChildRegion[];
  cameraPreset: ChildRegion["cameraPreset"];
  openingDescent?: { enabled?: boolean; seconds?: number };
  coverageManifestPath?: string;
  [key: string]: unknown;
}
interface TourContent {
  tourOrder: string[];
  tourIntroSentences: number;
  tourFlightSeconds?: number;
  tourReturnSeconds?: number;
  tourMapHoldSeconds?: Record<string, number>;
  /** Exact per-child sentence-cue ranges written by the render engine after
   *  the real narration SRT was measured. A child paragraph may be split into
   *  several TTS sentence cues; when present this mapping replaces the legacy
   *  "one cue per child" linear assumption so each stop covers the child's
   *  complete narration window and later villages do not drift. */
  tourChildCueRanges?: Array<{ childId: string; cueStartIndex: number; cueEndIndex: number }>;
}

interface OutroPauseMetadata {
  applied?: boolean;
  mode?: string;
  hasClosingNarration?: boolean;
  requestedSeconds?: number;
  insertedSeconds?: number;
  lastChildNarrationEndSeconds?: number;
  outroNarrationStartSeconds?: number | null;
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
// Studio projects may intentionally delete child scenes. The materialized
// tourOrder is therefore the current project's ordered subset, while the
// region catalog remains the complete source of geometry and camera metadata.
if (content.tourOrder.some((id) => !coverageIds.has(String(id)) || !childMap.has(String(id)))) {
  throw new Error(`tourOrder contains a child outside the direct region coverage for ${regionId}`);
}
if (new Set(content.tourOrder).size !== content.tourOrder.length) throw new Error(`tourOrder contains duplicate IDs for ${regionId}`);

const rawCues = parseSrt(await readFile(resolve(root, `assets/audio/${regionId}/narration-edge.srt`), "utf8"));
const introCount = content.tourIntroSentences;
if (!Number.isInteger(introCount) || introCount < 0) {
  throw new Error(`tourIntroSentences must be a non-negative integer for ${regionId}`);
}
// Legacy linear assumption (one narration sentence cue per child) matched the
// original paragraph-per-scene TTS layout, but Edge TTS splits a paragraph into
// one cue per sentence. When the render engine has written exact per-child cue
// ranges, the outro begins right after the final child's last cue; otherwise
// fall back to intro sentence count + one cue per child.
const lastMappedChild = (content.tourChildCueRanges ?? []).slice().sort((a, b) => a.cueStartIndex - b.cueStartIndex).at(-1);
const firstMappedChild = (content.tourChildCueRanges ?? []).slice().sort((a, b) => a.cueStartIndex - b.cueStartIndex)[0];
const outroCueIndex = lastMappedChild ? lastMappedChild.cueEndIndex + 1 : introCount + content.tourOrder.length;
if (rawCues.length < outroCueIndex) {
  throw new Error(`Narration has ${rawCues.length} sentence cues; expected at least ${outroCueIndex} cues for the introduction and complete child tour`);
}
const durationPath = resolve(root, `assets/audio/${regionId}/duration.json`);
const durationData = JSON.parse(await readFile(durationPath, "utf8")) as {
  durationSeconds: number;
  timelineDurationSeconds?: number;
  outroPause?: OutroPauseMetadata | null;
};
// Start narration and subtitles on the same beat as the parent boundary pen
// draw. The descent remains silent, but the overview must not wait for the
// outline and label to finish before speech begins. Cue-driven camera actions
// use this same offset so audio, captions, and map motion stay synchronized.
const PARENT_BOUNDARY_REVEAL_START_SECONDS = 0.35;
const narrationSyncOffsetSeconds = PARENT_BOUNDARY_REVEAL_START_SECONDS;
const openingSeconds = region.openingDescent?.enabled === false
  ? 0
  : Number(region.openingDescent?.seconds ?? 0);
const timelineDuration = Math.ceil(durationData.durationSeconds + openingSeconds + narrationSyncOffsetSeconds);
const tourStops = content.tourOrder.map((id, index) => {
  const child = childMap.get(String(id));
  if (!child) throw new Error(`Missing child camera metadata for ${id}`);
  // A child's narration may span several sentence cues (a paragraph with two
  // sentences produces two SRT cues). Prefer the measured scene->cue range;
  // fall back to the legacy one-cue-per-child linear position.
  const mapped = content.tourChildCueRanges?.find((item) => String(item.childId) === String(id));
  const firstCueIndex = mapped?.cueStartIndex ?? introCount + index;
  const lastCueIndex = mapped?.cueEndIndex ?? introCount + index;
  const firstCue = rawCues[firstCueIndex];
  if (!firstCue) throw new Error(`Missing narration cue for child ${id}`);
  const lastCue = rawCues[lastCueIndex] ?? firstCue;
  if (mapped && lastCueIndex > firstCueIndex) {
    // Guard against a damaged range pointing outside the narration.
    const joined = rawCues.slice(firstCueIndex, lastCueIndex + 1).map((cue) => cue.text).join("");
    if (!joined) throw new Error(`Empty cue range ${firstCueIndex}-${lastCueIndex} for child ${id}`);
  }
  const cueStart = firstCue.start;
  const cueEnd = lastCue.end;
  const cueDuration = cueEnd - cueStart;
  const previousCamera = index === 0
    ? region.cameraPreset
    : childMap.get(String(content.tourOrder[index - 1]))?.cameraPreset ?? region.cameraPreset;
  const distanceMeters = groundDistanceMeters(previousCamera, child.cameraPreset);
  const distanceDuration = FLIGHT_MIN_SECONDS
    + (FLIGHT_MAX_SECONDS - FLIGHT_MIN_SECONDS) * Math.sqrt(clamp(distanceMeters / 22_000, 0, 1));
  const editorialPreference = content.tourFlightSeconds ?? 4.2;
  const adaptiveDuration = distanceDuration * 0.76 + editorialPreference * 0.24;
  const requestedHoldSeconds = clamp(Number(content.tourMapHoldSeconds?.[String(id)] ?? SETTLE_SECONDS), 0, Math.max(0, cueDuration - FLIGHT_MIN_SECONDS));
  const availableDuration = Math.max(FLIGHT_MIN_SECONDS, cueDuration - requestedHoldSeconds);
  return {
    id: child.id,
    name: child.name,
    start: cueStart + narrationSyncOffsetSeconds,
    end: cueEnd + narrationSyncOffsetSeconds,
    flightDuration: Math.min(availableDuration, clamp(adaptiveDuration, FLIGHT_MIN_SECONDS, FLIGHT_MAX_SECONDS)),
    groundDistanceMeters: Math.round(distanceMeters),
    cameraPreset: child.cameraPreset,
    cameraProfiles: {
      ...(child.cameraProfiles ?? {}),
      portrait: portraitChildCameraPreset(child.cameraProfiles?.portrait ?? child.cameraPreset, child.bbox)
    },
    narration: rawCues.slice(firstCueIndex, lastCueIndex + 1).map((cue) => cue.text).join(""),
    requestedHoldSeconds
  };
});

const finalChildEnd = tourStops.at(-1)?.end;
if (finalChildEnd === undefined) {
  throw new Error(`Could not derive parent-return timing for ${regionId}`);
}
const pauseMetadata = durationData.outroPause;
if (!pauseMetadata?.applied || pauseMetadata.mode !== "parent-child-tour") {
  throw new Error(`Narration for ${regionId} has no parent-return silence metadata; run generate-narration first`);
}
const closingCue = rawCues[outroCueIndex];
const hasClosingNarration = pauseMetadata.hasClosingNarration ?? Boolean(closingCue);
if (hasClosingNarration && !closingCue) {
  throw new Error(`Narration metadata for ${regionId} declares a closing cue, but none exists after the child tour`);
}
const closingNarrationStart = hasClosingNarration ? closingCue!.start + narrationSyncOffsetSeconds : null;
if (closingNarrationStart !== null
  && pauseMetadata.outroNarrationStartSeconds !== undefined
  && pauseMetadata.outroNarrationStartSeconds !== null
  && Math.abs(pauseMetadata.outroNarrationStartSeconds - (closingNarrationStart - narrationSyncOffsetSeconds)) > 0.08) {
  throw new Error(`Narration SRT and parent-return silence metadata are out of sync for ${regionId}`);
}
const requestedReturnSeconds = normalizeTourReturnSeconds(
  pauseMetadata.insertedSeconds ?? content.tourReturnSeconds
);
const returnWindowSeconds = closingNarrationStart === null
  ? Number(pauseMetadata.returnWindowSeconds ?? requestedReturnSeconds)
  : closingNarrationStart - finalChildEnd;
if (returnWindowSeconds + 0.08 < requestedReturnSeconds) {
  throw new Error(`Parent-return window is only ${returnWindowSeconds.toFixed(3)}s; expected at least ${requestedReturnSeconds.toFixed(3)}s`);
}
const returnFlightSeconds = Math.min(requestedReturnSeconds, returnWindowSeconds);
const openingCameraLock = finalChildEnd + returnFlightSeconds;
if (closingNarrationStart !== null && closingNarrationStart + 0.001 < openingCameraLock) {
  throw new Error(`Closing narration for ${regionId} begins before the opening parent camera is locked`);
}

region.presentationMode = "parent-child-tour";
// `introCount` counts narration *sentences*, but `rawCues` is not always one cue per
// sentence: the 讯飞 voice returns one cue per scene paragraph, so `rawCues[introCount-1]`
// pointed at the wrong cue and the overview camera stayed parked until the third village
// (measured: tourIntroEnd 74.9 s against a first stop at 50.2 s). When the exact
// scene→cue map exists, the introduction ends at the cue just before the first child.
const firstChildCueIndex = firstMappedChild?.cueStartIndex;
region.tourIntroEnd = firstChildCueIndex !== undefined
  ? (firstChildCueIndex > 0 ? (rawCues[firstChildCueIndex - 1]?.end ?? 0) : 0) + narrationSyncOffsetSeconds
  : introCount > 0
    ? (rawCues[introCount - 1]?.end ?? 0) + narrationSyncOffsetSeconds
    : tourStops[0]?.start ?? narrationSyncOffsetSeconds;
region.tourReturnStart = finalChildEnd;
region.tourReturnDuration = returnFlightSeconds;
region.tourReturnWindowSeconds = returnWindowSeconds;
region.tourReturnSilent = true;
region.tourClosingNarrationStart = closingNarrationStart;
region.tourClosingNarrationPolicy = "after-exact-opening-camera-lock";
region.tourOutroStart = closingNarrationStart ?? openingCameraLock;
region.tourReturn = {
  action: "pullBackToParent",
  target: regionId,
  start: finalChildEnd,
  duration: returnFlightSeconds,
  windowEnd: closingNarrationStart ?? openingCameraLock,
  silent: true,
  cameraLockTarget: "exact-opening-parent-camera",
  closingNarrationStart,
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
  { id: "tour-return-parent", time: finalChildEnd, duration: returnFlightSeconds, type: "pullBackToParent", target: regionId, easing: "sineInOut", silent: true, cameraLockTarget: "exact-opening-parent-camera" },
  { id: "tour-parent-outro-hold", time: parentHoldStart, duration: Math.max(0, timelineDuration - parentHoldStart), type: "holdRegionCamera", target: regionId, easing: "linear" }
];
const timeline = {
  duration: timelineDuration,
  // Already carries the descent + the pen-draw offset; the compositor must not add an
  // opening gate on top of it (that double-count put narration and captions one whole
  // opening behind the picture). Kept explicit so the field cannot drift back in.
  narrationStartSeconds: openingSeconds + narrationSyncOffsetSeconds,
  openingGateSeconds: 0,
  actions
};
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
      scenes[index] = { ...scene, start: finalChildEnd, end: openingCameraLock, duration: returnFlightSeconds, silent: true };
      continue;
    }
    if (index > 0 && scenes[index - 1]?.cameraAction === "return-to-parent-overview") {
      const sceneStart = closingNarrationStart ?? openingCameraLock;
      scenes[index] = { ...scene, start: sceneStart, end: timelineDuration, duration: timelineDuration - sceneStart };
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
    timingMode?: "narration-cue-required" | "legacy-seconds";
    clips?: Array<Record<string, unknown> & { narrationCueIndex?: number }>;
  };
  visualManifest.clips = (visualManifest.clips ?? []).map((clip) => {
    const cueIndex = Number(clip.narrationCueIndex);
    const cue = Number.isInteger(cueIndex) ? rawCues[cueIndex] : undefined;
    if (visualManifest.timingMode === "narration-cue-required") {
      if (!cue) throw new Error(`Visual ${String(clip.id ?? "unknown")} has invalid narrationCueIndex ${String(clip.narrationCueIndex)}`);
      const { start: _legacyStart, end: _legacyEnd, ...cueDrivenClip } = clip;
      return cueDrivenClip;
    }
    return cue ? { ...clip, start: cue.start, end: cue.end } : clip;
  });
  await writeFile(visualManifestPath, JSON.stringify(visualManifest, null, 2), "utf8");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

if (region.coverageManifestPath) {
  // The manifest is an editorial sidecar: towns planned before coverage tracking existed
  // simply do not have it, and a missing sidecar must not abort a whole export.
  try {
    const coveragePath = resolve(root, String(region.coverageManifestPath));
    const coverage = JSON.parse(await readFile(coveragePath, "utf8")) as { children: Array<Record<string, unknown>>; [key: string]: unknown };
    const orderMap = new Map(content.tourOrder.map((id, index) => [String(id), index + 1]));
    coverage.children = coverage.children.map((child) => ({ ...child, editorialOrder: orderMap.get(String(child.id)) }));
    coverage.narrationCoverage = tourStops.map((stop) => ({ id: stop.id, start: stop.start, end: stop.end, camera: true, highlight: true }));
    await writeFile(coveragePath, JSON.stringify(coverage, null, 2), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

process.stdout.write(`CHILD_TOUR_READY ${regionId} ${tourStops.length} ${timelineDuration}s return=${returnFlightSeconds.toFixed(2)}s closing=${closingNarrationStart?.toFixed(2) ?? "none"}\n`);
