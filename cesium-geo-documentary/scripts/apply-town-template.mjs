#!/usr/bin/env node
/**
 * 把一份「乡镇抖音方案」JSON 应用到 Studio 项目：
 *   - 段数 = 图数 强校验（图文错位的根因）
 *   - 关键词必须出自本场旁白（否则合成会在预检阶段崩）
 *   - fit 按图片实际比例自动判定（竖图 contain，接近窗口比例 cover）
 *
 * 用法：
 *   node scripts/apply-town-template.mjs tmp/<place>-plan.json [--project <id>]
 *
 * plan 结构见 docs/templates/wuyang-plan-snapshot.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const STUDIO = process.env.STUDIO_URL ?? "http://127.0.0.1:4180";
const root = process.cwd();
const probe = join(root, "node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe");
const args = process.argv.slice(2);
const planPath = args[0];
const projectArgIndex = args.indexOf("--project");
const explicitProject = projectArgIndex >= 0 ? args[projectArgIndex + 1] : undefined;
if (!planPath) { console.error("usage: node scripts/apply-town-template.mjs <plan.json> [--project <id>]"); process.exit(1); }

const plan = JSON.parse(readFileSync(join(root, planPath), "utf8"));
const WINDOW_RATIO = 1080 / 780;
const TOLERANCE = 0.12;
const chars = (t) => String(t || "").replace(/\s+/g, "").length;
const estimate = (t) => Math.max(3.5, Math.round((chars(t) / 5.1) * 100) / 100);
const segments = (t) => String(t || "").split("\n").filter((x) => x.trim());

async function api(path, init) {
  const res = await fetch(`${STUDIO}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} ${res.status} ${body.error ?? ""}`);
  return body;
}

function ratioOf(asset) {
  if (!asset?.path) return null;
  const file = join(root, "workspace/assets", asset.path.split("/").pop());
  if (!existsSync(file)) return null;
  const r = spawnSync(probe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" });
  const [w, h] = String(r.stdout).trim().split(",").map(Number);
  return w && h ? w / h : null;
}

function fitFor(asset) {
  const ratio = ratioOf(asset);
  if (!ratio) return "cover";
  return Math.abs(ratio - WINDOW_RATIO) / WINDOW_RATIO > TOLERANCE ? "contain" : "cover";
}

// 1) 项目：显式指定，或取 plan.projectId，或按 regionId 找最新
let project;
if (explicitProject || plan.projectId) {
  project = await api(`/api/projects/${explicitProject ?? plan.projectId}`);
} else if (plan.regionId) {
  const list = await api(`/api/projects`);
  const arr = Array.isArray(list) ? list : list.projects ?? [];
  const hit = arr.filter((x) => x.regionId === plan.regionId).sort((a, b) => b.revision - a.revision)[0];
  if (!hit) throw new Error(`没有 regionId=${plan.regionId} 的方案，先用 POST /api/projects 建一个`);
  project = await api(`/api/projects/${hit.id}`);
} else {
  throw new Error("plan 里缺 projectId / regionId，也没传 --project");
}
console.log(`项目 ${project.id}｜rev ${project.revision}｜${project.scenes.length} 场`);

const byId = new Map(project.assets.map((a) => [a.id, a]));
const problems = [];

// 2) 改写场景
for (const item of plan.scenes ?? []) {
  const scene = project.scenes.find((s) => s.id === item.id);
  if (!scene) { problems.push(`缺场景 ${item.id}`); continue; }
  const narration = String(item.narration || "");
  const segs = segments(narration);
  const images = item.images ?? [];
  if (images.length && segs.length !== images.length) {
    problems.push(`${item.title ?? item.id}: 段数 ${segs.length} ≠ 图数 ${images.length}`);
    continue;
  }
  scene.title = item.title ?? scene.title;
  scene.narration = narration;
  scene.subtitle = narration;
  scene.duration = estimate(narration);
  const placements = [];
  for (const [assetId, keyword, alt] of images) {
    const asset = byId.get(assetId);
    if (!asset) { problems.push(`${item.id}: 缺素材 ${assetId}`); continue; }
    if (keyword && !narration.includes(keyword)) problems.push(`${item.id}: 关键词「${keyword}」不在旁白里`);
    placements.push({
      assetId, fit: fitFor(asset),
      crop: { x: 0, y: 0, width: 1, height: 1 }, focalPoint: { x: 0.5, y: 0.5 },
      scale: 1, offsetX: 0, offsetY: 0, animation: "push-in",
      leadSeconds: 0.25, tailSeconds: 0.2,
      minimumDisplaySeconds: Math.min(2.5, Math.max(1.6, scene.duration / Math.max(1, images.length) - 0.55)),
      requiredKeywords: keyword ? [keyword] : [], alt: alt ?? asset.name ?? "", includeInRender: true
    });
  }
  if (placements.length) {
    scene.placements = placements;
    scene.assetIds = [...new Set(placements.map((x) => x.assetId))];
    scene.assetDisplayCount = placements.length;
  }
}

// 3) 村：一段一图，图按 prefer 正则挑该村候选
for (const item of plan.children ?? []) {
  const scene = project.scenes.find((s) => s.id === item.id);
  if (!scene) { problems.push(`缺村场景 ${item.id}`); continue; }
  const narration = String(item.narration || "");
  const segs = segments(narration);
  if (segs.length > 1 && !(item.images && item.images.length)) {
    problems.push(`${item.id}: 旁白 ${segs.length} 段但只给了单图——多图场景请放到 plan.scenes 里`);
    continue;
  }
  scene.narration = narration;
  scene.subtitle = narration;
  scene.duration = estimate(narration);
  const childId = String(scene.childId ?? "");
  const prefer = new RegExp(item.prefer ?? "门楼|牌坊|宗祠|大宗|祖祠|公庙|太祖庙|广福|天后宫|古井|村牌|祠堂|庙");
  const keep = (scene.placements ?? [])[0];
  const candidates = project.assets.filter((a) => a.sourceType === "amap-poi" && a.poi?.childId === childId);
  const pick = keep ?? candidates.find((a) => prefer.test(String(a.poi?.poiName ?? ""))) ?? candidates[0];
  if (!pick) { problems.push(`${item.id}: 无可用村图`); continue; }
  const asset = byId.get(pick.assetId) ?? byId.get(pick.id);
  const keyword = String(scene.childName ?? scene.title.split("｜")[0]).replace(/社区$|村$/u, "");
  if (!narration.includes(keyword)) problems.push(`${item.id}: 村名「${keyword}」不在旁白首句`);
  const placements = [{
    assetId: asset?.id ?? pick.assetId ?? pick.id,
    fit: fitFor(asset),
    crop: { x: 0, y: 0, width: 1, height: 1 }, focalPoint: { x: 0.5, y: 0.5 },
    scale: 1, offsetX: 0, offsetY: 0, animation: "push-in",
    leadSeconds: 0.25, tailSeconds: 0.2,
    minimumDisplaySeconds: Math.min(2.5, Math.max(1.6, scene.duration - 0.9)),
    requiredKeywords: [keyword],
    alt: asset?.name ?? pick.alt ?? "",
    includeInRender: true
  }];
  scene.placements = placements;
  scene.assetIds = [placements[0].assetId];
  scene.assetDisplayCount = 1;
}

if (plan.cover) project.cover = { ...project.cover, ...plan.cover };
if (plan.name) project.name = plan.name;

const total = project.scenes.reduce((s, x) => s + (x.duration || 0), 0);
console.log(`应用后：${project.scenes.length} 场｜估算 ${total.toFixed(1)}s = ${(total / 60).toFixed(2)} min`);
if (problems.length) {
  console.log("存在问题（必须先修）：");
  problems.forEach((p) => console.log("  -", p));
  process.exit(2);
}

const saved = await api(`/api/projects/${project.id}`, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(project)
});
console.log("PUT ok rev", saved.revision);

const report = await api(`/api/projects/${project.id}/validate`, { method: "POST" });
const failed = (report.checks ?? []).filter((c) => !c.pass);
console.log(`validate ready=${report.ready} fails=${failed.length}`);
failed.forEach((c) => console.log("  -", c.name, "|", String(c.detail ?? "").slice(0, 120)));
writeFileSync(join(root, "tmp", "last-apply-report.json"), JSON.stringify({ projectId: project.id, revision: saved.revision, total, failed }, null, 2));
