import assert from "node:assert/strict";
import test from "node:test";
import { shiftCues, type Insertion } from "../apps/studio/render-timing.js";
import { isRetryableRenderFailure } from "../apps/studio/render-engine.js";
import type { TimedCue } from "../packages/render-spec/index.js";

const cue = (start: number, end: number, text = "x"): TimedCue => ({ index: 0, start, end, text });

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

test("阶段看门狗超时是可以重试的失败，冒充成功的退出码不是", () => {
  // A deadlocked stage restarts from the cached narration/map clip; a project error
  // must not be retried three times.
  assert.equal(isRetryableRenderFailure("录制 UE 地图 timed out after 600s"), true);
  assert.equal(isRetryableRenderFailure("导出失败"), false);
  assert.equal(isRetryableRenderFailure("生成或复用正式配音 exited with 1"), true);
  assert.equal(isRetryableRenderFailure("Project configuration is incomplete"), false);
});
