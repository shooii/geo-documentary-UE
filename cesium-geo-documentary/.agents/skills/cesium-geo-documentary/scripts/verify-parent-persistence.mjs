#!/usr/bin/env node
/**
 * Prove the two parent layers do their *opposite* jobs across the whole tour.
 *
 * The parent has two layers that fail independently, and `getDiagnostics()`
 * reports them separately as `parentBoundary.paintAlpha` and
 * `parentBoundary.labelAlpha`:
 *
 *   - the grounded parent BOUNDARY is hierarchy context: once its trace settles
 *     it stays painted through the whole child tour and takes the overview
 *     treatment back for the closing return.
 *   - the parent NAME is an opening-overview treatment: it introduces the
 *     region and then retires with the overview ramp as the first child flight
 *     begins. It must not come back - not through the tour, and not for the
 *     closing overview, which returns the camera to the parent framing but is
 *     narrated by the villages. A floor on the name (or an `overviewPeak` for
 *     the return) parks a large parent name on the parent label point, on top
 *     of the village names that are the actual subject; that is the regression
 *     this script exists to catch.
 *
 * Sampling a single overview frame reads identically before and after the fix
 * in both directions, and sampling only one of the two layers reads as "nothing
 * is wrong" for the other. This script therefore sweeps the opening overview,
 * the first-flight handoff, the body of the tour, and the closing overview.
 *
 * Usage (from the repository root):
 *   node .agents/skills/cesium-geo-documentary/scripts/verify-parent-persistence.mjs
 *   node .agents/skills/cesium-geo-documentary/scripts/verify-parent-persistence.mjs \
 *     --project=project-mu3m4jat --step=20
 *   node .agents/skills/cesium-geo-documentary/scripts/verify-parent-persistence.mjs \
 *     --region=440882116 --baseline=<old runtime.js> --step=5
 *
 * Without `--project` the script falls back to the first shipped
 * `parent-child-tour` region under `data/regions`, so a bare invocation is
 * meaningful. `--project=<id>` measures the real deliverable instead: it reads
 * the project and its render spec from the running Studio (`--studio=`, default
 * `http://127.0.0.1:4180`) and rebuilds the tour stops exactly the way
 * `apps/studio/public/studio.js#tourPreviewPayload()` does. Regions built
 * through the scene editor (乌石镇, 西连镇) carry no `tourStops` of their own,
 * so this is the only way to measure them.
 *
 * `--baseline` injects an older runtime.js through a route and measures it in
 * the same run (get the old file with
 * `git show <rev>:cesium-geo-documentary/apps/cesium-player/public/runtime.js`).
 * A runtime older than the `labelAlpha` diagnostic reports nothing for the
 * parent name, and the script says so rather than scoring every sample as
 * present or absent.
 *
 * When the baseline predates a change to the phase function itself, pair it
 * with `--baseline-tour=<file>` (from
 * `git show <rev>:cesium-geo-documentary/apps/cesium-player/public/tour-presentation.js`).
 * The runtime imports `parentNameStrengthAt` from that module, so injecting only
 * the old runtime against the new phase function measures a mix that behaves
 * like the fixed build - which would read as "the baseline was fine too".
 *
 * Exit code is non-zero when the fixed runtime leaves the parent boundary
 * unpainted during the tour, never introduces the parent name during the
 * opening overview, or lets the name survive past the first flight - so it can
 * gate a commit.
 *
 * `--shots=<t1,t2,...>` additionally saves a screenshot at each
 * presentation-relative second into `<out>/shots/<label>-t<t>.png`, so the
 * numbers above can be reviewed against the frames they describe - a parent
 * name that is "0.000 during the tour" is only convincing as a picture of the
 * village it no longer covers.
 *
 * Output: tmp/verify-parent-persistence/report.json plus a sample table on stdout.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, ...rest] = raw.replace(/^--/, "").split("=");
    return [key, rest.length ? rest.join("=") : "1"];
  })
);
const root = resolve(process.cwd());
const out = resolve(root, args.out || "tmp/verify-parent-persistence");
const port = Number(args.port || 4417);
const profile = String(args.profile || "portrait");
const step = Number(args.step || 5);
// Anything at or below this reads as absent.
const presenceFloor = Number(args.floor || 0.05);
// The parent name retires over the same 0.45 s overview ease that retires the
// high-energy outline, anchored at the first child's start, so samples inside
// that ramp are a handoff, not a violation.
const retireGuard = Number(args.retireGuard || 0.6);
await mkdir(out, { recursive: true });

const round = (value) => Number(Number(value).toFixed(3));

// ---- the region and its real tour ------------------------------------------
// Explicit floor/ceiling for labelAlpha readings that must be "definitely on"
// (overview) versus "definitely off" (tour and closing).
const NAME_VISIBLE_ABOVE = 0.5;

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  return response.json();
}

// Mirrors `tourPreviewPayload()` in apps/studio/public/studio.js. The editor
// sends exactly this shape, so measuring a synthesised copy is measuring the
// payload the preview and the export both use.
function tourPayloadFromProject(project, spec) {
  const ranges = new Map((spec.sceneCueRanges || []).map((range) => [range.sceneId, range]));
  const childScenes = (project.scenes || []).filter((scene) => scene.section === "child" && scene.childId && scene.camera);
  const tourStops = childScenes
    .map((scene) => {
      const range = ranges.get(scene.id);
      if (!range) return null;
      const duration = Math.max(0.001, Number(range.end || 0) - Number(range.start || 0));
      return {
        id: scene.childId,
        name: scene.childName || scene.title,
        start: Number(range.start || 0),
        end: Number(range.end || 0),
        flightDuration: Math.min(4.2, Math.max(3.2, duration - Number(scene.timing?.mapHoldSeconds || 0))),
        cameraPreset: scene.camera,
        cameraProfiles: { portrait: scene.camera }
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
  return { tourStops, returnDuration: Number(project.template?.tourReturnSeconds || 4.4) };
}

async function loadRegionTour() {
  if (args.region) return String(args.region);
  const dir = resolve(root, "data/regions");
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".json") || file.endsWith(".timeline.json")) continue;
    const data = JSON.parse(await readFile(resolve(dir, file), "utf8"));
    if (data.presentationMode === "parent-child-tour" && (data.tourStops || []).length > 1) return data.id;
  }
  throw new Error("no parent-child-tour region found under data/regions; pass --project=<id> for a scene-editor project");
}

let regionId;
let tourStops;
let returnDuration;
let tourSource;
if (args.project) {
  const studio = String(args.studio || "http://127.0.0.1:4180").replace(/\/$/, "");
  const projectId = String(args.project);
  let project;
  let spec;
  try {
    [project, spec] = await Promise.all([
      getJson(`${studio}/api/projects/${projectId}`),
      getJson(`${studio}/api/projects/${projectId}/render-spec`)
    ]);
  } catch (error) {
    throw new Error(`could not read ${projectId} from Studio at ${studio} (${error.message}); start it with \`pnpm studio\` and retry`);
  }
  regionId = String(project.regionId);
  ({ tourStops, returnDuration } = tourPayloadFromProject(project, spec));
  tourSource = `project ${projectId} via ${studio}`;
  if (tourStops.length < 2) throw new Error(`${projectId} has no child tour to verify`);
} else {
  regionId = await loadRegionTour();
  tourSource = "region file";
}

const regionData = JSON.parse(await readFile(resolve(root, `data/regions/${regionId}.json`), "utf8"));
if (!tourStops) {
  tourStops = (regionData.tourStops || []).map((stop) => ({ ...stop }));
  returnDuration = Number(regionData.tourReturnDurationSeconds || 4.4);
}
if (tourStops.length < 2) throw new Error(`${regionId} has no child tour to verify`);

const descent = Number(regionData.openingDescent?.seconds ?? 0);
const firstStart = Number(tourStops[0].start);
// `configureStudioTour` re-anchors the return to the last stop's end, so that is
// the frame the closing overview starts on regardless of what the region file
// declares.
const closingStart = Number(tourStops.at(-1).end);
const closingEnd = closingStart + returnDuration;

// Opening overview at both ends, dense across the handoff (where a floor on the
// name shows up), coarse through the body of the tour, and the closing overview.
const times = new Set();
for (let t = 0.5; t <= Math.min(firstStart - 1, 9); t += 0.5) times.add(round(t));
times.add(round(firstStart - 2));
times.add(round(firstStart - 0.2));
for (let t = Math.max(0, firstStart - 0.4); t <= firstStart + 1.4; t += 0.2) times.add(round(t));
for (let t = firstStart + 2; t < closingStart; t += step) times.add(round(t));
for (let t = closingStart; t <= closingEnd + 0.6; t += 0.6) times.add(round(t));
const sampleTimes = [...times].filter((t) => t >= 0).sort((a, b) => a - b);

// Optional visual half of the gate: presentation-relative seconds to screenshot.
const shotTimes = String(args.shots || "")
  .split(",")
  .map((raw) => Number(raw.trim()))
  .filter((value) => Number.isFinite(value));
const shotsDir = resolve(out, "shots");
if (shotTimes.length) await mkdir(shotsDir, { recursive: true });

const baseline = args.baseline ? await readFile(resolve(root, args.baseline), "utf8") : null;
const baselineTour = args["baseline-tour"] ? await readFile(resolve(root, args["baseline-tour"]), "utf8") : null;
if (baselineTour && !baseline) throw new Error("--baseline-tour only makes sense together with --baseline");

// ---- serve the player --------------------------------------------------------
const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
const server = spawn(process.execPath, [tsxCli, "apps/cesium-player/server.ts", `--port=${port}`], {
  cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true
});
let serverLogs = "";
server.stdout?.on("data", (chunk) => { serverLogs += chunk.toString("utf8"); });
server.stderr?.on("data", (chunk) => { serverLogs += chunk.toString("utf8"); });
await new Promise((resolvePromise, reject) => {
  const timer = setTimeout(() => reject(new Error(`server start timeout: ${serverLogs}`)), 60000);
  server.stdout?.on("data", () => {
    if (serverLogs.includes("CESIUM_PLAYER_READY")) { clearTimeout(timer); resolvePromise(); }
  });
});

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: [
    "--force-device-scale-factor=1", "--no-proxy-server",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion", "--enable-webgl", "--ignore-gpu-blocklist",
    "--disk-cache-dir=" + resolve(root, "tmp/chrome-cache-verify-parent"), "--disk-cache-size=1073741824"
  ]
});

async function measure(label, sources, phaseSources) {
  const context = await browser.newContext({
    viewport: { width: 540, height: 960 }, deviceScaleFactor: 1, locale: "zh-CN",
    timezoneId: "Asia/Shanghai", colorScheme: "dark", reducedMotion: "reduce"
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  if (sources) {
    // The baseline runtime.js keeps its own module token, so serve it verbatim.
    await page.route("**/runtime.js*", (route) => route.fulfill({ contentType: "text/javascript", body: sources }));
  }
  if (phaseSources) {
    await page.route("**/tour-presentation.js*", (route) => route.fulfill({ contentType: "text/javascript", body: phaseSources }));
  }

  await page.goto(
    `http://127.0.0.1:${port}/?region=${regionId}&profile=${profile}&studioPreview=2&imagery=esri-world-imagery&clean=1`,
    { waitUntil: "domcontentloaded", timeout: 120000 }
  );
  await page.waitForFunction(() => Boolean(window.geoVideo), undefined, { timeout: 90000 });
  await page.addStyleTag({ content: "#status,#sceneTitle{display:none !important}" });
  try {
    await page.waitForFunction(() => {
      const state = window.geoVideo.getFrameStatus();
      return Boolean(state?.tilesReady && state.pendingRequests === 0 && state.terrainReady && state.entitiesReady);
    }, undefined, { timeout: 90000 });
  } catch { /* the readings below are still meaningful */ }

  // Install the same tour context Studio posts, so the measured presentation
  // matches the editor and export convention rather than a bare page load.
  //
  // `time` is not optional here. `configureStudioTour` only ever *extends*
  // `timeline.duration`, and `seek()` clamps to it - and a region driven by the
  // scene editor carries its own timeline, which can be far shorter than the
  // tour it is made to play (乌石镇 ships `duration: 50` for a 537 s tour).
  // Studio never hits this because every preview message it posts carries
  // `preview.time` (the child's `start`, or the last stop's `end` for the
  // outro); a bare payload would leave the clock parked at 50 s, which reads as
  // "no child tour ever started" at every later sample instead of as a clamp.
  await page.evaluate(({ stops, returnDuration, time }) => {
    window.geoVideo.prepareStudioTour({ tourStops: stops, returnDuration, time });
  }, { stops: tourStops, returnDuration, time: closingEnd });

  const samples = [];
  for (const time of sampleTimes) {
    const reading = await page.evaluate(async ({ time, descent }) => {
      await window.geoVideo.seek(descent + time);
      const diagnostics = window.geoVideo.getDiagnostics();
      return {
        parentLine: diagnostics.parentBoundary?.paintAlpha ?? null,
        parentName: diagnostics.parentBoundary?.labelAlpha ?? null,
        child: diagnostics.selectedChildId ?? null,
        // The whole measurement is meaningless if the tour context did not
        // install: with no `tourStops` the runtime treats the first stop as
        // `Infinity`, so the overview never retires and *both* layers read as
        // "still on screen" for the entire run.
        mode: diagnostics.presentationMode ?? null
      };
    }, { time, descent });
    samples.push({ time, ...reading });
  }

  const shots = [];
  for (const time of shotTimes) {
    await page.evaluate(async ({ time, descent }) => {
      await window.geoVideo.seek(descent + time);
    }, { time, descent });
    const file = resolve(shotsDir, `${label}-t${round(time)}.png`);
    await page.screenshot({ path: file });
    shots.push({ time, file });
  }

  await context.close();
  return { label, samples, shots, errors: consoleErrors.slice(0, 6) };
}

// The two layers are scored separately, because "the parent is on screen" means
// opposite things for each of them.
function analyse(samples) {
  // A runtime older than a given diagnostic reports `null`, not `0` - and
  // `Number(null)` is 0, which would silently score every sample as fine. Test
  // the raw value, not the coercion.
  const reported = (key) => samples.filter((s) => s[key] !== null && Number.isFinite(Number(s[key])));
  const labelAvailable = reported("parentName").length > 0;
  const boundaryAvailable = reported("parentLine").length > 0;

  const opening = samples.filter((s) => s.time < firstStart - 0.2);
  const retired = samples.filter((s) => s.time >= firstStart + retireGuard);
  const closing = samples.filter((s) => s.time >= closingStart - 0.001);
  const value = (list, key) => list.map((s) => Number(s[key]));
  const max = (list, key) => (list.length ? Math.max(...value(list, key)) : null);

  const modes = [...new Set(samples.map((s) => String(s.mode)))];
  const tourInstalled = samples.some((s) => s.child !== null) && modes.includes("parent-child-tour");
  const nameOverviewMax = opening.length ? max(opening, "parentName") : null;
  const nameTourViolations = retired.filter((s) => Number(s.parentName) > presenceFloor).map((s) => s.time);
  const closingViolations = closing.filter((s) => Number(s.parentName) > presenceFloor).map((s) => s.time);
  // The outline must stay painted once the tour has started - including the
  // closing overview, where it returns to the full overview treatment.
  const boundaryMissing = retired.filter((s) => !(Number(s.parentLine) > presenceFloor)).map((s) => s.time);

  return {
    labelAvailable, boundaryAvailable,
    tourInstalled,
    presentationModes: modes,
    childSelectedSamples: samples.filter((s) => s.child !== null).length,
    openingSamples: opening.length,
    retiredSamples: retired.length,
    closingSamples: closing.length,
    nameOverviewMax: labelAvailable ? nameOverviewMax : null,
    nameRetiredMax: labelAvailable && retired.length ? max(retired, "parentName") : null,
    nameTourViolations: labelAvailable ? nameTourViolations : null,
    nameClosingViolations: labelAvailable ? closingViolations : null,
    boundaryMissing
  };
}

const runs = [await measure("fixed", null, null)];
if (baseline) runs.push(await measure("baseline", baseline, baselineTour));
const results = runs.map((run) => ({ ...run, analysis: analyse(run.samples) }));

const fixed = results[0];
console.log(`region ${regionId} ${regionData.name} - ${tourStops.length} children via ${tourSource}`);
console.log(`first flight at ${round(firstStart)}s, tour ends ${round(closingStart)}s, closing overview to ${round(closingEnd)}s (descent ${descent}s)`);
console.log(`sampled ${sampleTimes.length} points: ${fixed.analysis.openingSamples} opening, ${fixed.analysis.retiredSamples} from the first flight on, ${fixed.analysis.closingSamples} in the closing overview\n`);
const describe = (value, digits = 3) => (value === null || value === undefined ? "n/a" : Number(value).toFixed(digits));
for (const run of results) {
  const a = run.analysis;
  console.log(`[${run.label}] tour context    ${a.tourInstalled ? `installed (${a.presentationModes.join("/")}, a child selected at ${a.childSelectedSamples} sample(s))` : `NOT installed (${a.presentationModes.join("/")}, a child selected at ${a.childSelectedSamples} sample(s)) - nothing below is measurable`}`);
  if (!a.labelAvailable) {
    console.log(`[${run.label}] parent name     not reported by this runtime (no parentBoundary.labelAlpha) - cannot be compared`);
  } else {
    console.log(`[${run.label}] parent name     overview max ${describe(a.nameOverviewMax)}; from the first flight on max ${describe(a.nameRetiredMax)}`);
    if (a.nameOverviewMax !== null && a.nameOverviewMax <= NAME_VISIBLE_ABOVE) {
      console.log(`[${run.label}]                 never reached a visible strength during the opening overview`);
    }
    if (a.nameTourViolations?.length) console.log(`[${run.label}]                 still on screen at ${a.nameTourViolations.length} in-tour sample(s): ${a.nameTourViolations.slice(0, 12).join(", ")}${a.nameTourViolations.length > 12 ? ", ..." : ""}`);
    if (a.nameClosingViolations?.length) console.log(`[${run.label}]                 still on screen at ${a.nameClosingViolations.length} closing-overview sample(s): ${a.nameClosingViolations.slice(0, 12).join(", ")}${a.nameClosingViolations.length > 12 ? ", ..." : ""}`);
  }
  if (!a.boundaryAvailable) {
    console.log(`[${run.label}] parent boundary not reported by this runtime (no parentBoundary.paintAlpha)`);
  } else {
    console.log(`[${run.label}] parent boundary ${a.boundaryMissing.length ? `unpainted at ${a.boundaryMissing.length} sample(s): ${a.boundaryMissing.slice(0, 12).join(", ")}` : "painted at every sample from the first flight on"}`);
  }
  if (run.errors.length) console.log(`[${run.label}] console errors: ${run.errors.join(" | ")}`);
}

const report = {
  generatedAt: new Date().toISOString(),
  region: regionId, regionName: regionData.name, profile, tourSource,
  projectId: args.project ? String(args.project) : null,
  children: tourStops.length, firstStart, closingStart, closingEnd, descent,
  sampleCount: sampleTimes.length, presenceFloor, retireGuard,
  baseline: baseline ? resolve(root, args.baseline) : null,
  baselineTour: baselineTour ? resolve(root, args["baseline-tour"]) : null,
  shots: shotTimes,
  runs: results.map((run) => ({ label: run.label, analysis: run.analysis, shots: run.shots, errors: run.errors }))
};
await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2));

const reasons = [];
const f = fixed.analysis;
if (!f.tourInstalled) reasons.push(`the child-tour context never installed (presentation mode ${f.presentationModes.join("/")}), so the tour could not be measured`);
if (!f.labelAvailable) reasons.push("this runtime does not report parentBoundary.labelAlpha, so the parent name could not be verified");
else {
  if (f.nameOverviewMax === null || f.nameOverviewMax <= NAME_VISIBLE_ABOVE) reasons.push("the parent name never became visible during the opening overview");
  if (f.nameTourViolations.length) reasons.push(`the parent name is still on screen at ${f.nameTourViolations.length} in-tour sample(s)`);
  if (f.nameClosingViolations.length) reasons.push(`the parent name came back for the closing overview at ${f.nameClosingViolations.length} sample(s)`);
}
if (!f.boundaryAvailable) reasons.push("this runtime does not report parentBoundary.paintAlpha");
else if (f.boundaryMissing.length) reasons.push(`the parent boundary is unpainted at ${f.boundaryMissing.length} in-tour sample(s)`);
const ok = reasons.length === 0;

const baselineRun = results[1];
console.log("");
if (baselineRun?.analysis.labelAvailable) {
  const kept = (baselineRun.analysis.nameTourViolations?.length || 0) + (baselineRun.analysis.nameClosingViolations?.length || 0);
  console.log(kept
    ? `baseline keeps the parent name on screen at ${kept} sample(s) past the first flight; the fixed build retires it at the handoff`
    : "baseline also retires the parent name at the first flight (nothing to regress from)");
}
console.log(ok
  ? "PASS: the parent boundary persists and the parent name retires with the opening overview"
  : `FAIL: ${reasons.join("; ")}`);
console.log(`report: ${resolve(out, "report.json")}`);

await browser.close();
server.kill();
process.exit(ok ? 0 : 1);
