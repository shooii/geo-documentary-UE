import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("Studio UI polish keeps the editor contract and adds one shared visual system", async () => {
  const [html, css] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/index.html"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio-refine.css"), "utf8"),
  ]);

  for (const id of [
    "projectName",
    "openProjectList",
    "saveProjectButton",
    "openExportPanel",
    "sceneList",
    "cesiumPreview",
    "sceneInspector",
    "timelineScenes",
    "assetAnimation",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} must remain wired`);
  }

  // Assert the cache-busting token exists, not its literal value: the token is bumped
  // on every stylesheet/script edit (see topic studio-ui), and pinning the exact string
  // turns a routine bump into a false failure.
  assert.match(html, /studio-refine\.css\?v=[0-9A-Za-z-]+/);
  for (const token of ["--ui-panel", "--ui-accent", "--ui-line", "--ui-radius-md", "--ui-shadow-deep"]) {
    assert.match(css, new RegExp(`${token.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}:`));
  }
  assert.match(css, /\.stage-canvas::before\{content:"PREVIEW CANVAS"/);
  assert.match(css, /\.scene-item\.active\{/);
  assert.match(css, /\.timeline-clip\.active\{/);
  assert.match(css, /@media \(max-width:760px\)/);
});

/**
 * The manual save must report what it actually persisted.
 *
 * Source-level, because this behaviour lives in module-scoped state that no
 * DOM-free test can reach. The contract is narrow enough to pin by text: the
 * dialog used to choose its wording from `nameChanged` alone, so an operator who
 * edited something and hit 保存方案 inside the 700ms autosave debounce had the
 * change written and was told「方案已是最新状态」-- which reads as "you had nothing
 * to save" right after they changed something. They press save again, get the same
 * line, and conclude the save is broken instead of noticing it already worked.
 */
test("the save dialog reports what it persisted, and stays quiet when there was nothing to save", async () => {
  const source = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");

  // The lie: wording chosen from the name alone.
  assert.doesNotMatch(source, /toast\(nameChanged \? "方案已保存" : "方案已是最新状态"\)/);
  // The nag itself is gone: a dialog asked to save with nothing to save says nothing.
  // Match the string literal, not the phrase -- the comment above the check quotes
  // it while explaining the bug, and a bare /方案已是最新状态/ hits that too.
  assert.doesNotMatch(source, /"方案已是最新状态"/);
  assert.doesNotMatch(source, /toast\([^()]*已是最新/);
  // What replaces it: remember whether there was anything to write, then say so.
  assert.match(source, /const pendingChanges = state\.dirty;/);
  assert.match(source, /if \(nameChanged \|\| pendingChanges\) toast\("方案已保存"\);/);
  // A failed save must not be reported as a quiet success.
  assert.match(source, /if \(state\.dirty\) return;\s+\/\/ the save failed and already reported it/);
});

/**
 * The body of one top-level function, by brace matching.
 *
 * Naive counting is enough here (the functions this is used on have balanced
 * braces inside their strings and template placeholders), and a body that comes
 * out too large can only make the assertions below more forgiving, never fail a
 * correct tree.
 */
function functionBody(source: string, name: string): string {
  const signature = new RegExp(`(?:async )?function ${name}\\s*\\(`).exec(source);
  assert.ok(signature, `找不到函数 ${name}`);
  const start = source.indexOf("{", signature.index);
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`函数 ${name} 的花括号不配对`);
}

test("whatever shows the busy card hides it on every exit path", async () => {
  const source = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");
  /* The busy card covers the whole viewport. A function that shows it and hides it
     on its last line alone leaves the editor frozen until the 90-second safety net
     when any await in between fails -- observed live in openSavedProject, which
     awaits the project fetch, the region lookup, the spec refresh and the audio
     probe. Every shower must therefore hide in a `finally`. */
  for (const name of ["openSavedProject", "removeSelectedAssetsFromLibrary", "createProjectFromList"]) {
    const body = functionBody(source, name);
    assert.match(body, /setProjectBusy\(true/, `${name} 应当会显示忙碌遮罩（若不再显示，请更新本测试）`);
    assert.match(body, /finally\s*\{[\s\S]*?setProjectBusy\(false\)/, `${name} 必须在 finally 里关掉忙碌遮罩`);
  }
});

test("every scheme list is ordered by one real comparator", async () => {
  const source = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");
  /* updatedAt is an ISO string. `(b.updatedAt || 0) - (a.updatedAt || 0)` looks
     like a comparison and returns NaN, which leaves the array in whatever order
     the engine holds -- so an undeleted scheme dropped into the list wherever.
     Three sites ordered schemes; now they share one function. */
  // Match the comparator, not the phrase: the comment on byUpdatedAtDesc quotes the
  // broken expression while explaining it, and a bare /updatedAt || 0/ hits that too.
  assert.doesNotMatch(source, /sort\(\(a, b\) => \(b\.updatedAt \|\| 0\)\s*-/, "对 ISO 字符串做减法不是比较（NaN）");
  for (const site of [
    "const fallback = projects.sort(byUpdatedAtDesc)[0];",
    "const sorted = [...state.projects].sort(byUpdatedAtDesc);",
    "state.projects = [...state.projects, restored].sort(byUpdatedAtDesc);",
  ]) {
    assert.ok(source.includes(site), `方案列表排序应统一走 byUpdatedAtDesc：缺 ${site}`);
  }
  assert.match(source, /function byUpdatedAtDesc\(a, b\) \{ return \(b\.updatedAt \|\| ""\)\.localeCompare\(a\.updatedAt \|\| ""\); \}/);
});

test("a broken thumbnail says so instead of leaving a black square", async () => {
  const [source, css] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio-refine.css"), "utf8"),
  ]);
  /* The bound-asset card holds its <img> directly (no .spa-media wrapper). The
     old showMediaMissing looked the wrapper up with closest(), got null, hid the
     image and returned *before* adding anything -- so a failed picture became an
     unexplained dark rectangle, i.e. "the thumbnail went black". It must resolve
     a container first, and hide the media only once there is somewhere to put
     the notice. */
  const body = functionBody(source, "showMediaMissing");
  assert.match(body, /el\.closest\([^)]*\)\s*\|\|\s*el\.parentElement/, "必须回退到父元素，否则卡片里没有放占位的地方");
  assert.match(body, /if \(!wrap\) return;[\s\S]*?el\.style\.display = "none"/, "先确认有落点，再隐藏媒体");
  assert.doesNotMatch(body, /const wrap = el\.closest\([^)]*\);[\s\S]*?if \(!wrap \|\|/, "不能再在拿不到 wrapper 时直接 bail");

  /* And the placeholder has to be styled outside .spa-media, or the card shows
     an unstyled block where the picture was. Matched without anchoring on what
     follows the selector, since it may share a rule with the picker's. */
  assert.match(css, /\.scene-bound-asset \.media-missing/, "绑定卡片里的缺失占位需要有尺寸样式");
  assert.match(css, /^\.media-missing\{/m, "media-missing 的通用外观不能再挂在 .spa-media 下");

  /* A freshly re-rendered <img> can report complete===true with naturalWidth 0
     before its decode commits. Judging that immediately hid a good picture for
     the rest of the card's life. */
  const bind = functionBody(source, "bindAssetMedia");
  assert.match(bind, /setTimeout\(\(\) => \{ if \(img\.naturalWidth === 0\) showMediaMissing\(img\); \}, 0\)/,
    "complete 但宽高为 0 时必须延后判定，不能当场判死");
});
