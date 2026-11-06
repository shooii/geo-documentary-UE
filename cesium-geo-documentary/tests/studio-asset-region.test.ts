import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AssetRegionEvidence, withRegionAssetLibrary } from "../apps/studio/asset-library.js";
import type { StudioAsset, VideoProject } from "../packages/project-schema/index.js";

const WUSHI = "440882115";
const QINDOU = "440882116";
function asset(id: string, regionId?: string, projectId?: string): StudioAsset {
  return { id, name: id, path: `/workspace-assets/${id}.png`, type: "image", ...(regionId || projectId ? { scope: { ...(regionId ? { regionId } : {}), ...(projectId ? { projectId } : {}) } } : {}) };
}
function project(id: string, regionId: string, assets: StudioAsset[] = [], used: string[] = [], updatedAt = "2026-09-18T00:00:00.000Z"): VideoProject {
  return { id, regionId, assets, updatedAt, scenes: [{ id: "scene", assetIds: used, placements: used.map(assetId => ({ assetId })) }] } as VideoProject;
}

test("same-region schemes share uploads and POI media regardless of originating project", () => {
  const upload = asset("upload", WUSHI, "first");
  const poi = { ...asset("poi", WUSHI, "first"), sourceType: "amap-poi" as const, scope: { regionId: WUSHI, projectId: "first", childId: "village" } };
  const other = asset("other", QINDOU, "qindou");
  for (const id of ["first", "second", "third"]) {
    const result = withRegionAssetLibrary(project(id, WUSHI), [upload, poi, other]);
    assert.deepEqual(result.assets.map(a => a.id), ["upload", "poi"]);
    assert.equal(result.assets[1]!.scope!.childId, "village");
  }
  assert.deepEqual(withRegionAssetLibrary(project("q", QINDOU), [upload, poi, other]).assets, [other]);
});

test("stale globally merged snapshots and forged scopes cannot leak other towns", () => {
  const canonical = asset("foreign", QINDOU);
  const forged = asset("foreign", WUSHI);
  const local = asset("local", WUSHI);
  const original = project("p", WUSHI, [forged, local], ["foreign", "local"]);
  const result = withRegionAssetLibrary(original, [canonical, local]);
  assert.deepEqual(result.assets, [local]);
  assert.deepEqual(result.scenes[0]!.assetIds, ["local"]);
  assert.deepEqual(result.scenes[0]!.placements!.map(p => p.assetId), ["local"]);
  assert.deepEqual(original.scenes[0]!.assetIds, ["foreign", "local"], "source snapshot is not mutated");
});

test("unknown ownership and deleted uploads stay hidden; canonical metadata wins", () => {
  const unscoped = asset("unknown");
  const old = asset("local", WUSHI);
  const canonical = { ...old, name: "renamed" };
  const result = withRegionAssetLibrary(project("p", WUSHI, [unscoped, old, asset("deleted", WUSHI)]), [unscoped, canonical]);
  assert.deepEqual(result.assets, [canonical]);
});

test("regional baseline media is retained, without duplicating catalog entries", () => {
  const baseline = { ...asset("baseline"), path: "assets/source/local.png" };
  const local = asset("local", WUSHI);
  assert.deepEqual(withRegionAssetLibrary(project("p", WUSHI, [baseline, local]), [local, local]).assets, [baseline, local]);
});

test("legacy ownership uses actual scene references rather than global list membership", () => {
  const a = asset("legacy");
  const evidence = new AssetRegionEvidence();
  evidence.observe(project("other", QINDOU, [a]));
  evidence.observe(project("owner", WUSHI, [a], [a.id]));
  assert.equal(evidence.resolve(a), WUSHI);
});

test("an unbound upload is recovered from its uniquely earliest snapshot", () => {
  const a = asset("legacy");
  const evidence = new AssetRegionEvidence();
  evidence.observe(project("later", QINDOU, [a], [], "2026-09-19T00:00:00Z"));
  evidence.observe(project("owner", WUSHI, [a], [], "2026-09-18T00:00:00Z"));
  assert.equal(evidence.resolve(a), WUSHI);
});

test("conflicting uses and tied first appearances are not silently assigned", () => {
  for (const used of [true, false]) {
    const a = asset("ambiguous");
    const evidence = new AssetRegionEvidence();
    evidence.observe(project("a", WUSHI, [a], used ? [a.id] : []));
    evidence.observe(project("b", QINDOU, [a], used ? [a.id] : []));
    assert.equal(evidence.resolve(a), undefined);
  }
  assert.equal(new AssetRegionEvidence().resolve(asset("orphan")), undefined);
});

test("explicit region ownership takes priority over stale history; old project scopes migrate", () => {
  const evidence = new AssetRegionEvidence();
  const a = asset("scoped", QINDOU, "q");
  evidence.observe(project("p", WUSHI, [a], [a.id]));
  evidence.observe(project("q", QINDOU));
  assert.equal(evidence.resolve(a), QINDOU);
  assert.equal(evidence.resolve(asset("old", undefined, "q")), QINDOU);
  evidence.observe(project("q", WUSHI));
  assert.equal(evidence.resolve(asset("old", undefined, "q")), undefined);
});

test("upload ownership is resolved server-side from the captured project, not a supplied region", async () => {
  const server = await readFile(new URL("../apps/studio/server.ts", import.meta.url), "utf8");
  // Where the sidecar is actually written now; the router only routes to it.
  const store = await readFile(new URL("../apps/studio/asset-store.ts", import.meta.url), "utf8");
  const client = await readFile(new URL("../apps/studio/public/studio.js", import.meta.url), "utf8");
  assert.match(server, /if \(!input\.projectId\) throw new HttpError\(400/);
  assert.match(server, /const owner = await readProject\(input\.projectId\)/);
  assert.match(store, /scope: \{ regionId: owner\.regionId, projectId: owner\.id \}/);
  assert.match(server, /return withRegionAssetLibrary\(project, await readWorkspaceAssetLibrary\(\)\)/);
  // The upload carries the project id and the file's own name - never a region
  // the client picked. The display name (extension stripped) is derived from the
  // bytes and the request on the server side.
  assert.match(client, /new URLSearchParams\(\{ projectId: project\.id, name: file\.name, alt: displayName \}\)/);
  assert.match(client, /if \(state\.project !== project\) \{\s*item\.error = "已存入原方案所属素材库，未绑定到当前方案";\s*continue;/);
  assert.match(client, /if \(batch\.projectId !== project\.id\) return toastError/);
});
