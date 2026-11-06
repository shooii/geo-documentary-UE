import { readFile, writeFile } from "node:fs/promises";

const regionId = "440882116";
const projectId = "project-mu0y7zd2";
const route = [
  "440882116001", // 覃斗社区：从镇区出发
  "440882116207", // 塘边村
  "440882116202", // 凌新村
  "440882116201", // 六高村
  "440882116209", // 迈克村
  "440882116210", // 那金村
  "440882116200", // 讨泗村
  "440882116206", // 卜立村
  "440882116211", // 山尾村
  "440882116208", // 铺前村
  "440882116218", // 西岸村：转入西海岸
  "440882116203", // 英岭村
  "440882116204", // 海边村
  "440882116217", // 东港村
  "440882116205", // 后洪村
  "440882116216", // 提交村
  "440882116215", // 英楠村
  "440882116214", // 头和村
  "440882116212", // 流沙村
  "440882116213"  // 下海村：结束于南部海湾
];

const contentPath = "content/regions.zh-CN.json";
const master = JSON.parse(await readFile(contentPath, "utf8"));
const content = master[regionId];
if (!content) throw new Error(`Missing content region ${regionId}`);
const oldOrder = content.tourOrder.map(String);
const introCount = Number(content.tourIntroSentences);
const narrationByChild = new Map(oldOrder.map((id, index) => [id, content.narration[introCount + index]]));
if (route.some((id) => !narrationByChild.has(id))) throw new Error("Geographic route does not cover the existing narration order");
content.tourOrder = route;
content.narration = [
  ...content.narration.slice(0, introCount),
  ...route.map((id) => narrationByChild.get(id)),
  ...content.narration.slice(introCount + oldOrder.length)
];
await writeFile(contentPath, `${JSON.stringify(master, null, 2)}\n`, "utf8");

const response = await fetch(`http://127.0.0.1:4180/api/projects/${projectId}`);
if (!response.ok) throw new Error(`Cannot load Studio project: ${response.status}`);
const project = await response.json();
if (String(project.regionId) !== regionId) throw new Error(`Project ${projectId} is not the Qindou project`);
const childScenes = new Map(project.scenes.filter((scene) => scene.section === "child").map((scene) => [String(scene.childId), scene]));
if (route.some((id) => !childScenes.has(id))) throw new Error("Studio project does not contain the complete geographic route");
const firstChildIndex = project.scenes.findIndex((scene) => scene.section === "child");
const lastChildIndex = project.scenes.findLastIndex((scene) => scene.section === "child");
project.scenes = [
  ...project.scenes.slice(0, firstChildIndex),
  ...route.map((id) => childScenes.get(id)),
  ...project.scenes.slice(lastChildIndex + 1)
];
const saved = await fetch(`http://127.0.0.1:4180/api/projects/${projectId}`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(project)
});
if (!saved.ok) throw new Error(`Cannot save Studio project: ${saved.status} ${await saved.text()}`);
const result = await saved.json();
process.stdout.write(`GEOGRAPHIC_ROUTE_READY ${result.id} revision=${result.revision}\n`);
