import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildProjectRenderSpec, makeProject, normalizeProject } from "../apps/studio/project-service.js";
import { validateVideoProject } from "../packages/project-schema/index.js";
import { materializeProject } from "../apps/studio/render-engine.js";

const regionId = "990001001";

async function fixture(t: TestContext) {
  const scratchRoot = resolve(".tmp");
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(join(scratchRoot, "project-recovery-"));
  t.after(async () => {
    assert.ok(root.startsWith(`${scratchRoot}\\`) || root.startsWith(`${scratchRoot}/`));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "content"), { recursive: true });
  await mkdir(join(root, "data", "regions"), { recursive: true });
  const masterPath = join(root, "content", "regions.zh-CN.json");
  await writeFile(masterPath, JSON.stringify({
    [regionId]: { name: "测试镇", town: "测试镇", narration: ["测试开场。", "测试村介绍。", "测试结尾。"] }
  }));
  await writeFile(join(root, "data", "regions", `${regionId}.json`), JSON.stringify({
    id: regionId, name: "测试镇", childRegions: [{ id: "990001001001", name: "测试村" }]
  }));
  const audioRoot = join(root, "assets", "audio", regionId);
  await mkdir(audioRoot, { recursive: true });
  return { root, masterPath, srtPath: join(audioRoot, "narration-edge.srt") };
}

test("a saved v2 project survives a removed catalog and retains all authored content", async (t) => {
  const { root, masterPath } = await fixture(t);
  const saved = await makeProject(root, regionId);
  saved.revision = 73;
  saved.scenes[1]!.narration = "我修改后的开场。";
  saved.scenes[1]!.subtitle = saved.scenes[1]!.narration;
  const child = saved.scenes.find((scene) => scene.section === "child")!;
  child.camera = { longitude: 110, latitude: 21, height: 1800, heading: 20, pitch: -50, transition: "fly" };
  const before = structuredClone(saved);
  // Neither a missing master file nor a missing region entry may be required
  // to reopen a complete saved snapshot.
  await rm(masterPath);
  const restored = await normalizeProject(root, saved);
  assert.deepEqual(JSON.parse(JSON.stringify(restored)), before);
  assert.deepEqual(saved, before, "normalizing must not mutate the stored snapshot");
  validateVideoProject(restored);
  const spec = await buildProjectRenderSpec(root, restored);
  assert.equal(spec.projectRevision, 73);
  assert.equal(spec.sceneCueRanges[0]?.text, "我修改后的开场。");
  await writeFile(masterPath, "{}");
  assert.deepEqual(JSON.parse(JSON.stringify(await normalizeProject(root, saved))), before);
  await assert.rejects(makeProject(root, regionId), /尚未生成可制作/);
});

test("stale canonical SRT cannot prevent creating or reopening a project", async (t) => {
  const { root, srtPath } = await fixture(t);
  await writeFile(srtPath, "1\n00:00:00,000 --> 00:00:50,000\n旧版本无关的文案。\n");
  const saved = await makeProject(root, regionId);
  validateVideoProject(saved);
  const spec = await buildProjectRenderSpec(root, await normalizeProject(root, saved));
  assert.deepEqual(spec.sceneCueRanges.map((range) => range.text), saved.scenes.slice(1).map((scene) => scene.narration));
  assert.ok(spec.narrationDurationSeconds < 50, "old measured duration must not leak into estimates");
});

test("malformed or missing SRT uses preview estimates while explicit measured cues stay strict", async (t) => {
  const { root, srtPath } = await fixture(t);
  const project = await makeProject(root, regionId);
  const expected = await buildProjectRenderSpec(root, project);
  await writeFile(srtPath, "a truncated subtitle file");
  const spec = await buildProjectRenderSpec(root, project);
  assert.deepEqual(spec.narrationCues, expected.narrationCues);
  await assert.rejects(buildProjectRenderSpec(root, project, [
    { index: 0, start: 0, end: 2, text: "另一条配音。" }
  ]), /无法按文本稳定映射场景 overview-1/);
});

test("matching canonical SRT retains measured timing", async (t) => {
  const { root, srtPath } = await fixture(t);
  await writeFile(srtPath, ["测试开场。", "测试村介绍。", "测试结尾。"].map((text, index) =>
    `${index + 1}\n00:00:${String(index * 7).padStart(2, "0")},000 --> 00:00:${String((index + 1) * 7).padStart(2, "0")},000\n${text}`
  ).join("\n\n"));
  const project = await makeProject(root, regionId);
  const spec = await buildProjectRenderSpec(root, project);
  assert.deepEqual(spec.sceneCueRanges.map((range) => range.end - range.start), [7, 7, 7]);
  assert.equal(spec.narrationDurationSeconds, 21);
});

test("legacy saves still receive template migration", async (t) => {
  const { root } = await fixture(t);
  const project = await normalizeProject(root, { regionId });
  validateVideoProject(project);
  assert.equal(project.scenes.filter((scene) => scene.section === "cover").length, 1);
  assert.equal(project.scenes.filter((scene) => scene.section === "outro").length, 1);
});

test("export restores a missing catalog entry from the saved project inside its sandbox", async (t) => {
  const { root, masterPath } = await fixture(t);
  const project = await makeProject(root, regionId);
  const spec = await buildProjectRenderSpec(root, project);
  await writeFile(masterPath, JSON.stringify({ "990002001": { name: "其他镇" } }));
  await materializeProject(root, project, spec);
  const master = JSON.parse(await readFile(masterPath, "utf8"));
  assert.deepEqual(master["990002001"], { name: "其他镇" });
  assert.equal(master[regionId].town, project.cover.town);
  assert.deepEqual(master[regionId].narration, project.scenes.slice(1).map((scene) => scene.narration));
  assert.deepEqual(master[regionId].tourOrder, spec.childTourOrder);
  assert.equal(master[regionId].voiceId, project.voice.voiceId);
  assert.equal(master[regionId].voiceRate, "+0%");
});
