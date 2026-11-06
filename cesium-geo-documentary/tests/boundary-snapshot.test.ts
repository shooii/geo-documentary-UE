import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  captureBoundarySnapshot,
  deleteBoundarySnapshot,
  hasBoundarySnapshot,
  resolveWorkspacePath,
  snapshotFile
} from "../apps/studio/boundary-snapshot.js";
import { geometrySignature } from "../apps/studio/project-service.js";
import { guardFreeEnv, rmGuarded } from "./safe-delete.js";

const root = resolve(import.meta.dirname, "..");

/**
 * `data/regions/*.json` and `data/normalized/*.geojson` are workspace-wide
 * singletons. Re-importing a region rewrites them in place, and before
 * snapshots existed that silently redrew every scheme already authored against
 * the previous boundary — 草潭镇 lost 10 of its 21 child shapes and 4 names to
 * exactly that. These tests pin the replacement contract: a scheme reads its
 * own frozen copy, and the live files only drive schemes that have none.
 */

/** A miniature workspace: one township under one county, with a sibling fallback. */
async function makeFixtureRoot(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "geo-boundary-"));
  for (const directory of ["data/regions", "data/normalized", "data/raw", "workspace/projects"]) {
    await mkdir(join(fixture, directory), { recursive: true });
  }
  const write = (relative: string, value: unknown) => writeFile(join(fixture, relative), JSON.stringify(value), "utf8");
  await write("data/regions/990000.json", { id: "990000", name: "上级区", geometryPath: "data/normalized/990000.geojson" });
  await write("data/regions/990000.timeline.json", { duration: 12 });
  await write("data/normalized/990000.geojson", { type: "FeatureCollection", features: [] });
  await write("data/regions/990001.json", {
    id: "990001", name: "测试镇", parentId: "990000",
    geometryPath: "data/normalized/990001.geojson",
    childGeometryPath: "data/normalized/990001-children.geojson"
  });
  await write("data/normalized/990001.geojson", { type: "FeatureCollection", features: [{ properties: { id: "990001" } }] });
  await write("data/normalized/990001-children.geojson", { type: "FeatureCollection", features: [{ properties: { id: "990001001", name: "甲村" } }] });
  await write("data/regions/990001.timeline.json", { duration: 12 });
  await write("data/raw/990000_full.geojson", { type: "FeatureCollection", features: [{ properties: { id: "990000" } }] });
  return fixture;
}

test("capturing a snapshot mirrors every file the map reads for the region", async () => {
  const fixture = await makeFixtureRoot();
  try {
    const manifest = await captureBoundarySnapshot(fixture, "project-fixture", "990001");

    assert.equal(manifest.regionId, "990001");
    assert.deepEqual(manifest.regionChain, ["990000", "990001"], "the ancestor chain is part of the opening context");
    const paths = manifest.files.map((file) => file.path);
    assert.ok(paths.includes("data/regions/990001.json"));
    assert.ok(paths.includes("data/regions/990001.timeline.json"));
    assert.ok(paths.includes("data/normalized/990001.geojson"));
    assert.ok(paths.includes("data/normalized/990001-children.geojson"));
    assert.ok(paths.includes("data/regions/990000.json"), "the parent outline is drawn too");
    assert.ok(paths.includes("data/raw/990000_full.geojson"), "the sibling context has no record naming it, but is still an input");
    assert.deepEqual(manifest.missing, []);
    assert.match(manifest.digest, /^sha256:[0-9a-f]{64}$/);
    assert.ok(await hasBoundarySnapshot(fixture, "project-fixture"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("a re-imported source no longer reaches a scheme that was already made", async () => {
  const fixture = await makeFixtureRoot();
  try {
    await captureBoundarySnapshot(fixture, "project-fixture", "990001");
    const frozen = await snapshotFile(fixture, "project-fixture", "data/normalized/990001-children.geojson");
    assert.ok(frozen);
    const before = await readFile(frozen!, "utf8");

    await writeFile(
      join(fixture, "data", "normalized", "990001-children.geojson"),
      JSON.stringify({ type: "FeatureCollection", features: [{ properties: { id: "990001001", name: "甲社区" } }] }),
      "utf8"
    );

    const live = await readFile(join(fixture, "data", "normalized", "990001-children.geojson"), "utf8");
    assert.match(live, /甲社区/, "the live file really did change, so the freeze below is not a no-op");
    assert.equal(await readFile(frozen!, "utf8"), before);
    const stillFrozen = await snapshotFile(fixture, "project-fixture", "data/normalized/990001-children.geojson");
    assert.equal(await readFile(stillFrozen!, "utf8"), before, "the scheme keeps the boundary it was authored against");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("a scheme without a snapshot still reads the live workspace data", async () => {
  const fixture = await makeFixtureRoot();
  try {
    assert.equal(await snapshotFile(fixture, "project-unknown", "data/regions/990001.json"), null);
    assert.equal(await snapshotFile(fixture, undefined, "data/regions/990001.json"), null);
    assert.equal(await hasBoundarySnapshot(fixture, "project-unknown"), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("snapshot lookups refuse to escape the workspace", async () => {
  const fixture = await makeFixtureRoot();
  try {
    await captureBoundarySnapshot(fixture, "project-fixture", "990001");
    assert.equal(resolveWorkspacePath(fixture, "../outside.json"), null);
    assert.equal(resolveWorkspacePath(fixture, "data/../../outside.json"), null);
    assert.equal(resolveWorkspacePath(fixture, "data/regions/990001.json"), join(fixture, "data", "regions", "990001.json"));
    // A traversing path is simply not part of the mirror, so it can never resolve.
    assert.equal(await snapshotFile(fixture, "project-fixture", "../../etc/passwd"), null);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Studio signs a scheme against its frozen geometry, not the live files", async () => {
  const projectId = "boundarysnaptest";
  // These two tests clean up a snapshot under the real workspace rather than under
  // the OS temp dir, so the sandbox's delete guard charges them against the shared
  // per-session budget. A full `pnpm test` run exhausts that budget, and these two
  // were the first casualties — they failed only in the full run, never alone.
  // Removing the fixture through a shim-free child keeps them deterministic.
  rmGuarded(join(root, "workspace", "projects", `${projectId}.boundary`));
  try {
    await captureBoundarySnapshot(root, projectId, "440823113");
    const liveSignature = await geometrySignature(root, "440823113");
    assert.equal(await geometrySignature(root, "440823113", projectId), liveSignature, "a fresh snapshot matches the source it was taken from");

    // Tamper with the frozen copy only. The scheme must follow it — both for the
    // export cache key and for what the map draws — while the workspace-wide
    // signature stays put, because the live file was never touched.
    const frozen = await snapshotFile(root, projectId, "data/normalized/440823113-children.geojson");
    assert.ok(frozen);
    await writeFile(frozen!, JSON.stringify({ type: "FeatureCollection", features: [] }), "utf8");
    assert.notEqual(await geometrySignature(root, "440823113", projectId), liveSignature);
    assert.equal(await geometrySignature(root, "440823113"), liveSignature);
  } finally {
    rmGuarded(join(root, "workspace", "projects", `${projectId}.boundary`));
  }
});

async function startPlayerServer(port: number): Promise<{ child: ChildProcess; origin: string }> {
  const child = spawn(
    process.execPath,
    [resolve(root, "node_modules", "tsx", "dist", "cli.mjs"), "apps/cesium-player/server.ts", `--port=${port}`],
    // The server is only read for this test, but keep it off the shared delete
    // budget too so a later cleanup inside it cannot fail the run.
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: guardFreeEnv() }
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`player server exited with ${child.exitCode}: ${output}`);
    try {
      const response = await fetch(`${origin}/runtime-config.json`);
      if (response.ok) return { child, origin };
    } catch {
      // Not listening yet.
    }
    await new Promise((settle) => setTimeout(settle, 200));
  }
  child.kill();
  throw new Error(`player server did not become reachable on ${port}: ${output}`);
}

test("the preview player answers from the scheme's frozen boundary when scoped", async () => {
  const projectId = "boundaryscope-test";
  rmGuarded(join(root, "workspace", "projects", `${projectId}.boundary`));
  const { child, origin } = await startPlayerServer(44000 + (process.pid % 1500));
  try {
    await captureBoundarySnapshot(root, projectId, "440823113");
    // Mark the frozen record so the two answers are distinguishable.
    const frozenRegion = join(root, "workspace", "projects", `${projectId}.boundary`, "data", "regions", "440823113.json");
    const record = JSON.parse(await readFile(frozenRegion, "utf8")) as Record<string, unknown>;
    record.frozenMarker = "frozen";
    await writeFile(frozenRegion, JSON.stringify(record, null, 2), "utf8");

    const scoped = await fetch(`${origin}/data/regions/440823113.json?boundary=${projectId}`);
    assert.equal(scoped.status, 200);
    const scopedBody = await scoped.json() as Record<string, unknown>;
    assert.equal(scopedBody.frozenMarker, "frozen", "a scoped request must be served from the snapshot");

    const live = await fetch(`${origin}/data/regions/440823113.json`);
    assert.equal(live.status, 200);
    const liveBody = await live.json() as Record<string, unknown>;
    assert.equal(liveBody.frozenMarker, undefined, "unscoped playback still reads the live workspace data");

    // A scoped request for a file the snapshot never mirrored falls through
    // instead of 404-ing, so partial snapshots degrade rather than break.
    const fallback = await fetch(`${origin}/data/regions/440823.json?boundary=${projectId}`);
    assert.equal(fallback.status, 200);
    await fallback.arrayBuffer();

    // An id that cannot be a project id never touches the filesystem.
    const rejected = await fetch(`${origin}/data/regions/440823113.json?boundary=..%2F..%2Fetc`);
    assert.equal(rejected.status, 200);
    assert.equal(((await rejected.json()) as Record<string, unknown>).frozenMarker, undefined);
  } finally {
    child.kill();
    rmGuarded(join(root, "workspace", "projects", `${projectId}.boundary`));
  }
});

test("a deleted scheme leaves no boundary snapshot behind", async () => {
  const fixture = await makeFixtureRoot();
  try {
    await captureBoundarySnapshot(fixture, "project-fixture", "990001");
    assert.ok(existsSync(join(fixture, "workspace", "projects", "project-fixture.boundary", "snapshot.json")));
    await deleteBoundarySnapshot(fixture, "project-fixture");
    assert.equal(existsSync(join(fixture, "workspace", "projects", "project-fixture.boundary")), false);
    assert.equal(await hasBoundarySnapshot(fixture, "project-fixture"), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
