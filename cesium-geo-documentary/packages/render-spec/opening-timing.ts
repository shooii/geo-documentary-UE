/**
 * 旁白从地图时间线的哪一秒开始说话。
 *
 * 合成器只认一个数：`data/regions/<id>.timeline.json` 里的 `narrationStartSeconds`
 * （没有就按 0 处理），旁白音轨、字幕、以及所有跟着旁白走的镜头都从那里起算。
 * 这个数唯一的写入者是 `build-child-tour.ts`：开场下降保持静音，等父级边界开始
 * 描绘的那一刻才开口，所以它写的是 `开场下降 + 0.35`。
 *
 * 编辑器预览必须用同一个数，否则时间码和字幕起拍点与成片差一个 0.35 s —— 编导会
 * 以为成片错位，回头去改本来是对的时序。以前预览是自己拿 `openingDescentSeconds`
 * 凑的，就是从这里开始和成片分叉的。
 */

/** 父级边界开始描绘、旁白与字幕起拍的偏移，秒。 */
export const PARENT_BOUNDARY_REVEAL_START_SECONDS = 0.35;

export interface NarrationLeadInput {
  /** 方案里配置的开场下降秒数（`template.openingDescentSeconds`）。 */
  descentSeconds: number;
  /** 这个方案是否带下级行政区巡游。只有巡游会在下降之后等边界描绘。 */
  hasChildTour: boolean;
  /**
   * 区域 timeline.json 里实测的 `narrationStartSeconds`。有就以它为准——那是
   * 成片真正用的数；没有（timeline 还没生成，或是旧方案）才按规则推算。
   */
  timelineNarrationStartSeconds?: number | null | undefined;
}

export function compositionNarrationLeadSeconds(input: NarrationLeadInput): number {
  const measured = Number(input.timelineNarrationStartSeconds ?? NaN);
  if (Number.isFinite(measured) && measured > 0) return measured;
  // 普通方案的地图时间线里没有开场留白，旁白从 0 秒起，与下降同时进行。
  if (!input.hasChildTour) return 0;
  const descent = Number(input.descentSeconds);
  return (Number.isFinite(descent) && descent > 0 ? descent : 0) + PARENT_BOUNDARY_REVEAL_START_SECONDS;
}
