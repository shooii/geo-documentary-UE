#!/usr/bin/env node
/**
 * Deterministically verify the Cesium runtime presentation layers.
 *
 * The boundary, focus-mask, terrain, label and named-feature contracts are all
 * "invisible when broken" — a layer that silently fails to draw looks exactly
 * like a scene that legitimately has nothing there. Reading diagnostics alone
 * cannot tell the two apart, because a resolved-but-unpainted layer reports the
 * same geometry counts as a painted one. Every check here therefore pairs a
 * diagnostics read with a screenshot pixel diff against a control run in which
 * the layer is switched off.
 *
 * Usage (from the repository root):
 *   node .agents/skills/cesium-geo-documentary/scripts/verify-runtime-layers.mjs
 *   node .agents/skills/cesium-geo-documentary/scripts/verify-runtime-layers.mjs canal,canal-off
 *
 * Available labels: mask-on, mask-off, mask-ramp, canal, canal-off,
 * terrain-ellipsoid, terrain-arcgis. Passing a comma-separated list runs only
 * those.
 *
 * `mask-ramp` samples the recession densely across its fade window and reports
 * the alpha series with the largest single-step jump, which is how a ramp that
 * pops on is told apart from one that eases in.
 *
 * Output: tmp/verify-runtime-layers/{label}-t{time}.png plus report.json, and a
 * `* DIFF` line per control pair on stdout.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const root = resolve(process.cwd());
const port = 4398;
const out = resolve(root, "tmp/verify-runtime-layers");
await mkdir(out, { recursive: true });

const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
const server = spawn(process.execPath, [tsxCli, "apps/cesium-player/server.ts", `--port=${port}`], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
let logs = "";
server.stdout?.on("data", (chunk) => { logs += chunk.toString("utf8"); });
server.stderr?.on("data", (chunk) => { logs += chunk.toString("utf8"); });
await new Promise((resolvePromise, reject) => {
  const timer = setTimeout(() => reject(new Error(`server start timeout: ${logs}`)), 30000);
  server.stdout?.on("data", () => {
    if (logs.includes("CESIUM_PLAYER_READY")) {
      clearTimeout(timer);
      resolvePromise();
    }
  });
});

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: [
    "--force-device-scale-factor=1",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--disk-cache-dir=" + resolve(root, "tmp/chrome-cache-verify-runtime-layers"),
    "--disk-cache-size=1073741824"
  ]
});

const report = {};

async function run(label, { region, from, extra = "", patchConfig, times }) {
  const context = await browser.newContext({
    viewport: { width: 1080, height: 1920 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    colorScheme: "dark",
    reducedMotion: "reduce"
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  if (patchConfig) {
    await page.route("**/imagery-config.json", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      patchConfig(body);
      await route.fulfill({ response, body: JSON.stringify(body) });
    });
  }
  const url = `http://127.0.0.1:${port}/?region=${region}&from=${from}&profile=portrait&clean=1${extra}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => Boolean(window.geoVideo), undefined, { timeout: 40000 });
  await waitReady(page);

  const entries = [];
  try {
    for (const time of times) {
      // Seek twice: the first lands the clock, the second samples the fully
      // settled frame so alpha ramps and tile refinement are not caught mid-step.
      await page.evaluate((seconds) => window.geoVideo.seek(seconds), time);
      await waitReady(page);
      await page.waitForTimeout(350);
      await page.evaluate((seconds) => window.geoVideo.seek(seconds), time);
      await waitReady(page);
      await page.waitForTimeout(350);
      const shot = await page.screenshot({ path: resolve(out, `${label}-t${time}.png`) });
      const diagnostics = await page.evaluate(() => window.geoVideo.getDiagnostics());
      entries.push({
        time,
        bytes: shot.length,
        focusMask: diagnostics.focusMask,
        labelDistance: diagnostics.labelDistance,
        terrainProvider: diagnostics.terrainProvider,
        namedFeatures: diagnostics.namedFeatures,
        parentBoundary: diagnostics.parentBoundary,
        overlappedLabelPairs: diagnostics.overlappedLabelPairs,
        visibleLabelBoxes: diagnostics.visibleLabelBoxes,
        errors: diagnostics.errors
      });
      console.log(`${label} t=${time} mask=${JSON.stringify(diagnostics.focusMask)} terrain=${diagnostics.terrainProvider} labels=${diagnostics.visibleChildLabelIds.length} overlaps=${diagnostics.overlappedLabelPairs}`);
      console.log(`   boxes=${JSON.stringify(diagnostics.visibleLabelBoxes)}`);
      console.log(`   features=${JSON.stringify(diagnostics.namedFeatures)}`);
      if (diagnostics.errors?.length) console.log(`   errors=${JSON.stringify(diagnostics.errors)}`);
    }
  } finally {
    report[label] = { url, consoleErrors, entries };
    await context.close();
  }
}

async function waitReady(page) {
  await page.waitForFunction(() => {
    const state = window.geoVideo?.getFrameStatus();
    return Boolean(state?.ready && state.tilesReady && state.imageryReady && state.terrainReady && state.fontsReady && state.entitiesReady && state.pendingRequests === 0);
  }, undefined, { timeout: 120000 });
}

// Mean signed RGB delta over changed pixels: a darkening layer must come back
// negative on all three channels, and a coloured layer must show the expected
// channel ordering.
async function pixelDiff(fileA, fileB, { label, requireBlueDominance = false }) {
  let a;
  let b;
  try {
    [a, b] = await Promise.all([
      sharp(fileA).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      sharp(fileB).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    ]);
  } catch {
    console.log(`${label} SKIPPED (missing ${fileA} or ${fileB} — run both control labels together)`);
    return null;
  }
  let changed = 0;
  let blueDominant = 0;
  let sumR = 0; let sumG = 0; let sumB = 0;
  const channels = a.info.channels;
  for (let i = 0; i < a.data.length; i += channels) {
    const dr = b.data[i] - a.data[i];
    const dg = b.data[i + 1] - a.data[i + 1];
    const db = b.data[i + 2] - a.data[i + 2];
    if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) <= 6) continue;
    changed += 1;
    sumR += dr; sumG += dg; sumB += db;
    if (requireBlueDominance && db > 0 && db - dr > 10 && db - dg > 4) blueDominant += 1;
  }
  const result = {
    size: [a.info.width, a.info.height, channels],
    changedPixels: changed,
    changedFraction: Number((changed / (a.info.width * a.info.height)).toFixed(4)),
    meanDeltaRGB: changed === 0
      ? [0, 0, 0]
      : [sumR / changed, sumG / changed, sumB / changed].map((value) => Number(value.toFixed(2)))
  };
  if (requireBlueDominance) result.blueDominantPixels = blueDominant;
  console.log(`${label} DIFF ` + JSON.stringify(result));
  return result;
}

const only = process.argv[2] ? process.argv[2].split(",") : null;
const wanted = (label) => !only || only.includes(label);

if (wanted("mask-on")) await run("mask-on", { region: "440825111", from: "440825", times: [18, 95, 130] });
if (wanted("mask-off")) await run("mask-off", {
  region: "440825111",
  from: "440825",
  patchConfig: (body) => { body.focusMask = { ...(body.focusMask || {}), enabled: false }; },
  times: [18]
});
if (wanted("canal")) await run("canal", { region: "440882102", from: "440882", times: [4, 8, 30] });
if (wanted("canal-off")) await run("canal-off", {
  region: "440882102",
  from: "440882",
  patchConfig: (body) => { body.features = { ...(body.features || {}), enabled: false }; },
  times: [30]
});
if (wanted("terrain-ellipsoid")) await run("terrain-ellipsoid", { region: "440825111", from: "440825", extra: "&terrain=ellipsoid", times: [18] });
if (wanted("terrain-arcgis")) await run("terrain-arcgis", { region: "440825111", from: "440825", extra: "&terrain=arcgis", times: [18] });

// The recession ramp for 客路镇 (openingDescent 3s) starts at map time
// 0.35 + 2.2 + 0.34 = 2.89s and runs for fadeSeconds. These absolute samples
// bracket the whole window: the first two must still read zero, and no single
// step may carry a large share of the total change.
if (wanted("mask-ramp")) await run("mask-ramp", {
  region: "440882102",
  from: "440882",
  times: [5.7, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5, 10.5]
});

for (const [label, entry] of Object.entries(report)) {
  console.log(`CONSOLE ${label}: ${JSON.stringify(entry.consoleErrors.slice(0, 5))}`);
}

const ramp = report["mask-ramp"];
if (ramp) {
  const series = ramp.entries.map((item) => ({ t: item.time, alpha: item.focusMask?.alpha ?? null }));
  let maxStep = 0;
  let maxStepPair = null;
  for (let i = 1; i < series.length; i += 1) {
    const step = Math.abs(series[i].alpha - series[i - 1].alpha);
    if (step > maxStep) {
      maxStep = step;
      maxStepPair = [series[i - 1], series[i]];
    }
  }
  const total = Math.max(...series.map((item) => item.alpha)) - Math.min(...series.map((item) => item.alpha));
  console.log("MASK RAMP " + JSON.stringify({
    series,
    totalChange: Number(total.toFixed(4)),
    maxSingleStep: Number(maxStep.toFixed(4)),
    maxSingleStepShare: total > 0 ? Number((maxStep / total).toFixed(4)) : 0,
    maxSingleStepPair: maxStepPair
  }));
}

await pixelDiff(resolve(out, "mask-off-t18.png"), resolve(out, "mask-on-t18.png"), { label: "MASK" });
await pixelDiff(resolve(out, "terrain-ellipsoid-t18.png"), resolve(out, "terrain-arcgis-t18.png"), { label: "TERRAIN" });
await pixelDiff(resolve(out, "canal-off-t30.png"), resolve(out, "canal-t30.png"), { label: "CANAL", requireBlueDominance: true });

await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 1), "utf8");
await browser.close();
server.kill();
