import assert from "node:assert/strict";
import test from "node:test";
import { shiftCues, type Insertion } from "../apps/studio/render-timing.js";
import { isRetryableRenderFailure } from "../apps/studio/render-engine.js";
import { alignCueBoundaries, splitNarrationSentences } from "../packages/render-spec/narration-align.js";
import type { TimedCue } from "../packages/render-spec/index.js";

import { buildSingleLineCues, subtitleHighlightPoints, subtitleSpeechUnits } from "../packages/content-engine/subtitles.js";

const cue = (start: number, end: number, text = "x"): TimedCue => ({ index: 0, start, end, text });

test("数字使用朗读权重，半角显示宽度与音节分开计算", () => {
  assert.equal(subtitleSpeechUnits("400")[0]!.weight, 2);
  assert.equal(subtitleSpeechUnits("400")[0]!.width, 1.5);
  assert.equal(subtitleSpeechUnits("1909年")[0]!.weight, 4);
  assert.equal(subtitleSpeechUnits("1.44")[0]!.weight, 4);
  assert.equal(subtitleSpeechUnits("8,000")[0]!.weight, 2);
  assert.deepEqual(subtitleSpeechUnits("400,500").map((unit) => unit.text), ["400,500"]);
  assert.deepEqual(subtitleSpeechUnits("400,人口").map((unit) => unit.text), ["400", ",", "人", "口"]);
});

test("标点处高亮暂停，句尾标点的停顿不拖慢已读文字", () => {
  const points = subtitleHighlightPoints("甲，乙。", 0, 3.65);
  const pauseStart = points.findIndex((point) => point.progress === 0.5);
  assert.ok(pauseStart > 0);
  assert.equal(points[pauseStart + 1]!.progress, 0.5);
  assert.ok(points[pauseStart + 1]!.time > points[pauseStart]!.time);
  assert.ok(points.find((point) => point.progress === 1)!.time < 3.65);
});

test("标点随前一字平滑点亮，不会在零时长节点突然跳黄", () => {
  const points = subtitleHighlightPoints("甲，乙。", 0, 3.65);
  for (let index = 1; index < points.length; index++) {
    if (points[index]!.progress > points[index - 1]!.progress)
      assert.ok(points[index]!.time > points[index - 1]!.time);
  }
});

test("拆行保留原句标点停顿，末段400在句尾停顿前全部点亮", () => {
  const text = "馆和昌公书局，400。";
  const chunks = buildSingleLineCues([{ start: 10, end: 20, text }], 14, [], [{ cueIndex: 0, chunks: ["馆和昌公书局", "400"] }]);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1]!.start, chunks[0]!.end);
  assert.equal(chunks[1]!.end, 20);
  assert.equal(chunks[1]!.highlight!.at(-1)!.progress, 1);
  assert.ok(chunks[1]!.highlight!.at(-1)!.time < chunks[1]!.end);
});

test("post 静音插在场景结束时，下一场第一句字幕跟着一起后移", () => {
  // A post-hold lands at range.end, which is exactly where the next scene's first cue
  // starts. A strict `<` left that cue in place: the audio had the silence, the caption
  // did not, so the line appeared one hold too early.
  const cues = [cue(0, 4), cue(4, 8)];
  const insertions: Insertion[] = [{ position: 4, seconds: 1.5, kind: "post" }];
  const shifted = shiftCues(cues, insertions);
  assert.equal(shifted[0]!.start, 0);
  assert.equal(shifted[0]!.end, 4, "a cue ending at the insertion point stays before the silence");
  assert.equal(shifted[1]!.start, 5.5, "the cue starting at the insertion point must move with the audio");
  assert.equal(shifted[1]!.end, 9.5);
});

test("pre 静音插在场景开始时，本场第一句整体后移", () => {
  const cues = [cue(0, 3), cue(3, 6)];
  const shifted = shiftCues(cues, [{ position: 3, seconds: 0.8, kind: "pre" }]);
  assert.equal(shifted[0]!.end, 3);
  assert.equal(shifted[1]!.start, 3.8);
  assert.equal(shifted[1]!.end, 6.8);
});

test("多个插入点按位置累计，且不会把同一句平移两次", () => {
  const cues = [cue(0, 2), cue(2, 5), cue(5, 9)];
  const shifted = shiftCues(cues, [
    { position: 2, seconds: 1, kind: "post" },
    { position: 5, seconds: 2, kind: "post" }
  ]);
  assert.deepEqual(shifted.map((item) => [item.start, item.end]), [[0, 2], [3, 6], [8, 12]]);
});

test("插入点正好落在句尾时不延长该句", () => {
  const shifted = shiftCues([cue(1, 5)], [{ position: 5, seconds: 2, kind: "post" }]);
  assert.equal(shifted[0]!.end, 5);
});

test("没有插入点时时间轴原样返回", () => {
  const shifted = shiftCues([cue(1, 2), cue(2, 3)], []);
  assert.deepEqual(shifted.map((item) => [item.start, item.end]), [[1, 2], [2, 3]]);
});

test("没有停顿信息时退化为字数比例，末句仍收在总时长减尾部留白", () => {
  // This is the pre-silencedetect behaviour, kept as the fallback for Edge TTS audio
  // that has no measurable pauses.
  const ends = alignCueBoundaries([5, 5], 10, []);
  assert.ok(Math.abs(ends[0]! - 4.975) < 1e-9, `first half ends mid-way, got ${ends[0]}`);
  assert.equal(ends[1], 9.85);
});

test("边界吸附到实测停顿中点，且保持单调不减", () => {
  // 讯飞 has no sentence timestamps, so the only ground truth is where the speaker
  // actually stopped. Snapping each estimate to the nearest pause removes the drift
  // that accumulates inside a long paragraph.
  const ends = alignCueBoundaries([10, 10, 10], 20, [6.5, 13.2]);
  assert.equal(ends[0], 6.5);
  assert.equal(ends[1], 13.2);
  assert.equal(ends[2], 19.85);
  for (let index = 1; index < ends.length; index += 1) {
    assert.ok(ends[index]! >= ends[index - 1]!, "cue boundaries must never go backwards");
  }
});

test("吸附半径外的停顿不予采纳，不会被远处的静音拽偏", () => {
  const proportional = alignCueBoundaries([10, 10, 10], 20, []);
  const withFarPauses = alignCueBoundaries([10, 10, 10], 20, [0.2, 19.9]);
  assert.deepEqual(withFarPauses, proportional);
});

test("脏停顿数据下边界依然落在合法区间内", () => {
  // Real `silencedetect` output contains duplicates and a trailing pause, and can run
  // past the take. None of that may produce a cue ending after the audio or a zero-width
  // window.
  const ends = alignCueBoundaries([8, 8, 8, 8], 20, [1, 1, 5.5, 6, 12.4, 19.9]);
  assert.equal(ends.length, 4);
  for (const value of ends) {
    assert.ok(value > 0 && value <= 20, `boundary out of range: ${value}`);
  }
  for (let index = 1; index < ends.length; index += 1) {
    assert.ok(ends[index]! - ends[index - 1]! >= 0.2, "adjacent cues must not collapse");
  }
  assert.equal(ends[3], 19.85);
});

test("旁白按朗读换气点切句，不按段落", () => {
  assert.deepEqual(splitNarrationSentences("甲。乙！丙\n丁？"), ["甲。", "乙！", "丙", "丁？"]);
  assert.deepEqual(splitNarrationSentences("  \n\n "), []);
});

test("句末引号不会被切成一条只有标点的空字幕", () => {
  // 稿子里「脊梁！」收在引号里，按标点切完会剩下一个只有「”」的碎片：它会成为
  // 一条在屏幕上停 2.7 秒的空字幕（440882112 第一场实测）。
  assert.deepEqual(splitNarrationSentences("摸到脊梁！”"), ["摸到脊梁！”"]);
  assert.deepEqual(splitNarrationSentences("甲。乙！”丙。"), ["甲。", "乙！”", "丙。"]);
  assert.deepEqual(splitNarrationSentences("（一）。丁"), ["（一）。", "丁"]);
});

test("阶段看门狗超时是可以重试的失败，冒充成功的退出码不是", () => {
  // A deadlocked stage restarts from the cached narration/map clip; a project error
  // must not be retried three times.
  assert.equal(isRetryableRenderFailure("录制 UE 地图 timed out after 600s"), true);
  assert.equal(isRetryableRenderFailure("导出失败"), false);
  assert.equal(isRetryableRenderFailure("生成或复用正式配音 exited with 1"), true);
  assert.equal(isRetryableRenderFailure("Project configuration is incomplete"), false);
});
