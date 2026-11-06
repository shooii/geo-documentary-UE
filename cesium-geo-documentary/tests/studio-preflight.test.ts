import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { summarizePreflightReport } from "../apps/studio/render-engine.js";

const root = resolve(import.meta.dirname, "..");

test("the composition preflight gates on errors and never on warnings", () => {
  // Captured from `hyperframes check --json` against this workspace's own
  // composition: 798 warnings, 0 errors, exit 0, and it renders fine.
  const warningHeavy = {
    ok: true,
    strict: false,
    lint: { ok: true, errorCount: 0, warningCount: 798, infoCount: 29, findings: [{ severity: "warning", code: "duplicate_audio_track", message: "Multiple <audio> elements on track 6 overlap" }] },
    runtime: { ok: true, errorCount: 0, warningCount: 0, findings: [] },
    layout: { ok: true, errorCount: 0, warningCount: 0, findings: [] },
    motion: { ok: true, errorCount: 0, warningCount: 2, findings: [], enabled: false },
    contrast: { ok: true, errorCount: 0, warningCount: 0, findings: [], enabled: true, samples: 0 }
  };
  assert.equal(summarizePreflightReport(warningHeavy).errors, 0, "warnings must not block an export");
  assert.equal(summarizePreflightReport(warningHeavy).warnings, 800);
  assert.equal(summarizePreflightReport(warningHeavy).perSection.length, 5);

  const withErrors = {
    ok: false,
    lint: { errorCount: 0, warningCount: 3, findings: [] },
    layout: { errorCount: 2, warningCount: 0, findings: [{ severity: "error", message: "caption-4 overflows the canvas" }] },
    contrast: { errorCount: 1, warningCount: 0, findings: [{ severity: "error", message: "subtitle contrast 2.1 below AA" }] }
  };
  const summary = summarizePreflightReport(withErrors);
  assert.equal(summary.errors, 3);
  assert.deepEqual(summary.findings, [
    "layout: caption-4 overflows the canvas",
    "contrast: subtitle contrast 2.1 below AA"
  ]);

  // 报错必须点名元素：`Two text blocks overlap and may render unreadable.`
  // 曾经让人（和一次导出）来回猜它到底指哪两块文字。
  const located = summarizePreflightReport({
    ok: false,
    layout: {
      errorCount: 1,
      findings: [{
        severity: "error",
        code: "content_overlap",
        message: "Two text blocks overlap and may render unreadable.",
        selector: "#provider-credit",
        containerSelector: "#visual-caption-2",
        time: 8.734
      }]
    }
  } as never);
  assert.deepEqual(located.findings, [
    "layout: Two text blocks overlap and may render unreadable. [#provider-credit ↔ #visual-caption-2] @8.7s"
  ]);

  // A report the tool could not produce must never look like a verdict.
  assert.equal(summarizePreflightReport(null).errors, 0);
  assert.equal(summarizePreflightReport(undefined).errors, 0);
  assert.equal(summarizePreflightReport({} as never).errors, 0);
});

test("the preflight runs before the encode and stays out of the way when it cannot run", async () => {
  const engine = await readFile(resolve(root, "apps/studio/render-engine.ts"), "utf8");
  // It has to sit between composition and encoding — the composition does not
  // exist before the map video does, and the whole point is to refuse a
  // composition that cannot render *before* twenty minutes of encoding.
  const compose = engine.indexOf('"合成素材、字幕、配音与地图"');
  // There is also a pre-capture gate that calls the same helper (see
  // export-preflight-order.test.ts), so the one that must follow this
  // composition is the LAST call site, not the first.
  const preflight = engine.lastIndexOf("await preflightComposition(sandbox, callbacks");
  const encode = engine.indexOf('"编码新的 MP4", 79');
  assert.ok(compose > 0 && preflight > compose, "the preflight must run after composition");
  assert.ok(encode > preflight, "the preflight must run before the encode");
  // An inconclusive preflight passes the export through rather than inventing a
  // new failure mode.
  assert.match(engine, /PREFLIGHT_INCONCLUSIVE/);
  assert.match(engine, /if \(!report\) \{/);
  assert.match(engine, /STUDIO_PREFLIGHT/);
  assert.doesNotMatch(engine, /"check", "\.", "--json", "--samples", String\(samples\), "--strict"/);
});
