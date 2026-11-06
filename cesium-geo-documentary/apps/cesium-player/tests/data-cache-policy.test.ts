import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The preview is authored on the machine that serves it: the operator edits a
 * source shapefile, re-imports the region, and the very next preview must show
 * the new boundary. Serving `data/**` with `max-age=31536000, immutable` broke
 * that promise — the browser replayed the pre-import geometry without ever
 * asking the server again, so the re-import looked like a no-op. Nothing in the
 * UI can surface that mistake, so the header policy is pinned here.
 */

const root = resolve(process.cwd());

async function startPlayerServer(port: number): Promise<{ child: ChildProcess; origin: string }> {
  const child = spawn(
    process.execPath,
    [resolve(root, "node_modules", "tsx", "dist", "cli.mjs"), "apps/cesium-player/server.ts", `--port=${port}`],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
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

test("authored region data is revalidated instead of cached for a year", async () => {
  const { child, origin } = await startPlayerServer(40000 + (process.pid % 2000));
  try {
    const geometry = `${origin}/data/normalized/440306017-children.geojson`;
    const first = await fetch(geometry);
    assert.equal(first.status, 200);
    const cacheControl = first.headers.get("cache-control") ?? "";
    assert.doesNotMatch(cacheControl, /immutable/, "authored data must never be immutable");
    assert.doesNotMatch(cacheControl, /max-age=[1-9]/, "authored data must not be stored fresh");
    assert.match(cacheControl, /no-cache/);
    assert.match(first.headers.get("content-type") ?? "", /geo\+json/);
    const etag = first.headers.get("etag");
    assert.ok(etag, "authored data needs a validator so revalidation stays cheap");
    await first.arrayBuffer();

    const revalidated = await fetch(geometry, { headers: { "if-none-match": etag! } });
    assert.equal(revalidated.status, 304, "an unchanged boundary must answer 304, not a re-download");
    await revalidated.arrayBuffer();

    const config = await fetch(`${origin}/runtime-config.json`);
    const body = (await config.json()) as { dataVersion?: string };
    assert.match(String(body.dataVersion), /^[0-9a-z]+$/, "the client needs a freshness stamp to bust its own cache");
  } finally {
    child.kill();
  }
});

test("only the vendored Cesium build is served immutable", async () => {
  const { child, origin } = await startPlayerServer(42000 + (process.pid % 2000));
  try {
    const page = await fetch(`${origin}/index.html`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("cache-control") ?? "", /no-store/);
    await page.arrayBuffer();

    if (existsSync(resolve(root, "node_modules", "cesium", "Build", "Cesium", "Cesium.js"))) {
      const vendored = await fetch(`${origin}/Cesium/Cesium.js`);
      assert.equal(vendored.status, 200);
      assert.match(vendored.headers.get("cache-control") ?? "", /immutable/);
      await vendored.arrayBuffer();
    }
  } finally {
    child.kill();
  }
});
