import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSingleLineCues,
  subtitleAlignmentReport,
  subtitleHighlightPointsFromWords,
  type WordTiming
} from "../packages/content-engine/subtitles.js";
import { smoothHighlightSegments } from "../packages/content-engine/subtitle-motion.js";

/** 模拟渲染端在相邻节点之间对 progress 做线性插值。 */
function progressAt(points: ReadonlyArray<{ time: number; progress: number }>, time: number): number {
  if (!points.length) return 0;
  if (time <= points[0]!.time) return points[0]!.progress;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const next = points[index]!;
    if (time < next.time) {
      const fraction = next.time <= previous.time ? 1 : (time - previous.time) / (next.time - previous.time);
      return previous.progress + (next.progress - previous.progress) * fraction;
    }
  }
  return points.at(-1)!.progress;
}

const word = (start: number, end: number, text: string): WordTiming => ({ start, end, text });

function smoothProgressAt(points: ReadonlyArray<{ time: number; progress: number }>, time: number): number {
  const segments = smoothHighlightSegments(points);
  const segment = segments.find(s => time <= s.end) ?? segments.at(-1);
  if (!segment || time <= segment.start) return segment?.from ?? 0;
  const p = Math.min(1, (time - segment.start) / (segment.end - segment.start));
  const [a,b,c] = segment.ease;
  return segment.from + (segment.to - segment.from) * (a*p*p*p + b*p*p + c*p);
}

test("词内曲线以真实词首词尾为锚并保持连续单调", () => {
  const points = [
    {time: 0, progress: 0}, {time: .08, progress: .12}, {time: .21, progress: .28},
    {time: .45, progress: .28}, {time: .52, progress: .54}, {time: .66, progress: .70}, {time: .82, progress: 1}
  ];
  const segs = smoothHighlightSegments(points);
  assert.equal(smoothProgressAt(points, 0), 0);
  assert.equal(smoothProgressAt(points, .21), .28);
  assert.equal(smoothProgressAt(points, .45), .28, "词间静音保持原进度");
  assert.equal(smoothProgressAt(points, .82), 1, "句尾仍严格落在词时间终点");
  for (let i=1;i<=160;i++) assert.ok(smoothProgressAt(points, .82*i/160) >= smoothProgressAt(points, .82*(i-1)/160)-1e-9);
  for (let i=0;i<segs.length-1;i++) {
    const left=segs[i]!, right=segs[i+1]!;
    assert.ok(Math.abs(left.ease[0]+left.ease[1]+left.ease[2]-1) < 1e-9, "相邻段首尾命中真实锚点");
    const outgoing=(left.to-left.from)/(left.end-left.start)*(3*left.ease[0]+2*left.ease[1]+left.ease[2]);
    const incoming=(right.to-right.from)/(right.end-right.start)*right.ease[2];
    assert.ok(Math.abs(outgoing-incoming)<1e-8, "词段连接处速度连续，不能突然跳速");
  }
});

test("数字按字符对齐，不再把 UTF16 下标当作语音单元数组下标", () => {
  const words = [
    word(0, 0.4, "常住"),
    word(0.4, 0.8, "人口"),
    word(0.8, 2.0, "42104"),
    word(2.0, 2.3, "人")
  ];
  const points = subtitleHighlightPointsFromWords("常住人口42104人", 0, 2.5, words);
  assert.ok(points, "文本与词表应能按顺序对齐");
  // 5 个汉字 + 5 个半角数字：数字读完时累计宽度 6.5 / 7.5。
  assert.ok(Math.abs(progressAt(points, 2.0) - 6.5 / 7.5) < 1e-6, `数字读完时的进度不对: ${progressAt(points, 2.0)}`);
  assert.equal(points.at(-1)!.progress, 1);
  for (let index = 1; index < points.length; index += 1) {
    assert.ok(points[index]!.time > points[index - 1]!.time, "节点时间必须严格递增");
  }
});

test("词间静音期间金色擦出保持不动，停顿不会继续扫", () => {
  const words = [word(0, 0.3, "甲"), word(1.0, 1.3, "乙"), word(2.0, 2.3, "丙")];
  const points = subtitleHighlightPointsFromWords("甲乙丙", 0, 2.5, words);
  assert.ok(points);
  const atPauseStart = progressAt(points, 0.3);
  assert.ok(Math.abs(atPauseStart - 1 / 3) < 1e-6);
  assert.ok(Math.abs(progressAt(points, 0.6) - atPauseStart) < 1e-9, "第一处停顿应 hold");
  assert.ok(Math.abs(progressAt(points, 0.99) - atPauseStart) < 1e-9, "停顿末尾仍应 hold");
  assert.ok(Math.abs(progressAt(points, 1.3) - 2 / 3) < 1e-6, "第二个词念完才推进");
  assert.ok(Math.abs(progressAt(points, 1.6) - 2 / 3) < 1e-9, "第二处停顿应 hold");
});

test("重复词按顺序各自对齐，不会都命中首个同字词", () => {
  const words = [word(0, 0.2, "看"), word(0.5, 0.7, "看"), word(1.0, 1.2, "看"), word(1.5, 1.7, "看")];
  const points = subtitleHighlightPointsFromWords("看看看看", 0, 2, words);
  assert.ok(points);
  assert.ok(Math.abs(progressAt(points, 0.2) - 0.25) < 1e-6);
  assert.ok(Math.abs(progressAt(points, 0.7) - 0.5) < 1e-6);
  assert.ok(Math.abs(progressAt(points, 1.2) - 0.75) < 1e-6);
  assert.ok(Math.abs(progressAt(points, 1.7) - 1) < 1e-6);
});

test("跨行切词的字符各自继承词内时间，不重新从词首匹配", () => {
  const words = [word(0, 0.5, "窦州"), word(0.6, 0.9, "的"), word(1.0, 1.5, "千年")];
  const display = buildSingleLineCues(
    [{ start: 0, end: 1.6, text: "窦州的千年" }],
    30,
    [],
    [{ cueIndex: 0, chunks: ["窦", "州的千年"] }],
    words
  );
  assert.equal(display.length, 2);
  assert.equal(display[0]!.wordAlignment!.aligned, true);
  assert.equal(display[1]!.wordAlignment!.aligned, true);
  // 「窦」是「窦州」的第一个字符，词内 0~0.5 的线性插值落在 0.25。
  assert.ok(Math.abs(display[0]!.highlight!.at(-1)!.time - 0.25) < 1e-6);
  // 「州」是第二个字符，点亮在 0.5；「千年」的末字收在 1.5。
  assert.ok(display[1]!.highlight!.some((point) => Math.abs(point.time - 0.5) < 0.01));
  assert.ok(Math.abs(display[1]!.highlight!.at(-1)!.time - 1.5) < 1e-6);
});

test("TTS 发音替换导致覆盖不足时严格回退，不做首字冒配", () => {
  const substituted = [word(0, 0.3, "壹"), word(0.3, 0.6, "貳"), word(0.6, 0.9, "叁")];
  assert.equal(subtitleHighlightPointsFromWords("一二三", 0, 1, substituted), null);
  // 只有首字碰巧相同也不能当成匹配上。
  const partial = [word(0, 0.3, "香"), word(0.3, 0.6, "气")];
  assert.equal(subtitleHighlightPointsFromWords("苹果香蕉", 0, 1, partial), null);
});

test("行的出现时机锚定到真实词起点，不因字重插值提前出现", () => {
  const words = [word(2.0, 2.5, "甲"), word(3.0, 3.5, "乙")];
  const display = buildSingleLineCues([{ start: 0, end: 4, text: "甲乙" }], 30, [], [], words);
  assert.ok(Math.abs(display[0]!.start - 2.0) < 1e-6, `行首没有跟随真实词: ${display[0]!.start}`);
  assert.equal(display[0]!.wordAlignment!.aligned, true);
});

test("带停顿的多行字幕：每行窗口单调、金色收在真实词终点", () => {
  const words = [
    word(0.0, 0.3, "甲"), word(0.3, 0.6, "乙"), word(0.6, 0.9, "丙"),
    word(2.0, 2.3, "丁"), word(2.3, 2.6, "戊"), word(2.6, 2.9, "己")
  ];
  const display = buildSingleLineCues(
    [{ start: 0, end: 3.2, text: "甲乙丙丁戊己" }],
    30,
    [],
    [{ cueIndex: 0, chunks: ["甲乙丙", "丁戊己"] }],
    words
  );
  assert.equal(display.length, 2);
  assert.ok(display[1]!.start >= display[0]!.end - 1e-9);
  assert.ok(Math.abs(display[0]!.highlight!.at(-1)!.time - 0.9) < 1e-6);
  assert.ok(Math.abs(display[1]!.highlight!.at(-1)!.time - 2.9) < 1e-6);
  assert.ok(display[0]!.wordAlignment!.firstWordStart! < display[1]!.wordAlignment!.firstWordStart!);
});

test("对齐诊断报告给出覆盖率，便于导出后验收", () => {
  const words = [word(0, 0.3, "甲"), word(0.5, 0.8, "乙")];
  const display = buildSingleLineCues([{ start: 0, end: 1, text: "甲乙" }], 30, [], [], words);
  const report = subtitleAlignmentReport(display);
  assert.equal(report.totalCues, 1);
  assert.equal(report.alignedCues, 1);
  assert.equal(report.fallbackCues, 0);
  assert.equal(report.totalChars, 2);
  assert.equal(report.matchedChars, 2);
  assert.ok(Math.abs(report.coverage - 1) < 1e-9);
  assert.equal(report.rows[0]!.wordCount, 2);
});

test("没有词表时保持字重插值兼容，并标记为回退", () => {
  const display = buildSingleLineCues([{ start: 0, end: 2, text: "甲乙丙丁" }], 30);
  assert.equal(display.length, 1);
  assert.equal(display[0]!.wordAlignment!.aligned, false);
  assert.equal(display[0]!.wordAlignment!.coverage, 0);
  assert.equal(display[0]!.highlight!.at(-1)!.progress, 1);
});

// 回归护栏：buildSingleLineCues 曾丢弃 alignTextToWords 返回的推进后 cursor，
// 让每条 cue 都从词表第 0 个词重新匹配。单条 cue 的用例拦不住它（第一条恰好
// 对得上）；只有两条以上连续、文本各异的 cue 才会暴露——第二条之后全部回退。
test("连续两条不同 cue 各自对齐到自己的词段（跨 cue 游标必须推进）", () => {
  const words = [
    word(0, 0.4, "甲"), word(0.5, 0.9, "乙"),
    word(1.0, 1.4, "丙"), word(1.5, 1.9, "丁")
  ];
  const display = buildSingleLineCues(
    [
      { start: 0, end: 0.95, text: "甲乙" },
      { start: 1.0, end: 1.95, text: "丙丁" }
    ],
    30, [], [], words
  );
  assert.equal(display.length, 2);
  const report = subtitleAlignmentReport(display);
  assert.equal(report.fallbackCues, 0, "两条都必须对齐；若 cursor 未回写，第二条会 fallback");
  assert.equal(report.alignedCues, 2);
  assert.ok(Math.abs(report.coverage - 1) < 1e-9);
  assert.equal(display[0]!.wordAlignment!.wordCount, 2);
  assert.equal(display[1]!.wordAlignment!.wordCount, 2);
  // 第二条必须命中「丙丁」的真实时间（1.0~1.9），而不是词首「甲乙」的 0~0.9。
  assert.ok(display[1]!.highlight!.some((point) => Math.abs(point.time - 1.4) < 1e-6));
  assert.ok(Math.abs(display[1]!.highlight!.at(-1)!.time - 1.9) < 1e-6);
  assert.ok(display[1]!.highlight!.every((point) => point.time >= 0.99), "第二段不得出现 <1s 的词首时间");
});

test("连续三条不同 cue 逐段推进游标，覆盖率保持满值", () => {
  const words = [
    word(0, 0.3, "甲"), word(0.4, 0.7, "乙"),
    word(0.8, 1.1, "丙"), word(1.2, 1.5, "丁"),
    word(1.6, 1.9, "戊"), word(2.0, 2.3, "己")
  ];
  const display = buildSingleLineCues(
    [
      { start: 0, end: 0.75, text: "甲乙" },
      { start: 0.8, end: 1.55, text: "丙丁" },
      { start: 1.6, end: 2.35, text: "戊己" }
    ],
    30, [], [], words
  );
  const report = subtitleAlignmentReport(display);
  assert.equal(report.totalCues, 3);
  assert.equal(report.alignedCues, 3);
  assert.equal(report.fallbackCues, 0);
  assert.ok(Math.abs(report.coverage - 1) < 1e-9);
  assert.deepEqual(display.map((cue) => cue.wordAlignment!.wordCount), [2, 2, 2]);
  assert.ok(Math.abs(display[2]!.highlight!.at(-1)!.time - 2.3) < 1e-6, "第三段收在「己」的真实词尾");
});
