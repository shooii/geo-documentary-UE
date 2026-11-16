import test from "node:test";
import assert from "node:assert/strict";
import { buildTourPlan, assertTourPlanExportable, tourVisualReadySeconds, type TourCamera } from "../packages/render-spec/tour-plan.js";
import { planVisualClip } from "../packages/render-spec/visual-timeline.js";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { materializeProject } from "../apps/studio/render-engine.js";
import type { VideoProject } from "../packages/project-schema/index.js";
import type { RenderSpec } from "../packages/render-spec/index.js";
const camera: TourCamera = { longitude: 110, latitude: 21, height: 4000, heading: 0, pitch: -50, roll: 0 };
const child = (duration: number, longitude = 110.01) => ({ id: "scene-a", section: "child", childId: "a", title: "甲村", duration, camera: { ...camera, longitude }, timing: { mapHoldSeconds: 2 } });
test("估算累计全部开场且只加一次旁白起拍，不加下降", () => {
  const plan = buildTourPlan({ scenes: [{ id: "cover", section: "cover", duration: 3 }, { id: "intro", section: "overview", duration: 7 }, child(10)], parentCamera: camera });
  assert.equal(plan.tourStops[0]!.start, 7.35);
  assert.equal(plan.tourStops[0]!.end, 17.35);
  assert.deepEqual(plan, buildTourPlan({ scenes: [{ id: "cover", section: "cover", duration: 3 }, { id: "intro", section: "overview", duration: 7 }, child(10)], parentCamera: camera }));
});
test("真实cue优先、相机自定义原样保留、距离决定飞行", () => {
  const near = buildTourPlan({ scenes: [child(20)], parentCamera: camera, ranges: [{ sceneId: "scene-a", start: 42, end: 62 }] });
  const far = buildTourPlan({ scenes: [child(20, 111)], parentCamera: camera });
  assert.equal(near.tourStops[0]!.start, 42.35);
  assert.deepEqual(near.tourStops[0]!.cameraProfiles.portrait, child(20).camera);
  assert.ok(far.tourStops[0]!.flightDuration > near.tourStops[0]!.flightDuration);
});
test("短cue压缩飞行但保留落稳填色预算，不延长音画，正式导出阻断", () => {
  const compressed = buildTourPlan({ scenes: [child(4.5)], parentCamera: camera });
  assert.equal(compressed.tourStops[0]!.flightDuration, 2.5);
  assertTourPlanExportable(compressed);
  const short = buildTourPlan({ scenes: [child(2)], parentCamera: camera });
  assert.equal(short.tourStops[0]!.end, 2.35);
  assert.equal(short.diagnostics[0]!.code, "short-cue");
  assert.throws(() => assertTourPlanExportable(short), /至少需要/);
});
test("真实巡游构建脚本与预览计划同输入同飞行、起拍和相机", async () => {
  const root = resolve(process.cwd());
  const scratch = await mkdtemp(join(tmpdir(), "tour-plan-p0-"));
  const regionId = "990000001";
  try {
    await mkdir(join(scratch, "content"), { recursive: true });
    await mkdir(join(scratch, "data/regions"), { recursive: true });
    await mkdir(join(scratch, "assets/audio", regionId), { recursive: true });
    await writeFile(join(scratch, "content/regions.zh-CN.json"), JSON.stringify({ [regionId]: { tourOrder: ["a"], tourIntroSentences: 1, tourChildCueRanges: [{ childId: "a", cueStartIndex: 1, cueEndIndex: 1 }], tourMapHoldSeconds: { a: 2 } } }));
    const customCamera = { ...child(10).camera, transition: "fly" };
    await writeFile(join(scratch, "data/regions", `${regionId}.json`), JSON.stringify({ childIds: ["a"], cameraPreset: camera, openingDescent: { enabled: false }, childRegions: [{ id: "a", name: "甲村", bbox: [109.9, 20.9, 110.1, 21.1], cameraPreset: { ...camera, height: 9999 }, cameraProfiles: { portrait: { ...camera, height: 8888 } } }] }));
    const project = { id: "p0-camera", regionId, scenes: [{ id: "intro", section: "overview", narration: "总览" }, { ...child(10), narration: "甲村", camera: customCamera }], template: { tourReturnSeconds: 4.4 }, voice: { speed: 1 }, cover: { town: "测试镇" } } as unknown as VideoProject;
    const previewPlan = buildTourPlan({ parentCamera: camera, scenes: [{ ...child(10), camera: customCamera }], ranges: [{ sceneId: "scene-a", start: 7, end: 17 }] });
    await materializeProject(scratch, project, { childTourOrder: ["a"] } as RenderSpec);
    // 已存在child的默认镜头必须被真实StudioScene.camera覆盖，而非只验证新建child。
    const materialized = JSON.parse(await readFile(join(scratch, "data/regions", `${regionId}.json`), "utf8"));
    assert.deepEqual(materialized.childRegions[0].cameraPreset, previewPlan.tourStops[0]!.cameraPreset);
    assert.equal(materialized.childRegions[0].cameraPreset.transition, undefined);
    await writeFile(join(scratch, "assets/audio", regionId, "narration-edge.srt"), "1\n00:00:00,000 --> 00:00:07,000\n总览\n\n2\n00:00:07,000 --> 00:00:17,000\n甲村\n");
    await writeFile(join(scratch, "assets/audio", regionId, "duration.json"), JSON.stringify({ durationSeconds: 21.4, outroPause: { applied: true, mode: "parent-child-tour", hasClosingNarration: false, insertedSeconds: 4.4, returnWindowSeconds: 4.4 } }));
    execFileSync(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, ".agents/skills/cesium-geo-documentary/scripts/build-child-tour.ts"), "--region", regionId], { cwd: scratch, stdio: "pipe" });
    const exported = JSON.parse(await readFile(join(scratch, "data/regions", `${regionId}.json`), "utf8")).tourStops[0];
    const preview = previewPlan.tourStops[0]!;
    for (const key of ["start", "end", "flightDuration", "visualReadySeconds", "groundDistanceMeters", "cameraPreset", "cameraProfiles"] as const) assert.deepEqual(exported[key], preview[key]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("无效cue、缺range和重复child诊断而不混拼估算", () => {
  for (const range of [{ start: NaN, end: 5 }, { start: -1, end: 5 }, { start: 5, end: 2 }, { start: 0, end: Infinity }]) {
    const plan = buildTourPlan({ scenes: [child(10)], ranges: [{ sceneId: "scene-a", ...range }] });
    assert.equal(plan.tourStops.length, 0);
    assert.equal(plan.diagnostics[0]!.code, "invalid-range");
    assert.throws(() => assertTourPlanExportable(plan));
  }
  const missing = buildTourPlan({ scenes: [child(10)], ranges: [] });
  assert.equal(missing.diagnostics[0]!.code, "missing-range");
  assert.equal(missing.tourStops.length, 0);
  const overview = buildTourPlan({ scenes: [{ id: "spoken-overview", section: "overview", narration: "总览旁白", duration: 7 }, { id: "silent-hold", section: "overview", duration: 2 }], ranges: [] });
  assert.deepEqual(overview.diagnostics.map(item => item.sceneId), ["spoken-overview"]);
  assert.equal(overview.diagnostics[0]!.code, "missing-range");
  assert.throws(() => assertTourPlanExportable(overview));
  const duplicate = buildTourPlan({ scenes: [child(10), { ...child(10), id: "second" }] });
  assert.equal(duplicate.diagnostics.at(-1)!.code, "duplicate-child");
  const overlap = buildTourPlan({ scenes: [child(10), { ...child(10), id: "second", childId: "b" }], ranges: [{ sceneId: "scene-a", start: 0, end: 10 }, { sceneId: "second", start: 5, end: 15 }] });
  assert.equal(overlap.diagnostics.at(-1)!.code, "invalid-range");
});
test("缺相机、非法相机与NaN停留不向计划传播非有限数", () => {
  const missing = buildTourPlan({ scenes: [{ ...child(10), camera: undefined }] });
  assert.equal(missing.diagnostics[0]!.code, "missing-camera");
  const invalid = buildTourPlan({ scenes: [{ ...child(10), camera: { ...camera, height: NaN } }] });
  assert.equal(invalid.diagnostics[0]!.code, "invalid-camera");
  const timing = buildTourPlan({ scenes: [{ ...child(10), timing: { mapHoldSeconds: NaN } }], flightPreferenceSeconds: Infinity });
  assert.ok(timing.diagnostics.every(item => item.code === "invalid-timing"));
  assert.ok(Number.isFinite(timing.tourStops[0]!.flightDuration));
});
test("超短cue预览不跨场且诊断携带sceneId及required/available", () => {
  const plan = buildTourPlan({ scenes: [child(.5)] });
  const stop = plan.tourStops[0]!;
  assert.ok(stop.flightDuration <= stop.end - stop.start + 1e-9);
  assert.equal(plan.diagnostics[0]!.sceneId, "scene-a");
  assert.equal(plan.diagnostics[0]!.availableSeconds, .5);
  assert.equal(plan.diagnostics[0]!.requiredSeconds, 4.4);
  assert.throws(() => assertTourPlanExportable(plan));
});
test("父镜头回落与输出同源，不同输出画幅不重新拟合自定义相机", () => {
  const parent = { id: "intro", section: "overview", duration: 5, camera };
  const implicit = buildTourPlan({ scenes: [parent, child(10)] });
  const explicit = buildTourPlan({ scenes: [parent, child(10)], parentCamera: camera });
  assert.deepEqual(implicit, explicit);
  assert.deepEqual(implicit.parentCamera, camera);
  for (const profile of ["portrait", "landscape", "square"]) {
    assert.deepEqual(buildTourPlan({ scenes: [child(10)], parentCamera: camera }).tourStops[0]!.cameraPreset, child(10).camera, profile);
  }
});
test("过期spec不复用旧cue、QA只允许冻结或实测入口声称正式一致", async () => {
  const client = await readFile(resolve("apps/studio/public/studio.js"), "utf8");
  const functionSource = client.slice(client.indexOf("function tourPreviewPayload()"), client.indexOf("\n// An export materialises", client.indexOf("function tourPreviewPayload()")));
  const sceneA = child(10);
  const sceneB = { ...child(12, 110.2), id: "scene-b", childId: "b" };
  const state = { project: { id: "p0", template: {}, scenes: [{ id: "intro", section: "overview", duration: 7 }, sceneB, sceneA] }, renderSpecStale: true, durationDrafts: new Map([["intro", 9], ["scene-b", 20], ["scene-a", 30]]), renderSpec: { projectId: "p0", sceneCueRanges: [{ sceneId: "scene-a", start: 100, end: 110 }, { sceneId: "scene-b", start: 110, end: 122 }], tourPlan: { parentCamera: camera, tourStops: [] } } };
  const invoke = () => runInNewContext(`${functionSource};tourPreviewPayload()`, { state, buildTourPlan, sceneDuration: (scene: { id: string; duration: number }) => state.durationDrafts.get(scene.id) ?? scene.duration, sceneAnnotationWindows: () => [] });
  const result = invoke();
  assert.deepEqual(Array.from(result.tourStops, (stop: { id: string }) => stop.id), ["b", "a"]);
  assert.equal(result.tourStops[0].start, 9.35);
  assert.equal(result.tourStops[1].start, 29.35);
  assert.equal(result.tourStops[1].end, 59.35);
  assert.equal(result.planIdentity, "estimated");
  Object.assign(state.renderSpec, { cacheSignature: "sha256:verified-plan", tourPlan: { ...state.renderSpec.tourPlan, tourStops: result.tourStops } });
  state.renderSpecStale = false;
  assert.equal(invoke().planIdentity, "sha256:verified-plan");
  state.renderSpecStale = true;
  state.renderSpec.projectId = "other-project";
  const foreign = invoke();
  assert.equal(foreign.tourStops[0].groundDistanceMeters, 0);
  const qa = await readFile(resolve("scripts/ue-visual-qa.ts"), "utf8");
  assert.match(qa, /option\('render-spec', ''\)/);
  assert.match(qa, /option\('cues', ''\)/);
  assert.match(qa, /formalParity: timingSource !== 'estimated'/);
  assert.match(qa, /option\('region', project\.regionId\)/);
});

test("图片使用计划的实际飞行与完整填色落稳预算", () => {
  const stop = buildTourPlan({ scenes: [child(10)], parentCamera: camera }).tourStops[0]!;
  const plan = planVisualClip({ scene: child(10), range: { start: 4, end: 14 }, placement: {}, sequenceIndex: 0, childVisualReadySeconds: stop.visualReadySeconds });
  assert.equal(stop.visualReadySeconds, tourVisualReadySeconds(stop.flightDuration));
  assert.equal(plan.notBeforeNarrationSeconds, 4 + stop.flightDuration + 1.15 + .4);
});
