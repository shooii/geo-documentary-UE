import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * The export panel used to promise `finishedMinutes × 15` minutes and
 * `finishedMinutes × 20` MB. This workspace's own history says otherwise: the 21
 * completed portrait exports between 2026-09-14 and 2026-10-12 ran 7.0–15.6 wall
 * minutes per finished minute and produced 97–132 MB per finished minute, so a
 * 5.5-minute film was promised 84–92 minutes and 111–167 MB, and actually took
 * 42.5 minutes and 490 MB. The estimate now has to be fed by measurements — and
 * by whether the map video can be copied out of the render cache, which is the
 * difference between the fast and the slow band.
 */

const root = resolve(import.meta.dirname, "..");

test("the render engine records what an export actually cost", async () => {
  const source = await readFile(resolve(root, "apps/studio/render-engine.ts"), "utf8");
  assert.match(source, /export interface RenderStageTimings/);
  for (const field of ["setupSeconds", "narrationSeconds", "mapSeconds", "mapCacheHit", "compositionSeconds", "qaSeconds", "totalSeconds"]) {
    assert.match(source, new RegExp(`${field}: `), `${field} has to be measured`);
  }
  assert.match(source, /const exportStartedAt = Date\.now\(\)/);
  assert.match(source, /const mapStartedAt = Date\.now\(\)/);
  assert.match(source, /const compositionStartedAt = Date\.now\(\)/);
  // The three numbers the estimator needs, written when the job completes.
  assert.match(source, /videoDurationSeconds: Math\.round\(Number\(spec\.totalDurationSeconds\) \* 10\) \/ 10/);
  assert.match(source, /outputBytes: outputInfo\.size/);
  assert.match(source, /mapCacheHit: hit/);
});

test("the render spec tells the panel whether the map recording can be reused", async () => {
  const source = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");
  assert.match(source, /mapCacheAvailable: existsSync\(cached\)/);
  assert.match(source, /workspace", "render-cache", spec\.cacheSignature\.replace\("sha256:", ""\)/);
});

test("the panel estimates from measured history instead of a constant", async () => {
  const source = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");
  assert.match(source, /function measuredExportRates/);
  assert.match(source, /medianOf\(/);
  assert.match(source, /Number\(job\.videoDurationSeconds\) > 0/);
  assert.match(source, /Number\(job\.outputBytes\) > 0/);
  assert.match(source, /job\.timings\?\.mapCacheHit \? warm : cold/);
  assert.match(source, /state\.renderSpec\?\.mapCacheAvailable/);
  assert.match(source, /const EXPORT_ESTIMATE_FALLBACK = Object\.freeze\(\{/);
  // The two constants that produced the wrong numbers must be gone.
  assert.doesNotMatch(source, /minutes \* \(draft \? 6 : 15\)/);
  assert.doesNotMatch(source, /minutes \* \(draft \? 8 : 20\)/);
  assert.doesNotMatch(source, /经验估算，仅供参考/);
  assert.match(source, /按本机最近 \$\{measured\.samples\} 次成片实测/);
});

test("the film length comes from the spec the encoder is given", async () => {
  const source = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");
  const start = source.indexOf("function estimateVideoSeconds()");
  const body = source.slice(start, source.indexOf("function refreshExportEstimate()", start));
  assert.match(body, /spec\?\.totalDurationSeconds/, "the spec total is the authoritative length");
  assert.ok(
    body.indexOf("specTotal") < body.indexOf("maxEnd"),
    "scene cue ends are the fallback, not the primary source"
  );
});
