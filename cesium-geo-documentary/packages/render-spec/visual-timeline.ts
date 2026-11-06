/**
 * Where each picture actually sits in the film.
 *
 * Two things used to live only inside different executables:
 *
 *  - `render-engine.ts` decided which fields to hand the compositor
 *    (`notBeforeNarrationSeconds`, a clamped `minimumDisplaySeconds`).
 *  - `compose-hyperframes.ts` turned those fields into start/end seconds with
 *    `max(cueEnd + tail, start + minimum)`, capped by the scene boundary.
 *
 * The editor never saw either, so an operator could only learn what the film
 * would do by exporting it and watching. This module is the third consumer, and
 * the one place both sides are described: `planVisualClip()` reproduces what the
 * export hands over, `resolveVisualClipWindow()` reproduces what the compositor
 * makes of it. The timeline panel renders exactly these numbers, so a card that
 * crosses its scene boundary shows up before anyone spends two hours rendering.
 *
 * Keep `resolveVisualClipWindow()` in step with `resolveVisualClip()` in
 * `.agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts`;
 * `tests/visual-timeline.test.ts` fails if the compositor's formula drifts.
 */

/** Narration starts with the boundary pen-down; hold the map alone long enough to read it. */
export const OPENING_VISUAL_DELAY_SECONDS = 2.8;
/** The compositor refuses a clip shorter than this. */
export const MINIMUM_RENDERED_VISUAL_SECONDS = 0.5;
/** A child photo waits for the camera to finish its flight before it may appear. */
export const CHILD_FLIGHT_SECONDS = { min: 3.2, max: 5.4 } as const;

export interface VisualClipRange {
  start: number;
  end: number;
}

export interface VisualClipPlacement {
  leadSeconds?: number;
  tailSeconds?: number;
  minimumDisplaySeconds?: number;
}

export interface VisualClipPlanInput {
  scene: {
    id: string;
    section?: string;
    timing?: { mapHoldSeconds?: number };
  };
  placement: VisualClipPlacement;
  range?: VisualClipRange;
  sequenceIndex: number;
  openingSceneId?: string;
  openingDelaySeconds?: number;
  /** Absent when the asset has no resolved cue; the scene window is used instead. */
  cueStartSeconds?: number;
  cueEndSeconds?: number;
}

export interface VisualClipPlan {
  /** Absolute (presentation-relative) seconds, matching the manifest fields. */
  notBeforeNarrationSeconds?: number;
  notAfterNarrationSeconds?: number;
  /** What the operator configured, kept so the UI can say "13.5 s clamped to 4.4 s". */
  configuredMinimumSeconds: number;
  minimumDisplaySeconds: number;
  /** The whole window the scene leaves for this picture, before splitting it across a sequence. */
  availableSeconds?: number;
  sequenceCount?: number;
  sequenceIndex: number;
}

export interface VisualClipWindow {
  startSeconds: number;
  endSeconds: number;
  hardEndSeconds: number;
  /** True when the scene boundary, not the cue, decided the end. */
  truncatedByScene: boolean;
}

/**
 * A picture may not outlive its own scene.
 *
 * The composition computes a clip's end as
 * `max(cueEnd + tail, start + minimumDisplaySeconds)`, so a "minimum display"
 * longer than the scene itself decides the end. One opening card asked for
 * 13.5 s inside a 7.24 s scene: the clip ran 9 s past its scene and covered the
 * two scenes after it, which is why a scene that owned no picture showed a
 * neighbour's photo. Clamping the minimum to the window the scene actually
 * offers leaves `notAfterNarrationSeconds` in charge.
 */
export function clampMinimumDisplaySeconds(configuredSeconds: number, availableSeconds?: number): number {
  const configured = Math.max(0.1, Number(configuredSeconds) || 0.1);
  if (availableSeconds === undefined || !Number.isFinite(availableSeconds)) return configured;
  return Math.min(configured, Math.max(0.1, availableSeconds));
}

/** How long the camera needs before a child photo may appear in its own scene. */
export function childFlightSeconds(sceneDurationSeconds: number, mapHoldSeconds: number): number {
  return Math.min(CHILD_FLIGHT_SECONDS.max, Math.max(CHILD_FLIGHT_SECONDS.min, sceneDurationSeconds - mapHoldSeconds));
}

/**
 * The manifest fields for one picture — the same numbers `writeVisualsManifest()`
 * writes into `content/visuals/<region>.json`, computed without a sandbox.
 */
export function planVisualClip(input: VisualClipPlanInput): VisualClipPlan {
  const { scene, placement, range, sequenceIndex } = input;
  const rangeLength = range ? Math.max(0, range.end - range.start) : 0;
  const openingDelay = input.openingDelaySeconds ?? OPENING_VISUAL_DELAY_SECONDS;
  const flight = scene.section === "child"
    ? childFlightSeconds(rangeLength, Number(scene.timing?.mapHoldSeconds ?? 2))
    : 0;
  const notBeforeNarrationSeconds = scene.id === input.openingSceneId && range
    ? range.start + openingDelay
    : scene.section === "child" && range
    ? range.start + flight
    : range && sequenceIndex === 0
    ? range.start
    : undefined;
  const cueStartSeconds = range ? input.cueStartSeconds ?? range.start : undefined;
  const resolvedStartSeconds = range && cueStartSeconds !== undefined
    ? Math.max(cueStartSeconds - Number(placement.leadSeconds ?? 0.3), notBeforeNarrationSeconds ?? 0)
    : undefined;
  const availableSeconds = range && resolvedStartSeconds !== undefined
    ? Math.max(0.1, range.end - resolvedStartSeconds)
    : undefined;
  const configuredMinimumSeconds = Number(placement.minimumDisplaySeconds ?? 0.1);
  return {
    ...(notBeforeNarrationSeconds !== undefined ? { notBeforeNarrationSeconds } : {}),
    ...(range ? { notAfterNarrationSeconds: range.end } : {}),
    configuredMinimumSeconds,
    minimumDisplaySeconds: clampMinimumDisplaySeconds(configuredMinimumSeconds, availableSeconds),
    ...(availableSeconds !== undefined ? { availableSeconds } : {}),
    sequenceIndex
  };
}

export interface VisualClipWindowInput {
  cueStartSeconds: number;
  cueEndSeconds: number;
  leadSeconds?: number;
  tailSeconds?: number;
  minimumDisplaySeconds?: number;
  notBeforeNarrationSeconds?: number;
  notAfterNarrationSeconds?: number;
  sequenceIndex?: number;
  sequenceCount?: number;
}

/**
 * The start/end the compositor will use, given the manifest fields.
 *
 * Mirrors `resolveVisualClip()` in `compose-hyperframes.ts` line for line: the
 * cue-driven start pushed out by `notBefore`, the natural end from the last cue
 * plus `tail`, the minimum display floor, and the scene boundary as a hard cap.
 * 多图按每张图自己的 cue、lead 与 notBefore 窗口切片，最后一张取该窗口余量。
 * 不同图片的窗口可能不同，切口会重叠或留空；自然 cue 提前结束时也不会填满场景。
 *
 * It takes cue seconds in the same space as the boundary fields (relative to
 * narration start); the caller adds `narrationStartSeconds` when rendering.
 */
export function resolveVisualClipWindow(input: VisualClipWindowInput): VisualClipWindow {
  const leadSeconds = input.leadSeconds ?? 0.3;
  const tailSeconds = input.tailSeconds ?? 0.24;
  const cueDrivenStart = Math.max(0, input.cueStartSeconds - leadSeconds);
  const notBefore = Math.max(0, Number(input.notBeforeNarrationSeconds ?? 0));
  const startSeconds = Math.max(cueDrivenStart, notBefore);
  const hardEndSeconds = input.notAfterNarrationSeconds === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Number(input.notAfterNarrationSeconds));
  const naturalEnd = Math.min(hardEndSeconds, input.cueEndSeconds + tailSeconds);
  const minimumEnd = startSeconds + Math.max(0.1, Number(input.minimumDisplaySeconds ?? 0.1));
  let endSeconds = Math.min(hardEndSeconds, Math.max(naturalEnd, minimumEnd));
  let sequenceStart = startSeconds;
  const sequenceCount = Math.max(1, Math.floor(Number(input.sequenceCount || 1)));
  const sequenceIndex = Math.max(0, Math.min(sequenceCount - 1, Math.floor(Number(input.sequenceIndex || 0))));
  if (sequenceCount > 1) {
    const sequenceEnd = Math.min(hardEndSeconds, Math.max(sequenceStart + 0.1, naturalEnd));
    const slice = Math.max(0.1, (sequenceEnd - sequenceStart) / sequenceCount);
    sequenceStart += slice * sequenceIndex;
    endSeconds = sequenceIndex === sequenceCount - 1 ? sequenceEnd : sequenceStart + slice;
  }
  return {
    startSeconds: sequenceStart,
    endSeconds,
    hardEndSeconds,
    // The card stops exactly at the boundary, so the scene — not the cue and not
    // the configured minimum — decided where it ends.
    truncatedByScene: Number.isFinite(hardEndSeconds) && endSeconds >= hardEndSeconds - 1e-6
  };
}
