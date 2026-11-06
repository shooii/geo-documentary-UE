/* Scene-strip regression guard: does the timeline tell the truth about lengths?
 *
 * Two invariants, both measured in a real browser on a throwaway copy of a real
 * project:
 *
 *   1. One edit must not resize the other clips. Width is
 *      `max(112, round(sceneDuration * 13))`, a pure function of that scene's own
 *      narration, so pressing "+ 新增场景" has to leave every other clip alone.
 *   2. An edit must resize its own clip at once. The authoritative length only
 *      arrives with the next render spec (autosave debounce + PUT + rebuild,
 *      ~4.3s on a live project), so the editor estimates from the text as it is
 *      typed and lets the spec take over. A regression here means the strip
 *      visibly lags the cursor.
 *
 * Both used to fail loudly: `markDirty()` released the render spec on every
 * edit, so the strip re-measured every clip from the drifted `scene.duration`
 * fallback — 33 of 41 clips jumped (乌石镇·结尾 644→146px) — and editing a
 * narration left the owning clip on the *previous* text's length for ~4s.
 *
 *   node .agents/skills/cesium-geo-documentary/scripts/verify-scene-strip-width.mjs [--project <id>]
 *
 * Side effects: writes and deletes `workspace/projects/project-stripcheck.*`, and
 * opens that copy in a dedicated browser profile (the operator's own "last
 * project" pointer is per browser context, so it is not touched).
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const PROJECTS = join(ROOT, "workspace", "projects");
const STUDIO = process.env.STUDIO_URL ?? "http://127.0.0.1:4180/";
const TEMP_ID = "project-stripcheck";
const TEMP_NAME = "场景条带自检（临时·可删）";
/* Round-trip to the authoritative spec used to take ~4.3s; the draft has to be
   on screen in about a frame, so a generous ceiling still catches a regression. */
const MAX_LENGTH_LATENCY_MS = 600;
const NARRATION_EDIT = "本句用于测量旁白字数变化后时长更新的延迟，特意写长一点把字数差距拉开。";

/* Pick the newest revision of the requested project (or of whatever was edited
   last) as the specimen. */
function newestRevisionFile(projectId) {
  const id = projectId ?? latestProjectId();
  const versions = readdirSync(PROJECTS)
    .map((name) => new RegExp(`^${id}\\.v(\\d+)\\.json$`).exec(name))
    .filter(Boolean)
    .map((match) => ({ name: match[0], version: Number(match[1]) }))
    .sort((a, b) => b.version - a.version);
  if (!versions.length) throw new Error(`no revisions found for ${id}`);
  return join(PROJECTS, versions[0].name);
}

function latestProjectId() {
  const ranked = readdirSync(PROJECTS)
    .map((name) => /^(project-[a-z0-9]+)\.v(\d+)\.json$/.exec(name))
    .filter(Boolean)
    .map((match) => ({ id: match[1], version: Number(match[2]), mtime: 0 }));
  const seen = new Map();
  for (const entry of ranked) if (!seen.has(entry.id) || seen.get(entry.id).version < entry.version) seen.set(entry.id, entry);
  const ids = [...seen.values()].sort((a, b) => a.version - b.version);
  if (!ids.length) throw new Error("no projects in workspace/projects");
  return ids[ids.length - 1].id;
}

const projectArg = process.argv.indexOf("--project");
const specimen = newestRevisionFile(projectArg >= 0 ? process.argv[projectArg + 1] : undefined);
const project = JSON.parse(readFileSync(specimen, "utf8"));
project.id = TEMP_ID;
project.name = TEMP_NAME;
project.revision = 1;
const tempFile = join(PROJECTS, `${TEMP_ID}.v000001.json`);
writeFileSync(tempFile, JSON.stringify(project, null, 2));
console.log(`specimen: ${specimen} (${project.scenes.length} scenes)`);

const cleanup = () => {
  for (const name of readdirSync(PROJECTS)) if (name.startsWith(`${TEMP_ID}.`)) rmSync(join(PROJECTS, name), { force: true });
};

let browser;
let failures = 0;
try {
  if (!existsSync(join(ROOT, "node_modules", "playwright"))) throw new Error("playwright is not installed; run pnpm install");
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1720, height: 1000 } });
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));

  /* Enter the throwaway copy through the remembered-project shortcut: the
     project-list modal renders whatever the boot fetched, and a copy written a
     second ago is not guaranteed to be in that render. localStorage lives in
     this browser context alone, so the operator's own "last project" is safe. */
  await page.addInitScript((id) => {
    try { localStorage.setItem("geo-video-studio:last-project-id", id); } catch { /* private mode */ }
  }, TEMP_ID);
  await page.goto(STUDIO, { waitUntil: "domcontentloaded" });
  // Boot loads a project behind a busy overlay that swallows pointer events.
  await page.waitForFunction(() => document.getElementById("projectBusy")?.hidden !== false, null, { timeout: 180000 });
  const opened = await page.evaluate(() => document.getElementById("projectName")?.value ?? "");
  if (!opened.includes("条带自检")) throw new Error(`the Studio opened ${JSON.stringify(opened)} instead of the throwaway copy; refusing to edit a real project`);

  await page.waitForFunction(() => document.querySelectorAll(".timeline-clip").length > 2, null, { timeout: 180000 });
  await page.waitForFunction(() => document.getElementById("specBadge")?.hidden === true, null, { timeout: 180000 })
    .catch(() => problems.push("the render spec never arrived, so the strip has no timings to compare"));
  /* Opening a project keeps walking the admin tree well after the strip paints;
     measuring during that window compares against a half-built editor. */
  await page.waitForTimeout(14000);
  await page.waitForFunction(() => document.getElementById("saveState")?.textContent === "已保存", null, { timeout: 60000 })
    .catch(() => problems.push("the editor never settled into 已保存"));

  await page.evaluate(() => {
    window.__snaps = [];
    const snap = (tag) => {
      window.__snaps.push({
        tag,
        at: Date.now(),
        clips: [...document.querySelectorAll(".timeline-clip")].map((el) => ({
          id: el.dataset.sceneId,
          title: el.querySelector(".clip-title")?.textContent ?? "",
          width: el.offsetWidth
        }))
      });
    };
    window.__snap = snap;
    new MutationObserver(() => snap("render")).observe(document.getElementById("timelineScenes"), { childList: true });
  });

  await page.evaluate(() => window.__snap("before"));
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__snap("before-quiet"));
  await page.evaluate(() => document.getElementById("addScene").click());
  await page.waitForTimeout(6000);
  await page.evaluate(() => window.__snap("after-settle"));

  const snaps = await page.evaluate(() => window.__snaps);
  const byId = (snapshot) => new Map((snapshot?.clips ?? []).map((clip, index) => [clip.id, { ...clip, position: index + 1 }]));
  const before = snaps.find((snapshot) => snapshot.tag === "before");
  const firstFrame = snaps.find((snapshot) => snapshot.tag === "render") ?? null;
  const settled = snaps.find((snapshot) => snapshot.tag === "after-settle");
  const a = byId(before);
  const b = byId(firstFrame);
  const c = byId(settled);

  let movedFirstFrame = 0;
  let movedSettled = 0;
  for (const [id, entry] of a) {
    const first = b.get(id)?.width;
    const settled_ = c.get(id)?.width;
    const movedNow = first !== undefined && first !== entry.width;
    const movedLater = settled_ !== undefined && settled_ !== entry.width;
    if (movedNow) movedFirstFrame += 1;
    if (movedLater) movedSettled += 1;
    if (movedNow || movedLater) console.log(`  ! ${entry.title} #${id}: ${entry.width}px → ${first ?? "?"} → ${settled_ ?? "?"}`);
  }
  const added = [...c.keys()].filter((id) => !a.has(id));
  console.log(`\n[新增场景] 原有 ${a.size} 张卡片：首帧 ${movedFirstFrame} 张变宽/变窄，稳定后 ${movedSettled} 张仍不同`);
  console.log(`[新增场景] 新增 ${added.length} 张：${added.map((id) => `${c.get(id).title} ${c.get(id).width}px`).join(", ")}`);
  for (const id of added) if (c.get(id).width !== 112) console.log(`  ! 新卡片宽度 ${c.get(id).width}px，预期落在 112px 下限`);
  if (added.length !== 1) failures += 1;
  if (movedFirstFrame || movedSettled) failures += 1;

  /* --- 旁白字数变化后，卡片长度必须立刻跟上 --- */
  const target = project.scenes.find((scene) => scene.section === "child") ?? project.scenes[1];
  await page.evaluate((sceneId) => {
    const clip = () => document.querySelector(`.timeline-clip[data-scene-id="${CSS.escape(sceneId)}"]`);
    window.__lengthRead = () => {
      const el = clip();
      const label = el?.querySelector("span")?.textContent ?? "";
      return {
        width: el?.offsetWidth ?? null,
        seconds: (label.split("s")[0] ?? "").trim(),
        total: document.getElementById("totalDuration")?.textContent ?? "",
        save: document.getElementById("saveState")?.textContent ?? "",
        spec: document.getElementById("specBadge")?.hidden ? "fresh" : "stale"
      };
    };
    window.__lengthChanges = [];
    window.__lengthInputs = [];
    window.__lengthBaseline = window.__lengthRead();
    let last = JSON.stringify(window.__lengthBaseline);
    const tick = () => {
      const current = window.__lengthRead();
      const key = JSON.stringify(current);
      if (key !== last) { window.__lengthChanges.push({ at: Date.now(), value: current }); last = key; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    document.getElementById("narration").addEventListener("input", () => window.__lengthInputs.push(Date.now()));
  }, target.id);

  await page.evaluate((sceneId) => document.querySelector(`.timeline-clip[data-scene-id="${CSS.escape(sceneId)}"]`).click(), target.id);
  await page.waitForTimeout(1500);
  const narrationBaseline = await page.evaluate(() => {
    /* Re-baseline with the target scene selected: selection re-renders both
       lists, and anything logged before it belongs to an unrelated paint. */
    window.__lengthChanges = [];
    window.__lengthInputs = [];
    window.__lengthBaseline = window.__lengthRead();
    return window.__lengthBaseline;
  });

  await page.evaluate(() => {
    const field = document.getElementById("narration");
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  });
  await page.keyboard.type(NARRATION_EDIT, { delay: 40 });
  const typed = await page.evaluate(() => ({
    baseline: window.__lengthBaseline,
    changes: window.__lengthChanges,
    inputs: window.__lengthInputs
  }));
  const lastInputAt = typed.inputs.at(-1);
  const firstChange = typed.changes.find((change) => change.value.seconds !== typed.baseline.seconds);
  const lastChange = typed.changes.filter((change) => change.value.seconds !== typed.baseline.seconds).at(-1) ?? null;
  const latency = firstChange ? firstChange.at - lastInputAt : null;
  console.log(`\n[旁白改字] ${target.title} 基线 ${narrationBaseline.seconds}s / ${narrationBaseline.width}px / 总长 ${narrationBaseline.total} (${narrationBaseline.spec})`);
  if (!firstChange) {
    console.log("  ! 输入结束前卡片长度从未变化");
  } else {
    console.log(`  首次更新 +${latency}ms：${firstChange.value.seconds}s / ${firstChange.value.width}px / 总长 ${firstChange.value.total} (${firstChange.value.spec})`);
    console.log(`  输入结束：${lastChange.value.seconds}s / ${lastChange.value.width}px / 总长 ${lastChange.value.total}`);
    for (const change of typed.changes.slice(0, 4)) {
      console.log(`    [+${String(change.at - lastInputAt).padStart(7)}ms] ${change.value.seconds}s / ${change.value.width}px / 总长 ${change.value.total}  ${change.value.save}${change.value.spec === "stale" ? " ⊙" : ""}`);
    }
    console.log(`    … 共 ${typed.changes.length} 次重绘`);
  }
  if (latency === null || latency > MAX_LENGTH_LATENCY_MS) failures += 1;
  if (firstChange && firstChange.value.total === typed.baseline.total) {
    console.log("  ! 卡片长度变了但总时长没动，头部数字与条带自相矛盾");
    failures += 1;
  }

  /* The spec has to confirm the estimate rather than snap the clip back. */
  await page.waitForTimeout(25000);
  const finalState = await page.evaluate(() => window.__lengthRead());
  console.log(`  稳定后：${finalState.seconds}s / ${finalState.width}px / 总长 ${finalState.total} (${finalState.spec})`);
  if (!firstChange || !lastChange) failures += 1;
  else if (finalState.seconds !== lastChange.value.seconds || Math.abs(finalState.width - lastChange.value.width) > 2) {
    console.log("  ! 规格落地后卡片长度回跳，说明本地估算与服务端不一致");
    failures += 1;
  }
  if (finalState.spec !== "fresh") {
    console.log("  ! 规格始终没有刷新，无法确认估算与服务端一致");
    failures += 1;
  }

  for (const problem of problems) console.log("[warn]", problem);
  if (problems.length) failures += 1;
} finally {
  await browser?.close();
  cleanup();
}

console.log(failures ? "\nFAIL: 场景条带与长度不符（新增场景影响了其它卡片，或旁白改字后长度未及时更新）" : "\nOK: 新增场景只添加一张卡片，旁白改字后本卡片长度立即更新且与规格一致");
process.exit(failures ? 1 : 0);
