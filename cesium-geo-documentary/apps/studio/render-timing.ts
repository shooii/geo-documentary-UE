import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RenderSpec, TimedCue } from "../../packages/render-spec/index.js";
import type { VideoProject } from "../../packages/project-schema/index.js";

interface Insertion { position: number; seconds: number; kind: "pre" | "post" }

function stamp(value: number, comma: boolean): string {
  const milliseconds = Math.max(0, Math.round(value * 1000));
  const separator = comma ? "," : ".";
  return `${String(Math.floor(milliseconds / 3_600_000)).padStart(2, "0")}:${String(Math.floor(milliseconds % 3_600_000 / 60_000)).padStart(2, "0")}:${String(Math.floor(milliseconds % 60_000 / 1000)).padStart(2, "0")}${separator}${String(milliseconds % 1000).padStart(3, "0")}`;
}

function serializeSrt(cues: TimedCue[]): string {
  return cues.map((cue, index) => `${index + 1}\n${stamp(cue.start, true)} --> ${stamp(cue.end, true)}\n${cue.text}`).join("\n\n") + "\n";
}

function serializeVtt(cues: TimedCue[]): string {
  return `WEBVTT\n\n${cues.map((cue) => `${stamp(cue.start, false)} --> ${stamp(cue.end, false)}\n${cue.text}`).join("\n\n")}\n`;
}

function shiftCues(cues: TimedCue[], insertions: Insertion[]): TimedCue[] {
  const epsilon = 0.0005;
  return cues.map((cue) => {
    const startShift = insertions.filter((item) => item.position < cue.start - epsilon || (item.kind === "pre" && Math.abs(item.position - cue.start) <= epsilon)).reduce((sum, item) => sum + item.seconds, 0);
    const endShift = insertions.filter((item) => item.position < cue.end - epsilon || (item.kind === "pre" && Math.abs(item.position - cue.start) <= epsilon)).reduce((sum, item) => sum + item.seconds, 0);
    return { ...cue, start: cue.start + startShift, end: cue.end + endShift };
  });
}

export function normalizeTimedCueOverlaps(cues: TimedCue[]): TimedCue[] {
  return cues.map((cue, index) => {
    const next = cues[index + 1];
    if (!next || cue.end <= next.start) return { ...cue };
    // Edge TTS may report a tiny cross-fade overlap between adjacent phrases.
    // Audio remains untouched; the display interval is closed at the next
    // provider cue so subtitles and HyperFrames clips remain deterministic.
    const end = Math.max(cue.start + 0.001, next.start);
    return { ...cue, end };
  });
}

function insertPcmSilence(wav: Buffer, insertions: Insertion[]): Buffer {
  if (insertions.length === 0) return wav;
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("Narration WAV is not a RIFF/WAVE file");
  let offset = 12;
  let dataOffset = -1;
  let dataSize = 0;
  let sampleRate = 0;
  let blockAlign = 0;
  let audioFormat = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      audioFormat = wav.readUInt16LE(offset + 8);
      sampleRate = wav.readUInt32LE(offset + 12);
      blockAlign = wav.readUInt16LE(offset + 20);
    }
    if (id === "data") { dataOffset = offset + 8; dataSize = size; break; }
    offset += 8 + size + (size % 2);
  }
  if (audioFormat !== 1 || dataOffset < 0 || sampleRate <= 0 || blockAlign <= 0) throw new Error("Narration WAV must be uncompressed PCM");
  const data = wav.subarray(dataOffset, dataOffset + dataSize);
  const grouped = new Map<number, number>();
  for (const item of insertions) {
    const frame = Math.max(0, Math.min(Math.floor(data.length / blockAlign), Math.round(item.position * sampleRate)));
    grouped.set(frame, (grouped.get(frame) ?? 0) + item.seconds);
  }
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const [frame, seconds] of [...grouped.entries()].sort(([a], [b]) => a - b)) {
    const byte = frame * blockAlign;
    chunks.push(data.subarray(cursor, byte));
    chunks.push(Buffer.alloc(Math.round(seconds * sampleRate) * blockAlign));
    cursor = byte;
  }
  chunks.push(data.subarray(cursor));
  const expanded = Buffer.concat(chunks);
  const prefix = Buffer.from(wav.subarray(0, dataOffset));
  prefix.writeUInt32LE(expanded.length, dataOffset - 4);
  const suffix = wav.subarray(dataOffset + dataSize + (dataSize % 2));
  const result = Buffer.concat([prefix, expanded, suffix]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

export async function applyProjectTiming(jobRoot: string, project: VideoProject, spec: RenderSpec): Promise<{ cues: TimedCue[]; insertedSeconds: number }> {
  const insertions: Insertion[] = [];
  const sceneById = new Map(project.scenes.map((scene) => [scene.id, scene]));
  for (const range of spec.sceneCueRanges) {
    const timing = sceneById.get(range.sceneId)?.timing;
    if (timing?.preHoldSeconds) insertions.push({ position: range.start, seconds: timing.preHoldSeconds, kind: "pre" });
    if (timing?.postHoldSeconds) insertions.push({ position: range.end, seconds: timing.postHoldSeconds, kind: "post" });
  }
  const insertedSeconds = insertions.reduce((sum, item) => sum + item.seconds, 0);
  const shifted = shiftCues(spec.narrationCues, insertions);
  const displayCues = normalizeTimedCueOverlaps(shifted);
  const audioDir = join(jobRoot, "assets", "audio", project.regionId);
  const wavPath = join(audioDir, "narration.wav");
  if (insertions.length && existsSync(wavPath)) await writeFile(wavPath, insertPcmSilence(await readFile(wavPath), insertions));
  await writeFile(join(audioDir, "narration-edge.srt"), serializeSrt(shifted), "utf8");
  const captionBase = join(jobRoot, "apps", "video-compositor", "captions", project.regionId);
  let protectedPhrases: string[] = [];
  if (existsSync(`${captionBase}.json`)) {
    const current = JSON.parse(await readFile(`${captionBase}.json`, "utf8")) as { protectedPhrases?: string[] };
    protectedPhrases = current.protectedPhrases ?? [];
  }
  await Promise.all([
    writeFile(`${captionBase}.json`, JSON.stringify({ regionId: project.regionId, protectedPhrases, cues: displayCues }, null, 2), "utf8"),
    writeFile(`${captionBase}.srt`, serializeSrt(displayCues), "utf8"),
    writeFile(`${captionBase}.vtt`, serializeVtt(displayCues), "utf8")
  ]);
  const durationPath = join(audioDir, "duration.json");
  if (existsSync(durationPath)) {
    const duration = JSON.parse(await readFile(durationPath, "utf8")) as Record<string, unknown> & {
      durationSeconds?: number;
      timelineDurationSeconds?: number;
      outroPause?: Record<string, unknown> & { applied?: boolean; outroCueIndex?: number };
    };
    duration.durationSeconds = Number(duration.durationSeconds ?? spec.narrationDurationSeconds) + insertedSeconds;
    duration.timelineDurationSeconds = Math.ceil(duration.durationSeconds + project.template.openingDescentSeconds);
    duration.studioTiming = { insertedSeconds, insertions };
    if (duration.outroPause?.applied) {
      const childRanges = spec.sceneCueRanges.filter((range) => sceneById.get(range.sceneId)?.section === "child");
      const lastChild = childRanges.at(-1);
      const outroRange = spec.sceneCueRanges.find((range) => sceneById.get(range.sceneId)?.section === "outro");
      const shiftedLastChild = lastChild ? shifted[lastChild.cueEndIndex] : undefined;
      // The narration generator owns the canonical outro cue index. A Studio
      // project may split or delete overview scenes, so deriving this value
      // again from scene-to-cue ranges can point at a different cue and leave
      // duration.json inconsistent with the SRT we just rewrote.
      const metadataOutroCueIndex = Number(duration.outroPause.outroCueIndex);
      const shiftedOutro = Number.isInteger(metadataOutroCueIndex)
        ? shifted[metadataOutroCueIndex]
        : outroRange ? shifted[outroRange.cueStartIndex] : undefined;
      if (shiftedLastChild) {
        duration.outroPause.insertionAtSeconds = shiftedLastChild.end;
        duration.outroPause.lastChildNarrationEndSeconds = shiftedLastChild.end;
      }
      if (shiftedOutro) {
        duration.outroPause.outroNarrationStartSeconds = shiftedOutro.start;
        duration.outroPause.returnWindowSeconds = shiftedLastChild ? shiftedOutro.start - shiftedLastChild.end : project.template.tourReturnSeconds;
      }
    }
    await writeFile(durationPath, JSON.stringify(duration, null, 2), "utf8");
  }
  return { cues: shifted, insertedSeconds };
}

export async function writeSubtitleOverrides(jobRoot: string, project: VideoProject, spec: RenderSpec): Promise<void> {
  // The render spec already decided the caption lines: it honours an editor's
  // newlines in `scene.subtitle`, and otherwise breaks on punctuation. Without
  // this file the compositor re-divides each narration cue by character count,
  // which sliced words and names in half (「一进门满 / 檐」, 「陈兰 / 彬」).
  // Visual windows still key off the untouched narration cues, so only the
  // caption text changes here.
  const displayCues = spec.subtitleCues;
  const cues = spec.narrationCues;
  const perCue: string[][] = cues.map(() => []);
  let displayIndex = 0;
  for (let cueIndex = 0; cueIndex < cues.length; cueIndex += 1) {
    const cue = cues[cueIndex]!;
    while (displayIndex < displayCues.length) {
      const line = displayCues[displayIndex]!;
      if (line.start >= cue.end - 0.002) break;
      perCue[cueIndex]!.push(line.text);
      displayIndex += 1;
    }
  }
  const overrides = perCue
    .map((chunks, cueIndex) => ({ cueIndex, chunks }))
    .filter((item) => item.chunks.length > 1);
  const path = join(jobRoot, "content", "subtitle-overrides", `${project.regionId}-${project.output.profile}.json`);
  await mkdir(join(jobRoot, "content", "subtitle-overrides"), { recursive: true });
  await writeFile(path, JSON.stringify({ regionId: project.regionId, profile: project.output.profile, cues: overrides }, null, 2), "utf8");
}
