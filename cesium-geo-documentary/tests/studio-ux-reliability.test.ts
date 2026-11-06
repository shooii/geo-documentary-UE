import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../apps/studio/public/studio.js", import.meta.url), "utf8");
function section(start: string, end: string): string {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `missing source section ${start}`);
  return source.slice(first, last);
}
const saveSource = section("async function saveProject()", "/* Persistence is explicit");
const syncSource = section("async function syncProjectState()", "async function saveProject()");
const guardSource = section("async function saveBeforeAction(", "/* A scene's length follows");
const deferred = () => {
  let resolve!: (value: any) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture() {
  const nodes = new Map<string, any>();
  const project = { id: "a", revision: 1, name: "original", scenes: [{ id: "shared", narration: "before" }] };
  const state: any = { project, dirty: true, editEpoch: 1, savePromise: null, specRequest: 0, renderSpecStale: true };
  const context: any = {
    state, $: (id: string) => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); },
    api: async () => ({ ...project, revision: 2 }), upsertProjectList() {}, toastError() {}, askConfirm: async () => true,
    syncProjectState: async () => {}, clearTimeout() {}, render() {}, releaseSettledDrafts() {},
    refreshExportEstimate() {}, renderExportTimeline() {},
    renderSaveState(status: string) { context.$("saveState").textContent = status === "error" ? "保存失败，点击重试" : status === "saved" ? "已保存" : "保存中…"; },
  };
  runInNewContext(`${saveSource}\n${guardSource}\nthis.save = saveProject; this.saveBefore = saveBeforeAction;`, context);
  return { state, project, context, nodes };
}

test("slow save serializes requests and preserves all edits arriving during PUT", async () => {
  const f = fixture();
  const gate = deferred();
  const bodies: any[] = [];
  let active = 0, maxActive = 0;
  f.context.api = async (_path: string, options: any) => {
    const body = JSON.parse(options.body); bodies.push(body); active += 1; maxActive = Math.max(maxActive, active);
    if (bodies.length === 1) await gate.promise;
    active -= 1;
    return { ...body, revision: bodies.length + 1, name: body.name.trim() };
  };
  const first = f.context.save();
  f.project.scenes[0]!.narration = "typed during request";
  f.project.name = " normalized "; f.state.editEpoch += 1; f.state.dirty = true;
  const second = f.context.save();
  gate.resolve(null);
  await Promise.all([first, second]);
  assert.equal(maxActive, 1);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].scenes[0].narration, "typed during request");
  assert.equal(f.project.scenes[0]!.narration, "typed during request");
  assert.equal(f.project.name, "normalized", "settled response accepts server normalization");
  assert.equal(f.state.project, f.project, "project object identity stays stable");
  assert.equal(f.state.dirty, false);
});

test("failed save preserves dirty edits and can be retried explicitly", async () => {
  const f = fixture();
  f.context.api = async () => { throw new Error("offline"); };
  await assert.rejects(f.context.save(), /offline/);
  assert.equal(f.state.dirty, true);
  assert.match(f.nodes.get("saveState").textContent, /保存失败.*重试/);
  assert.equal(f.state.project, f.project);
  assert.equal(f.state.savePromise, null);
  f.context.api = async () => ({ ...f.project, revision: 2 });
  await f.context.save();
  assert.equal(f.state.dirty, false);
  assert.equal(f.project.revision, 2);
});

test("saveBeforeAction never writes without explicit confirmation", async () => {
  const f = fixture();
  let writes = 0;
  f.context.api = async (_path: string, options: any) => { writes += 1; return { ...JSON.parse(options.body), revision: 2 }; };
  f.context.askConfirm = async () => false;
  assert.equal(await f.context.saveBefore("继续导出"), false);
  assert.equal(writes, 0);
  assert.equal(f.state.dirty, true);
  f.context.askConfirm = async () => true;
  assert.equal(await f.context.saveBefore("继续导出"), true);
  assert.equal(writes, 1);
  assert.equal(f.state.dirty, false);
});

test("an old save response cannot change a different project's state", async () => {
  const f = fixture(); const gate = deferred();
  f.context.api = () => gate.promise;
  const pending = f.context.save();
  const other = { id: "b", revision: 7 };
  f.state.project = other; f.state.dirty = true;
  gate.resolve({ ...f.project, revision: 2 });
  await pending;
  assert.equal(f.state.project, other);
  assert.equal(other.revision, 7);
  assert.equal(f.state.dirty, true);
});

test("edits arriving during spec refresh are persisted before save resolves", async () => {
  const f = fixture(); let writes = 0; let refreshes = 0;
  f.context.api = async (_path: string, options: any) => ({ ...JSON.parse(options.body), revision: ++writes + 1 });
  f.context.syncProjectState = async () => {
    if (++refreshes === 1) {
      f.project.scenes[0]!.narration = "edited during refresh";
      f.state.editEpoch += 1; f.state.dirty = true;
    }
  };
  await f.context.save();
  assert.equal(writes, 2);
  assert.equal(f.state.dirty, false);
});

for (const scenario of ["new edit", "wrong revision", "other project", "older request"] as const) {
  test(`spec refresh refuses stale context: ${scenario}`, async () => {
    const f = fixture(); const gate = deferred(); let released = false;
    f.state.dirty = false;
    f.state.renderSpec = { sentinel: true };
    f.context.api = () => gate.promise;
    f.context.releaseSettledDrafts = () => { released = true; };
    runInNewContext(`${syncSource}\nthis.sync = syncProjectState;`, f.context);
    const pending = f.context.sync();
    if (scenario === "new edit") { f.state.editEpoch += 1; f.state.dirty = true; }
    if (scenario === "other project") f.state.project = { id: "b", revision: 1 };
    if (scenario === "older request") f.state.specRequest += 1;
    gate.resolve({ projectRevision: scenario === "wrong revision" ? 0 : 1 });
    await pending;
    assert.equal(released, false);
    assert.equal(f.state.renderSpec.sentinel, true);
    assert.equal(f.state.renderSpecStale, true);
  });
}

test("saving and structural operations retain guarded failure paths", () => {
  assert.doesNotMatch(source, /setTimeout\(\(\) => saveProject\(\)\.catch\(\(\) => undefined\), 700\)/);
  assert.match(source, /async function saveBeforeAction\(/);
  assert.match(source, /只有点击“保存方案”后，场景修改才会生效/);
  assert.match(source, /state\.assetUndoStack\.push\(\{ \.\.\.record, projectId: state\.project\?\.id \}\)/);
  assert.match(source, /const project = state\.project;\s*if \(!project \|\| record\.projectId !== project\.id\)/);
  assert.match(source, /host\.hidden = false;\s*host\.classList\.toggle\("is-warning", interrupted\)/);
  assert.match(source, /button\.dataset\.exportAction === "diagnostics"/);
});
