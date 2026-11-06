import { createHash } from "node:crypto";

export interface NarrationCue {
  start: number;
  end: number;
  text: string;
}

export interface TourOutroPausePlan {
  outroCueIndex: number;
  hasClosingNarration: boolean;
  insertionAtSeconds: number;
  insertedSeconds: number;
  lastChildNarrationEndSeconds: number;
  rawOutroNarrationStartSeconds: number | null;
  outroNarrationStartSeconds: number | null;
  returnWindowSeconds: number;
}

export const DEFAULT_TOUR_RETURN_SECONDS = 4.4;

function roundToSrtMilliseconds(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

export function stableNarrationTextHash(input: string): string {
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

export function parseSrtTimestamp(value: string): number {
  const match = value.trim().match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!match) throw new Error(`Invalid SRT timestamp ${value}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

export function formatSrtTimestamp(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
  const secs = Math.floor(milliseconds % 60_000 / 1000);
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function parseSrt(value: string): NarrationCue[] {
  const normalized = value.replace(/^\uFEFF/, "").trim();
  if (!normalized) return [];
  return normalized.split(/\r?\n\r?\n/).flatMap((block) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 3 || !lines[1]?.includes("-->")) return [];
    const [startRaw, endRaw] = lines[1].split("-->").map((item) => item.trim());
    if (!startRaw || !endRaw) throw new Error(`Invalid SRT timing line ${lines[1]}`);
    return [{
      start: parseSrtTimestamp(startRaw),
      end: parseSrtTimestamp(endRaw),
      text: lines.slice(2).join("")
    }];
  });
}

export function serializeSrt(cues: NarrationCue[]): string {
  const blocks = cues.map((cue, index) => [
    String(index + 1),
    `${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}`,
    cue.text
  ].join("\n"));
  return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
}

export function normalizeTourReturnSeconds(value: number | undefined): number {
  const seconds = value ?? DEFAULT_TOUR_RETURN_SECONDS;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 30) {
    throw new Error(`tourReturnSeconds must be greater than 0 and no more than 30; received ${String(value)}`);
  }
  return seconds;
}

export function planTourOutroPause(
  cues: NarrationCue[],
  introCueCount: number,
  childCueCount: number,
  insertedSeconds: number
): TourOutroPausePlan {
  if (!Number.isInteger(introCueCount) || introCueCount < 0) {
    throw new Error(`introCueCount must be a non-negative integer; received ${introCueCount}`);
  }
  if (!Number.isInteger(childCueCount) || childCueCount <= 0) {
    throw new Error(`childCueCount must be a positive integer; received ${childCueCount}`);
  }
  const pauseSeconds = normalizeTourReturnSeconds(insertedSeconds);
  const outroCueIndex = introCueCount + childCueCount;
  const lastChildCue = cues[outroCueIndex - 1];
  const firstOutroCue = cues[outroCueIndex];
  if (!lastChildCue) {
    throw new Error(`Narration has no cue for the final child at index ${outroCueIndex - 1}`);
  }
  if (!firstOutroCue) {
    const insertionAtSeconds = roundToSrtMilliseconds(lastChildCue.end);
    return {
      outroCueIndex,
      hasClosingNarration: false,
      insertionAtSeconds,
      insertedSeconds: pauseSeconds,
      lastChildNarrationEndSeconds: insertionAtSeconds,
      rawOutroNarrationStartSeconds: null,
      outroNarrationStartSeconds: null,
      returnWindowSeconds: pauseSeconds
    };
  }
  const cueOverlapSeconds = lastChildCue.end - firstOutroCue.start;
  if (cueOverlapSeconds > 0.25) {
    throw new Error(`The first outro cue overlaps the final child cue by ${cueOverlapSeconds.toFixed(3)}s`);
  }
  const lastChildNarrationEndSeconds = Math.min(lastChildCue.end, firstOutroCue.start);
  const outroNarrationStartSeconds = roundToSrtMilliseconds(firstOutroCue.start + pauseSeconds);
  return {
    outroCueIndex,
    hasClosingNarration: true,
    insertionAtSeconds: firstOutroCue.start,
    insertedSeconds: pauseSeconds,
    lastChildNarrationEndSeconds,
    rawOutroNarrationStartSeconds: firstOutroCue.start,
    outroNarrationStartSeconds,
    returnWindowSeconds: roundToSrtMilliseconds(outroNarrationStartSeconds - lastChildNarrationEndSeconds)
  };
}

export function applyTourOutroPause(
  cues: NarrationCue[],
  plan: TourOutroPausePlan
): NarrationCue[] {
  return cues.map((cue, index) => {
    if (index === plan.outroCueIndex - 1 && cue.end > plan.insertionAtSeconds) {
      return { ...cue, end: plan.insertionAtSeconds };
    }
    return index < plan.outroCueIndex
      ? { ...cue }
      : {
        ...cue,
        start: roundToSrtMilliseconds(cue.start + plan.insertedSeconds),
        end: roundToSrtMilliseconds(cue.end + plan.insertedSeconds)
      };
  });
}
