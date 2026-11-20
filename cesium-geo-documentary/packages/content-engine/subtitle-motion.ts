export interface HighlightPoint { time: number; progress: number }
export interface HighlightSegment {
  start: number; end: number; from: number; to: number;
  /** Cubic Hermite ease coefficients: a*p^3 + b*p^2 + c*p. */
  ease: [number, number, number];
}

/** Monotone, C1-continuous interpolation through the original speech anchors.
 * Flat spans remain perfectly flat. No timestamp is shifted or removed.
 */
export function smoothHighlightSegments(points: readonly HighlightPoint[]): HighlightSegment[] {
  if (points.length < 2) return [];
  const h = points.slice(1).map((p, i) => p.time - points[i]!.time);
  if (h.some(v => v <= 0)) throw new Error("Highlight timestamps must increase");
  const d = h.map((v, i) => (points[i + 1]!.progress - points[i]!.progress) / v);
  if (d.some(v => v < 0)) throw new Error("Highlight progress must not decrease");
  const m = points.map(() => 0);
  for (let i = 1; i < points.length - 1; i++) {
    const left = d[i - 1]!, right = d[i]!;
    if (left <= 0 || right <= 0) continue;
    const w1 = 2 * h[i]! + h[i - 1]!, w2 = h[i]! + 2 * h[i - 1]!;
    m[i] = (w1 + w2) / (w1 / left + w2 / right);
  }
  return h.map((duration, i) => {
    const slope = d[i]!;
    if (!slope) return { start: points[i]!.time, end: points[i + 1]!.time,
      from: points[i]!.progress, to: points[i + 1]!.progress, ease: [0, 0, 1] };
    const s = m[i]! / slope, e = m[i + 1]! / slope;
    return { start: points[i]!.time, end: points[i + 1]!.time,
      from: points[i]!.progress, to: points[i + 1]!.progress,
      ease: [s + e - 2, 3 - 2 * s - e, s] };
  });
}

/** Shared by production compositor and browser verification. A trailing feather
 * softens the gold front without painting any pixels ahead of its timed edge.
 */
export const GOLD_WASH_STYLE = "--gold-edge:0%;clip-path:inset(0 calc(100% - var(--gold-edge)) 0 0);-webkit-mask-image:linear-gradient(to right,#000 0%,#000 calc(var(--gold-edge) - 5px),transparent var(--gold-edge));mask-image:linear-gradient(to right,#000 0%,#000 calc(var(--gold-edge) - 5px),transparent var(--gold-edge))";

export function goldWashAnimation(selector: string, points: readonly HighlightPoint[], offset: number): string {
  if (!points.length) return "";
  const q = JSON.stringify(selector);
  const vars = (progress: number) => `"--gold-edge":"${(progress * 100).toFixed(6)}%"`;
  const first = points[0]!, last = points.at(-1)!;
  const segments = smoothHighlightSegments(points);
  const span = last.time - first.time, delta = last.progress - first.progress;
  if (span <= 0 || delta <= 0) return `.set(${q},{${vars(first.progress)}},${(first.time + offset).toFixed(6)})`;
  // One tween owns each row's properties. Many adjacent fromTo tweens can leave
  // stale start values when an offline renderer seeks backwards between samples.
  const rows = segments.map(s => [s.start, s.end, s.from, s.to, ...s.ease]);
  const ease = `p=>{const t=${first.time}+p*${span},ss=${JSON.stringify(rows)};const s=ss.find(x=>t<=x[1])||ss[ss.length-1];const u=Math.max(0,Math.min(1,(t-s[0])/(s[1]-s[0])));return (s[2]+(s[3]-s[2])*(s[4]*u*u*u+s[5]*u*u+s[6]*u)-${first.progress})/${delta};}`;
  return `.fromTo(${q},{${vars(first.progress)}},{${vars(last.progress)},duration:${span.toFixed(6)},ease:${ease},immediateRender:false},${(first.time+offset).toFixed(6)})`;
}
