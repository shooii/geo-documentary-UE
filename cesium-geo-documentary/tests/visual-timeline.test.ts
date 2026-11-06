import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { planVisualTimeline, type RenderSpec, type RenderSpecAsset } from "../packages/render-spec/index.js";
import { childFlightSeconds, planVisualClip, resolveVisualClipWindow, type VisualClipWindowInput } from "../packages/render-spec/visual-timeline.js";
import type { StudioScene, VideoProject } from "../packages/project-schema/index.js";

function scene(id: string, section: NonNullable<StudioScene["section"]> = "overview", type: StudioScene["type"] = "image-card"): StudioScene {
  return { id, section, type, title: id, narration: id, subtitle: id, duration: 10, assetIds: [], placements: [] };
}

function asset(id: string, sceneId: string, cueIndex: number, selected = true): RenderSpecAsset {
  return {
    id, sceneId, assetId: id, name: id, path: `${id}.jpg`, cueStartIndex: cueIndex, cueEndIndex: cueIndex,
    sourceType: "user-provided", verifiedReal: true, fit: "cover", crop: { x: 0, y: 0, width: 1, height: 1 },
    focalPoint: { x: 0.5, y: 0.5 }, scale: 1, offsetX: 0, offsetY: 0, animation: "still",
    leadSeconds: 0.3, tailSeconds: 0.24, minimumDisplaySeconds: 13.5, requiredKeywords: [], alt: id, includeInRender: selected
  };
}

function fixture(scenes: StudioScene[], assets: RenderSpecAsset[], ranges: Array<{ sceneId: string; start: number; end: number }>): { project: VideoProject; spec: RenderSpec } {
  for (const item of scenes) item.placements = assets.filter((entry) => entry.sceneId === item.id);
  return {
    project: { scenes } as VideoProject,
    spec: {
      assets,
      narrationCues: ranges.map((range, index) => ({ index, start: range.start, end: range.end, text: range.sceneId })),
      sceneCueRanges: ranges.map((range, index) => ({ ...range, sceneTextHash: "", cueStartIndex: index, cueEndIndex: index, text: range.sceneId })),
      narrationDurationSeconds: ranges.at(-1)?.end ?? 0
    } as RenderSpec
  };
}

function close(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} 应接近 ${expected}`);
}

test("开场图片保留2.8秒地图时间并将过长最短展示压到本场边界", () => {
  const plan = planVisualClip({ scene: { id: "opening", section: "overview" }, placement: { minimumDisplaySeconds: 13.5 }, range: { start: 0.05, end: 7.287 }, sequenceIndex: 0, openingSceneId: "opening" });
  close(plan.notBeforeNarrationSeconds!, 2.85);
  close(plan.minimumDisplaySeconds, 4.437);
  assert.equal(plan.notAfterNarrationSeconds, 7.287);
  assert.equal(plan.configuredMinimumSeconds, 13.5);
  const window = resolveVisualClipWindow({ cueStartSeconds: 0.05, cueEndSeconds: 7.287, ...plan });
  close(window.startSeconds, 2.85);
  assert.equal(window.endSeconds, 7.287);
  assert.equal(window.truncatedByScene, true);
});

test("子场景飞行上下限与自定义地图停留均遵循导出规则", () => {
  assert.equal(childFlightSeconds(3, 2), 3.2);
  assert.equal(childFlightSeconds(12, 2), 5.4);
  assert.equal(childFlightSeconds(8, 4), 4);
  const plan = planVisualClip({ scene: { id: "child", section: "child", timing: { mapHoldSeconds: 4 } }, placement: { minimumDisplaySeconds: 10 }, range: { start: 10, end: 18 }, sequenceIndex: 1 });
  assert.equal(plan.notBeforeNarrationSeconds, 14);
  assert.equal(plan.minimumDisplaySeconds, 4);
});

test("无区间的计划不伪造边界或夹紧配置，后续普通图片保留独立cue起点", () => {
  assert.deepEqual(planVisualClip({ scene: { id: "missing" }, placement: { minimumDisplaySeconds: 13.5 }, sequenceIndex: 0 }), { configuredMinimumSeconds: 13.5, minimumDisplaySeconds: 13.5, sequenceIndex: 0 });
  const first = planVisualClip({ scene: { id: "later" }, placement: {}, range: { start: 10, end: 20 }, sequenceIndex: 0 });
  const later = planVisualClip({ scene: { id: "later" }, placement: {}, range: { start: 10, end: 20 }, sequenceIndex: 1 });
  assert.equal(first.notBeforeNarrationSeconds, 10);
  assert.equal(Object.hasOwn(later, "notBeforeNarrationSeconds"), false);
});

test("单图窗口保留cue前后余量与最短展示，边界始终封顶", () => {
  const natural = resolveVisualClipWindow({ cueStartSeconds: 3, cueEndSeconds: 4 });
  close(natural.startSeconds, 2.7);
  close(natural.endSeconds, 4.24);
  assert.equal(natural.hardEndSeconds, Infinity);
  assert.equal(natural.truncatedByScene, false);
  assert.equal(resolveVisualClipWindow({ cueStartSeconds: 3, cueEndSeconds: 4, minimumDisplaySeconds: 10, notAfterNarrationSeconds: 6 }).endSeconds, 6);
  close(resolveVisualClipWindow({ cueStartSeconds: 3, cueEndSeconds: 4, minimumDisplaySeconds: 5 }).endSeconds, 7.7);
});

test("多图使用自然cue窗口切片而非配置最短展示，并保留逐图起点造成的切口重叠", () => {
  const shared = { cueStartSeconds: 10, cueEndSeconds: 20, notAfterNarrationSeconds: 20, minimumDisplaySeconds: 100, sequenceCount: 2 };
  const first = resolveVisualClipWindow({ ...shared, sequenceIndex: 0, notBeforeNarrationSeconds: 10 });
  const second = resolveVisualClipWindow({ ...shared, sequenceIndex: 1 });
  assert.equal(first.startSeconds, 10);
  assert.equal(first.endSeconds, 15);
  close(second.startSeconds, 14.85);
  assert.equal(second.endSeconds, 20);
  assert.ok(second.startSeconds < first.endSeconds, "诊断须忠实显示既有合成切口重叠，不得悄悄改成共同等分");
  const short = resolveVisualClipWindow({ cueStartSeconds: 0, cueEndSeconds: 2, minimumDisplaySeconds: 100, notAfterNarrationSeconds: 10, sequenceCount: 2, sequenceIndex: 1 });
  close(short.endSeconds, 2.24);
});

test("序号归一化与0.1秒切片下限复现合成器，包括过密时越界的诊断值", () => {
  const base = { cueStartSeconds: 0, cueEndSeconds: 1, notAfterNarrationSeconds: 1, sequenceCount: 2.9 };
  assert.equal(resolveVisualClipWindow({ ...base, sequenceIndex: -5 }).startSeconds, 0);
  assert.equal(resolveVisualClipWindow({ ...base, sequenceIndex: 50 }).startSeconds, 0.5);
  const crowded = resolveVisualClipWindow({ cueStartSeconds: 0, cueEndSeconds: 0.2, notAfterNarrationSeconds: 0.2, sequenceCount: 4, sequenceIndex: 2 });
  close(crowded.startSeconds, 0.2);
  close(crowded.endSeconds, 0.3);
});

test("共享窗口与实际合成器计算代码在时间偏移及多图样例上行为一致", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../.agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts"), "utf8");
  const start = source.indexOf("    const cueDrivenStart = narrationStartSeconds +");
  const end = source.indexOf("    return {", start);
  assert.ok(start >= 0 && end > start, "实际合成器时间计算段必须存在");
  const compositor = new Function("visual", "cueStart", "cueEnd", "narrationStartSeconds", `const leadSeconds = visual.leadSeconds ?? 0.3; const tailSeconds = visual.tailSeconds ?? 0.24;\n${source.slice(start, end)}\nreturn { startSeconds: sequenceStart - narrationStartSeconds, endSeconds: resolvedEnd - narrationStartSeconds };`) as (input: VisualClipWindowInput, start: number, end: number, offset: number) => { startSeconds: number; endSeconds: number };
  const cases: VisualClipWindowInput[] = [
    { cueStartSeconds: 0.05, cueEndSeconds: 7.287, notBeforeNarrationSeconds: 2.85, notAfterNarrationSeconds: 7.287, minimumDisplaySeconds: 13.5 },
    { cueStartSeconds: 10, cueEndSeconds: 20, leadSeconds: 0.75, tailSeconds: 0.75, notBeforeNarrationSeconds: 15.4, notAfterNarrationSeconds: 20, sequenceCount: 3, sequenceIndex: 1 },
    { cueStartSeconds: 10, cueEndSeconds: 20, notAfterNarrationSeconds: 20, sequenceCount: 2, sequenceIndex: 1 },
    { cueStartSeconds: 3, cueEndSeconds: 4, minimumDisplaySeconds: 10 },
    { cueStartSeconds: 0, cueEndSeconds: 0.2, notAfterNarrationSeconds: 0.2, sequenceCount: 4, sequenceIndex: 2 }
  ];
  for (const input of cases) {
    for (const offset of [0, 4.6]) {
      const expected = compositor(input, input.cueStartSeconds, input.cueEndSeconds, offset);
      const actual = resolveVisualClipWindow(input);
      close(actual.startSeconds, expected.startSeconds);
      close(actual.endSeconds, expected.endSeconds);
    }
  }
});

test("总时间线只收录明确勾选图片并遵守placement顺序、地图空场与缺图计数", () => {
  const scenes = [scene("cover", "cover", "cover"), scene("opening"), scene("map", "overview", "map-overview"), scene("missing"), scene("photos")];
  const a = asset("a", "photos", 3);
  const b = asset("b", "photos", 3);
  const hidden = asset("hidden", "photos", 3, false);
  const { project, spec } = fixture(scenes, [a, b, hidden], [{ sceneId: "opening", start: 0, end: 8 }, { sceneId: "map", start: 8, end: 10 }, { sceneId: "missing", start: 10, end: 12 }, { sceneId: "photos", start: 12, end: 20 }]);
  scenes[4]!.placements = [b, hidden, a];
  const before = JSON.stringify({ project, spec });
  const timeline = planVisualTimeline(project, spec);
  assert.deepEqual(timeline.clips.map((clip) => clip.id), ["b", "a"]);
  assert.equal(timeline.scenes[3]!.boundCount, 3);
  assert.equal(timeline.scenes[3]!.imageCount, 2);
  assert.equal(timeline.scenes[1]!.expectsImages, false);
  assert.equal(timeline.totalSeconds, 20);
  assert.deepEqual(timeline.counts, { scenes: 4, scenesWithImages: 1, imageScenesWithoutPictures: 2, clips: 2, clamped: 2, truncated: 1, tooShort: 0, overflows: 0 });
  assert.equal(JSON.stringify({ project, spec }), before, "规划不能修改项目或实测spec");
});

test("时间线保留多句cue范围、单张夹紧标记和封面外的总时间", () => {
  const opening = scene("opening");
  const picture = asset("picture", "opening", 0);
  picture.cueEndIndex = 1;
  const { project, spec } = fixture([scene("cover", "cover", "cover"), opening], [picture], [{ sceneId: "opening", start: 0.05, end: 7.287 }]);
  spec.narrationCues = [{ index: 0, start: 0.05, end: 3, text: "第一句" }, { index: 1, start: 3.2, end: 7.287, text: "第二句" }];
  const timeline = planVisualTimeline(project, spec);
  assert.equal(timeline.clips[0]!.cueStartSeconds, 0.05);
  assert.equal(timeline.clips[0]!.cueEndSeconds, 7.287);
  close(timeline.clips[0]!.startSeconds, 2.85);
  assert.equal(timeline.clips[0]!.endSeconds, 7.287);
  assert.equal(timeline.clips[0]!.clamped, true);
  assert.equal(timeline.counts.truncated, 1);
  assert.equal(timeline.counts.overflows, 0);
  assert.equal(timeline.scenes.length, 1);
  assert.equal(timeline.totalSeconds, 7.287);
});

test("过密序列在总时间线中保留越界和负窗口警告，不掩饰合成器将拒绝的图片", () => {
  const child = scene("child", "child", "region-focus");
  const images = ["a", "b", "c", "d"].map((id) => asset(id, "child", 1));
  const { project, spec } = fixture([scene("opening", "overview", "map-overview"), child], images, [{ sceneId: "opening", start: 0, end: 10 }, { sceneId: "child", start: 10, end: 13.4 }]);
  const timeline = planVisualTimeline(project, spec);
  assert.equal(timeline.counts.tooShort, 4);
  assert.equal(timeline.counts.overflows, 1);
  assert.ok(timeline.clips[3]!.startSeconds > timeline.clips[3]!.endSeconds);
  assert.equal(timeline.scenes[1]!.perImageSeconds, 0);
});

test("时间线用实际飞行后的图片窗口报告不足0.5秒，而不是全场旁白均分", () => {
  const child = scene("child", "child", "region-focus");
  const { project, spec } = fixture([scene("opening", "overview", "map-overview"), child], [asset("a", "child", 1), asset("b", "child", 1)], [{ sceneId: "opening", start: 0, end: 10 }, { sceneId: "child", start: 10, end: 13.8 }]);
  const timeline = planVisualTimeline(project, spec);
  close(timeline.clips[0]!.startSeconds, 13.2);
  close(timeline.clips[0]!.endSeconds, 13.5);
  assert.equal(timeline.counts.tooShort, 2);
  close(timeline.scenes[1]!.perImageSeconds!, 0.3);
});
