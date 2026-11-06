import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

async function sources() {
  return Promise.all([
    readFile(resolve(root, "apps/studio/public/index.html"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
  ]);
}

test("new project creation makes the administrative area explicit and reuses the picker", async () => {
  const [html, source] = await sources();

  assert.match(html, /id="newProjectRegionName"/);
  assert.match(html, /id="newProjectRegionPath"/);
  assert.match(html, /id="changeNewProjectRegion"/);
  assert.match(html, /按所选行政区自动命名/);
  assert.doesNotMatch(html, /<\/section>>/);

  assert.match(source, /async function createProjectFromList\(name\)\s*\{\s*const regionId = state\.creation\.regionId/);
  assert.match(source, /JSON\.stringify\(\{ regionId, \.\.\.\(name \? \{ name \} : \{\}\) \}\)/);
  assert.match(source, /function setNewProjectOpen\(open, preserveCreationRegion = false\)/);
  assert.match(source, /setNewProjectOpen\(true, true\);/);
  assert.match(source, /state\.creation\.selectingRegion\s*\?\s*"选择此地区并继续"/);
  assert.match(source, /state\.creation\.busy = false;\s*setNewProjectOpen\(true, true\)/);
  assert.doesNotMatch(source, /async function createProject\(regionId = state\.admin\.selected\?\.code \|\| state\.project\?\.regionId \|\| "440825112"\)/);

  // Choosing a region in the picker leaves "选择此地区并继续" on the panel button, so
  // the next click silently created the plan under the server default name; the
  // branch has to hand the button back to the action it now performs.
  const pickerBranch = source.slice(
    source.indexOf("if (state.creation.selectingRegion) {"),
    source.indexOf("createProject(state.admin.selected?.code);")
  );
  assert.ok(pickerBranch.length > 0);
  assert.ok(pickerBranch.includes("updateNewProjectContext();"));
  assert.ok(pickerBranch.includes("updateRegionSelection(node);"), "the picker branch must refresh the panel button");
  assert.ok(pickerBranch.indexOf("updateNewProjectContext();") < pickerBranch.indexOf("updateRegionSelection(node);"));
});

test("new project failures release both busy states so the form can be retried", async () => {
  const [, source] = await sources();
  const creation = /async function createProjectFromList\(name\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(creation);
  assert.match(creation, /try \{/);
  assert.match(creation, /finally \{[\s\S]*?state\.creation\.busy = false;[\s\S]*?setProjectBusy\(false\);/);

  const confirm = /async function confirmNewProject\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(confirm);
  assert.match(confirm, /setNewProjectOpen\(false\);/);
  assert.match(confirm, /state\.creation\.busy = false;/);
  assert.match(confirm, /showNewProjectError\(error\.message\);/);
});


test("the shared busy card rewrites both lines so a new plan never looks like the open one", async () => {
  const [, source] = await sources();

  // 安铺镇 was open, the operator created a plan for another town, and the card
  // still read "正在打开方案：安铺镇地理图说" above "正在创建新方案…": `setProjectBusy`
  // only wrote the fields its caller passed, so the previous request's title
  // survived into the next one. Both lines are now written on every show.
  const busy = /function setProjectBusy\(show, stage = "", title = ""\) \{[\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(busy);
  assert.match(busy, /\$\("projectBusyTitle"\)\.textContent = title \|\| [A-Z_]+;/);
  assert.match(busy, /\$\("projectBusyStage"\)\.textContent = stage \|\| "";/);
  assert.doesNotMatch(busy, /if \(title\)/);

  // Every caller that names what it is doing passes both; the two that could not
  // know a name yet fall back to the card's own default title.
  assert.match(source, /setProjectBusy\(true, "正在创建项目…", `正在创建方案：\$\{selectedNode\?\.name \|\| regionId\}`\);/);
  assert.match(source, /setProjectBusy\(true, "正在创建新方案…", `正在创建方案：\$\{name \|\| state\.creation\.regionName \|\| ""\}`\);/);
  assert.match(source, /setProjectBusy\(true, "正在启动工作台并加载最近方案…"\);/);
  assert.match(source, /const PROJECT_BUSY_DEFAULT_TITLE = "正在打开方案…";/);

  // The title names the node it is about, so it has to be built *after* that node is
  // resolved: reading `selectedNode` above its own `const` is a temporal-dead-zone
  // ReferenceError that aborts the whole creation instead of mistitling the card.
  const create = /async function createProject\(regionId = state\.admin\.selected\?\.code\) \{[\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(create);
  assert.ok(create.indexOf("const selectedNode") < create.indexOf('setProjectBusy(true, "正在创建项目…"'), "the busy card must be shown after selectedNode exists");
});

test("the suggested plan name never collides with an existing plan", async () => {
  const [, source] = await sources();

  // 新建方案 pre-filled `${region}地理图说` - the exact name the open plan of that
  // region already carries - so the first click was rejected with 已存在同名方案
  // and the operator had to invent a name. The suggestion now takes the suffix the
  // server itself would apply, and every entry point uses it.
  const suggest = /function suggestProjectName\(region\) \{[\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(suggest);
  assert.match(suggest, /if \(!isDuplicateProjectName\(base\)\) return base;/);
  assert.match(suggest, /const candidate = `\$\{base\}（\$\{index\}）`;/);
  assert.match(suggest, /if \(!isDuplicateProjectName\(candidate\)\) return candidate;/);

  assert.match(source, /input\.value = suggestProjectName\(name\); state\.creation\.nameTouched = false;/);
  assert.match(source, /\$\("newProjectName"\)\.value = state\.creation\.pendingName \|\| suggestProjectName\(node\.name\);/);
  assert.match(source, /\|\| suggestProjectName\(state\.creation\.regionName \|\| regionId\);/);
  assert.doesNotMatch(source, /`\$\{name\}地理图说`/);
  assert.doesNotMatch(source, /`\$\{node\.name\}地理图说`/);
});

test("changing the region refreshes the auto-suggested plan name", async () => {
  const [, source] = await sources();

  // 草潭镇 (440823113): the picker auto-fills `${region}地理图说`, and the old flow
  // captured that suggestion as if the operator had typed it. Picking a new region
  // then restored the *previous* region's name, so the modal offered
  // "安铺镇地理图说" for 草潭镇 and created a project whose name contradicted its
  // region. The suggestion is now tracked apart from a deliberate edit.
  assert.match(source, /creation: \{ regionId: null, regionName: "", breadcrumb: "", selectingRegion: false, pendingName: "", nameTouched: false, busy: false \}/);
  assert.match(source, /state\.creation\.pendingName = state\.creation\.nameTouched \? String\(\$\("newProjectName"\)\.value \|\| ""\)\.trim\(\) : "";/);
  assert.match(source, /\$\("newProjectName"\)\.oninput = \(\) => \{ state\.creation\.nameTouched = true; \};/);
  assert.match(source, /state\.creation\.nameTouched = Boolean\(state\.creation\.pendingName\);/);
  // Opening a fresh modal has to reset the flag, or the first region change would
  // inherit the previous session's edit and still suggest the wrong name.
  assert.match(source, /state\.creation\.pendingName = "";\s*state\.creation\.nameTouched = false;\s*\$\("newProjectName"\)\.value = "";/);
});
