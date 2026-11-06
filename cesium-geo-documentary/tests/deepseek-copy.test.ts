import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { applyGeneratedCopy, buildCopyPrompt } from "../apps/studio/deepseek-copy.js";
import { makeProject } from "../apps/studio/project-service.js";
import type { VideoProject } from "../packages/project-schema/index.js";

const root = resolve(process.cwd());

function rowsFor(project: VideoProject, narrationByTitle: Record<string, string> = {}) {
  return project.scenes
    .filter((scene) => scene.section !== "cover")
    .map((scene) => ({ id: scene.id, narration: narrationByTitle[scene.title] ?? `${scene.title}的新文案。` }));
}

test("DeepSeek prompt contains scene facts and an explicit no-invention rule", async () => {
  const project = await makeProject(root, "440825112");
  const prompt = buildCopyPrompt(project);
  assert.match(prompt, /只输出 JSON/);
  assert.match(prompt, /不得新增数字/);
  assert.match(prompt, /事实铁律/);
  assert.match(prompt, new RegExp(project.cover.town));
  assert.match(prompt, new RegExp(project.scenes.find((scene) => scene.section === "child")!.id));
});

test("generated narration is copied to subtitles for every editable scene", async () => {
  const project = await makeProject(root, "440825112");
  const rows = rowsFor(project);
  const generated = applyGeneratedCopy(project, { scenes: rows });
  assert.equal(generated.scenes[0]!.narration, "");
  assert.ok(generated.scenes
    .filter((scene) => scene.section !== "cover")
    .every((scene) => scene.narration === scene.subtitle));
  assert.throws(() => applyGeneratedCopy(project, { scenes: rows.slice(1) }), /全部场景/);
});

test("truth guard rejects invented statistics, years and natural-village counts", async () => {
  const project = await makeProject(root, "440825112");
  const target = project.scenes.find((scene) => scene.section === "child")!;
  const invented = [
    "2026年全镇常住人口约五万人，是当地人口最多的乡镇。",
    "全镇土地面积一百二十平方公里，经济总量突破十亿元。",
    "下辖 999 个自然村，村庄星罗棋布。"
  ];
  for (const narration of invented) {
    assert.throws(
      () => applyGeneratedCopy(project, { scenes: rowsFor(project, { [target.title]: narration }) }),
      /真实性护栏拦截/,
      `should reject: ${narration}`
    );
  }
});

test("truth guard accepts value-equivalent rephrasing but rejects real drift", async () => {
  const base = await makeProject(root, "440825112");
  const overview = base.scenes.find((scene) => scene.section === "overview")!;
  const previous = { ...base, scenes: base.scenes.map((scene) => scene.id === overview.id ? { ...scene, narration: "2019年末，全镇户籍人口34247人，下辖10个行政村。" } : scene) };
  // Same census figure rewritten in Chinese numerals + rounding stays grounded.
  assert.doesNotThrow(() => applyGeneratedCopy(previous, { scenes: rowsFor(previous, { [overview.title]: "2019年底，镇里住着大约三万四千人，下辖10个行政村。" }) }));
  // A materially larger invented population is rejected.
  assert.throws(
    () => applyGeneratedCopy(previous, { scenes: rowsFor(previous, { [overview.title]: "镇里人口约有五万人，是全县人口最多的地方。" }) }),
    /真实性护栏拦截/
  );
});

test("scoped apply rewrites only the requested scene and leaves others untouched", async () => {
  const project = await makeProject(root, "440825112");
  const overview = project.scenes.find((scene) => scene.section === "overview")!;
  const child = project.scenes.find((scene) => scene.section === "child")!;
  const childNarration = child.narration;
  const generated = applyGeneratedCopy(
    project,
    { scenes: [{ id: overview.id, narration: "镜头沿着海岸线缓缓移动，将全镇轮廓收入画面。" }] },
    overview.id
  );
  const overviewAfter = generated.scenes.find((scene) => scene.id === overview.id)!;
  const childAfter = generated.scenes.find((scene) => scene.id === child.id)!;
  assert.equal(overviewAfter.narration, "镜头沿着海岸线缓缓移动，将全镇轮廓收入画面。");
  assert.equal(childAfter.narration, childNarration);
  assert.equal(generated.scenes.length, project.scenes.length);
});

test("truth guard accepts conservative copy and structurally-known child counts", async () => {
  const project = await makeProject(root, "440825112");
  const childScenes = project.scenes.filter((scene) => scene.section === "child");
  const count = childScenes.length;
  const target = childScenes[0]!;
  const safe = {
    [target.title]: `镜头跟随海岸线缓缓移动，${target.childName}的房屋与滩涂在画面中依次出现。`
  };
  // Plain copy without numbers must pass.
  assert.doesNotThrow(() => applyGeneratedCopy(project, { scenes: rowsFor(project, safe) }));
  // A count that mirrors the structural child list is trusted.
  const countRow = rowsFor(project, { [target.title]: `全镇共有${count}个行政村，村庄沿河分布。` });
  assert.doesNotThrow(() => applyGeneratedCopy(project, { scenes: countRow }));
  // An off-by-one count is not structural and must be rejected.
  assert.throws(
    () => applyGeneratedCopy(project, { scenes: rowsFor(project, { [target.title]: `全镇共有${count + 1}个行政村。` }) }),
    /真实性护栏拦截/
  );
});
