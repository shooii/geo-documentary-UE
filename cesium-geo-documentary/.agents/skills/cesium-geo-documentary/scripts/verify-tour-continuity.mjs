#!/usr/bin/env node
/**
 * Prove the camera does not jump during a child tour.
 *
 * Every village flight is a geodesic interpolation between two cameras, and the
 * origin of each leg is a contract: the first leg must leave the settled parent
 * overview *as rendered* (that camera carries `PARENT_OVERVIEW_CAMERA_HEIGHT_-
 * SCALE`), every later leg leaves the previous village. Getting it wrong is
 * invisible to diagnostics — the flight is smooth, it just starts from a range
 * the viewer never saw, so the first frame snaps. The shipped 乌石镇 portrait
 * project regressed exactly that way: a 2 617 m altitude discontinuity in one
 * frame, 11.1 % of the frame, 10.2 frames of the flight's own motion packed into
 * one.
 *
 * The script drives the real region with the real tour payload Studio would
 * post, then sweeps the page clock densely and looks for a step that is out of
 * scale with the flight's own motion. It deliberately does NOT model where the
 * scene boundaries are: the page's clock offset depends on whether an opening
 * descent has been installed, which differs between a bare load and the Studio
 * flow, so any hardcoded boundary time is a trap. A jump is instead identified
 * by shape — one step orders of magnitude above the surrounding steps — and
 * reported with the times it occurred at.
 *
 * Usage (from the repository root, with Studio running):
 *   node .agents/skills/cesium-geo-documentary/scripts/verify-tour-continuity.mjs
 *   node .agents/skills/cesium-geo-documentary/scripts/verify-tour-continuity.mjs \
 *     --project=project-mu3m4jat --profile=portrait --baseline=<old runtime.js>
 *
 * `--baseline` injects an older runtime.js through a route and measures it in the
 * same run, which is how the "before" numbers are produced (get the old file with
 * `git show <rev>:cesium-geo-documentary/apps/cesium-player/public/runtime.js`).
 *
 * Exit code is non-zero when a step exceeds both `--tolerance` metres (default
 * 25) and `--ratio` times the window's 95th-percentile step (default 3), so it
 * can gate a commit.
 *
 * Output: tmp/verify-tour-continuity/report.json plus `* MAXSTEP` / `* TOP` lines
 * on stdout.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, ...rest] = raw.replace(/^--/, "").split("=");
    return [key, rest.length ? rest.join("=") : "1"];
  })
);
const root = resolve(process.cwd());
const out = resolve(root, args.out || "tmp/verify-tour-continuity");
const port = Number(args.port || 4397);
const studio = String(args.studio || "http://127.0.0.1:4180").replace(/\/$/, "");
const projectId = String(args.project || "project-mu3m4jat");
const tolerance = Number(args.tolerance || 25);
const ratio = Number(args.ratio || 3);
const sweepStep = Number(args.step || 0.05);
await mkdir(out, { recursive: true });

// ---- the tour payload, derived exactly the way studio.js derives it ---------
// A different derivation here would verify a payload the editor never sends.
const project = await (await fetch(`${studio}/api/projects/${projectId}`)).json();
const spec = await (await fetch(`${studio}/api/projects/${projectId}/render-spec`)).json();
if (!project?.scenes || !spec?.sceneCueRanges) {
  throw new Error(`cannot read project/render-spec for ${projectId} from ${studio}`);
}
const childScenes = project.scenes.filter((item) => item.section === "child" && item.childId && item.camera);
const stops = childScenes.map((item) => {
  const range = spec.sceneCueRanges.find((candidate) => candidate.sceneId === item.id);
  const duration = Math.max(0.001, Number(range?.end || 0) - Number(range?.start || 0));
  return {
    id: item.childId,
    name: item.childName || item.title,
    start: Number(range?.start || 0),
    end: Number(range?.end || 0),
    flightDuration: Math.min(4.2, Math.max(3.2, duration - Number(item.timing?.mapHoldSeconds || 0))),
    cameraPreset: item.camera,
    cameraProfiles: { portrait: item.camera }
  };
});
if (stops.length === 0) throw new Error(`${projectId} has no child scenes to tour`);

const profile = String(args.profile || "portrait");
const regionId = String(project.regionId);
const returnDuration = Number(project.template?.tourReturnSeconds || 4.4);

const baseline = args.baseline ? await readFile(resolve(root, args.baseline), "utf8") : null;

// The window is wide enough to contain the first scene boundary whatever the
// page's clock offset turns out to be (0 without an opening descent, the descent
// length with one), plus the whole first flight.
const sweepFrom = +(stops[0].start - 2).toFixed(3);
const sweepTo = +(stops[0].start + 8).toFixed(3);
const sweepTimes = [];
for (let time = sweepFrom; time <= sweepTo + 1e-9; time += sweepStep) sweepTimes.push(+time.toFixed(3));

// ---- services --------------------------------------------------------------
const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
const server = spawn(process.execPath, [tsxCli, "apps/cesium-player/server.ts", `--port=${port}`], {
  cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true
});
let logs = "";
server.stdout?.on("data", (chunk) => { logs += chunk.toString("utf8"); });
server.stderr?.on("data", (chunk) => { logs += chunk.toString("utf8"); });
await new Promise((resolvePromise, reject) => {
  const timer = setTimeout(() => reject(new Error(`server start timeout: ${logs}`)), 40000);
  server.stdout?.on("data", () => {
    if (logs.includes("CESIUM_PLAYER_READY")) { clearTimeout(timer); resolvePromise(); }
  });
});

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: [
    "--force-device-scale-factor=1",
    "--no-proxy-server",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--disk-cache-dir=" + resolve(root, out, "chrome-cache"),
    "--disk-cache-size=1073741824"
  ]
});

const url = `http://127.0.0.1:${port}/?region=${regionId}&profile=${profile}&studioPreview=2&clean=1`;

async function measure(variant, injectedSource) {
  const context = await browser.newContext({
    viewport: { width: 540, height: 960 }, deviceScaleFactor: 1, locale: "zh-CN",
    timezoneId: "Asia/Shanghai", colorScheme: "dark", reducedMotion: "reduce"
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  if (injectedSource) {
    await page.route("**/runtime.js*", (route) => route.fulfill({ contentType: "application/javascript", body: injectedSource }));
  }
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => Boolean(window.geoVideo), undefined, { timeout: 60000 });

  const settle = async () => {
    try {
      await page.waitForFunction(() => {
        const state = window.geoVideo.getFrameStatus();
        return Boolean(state?.tilesReady && state.pendingRequests === 0 && state.terrainReady && state.entitiesReady);
      }, undefined, { timeout: 60000 });
    } catch { console.log(`[${variant}] settle gate timed out, continuing`); }
  };
  await settle();
  // Install the tour the way Studio does, then walk the clock. Note this does
  // NOT install an opening descent, so the page's map time equals its page time
  // here -- which is exactly why the sweep cannot assume a boundary time.
  await page.evaluate((payload) => window.geoVideo.showStudioTourFrame(payload), {
    tourStops: stops, time: 0, returnDuration, targetId: stops[0].id, segmentDuration: 5
  });
  await settle();

  const samples = [];
  for (const time of sweepTimes) {
    const reading = await page.evaluate(async (at) => {
      try { await window.geoVideo.seek(at); } catch (error) { return { time: at, seekError: String(error?.message || error) }; }
      const diagnostics = window.geoVideo.getDiagnostics();
      return { time: at, height: diagnostics.camera?.height ?? null };
    }, time);
    samples.push(reading);
  }
  await context.close();
  return { variant, samples, consoleErrors: consoleErrors.slice(0, 5) };
}

const results = [];
if (baseline) results.push(await measure("baseline", baseline));
results.push(await measure("current", null));

const quantile = (values, fraction) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
};
const analysis = {};
for (const result of results) {
  const series = result.samples.filter((sample) => Number.isFinite(sample.height));
  const steps = [];
  for (let index = 1; index < series.length; index += 1) {
    steps.push({ fromTime: series[index - 1].time, toTime: series[index].time, meters: Math.abs(series[index].height - series[index - 1].height) });
  }
  const values = steps.map((step) => step.meters);
  const p50 = quantile(values, 0.5);
  const p95 = quantile(values, 0.95);
  const top = [...steps].sort((a, b) => b.meters - a.meters).slice(0, 5).map((step) => ({
    fromTime: step.fromTime, toTime: step.toTime, meters: Number(step.meters.toFixed(1))
  }));
  const largest = top[0] ?? null;
  analysis[result.variant] = {
    samples: series.length,
    firstAltitude: Number((series[0]?.height ?? NaN).toFixed(1)),
    p50StepMeters: Number((p50 ?? 0).toFixed(1)),
    p95StepMeters: Number((p95 ?? 0).toFixed(1)),
    topSteps: top,
    jumpRatio: p95 ? Number((largest?.meters ?? 0) / p95).toFixed(2) : null,
    verdict: largest && largest.meters > tolerance && p95 && largest.meters > ratio * p95 ? "jump" : "continuous"
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  projectId, regionId, profile, returnDuration,
  stops: stops.length,
  sweep: { from: sweepFrom, to: sweepTo, step: sweepStep, samples: sweepTimes.length },
  gate: { toleranceMeters: tolerance, ratioOverP95: ratio },
  analysis,
  consoleErrors: Object.fromEntries(results.map((result) => [result.variant, result.consoleErrors]))
};
await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2));

let failed = 0;
for (const [variant, data] of Object.entries(analysis)) {
  // Only the current build gates the exit code: a `--baseline` run is expected
  // to fail, that is the whole point of measuring it.
  const gates = variant === "current";
  const bad = data.verdict === "jump" ? (gates ? "  <-- FAIL" : "  (baseline, not gated)") : "";
  if (gates && data.verdict === "jump") failed += 1;
  console.log(
    `${variant.toUpperCase()} MAXSTEP ${data.verdict} p50=${data.p50StepMeters}m p95=${data.p95StepMeters}m ` +
    `max=${data.topSteps[0]?.meters}m at ${data.topSteps[0]?.fromTime}->${data.topSteps[0]?.toTime}s ` +
    `ratio=${data.jumpRatio}x${bad}`
  );
  for (const step of data.topSteps.slice(1, 3)) {
    console.log(`${variant.toUpperCase()}   next ${step.meters}m at ${step.fromTime}->${step.toTime}s`);
  }
}
for (const [variant, errors] of Object.entries(report.consoleErrors)) {
  if (errors.length) console.log(`[${variant}] consoleErrors=${JSON.stringify(errors)}`);
}
console.log(`report: ${resolve(out, "report.json")}`);
await browser.close();
server.kill();
process.exit(failed ? 1 : 0);
