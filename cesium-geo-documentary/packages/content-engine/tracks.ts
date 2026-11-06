/**
 * Track bands for the HyperFrames composition.
 *
 * HyperFrames' `overlapping_clips_same_track` lint refuses to render two clips
 * whose windows intersect on one `data-track-index`, and the Studio preflight
 * turns that lint error into a hard export failure. The bands below therefore
 * have to be disjoint *for every count the composition can produce*, not just
 * for today's data.
 *
 * They were not. Visuals used `20 + index` and music beds `70 + index`, so the
 * 51st selected visual landed on track 70 — the first music bed — and 城月镇
 * (61 selected visuals) died at the preflight with "Track 80: clip ending at
 * 511.6s overlaps with clip starting at 489.548s", which reads like a timing
 * bug and is really two different clip families sharing a number. The cover
 * used 100, which would have collided with the 81st visual next.
 *
 * The fix is to give each family a base far apart, so the guarantee is
 * arithmetic rather than a promise to keep the counts small: visuals count in
 * the hundreds at most, and 40 000 tracks of headroom is more than enough.
 */
export const COMPOSITION_TRACKS = {
  /** The Cesium map video, underneath everything. */
  map: 0,
  /** The vignette/shade drawn on top of the map. */
  shade: 1,
  /** One subtitle at a time. */
  subtitle: 5,
  /** Narration audio. */
  narration: 6,
  /** The boundary pen-down sound effect. */
  boundaryPen: 7,
  /** Imagery attribution line. */
  imageryCredit: 11,
  /** Visuals: `visualBase + index`. Index is the position in the visual manifest. */
  visualBase: 100,
  /** Music beds: `musicBase + index`. Audio only, so the band sits far above visuals. */
  musicBase: 40_100,
  /** The cover card, shown before the map starts. */
  cover: 80_100
} as const;

/** Track for the visual at `index` in the composed visual list. */
export function visualTrack(index: number): number {
  return COMPOSITION_TRACKS.visualBase + index;
}

/** Track for the music bed at `index`. */
export function musicTrack(index: number): number {
  return COMPOSITION_TRACKS.musicBase + index;
}
