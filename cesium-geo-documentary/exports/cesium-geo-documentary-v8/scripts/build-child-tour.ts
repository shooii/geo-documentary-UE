import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SceneTimelineSchema } from "../../../../packages/timeline-schema/index.js";

interface Cue { start: number; end: number; text: string }
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
  childRegions: ChildRegion[];
  cameraPreset: ChildRegion["cameraPreset"];
  coverageManifestPath?: string;
  [key: string]: unknown;
}
interface TourContent {
  tourOrder: string[];
  tourIntroSentences: number;
  tourFlightSeconds?: number;
}

const root = resolve(process.cwd());
const args = process.argv.slice(2);
const regionIndex = args.indexOf("--region");
const regionId = regionIndex >= 0 ? args[regionIndex + 1] : undefined;
if (!regionId) throw new Error("--region is required");
const FLIGHT_MIN_SECONDS = 2.2;
const FLIGHT_MAX_SECONDS = 4.5;
const SETTLE_SECONDS = 0.65;

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

function parseTimestamp(value: string): number {
  const match = value.trim().match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!match) throw new Error(`Invalid SRT timestamp ${value}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function parseSrt(value: string): Cue[] {
  return value.trim().split(/\r?\n\r?\n/).flatMap((block) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 3 || !lines[1]?.includes("-->")) return [];
    const [startRaw, endRaw] = lines[1].split("-->").map((item) => item.trim());
    if (!startRaw || !endRaw) throw new Error(`Invalid SRT timing line ${lines[1]}`);
    return [{ start: parseTimestamp(startRaw), end: parseTimestamp(endRaw), text: lines.slice(2).join("") }];
  });
}

const contentIndex = JSON.parse(await readFile(resolve(root, "content/regions.zh-CN.json"), "utf8")) as Record<string, TourContent>;
const content = contentIndex[regionId];
if (!content?.tourOrder?.length) throw new Error(`Region ${regionId} has no tourOrder`);
const regionPath = resolve(root, `data/regions/${regionId}.json`);
const region = JSON.parse(await readFile(regionPath, "utf8")) as RegionRecord;
const childMap = new Map(region.childRegions.map((child) => [String(child.id), child]));
const coverageIds = new Set(region.childIds.map(String));
if (content.tourOrder.length !== coverageIds.size || content.tourOrder.some((id) => !coverageIds.has(String(id)))) {
  throw new Error(`tourOrder must contain every direct child exactly once for ${regionId}`);
}
if (new Set(content.tourOrder).size !== content.tourOrder.length) throw new Error(`tourOrder contains duplicate IDs for ${regionId}`);

const rawCues = parseSrt(await readFile(resolve(root, `assets/audio/${regionId}/narration-edge.srt`), "utf8"));
const introCount = content.tourIntroSentences;
if (rawCues.length < introCount + content.tourOrder.length) {
  throw new Error(`Narration has ${rawCues.length} sentence cues; expected at least ${introCount + content.tourOrder.length}`);
}
const durationPath = resolve(root, `assets/audio/${regionId}/duration.json`);
const durationData = JSON.parse(await readFile(durationPath, "utf8")) as { durationSeconds: number; timelineDurationSeconds?: number };
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
    + (FLIGHT_MAX_SECONDS - FLIGHT_MIN_SECONDS) * Math.sqrt(clamp(distanceMeters / 18_000, 0, 1));
  const editorialPreference = content.tourFlightSeconds ?? 2.8;
  const adaptiveDuration = distanceDuration * 0.72 + editorialPreference * 0.28;
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

region.presentationMode = "parent-child-tour";
region.tourIntroEnd = rawCues[Math.max(0, introCount - 1)]?.end ?? tourStops[0]?.start ?? 0;
region.tourOutroStart = rawCues[introCount + content.tourOrder.length]?.start ?? tourStops.at(-1)?.end ?? timelineDuration;
region.tourStops = tourStops;
await writeFile(regionPath, JSON.stringify(region, null, 2), "utf8");

const actions = [
  { id: "camera-overview-hold", time: 0, duration: Math.max(0.1, Number(region.tourIntroEnd)), type: "holdRegionCamera", target: regionId, easing: "linear" },
  { id: "parent-outline", time: 0.3, duration: 2.2, type: "revealParentBoundary", target: regionId, easing: "cubicInOut" },
  { id: "child-boundaries", time: 2.8, duration: 1.1, type: "fadeChildBoundaries", target: regionId, easing: "cubicInOut" },
  { id: "selected-fill", time: 3.3, duration: 1.1, type: "fadeSelectedFill", target: regionId, easing: "cubicInOut" },
  ...tourStops.flatMap((stop, index) => [
    { id: `tour-flight-${index + 1}`, time: stop.start, duration: stop.flightDuration, type: "flyToRegion", target: stop.id, easing: "cubicInOut" },
    { id: `tour-hold-${index + 1}`, time: stop.start + stop.flightDuration, duration: Math.max(0, stop.end - stop.start - stop.flightDuration), type: "holdRegionCamera", target: stop.id, easing: "linear" }
  ])
];
const timeline = { duration: timelineDuration, actions };
SceneTimelineSchema.parse(timeline);
await writeFile(resolve(root, `data/regions/${regionId}.timeline.json`), JSON.stringify(timeline, null, 2), "utf8");
durationData.timelineDurationSeconds = timelineDuration;
await writeFile(durationPath, JSON.stringify(durationData, null, 2), "utf8");

if (region.coverageManifestPath) {
  const coveragePath = resolve(root, String(region.coverageManifestPath));
  const coverage = JSON.parse(await readFile(coveragePath, "utf8")) as { children: Array<Record<string, unknown>>; [key: string]: unknown };
  const orderMap = new Map(content.tourOrder.map((id, index) => [String(id), index + 1]));
  coverage.children = coverage.children.map((child) => ({ ...child, editorialOrder: orderMap.get(String(child.id)) }));
  coverage.narrationCoverage = tourStops.map((stop) => ({ id: stop.id, start: stop.start, end: stop.end, camera: true, highlight: true }));
  await writeFile(coveragePath, JSON.stringify(coverage, null, 2), "utf8");
}

process.stdout.write(`CHILD_TOUR_READY ${regionId} ${tourStops.length} ${timelineDuration}s\n`);
