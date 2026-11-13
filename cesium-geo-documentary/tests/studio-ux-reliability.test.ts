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

function coverFixture() {
  const project = { id: "a", cover: { administrativeLabel: "标题", subtitle: "副标题", contentMeta: "底部" } };
  const state: any = { project, coverPreviewRequest: 0, coverPreviewInFlight: false, coverPreviewPending: false };
  const timers = new Map<number, () => any>();
  const nodes = new Map<string, any>();
  const requests: { body: any; gate: ReturnType<typeof deferred> }[] = [];
  const errors: string[] = [];
  let nextTimer = 0, created = 0, revoked = 0, dirty = 0;
  const context: any = {
    state,
    $: (id: string) => { if (!nodes.has(id)) nodes.set(id, { dataset: {} }); return nodes.get(id); },
    fetch: (_path: string, options: any) => {
      const gate = deferred(); requests.push({ body: JSON.parse(options.body), gate }); return gate.promise;
    },
    URL: { createObjectURL: () => `blob:${++created}`, revokeObjectURL: () => { revoked++; } },
    setTimeout: (fn: () => any) => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: (id: number) => timers.delete(id),
    toastError: (message: string) => errors.push(message),
    markDirty: () => { dirty++; },
    render: () => { throw new Error("cover typing must not rebuild the editor"); }
  };
  runInNewContext(`${section("async function refreshCoverPreview()", "function isOpeningScene(")}\nthis.refresh = refreshCoverPreview; this.schedule = scheduleCoverPreview;`, context);
  return {
    state, project, context, requests, errors, nodes, timers,
    counts: () => ({ created, revoked, dirty }),
    flushTimer: () => {
      const callbacks = [...timers.values()]; timers.clear();
      return Promise.all(callbacks.map((fn) => fn()));
    }
  };
}
const previewResponse = () => ({ ok: true, blob: async () => ({}) });

test("cover preview serializes slow requests and coalesces edits to the latest text", async () => {
  const f = coverFixture();
  const first = f.context.refresh();
  for (const text of ["第一次修改", "第二次修改", "最终修改"]) {
    f.project.cover.subtitle = text; f.context.schedule(); await f.flushTimer();
  }
  assert.equal(f.requests.length, 1, "a slow image request must not fan out");
  f.requests[0]!.gate.resolve(previewResponse()); await first;
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1]!.body.cover.subtitle, "最终修改");
  assert.equal(f.counts().created, 0, "superseded image must not be displayed");
  f.requests[1]!.gate.resolve(previewResponse());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.nodes.get("coverPreview").src, "blob:1");
  assert.equal(f.state.coverPreviewInFlight, false);
});

test("cover responses cannot overwrite edits during debounce or another project", async () => {
  for (const scenario of ["debounce", "switch"]) {
    const f = coverFixture(); const pending = f.context.refresh();
    if (scenario === "debounce") { f.project.cover.subtitle = "new"; f.context.schedule(); }
    else f.state.project = { id: "b", cover: { subtitle: "other" } };
    f.requests[0]!.gate.resolve(previewResponse()); await pending;
    assert.equal(f.counts().created, 0, scenario);
    assert.equal(f.errors.length, 0);
  }
});

test("failed cover request releases the queue and a later edit still updates", async () => {
  const f = coverFixture(); const first = f.context.refresh();
  f.requests[0]!.gate.reject(new Error("offline")); await first;
  assert.equal(f.errors.length, 1);
  assert.equal(f.state.coverPreviewInFlight, false);
  const retry = f.context.refresh();
  f.requests[1]!.gate.resolve(previewResponse()); await retry;
  const next = f.context.refresh(); f.requests[2]!.gate.resolve(previewResponse()); await next;
  assert.equal(f.counts().created, 2);
  assert.equal(f.counts().revoked, 1, "old image URL is released");
});

test("all three cover fields preserve typing and defer Chinese composition without rerender", async () => {
  const f = coverFixture();
  runInNewContext(section("  const coverFields =", '  $("coverIntro").onchange'), f.context);
  const fields = { coverAdministrativeLabel: "administrativeLabel", coverSubtitle: "subtitle", coverContentMeta: "contentMeta" } as const;
  for (const [id, key] of Object.entries(fields)) {
    const input = f.nodes.get(id);
    input.oninput({ target: { value: "拼音组合" }, isComposing: true });
    assert.equal(f.project.cover[key as keyof typeof f.project.cover], "拼音组合");
    assert.equal(f.timers.size, 0);
    input.oncompositionend();
    assert.equal(f.timers.size, 1);
    input.oninput({ target: { value: "正式中文" }, isComposing: false });
    assert.equal(f.timers.size, 1);
  }
  const pending = f.flushTimer();
  assert.equal(f.requests.length, 1);
  f.requests[0]!.gate.resolve(previewResponse()); await pending;
  assert.equal(f.counts().dirty, 6);
});

test("saving and structural operations retain guarded failure paths", () => {
  assert.doesNotMatch(source, /setTimeout\(\(\) => saveProject\(\)\.catch\(\(\) => undefined\), 700\)/);
  assert.match(source, /async function saveBeforeAction\(/);
  assert.match(source, /只有点击“保存方案”后，场景修改才会生效/);
  assert.match(source, /state\.assetUndoStack\.push\(\{ \.\.\.record, projectId: state\.project\?\.id \}\)/);
  assert.match(source, /const project = state\.project;\s*if \(!project \|\| record\.projectId !== project\.id\)/);
  assert.match(source, /host\.hidden = false;\s*host\.classList\.toggle\("is-warning", interrupted\)/);
  assert.match(source, /button\.dataset\.exportAction === "diagnostics"/);
});
