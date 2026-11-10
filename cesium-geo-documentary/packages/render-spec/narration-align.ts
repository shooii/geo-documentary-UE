/**
 * 讯飞在线合成只返回音频，没有句级时间戳，字幕时间轴只能从文本和音频里推。
 *
 * 纯字数比例的问题不是"平均而言不准"，而是**每段内部锯齿**：一段 110 字的话里，
 * 六个真实停顿每个 0.5–0.75 s，按字数只分到 0.23 s，后半段字幕一路提前 2 s。
 * 中文朗读在句号处一定会停，所以这些停顿就是比例想猜的那个真相。
 *
 * 这个模块只做纯计算（不碰文件、不跑 ffmpeg），由调用方把 `silencedetect` 测到的
 * 停顿中点传进来；可以单独测试。
 */

/** 收在句末、却会被标点切到下一句开头的成对符号。 */
const TRAILING_CLOSERS = /^[”’」』）】》]+/u;

/** 把一段旁白切成"朗读员会换气"的句子。 */
export function splitNarrationSentences(text: string): string[] {
  const parts = text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[。！？；;…])/u))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  // 稿子里的「…脊梁！」是带引号的，按感叹号切完，引号会落到下一句开头——
  // 那会变成一条只有「”」的空字幕（440882112 第一场实测停 2.7 秒），或者让
  // 下一句以引号开头。收尾符号并回上一句，剩下没有可念字的碎片也并回去。
  const sentences: string[] = [];
  for (const part of parts) {
    let current = part;
    if (sentences.length > 0) {
      const closers = current.match(TRAILING_CLOSERS);
      if (closers) {
        sentences[sentences.length - 1] += closers[0];
        current = current.slice(closers[0].length);
      }
    }
    if (!current) continue;
    if (sentences.length > 0 && !/[\p{L}\p{N}]/u.test(current)) sentences[sentences.length - 1] += current;
    else sentences.push(current);
  }
  return sentences;
}

export interface CueBoundaryOptions {
  /** 首句之前留白，默认 0.1 s。 */
  startPadding?: number;
  /** 末句之后留白，默认 0.15 s。 */
  endPadding?: number;
  /** 吸附搜索半径：超过这个距离的停顿不算"这一句的结尾"，默认 2.5 s。 */
  snapRadius?: number;
  /** 两句之间至少隔多久，默认 0.2 s。 */
  minCueSeconds?: number;
}

/**
 * 返回每句的结束时间（长度与 `weights` 相同，单调递增，最后一条等于总时长减尾部留白）。
 *
 * `pauses` 是停顿中点（秒），可以为空——没有停顿信息时退化为纯字数比例，
 * 也就是这个函数在引入静音检测之前的行为。
 */
export function alignCueBoundaries(weights: number[], duration: number, pauses: number[] = [], options: CueBoundaryOptions = {}): number[] {
  const startPadding = options.startPadding ?? 0.1;
  const endPadding = options.endPadding ?? 0.15;
  const snapRadius = options.snapRadius ?? 2.5;
  const minCueSeconds = options.minCueSeconds ?? 0.2;
  if (weights.length === 0) return [];
  const totalWeight = weights.reduce((sum, value) => sum + Math.max(1, value), 0);
  const usable = Math.max(1, duration - startPadding - endPadding);
  const ends: number[] = [];
  let cursor = startPadding;
  for (const weight of weights) {
    cursor += usable * Math.max(1, weight) / totalWeight;
    ends.push(cursor);
  }
  ends[ends.length - 1] = Math.max(startPadding + 0.25, duration - endPadding);
  if (pauses.length === 0) return ends;

  // 按顺序吸附，一个停顿只用一次：贪心即可，因为边界天然单调、停顿也单调。
  let used = 0;
  let previous = startPadding;
  for (let index = 0; index < ends.length - 1; index += 1) {
    const target = ends[index]!;
    let best = -1;
    let bestDistance = Infinity;
    for (let candidate = used; candidate < pauses.length; candidate += 1) {
      const at = pauses[candidate]!;
      if (at > target + snapRadius) break;
      if (at < previous + minCueSeconds + 0.15) continue;
      const distance = Math.abs(at - target);
      if (distance < bestDistance) { best = candidate; bestDistance = distance; }
    }
    if (best >= 0 && bestDistance <= snapRadius) {
      previous = pauses[best]!;
      used = best + 1;
      ends[index] = previous;
    } else {
      previous = Math.max(previous + minCueSeconds, target);
      ends[index] = previous;
    }
  }
  return ends;
}
