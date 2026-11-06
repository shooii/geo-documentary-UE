import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { resolve } from "node:path";
import { chromium, type CDPSession, type Page } from "playwright";
import sharp from "sharp";
import YAML from "yaml";

interface FrameStatus {
  time: number;
  ready: boolean;
  tilesReady: boolean;
  imageryReady: boolean;
  terrainReady: boolean;
  fontsReady: boolean;
  entitiesReady: boolean;
  pendingRequests: number;
  activeRequests: number;
  /** True while the per-scene 天地图 label layer is switched on. */
  annotationVisible?: boolean;
  annotationWindowCount?: number;
  errors: string[];
}

declare global {
  interface Window {
    geoVideo: {
      seek(seconds: number): Promise<void>;
      getFrameStatus(): FrameStatus;
      getDiagnostics(): unknown;
    };
  }
}

const root = resolve(process.cwd());
const args = process.argv.slice(2);
const valueAfter = (flag: string, fallback?: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const regionId = valueAfter("--region");
if (!regionId) throw new Error("--region is required");
const profileName = valueAfter("--profile", "landscape")!;
const requestedFps = Number(valueAfter("--fps", "30"));
const requestedEndTime = valueAfter("--end-time");
const endInclusive = args.includes("--end-inclusive");
const requestedStartTime = valueAfter("--start-time");
const sampleOnly = args.includes("--sample");
const endpointsOnly = args.includes("--endpoints-only");
const encode = args.includes("--encode") || !sampleOnly;
const port = Number(valueAfter("--port", String(4300 + Number(regionId.slice(-2)) % 200)));
const cacheKey = (valueAfter("--cache-key", "default") ?? "default").replaceAll(/[^a-zA-Z0-9_-]/g, "-");
const imageryProvider = valueAfter("--imagery", "cesium-ion-world-imagery")!;

const profiles = YAML.parse(await readFile(resolve(root, "config/render-profiles.yaml"), "utf8")) as {
  profiles: Record<string, { width: number; height: number }>;
};
const profile = profiles.profiles[profileName];
if (!profile) throw new Error(`Unknown render profile ${profileName}`);
const timeline = JSON.parse(await readFile(resolve(root, `data/regions/${regionId}.timeline.json`), "utf8")) as { duration: number };
const regionRecord = JSON.parse(await readFile(resolve(root, `data/regions/${regionId}.json`), "utf8")) as {
  parentId?: string;
  level?: string;
  levelRole?: string;
  presentationMode?: string;
  openingDescent?: { enabled?: boolean; seconds?: number };
  annotationWindows?: Array<{ sceneId?: string; start: number; end: number }>;
  tourStops?: Array<{ start: number; end: number; flightDuration: number }>;
  tourReturnStart?: number;
  tourReturnDuration?: number;
  tourReturnDurationSeconds?: number;
};
const defaultFromRegion = regionRecord.parentId ?? regionId;
const fromRegionId = valueAfter("--from-region", defaultFromRegion)!;
const tourStops = regionRecord.presentationMode === "parent-child-tour" ? regionRecord.tourStops ?? [] : [];
const duration = Number(valueAfter("--duration", String(timeline.duration)));
const endTime = requestedEndTime !== undefined
  ? Math.min(Number(requestedEndTime), duration)
  : duration;
const startTime = requestedStartTime !== undefined
  ? Math.min(Math.max(0, Number(requestedStartTime)), duration)
  : 0;
const openingSeconds = regionRecord.openingDescent?.enabled === false
  ? 0
  : Number(regionRecord.openingDescent?.seconds ?? 0);
const videoTourStops = tourStops.map((stop) => ({
  ...stop,
  start: stop.start + openingSeconds,
  end: stop.end + openingSeconds
}));
const fps = requestedFps;
const totalFrames = Math.max(1, Math.ceil(endTime * fps) + (endInclusive ? 1 : 0));
const startFrame = Math.min(totalFrames - 1, Math.max(0, Math.ceil(startTime * fps)));
const tourReturnStart = Number(regionRecord.tourReturnStart);
const configuredTourReturnDuration = Number(regionRecord.tourReturnDurationSeconds ?? regionRecord.tourReturnDuration);
const tourReturnDuration = Number.isFinite(configuredTourReturnDuration) ? configuredTourReturnDuration : 0;
const videoTourReturnStart = Number.isFinite(tourReturnStart) ? tourReturnStart + openingSeconds : Number.NaN;
const hasTourReturn = videoTourStops.length > 0
  && Number.isFinite(videoTourReturnStart)
  && tourReturnDuration > 0
  && videoTourReturnStart < duration;
const tourReturnEnd = hasTourReturn ? Math.min(duration, videoTourReturnStart + tourReturnDuration) : 0;

const diagnosticsDir = resolve(root, `renders/diagnostics/${regionId}-${profileName}`);
const sampleDir = resolve(root, `renders/frames/${regionId}-${profileName}-samples`);
const intermediateDir = resolve(root, "renders/intermediate");
const chromeCacheDir = resolve(root, `tmp/chrome-cache-${cacheKey}`);
await rm(sampleDir, { recursive: true, force: true });
await Promise.all([mkdir(diagnosticsDir, { recursive: true }), mkdir(sampleDir, { recursive: true }), mkdir(intermediateDir, { recursive: true }), mkdir(chromeCacheDir, { recursive: true })]);

function startServer(): Promise<ChildProcess> {
  const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
  const child = spawn(process.execPath, [tsxCli, "apps/cesium-player/server.ts", `--port=${port}`], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  return new Promise((resolvePromise, reject) => {
    let logs = "";
    const timer = setTimeout(() => reject(new Error(`Cesium server did not start. Logs: ${logs}`)), 30_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      logs += chunk.toString("utf8");
      if (logs.includes("CESIUM_PLAYER_READY")) {
        clearTimeout(timer);
        resolvePromise(child);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => { logs += chunk.toString("utf8"); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Cesium server exited early with ${code}. Logs: ${logs}`));
    });
  });
}

async function waitReady(page: Page, timeout = 120_000): Promise<FrameStatus> {
  try {
    await page.waitForFunction(() => {
      const state = window.geoVideo?.getFrameStatus();
      return Boolean(state?.ready && state.tilesReady && state.imageryReady && state.terrainReady && state.fontsReady && state.entitiesReady && state.pendingRequests === 0);
    }, undefined, { timeout });
  } catch (error) {
    // A bare timeout hides the one thing worth knowing: which tile host died.
    // The runtime already collects that, so surface it instead of "timed out".
    const status = await page.evaluate(() => window.geoVideo?.getFrameStatus?.() ?? null).catch(() => null);
    const reported = (status?.errors ?? []).slice(0, 4).join(" | ");
    const state = status
      ? `ready=${status.ready} tiles=${status.tilesReady} imagery=${status.imageryReady} terrain=${status.terrainReady} fonts=${status.fontsReady} entities=${status.entitiesReady} pending=${status.pendingRequests}`
      : "页面没有回应 getFrameStatus";
    throw new Error(`Cesium 画面在 ${Math.round(timeout / 1000)}s 内没有就绪（${state}）${reported ? `：${reported}` : ""}`);
  }
  return page.evaluate(() => window.geoVideo.getFrameStatus());
}

async function writeWithBackpressure(stream: NodeJS.WritableStream, buffer: Buffer): Promise<void> {
  if (!stream.write(buffer)) await once(stream, "drain");
}

async function stabilizeCamera(page: Page, cdp: CDPSession, time: number, minimumMs: number, label: string): Promise<Buffer> {
  const started = Date.now();
  let previous: Buffer | null = null;
  let stablePasses = 0;
  let previousDecoded: { data: Buffer; info: { width: number; height: number } } | null = null;
  while (Date.now() - started < 30_000) {
    await page.evaluate((seconds) => window.geoVideo.seek(seconds), time);
    await waitReady(page);
    const captured = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true });
    const current = Buffer.from(captured.data, "base64");
    let stable = false;
    if (previous && previous.equals(current)) {
      stable = true;
    } else if (previous && previousDecoded) {
      const decoded = await sharp(current).raw().toBuffer({ resolveWithObject: true });
      const previousRaw = previousDecoded.data;
      const currentRaw = decoded.data;
      const width = decoded.info.width;
      const height = decoded.info.height;
      let changedPixels = 0;
      let sumAbs = 0;
      const limit = Math.min(previousRaw.length, currentRaw.length);
      for (let index = 0; index < limit; index += 4) {
        const delta = Math.max(
          Math.abs((previousRaw[index] ?? 0) - (currentRaw[index] ?? 0)),
          Math.abs((previousRaw[index + 1] ?? 0) - (currentRaw[index + 1] ?? 0)),
          Math.abs((previousRaw[index + 2] ?? 0) - (currentRaw[index + 2] ?? 0))
        );
        if (delta > 0) {
          changedPixels += 1;
          sumAbs += delta;
        }
      }
      const changedFraction = changedPixels / Math.max(1, width * height);
      const meanAbs = sumAbs / Math.max(1, changedPixels);
      stable = changedFraction < 0.001 && meanAbs <= 3;
      previousDecoded = decoded;
    }
    if (!previousDecoded) previousDecoded = await sharp(current).raw().toBuffer({ resolveWithObject: true });
    previous = current;
    stablePasses = stable ? stablePasses + 1 : 0;
    if (Date.now() - started >= minimumMs && stablePasses >= 2) return current;
    await page.waitForTimeout(250);
  }
  throw new Error(`${label} satellite frame did not stabilize before timeout`);
}

async function warmRestartFrame(page: Page, cdp: CDPSession, time: number): Promise<Buffer> {
  let png: Buffer | null = null;
  for (let pass = 0; pass < 3; pass += 1) {
    await page.evaluate((seconds) => window.geoVideo.seek(seconds), time);
    await waitReady(page);
    await page.waitForTimeout(160);
    const captured = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      optimizeForSpeed: true
    });
    png = Buffer.from(captured.data, "base64");
  }
  if (!png) throw new Error(`Reloaded frame ${time.toFixed(3)}s did not render`);
  return png;
}

async function prewarmCameraPath(page: Page, parentOverviewOnly: boolean, endpointsOnly: boolean): Promise<void> {
  const openingEnd = openingSeconds + 6;
  const openingTimes = Array.from(
    { length: Math.floor(Math.min(openingEnd, duration) / 0.5) + 1 },
    (_, index) => index * 0.5
  );
  const relevantTourStops: typeof videoTourStops = [];
  const times = relevantTourStops.length > 0
    ? [
        ...openingTimes,
        ...relevantTourStops.flatMap((stop) => [0, 0.25, 0.5, 0.75, 1]
          .map((ratio) => Math.min(duration, stop.start + stop.flightDuration * ratio)))
      ]
    : parentOverviewOnly
    ? openingTimes
    : endpointsOnly
      ? [0, Math.min(8, duration)]
      : [
          0,
          ...Array.from(
            { length: Math.floor(Math.min(8, duration) / 0.5) + 1 },
            (_, index) => index * 0.5
          )
        ];
  for (const time of [...new Set(times)]) {
    await page.evaluate((seconds) => window.geoVideo.seek(seconds), time);
    await waitReady(page);
    await page.waitForTimeout(80);
  }
}

const server = await startServer();
// Chrome follows the Windows system proxy on its own. A stale VPN entry then
// fails every imagery tile with ERR_CONNECTION_CLOSED, the base layer never
// loads, and a long recording dies at the first waitReady with nothing but a
// timeout to show for it. The route is therefore explicit:
//   unset / "system" → leave Chrome's own resolution alone (long-standing behaviour)
//   "direct"         → bypass the proxy entirely
//   "http://host:port" (or any proxy string) → use exactly that proxy
const proxyArgs = (() => {
  const value = String(process.env.GEO_CAPTURE_PROXY ?? "").trim();
  if (!value || value === "system") return [] as string[];
  if (["direct", "none", "off"].includes(value.toLowerCase())) return ["--no-proxy-server"];
  return [`--proxy-server=${value}`];
})();
if (proxyArgs.length) console.log(`CAPTURE_PROXY ${proxyArgs.join(" ")}`);
const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: [
    "--force-device-scale-factor=1",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--disable-web-security",
    "--allow-running-insecure-content",
    ...proxyArgs,
    `--disk-cache-dir=${chromeCacheDir}`,
    "--disk-cache-size=1073741824"
  ]
});
const context = await browser.newContext({
  viewport: { width: profile.width, height: profile.height },
  deviceScaleFactor: 1,
  locale: "zh-CN",
  timezoneId: "Asia/Shanghai",
  colorScheme: "dark",
  reducedMotion: "reduce"
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const consoleErrors: string[] = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", (error) => consoleErrors.push(error.message));

let ffmpeg: ChildProcess | null = null;
const outputPath = resolve(intermediateDir, `${regionId}-map-${profileName}.mp4`);
const temporaryOutputPath = resolve(intermediateDir, `${regionId}-map-${profileName}.tmp.mp4`);
let ffmpegErrors = "";
if (encode) {
  const ffmpegPath = process.platform === "win32"
    ? resolve(root, "node_modules/ffmpeg-static/ffmpeg.exe")
    : resolve(root, "node_modules/ffmpeg-static/ffmpeg");
  if (!existsSync(ffmpegPath)) throw new Error(`FFmpeg binary not found at ${ffmpegPath}`);
  ffmpeg = spawn(ffmpegPath, [
    "-y", "-loglevel", "error", "-nostats", "-f", "image2pipe", "-vcodec", "png", "-framerate", String(fps), "-i", "-",
    "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "13", "-pix_fmt", "yuv420p", temporaryOutputPath
  ], { cwd: root, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  ffmpeg.stderr?.on("data", (chunk: Buffer) => { ffmpegErrors = `${ffmpegErrors}${chunk.toString("utf8")}`.slice(-16_000); });
}

const startedAt = Date.now();
const parentOverviewOnly = regionRecord.presentationMode === "parent-topic"
  || regionRecord.level === "prefecture"
  || regionRecord.levelRole === "admin2";
const introDynamicEnd = openingSeconds + 6;
const dynamicRanges = tourStops.length > 0
  ? [
      { start: 0, end: introDynamicEnd },
      ...videoTourStops.map((stop) => ({ start: stop.start, end: stop.start + stop.flightDuration })),
      ...(hasTourReturn ? [{ start: videoTourReturnStart, end: tourReturnEnd }] : [])
    ]
  : parentOverviewOnly ? [{ start: 0, end: 6 }] : [{ start: 0, end: 8 }];
const flightRestartIntervalSeconds = 0.5;
const tourRestartFrames = new Set(
  [
    ...(openingSeconds > 0 ? [{ start: 0, duration: openingSeconds }] : []),
    ...videoTourStops.map((stop) => ({ start: stop.start, duration: stop.flightDuration })),
    ...(hasTourReturn ? [{ start: videoTourReturnStart, duration: tourReturnEnd - videoTourReturnStart }] : [])
  ]
    .flatMap((flight) => sampleOnly
      ? [flight.start]
      : [
          ...Array.from(
            { length: Math.ceil(flight.duration / flightRestartIntervalSeconds) },
            (_, index) => flight.start + Math.min(flight.duration, index * flightRestartIntervalSeconds)
          ),
          flight.start + flight.duration
        ])
    .filter((time) => time < duration)
    .map((time) => sampleOnly ? Math.round(time * fps) : Math.ceil(time * fps))
);
const staticPngByAnchor = new Map<string, Buffer>();
let initialPng: Buffer | null = null;
let selectedEndpointPng: Buffer | null = null;

function staticAnchorAt(time: number): number | null {
  let anchor = 0;
  for (const range of dynamicRanges) {
    if (time >= range.start && time < range.end) return null;
    if (time >= range.end) anchor = (Math.floor(range.end * fps) + 1) / fps;
  }
  return anchor;
}
const selectedSampleFrames = endpointsOnly
  ? new Set([0, Math.round(8 * fps), totalFrames - 1])
  : new Set([
      ...[0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map((ratio) => Math.min(totalFrames - 1, Math.round((totalFrames - 1) * ratio))),
      ...Array.from(
        { length: openingSeconds > 0 ? 13 : 1 },
        (_, index) => openingSeconds > 0 ? openingSeconds * index / 12 : 0
      ).map((seconds) => Math.min(totalFrames - 1, Math.round(seconds * fps))),
      ...(openingSeconds > 0
        ? [0, 0.35, 1, 1.8, 2.6, 3.15, 3.55, 3.7, 4.2, 4.7, 4.9]
            .map((seconds) => openingSeconds + seconds)
            .map((seconds) => Math.min(totalFrames - 1, Math.round(seconds * fps)))
        : []),
      ...[0, 0.35, 1, 1.8, 2, 2.6, 3.15, 3.55, 3.7, 4, 4.2, 4.7, 4.9, 6, 8, 10, 17, 25, 35, 40, 44, 49, duration]
        .map((seconds) => Math.min(totalFrames - 1, Math.round(seconds * fps))),
      ...videoTourStops.flatMap((stop) => [
        stop.start,
        stop.start + stop.flightDuration / 2,
        stop.start + stop.flightDuration,
        (stop.start + stop.end) / 2
      ]
        .map((seconds) => Math.min(totalFrames - 1, Math.round(seconds * fps)))),
      ...(hasTourReturn
        ? [videoTourReturnStart, (videoTourReturnStart + tourReturnEnd) / 2, tourReturnEnd]
            .map((seconds) => Math.min(totalFrames - 1, Math.round(seconds * fps)))
        : [])
    ]);

try {
  const playerUrl = `http://127.0.0.1:${port}/?region=${regionId}&from=${fromRegionId}&profile=${profileName}&clean=1`;
  let initialReady = false;
  for (let attempt = 1; attempt <= 3 && !initialReady; attempt += 1) {
    // Enable the continuous screen-space boundary trace during capture. The
    // Cesium ground segments remain prewarmed underneath and take over after
    // the reveal settles; the canvas keeps the line and pen synchronized while
    // the camera is moving and during deterministic frame seeks.
    await page.goto(`${playerUrl}&imagery=${encodeURIComponent(imageryProvider)}&boundaryCanvas=1&attempt=${attempt}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(() => Boolean(window.geoVideo), undefined, { timeout: 30_000 });
    try {
      await waitReady(page, 45_000);
      initialReady = true;
    } catch (error) {
      process.stderr.write(`IMAGERY_READY_RETRY ${imageryProvider} ${attempt}/3 ${String(error)}\n`);
    }
  }
  if (!initialReady) {
    throw new Error(`Selected imagery provider did not become ready: ${imageryProvider}`);
  }
  await prewarmCameraPath(page, parentOverviewOnly, endpointsOnly);
  initialPng = await stabilizeCamera(page, cdp, 0, 3_000, "Initial");
  if (endpointsOnly && !parentOverviewOnly && tourStops.length === 0) selectedEndpointPng = await stabilizeCamera(page, cdp, 8, 2_000, "Selected-region");
  const frames = sampleOnly
    ? [...selectedSampleFrames].sort((a, b) => a - b).filter((frame) => frame >= startFrame)
    : Array.from({ length: totalFrames }, (_, index) => index).filter((frame) => frame >= startFrame);
  /* The film's label windows live in presentation time; capture seeks the
     opened-up timeline, so a window at 46.3 s starts 46.3 + openingDescent.
     Counting the frames that *should* carry labels lets the run prove it
     recorded them instead of trusting that the toggle worked. */
  const annotationWindows = Array.isArray(regionRecord.annotationWindows) ? regionRecord.annotationWindows : [];
  /** Would the label layer be on at this frame? Pure arithmetic on the window list. */
  const wantsAnnotations = (time: number): boolean => {
    const presentation = time - openingSeconds;
    return annotationWindows.some((range) => presentation + 0.001 >= Number(range.start) && presentation <= Number(range.end) + 0.001);
  };
  /** First frame of the window that covers `time`, or null when outside every window. */
  const annotationWindowStartAt = (time: number): number | null => {
    const presentation = time - openingSeconds;
    const hit = annotationWindows.find((range) => presentation + 0.001 >= Number(range.start) && presentation <= Number(range.end) + 0.001);
    return hit ? Math.max(0, Number(hit.start) + openingSeconds) : null;
  };
  const annotationFrameBudget = frames.filter((frame) => wantsAnnotations(frame / fps)).length;
  /* Which frames actually came back with the layer on.
   *
   * A still stretch of the tour re-uses one PNG (`staticAnchorAt`), and that
   * anchor is the end of the last *camera* movement — which usually sits before
   * the label window opens. Re-using it therefore records a label-free frame for
   * the whole window, silently. Measured on 城月镇: 1012 frames were supposed to
   * carry labels and every one of them was re-using the pre-window anchor.
   *
   * A label window is not camera movement, but it changes the picture all the
   * same, so the anchor has to move to the window's first frame. Inside a
   * window, still frames then share that one properly-labelled anchor; outside,
   * they keep sharing the original one.
   */
  const staticAnchorForKey = (time: number): number | null => {
    const anchor = staticAnchorAt(time);
    if (anchor === null) return null;
    const windowStart = annotationWindowStartAt(time);
    if (windowStart === null) return anchor;
    // Snap to the frame grid so every frame in the window resolves to one anchor.
    return Math.max(anchor, Math.ceil(windowStart * fps - 1e-6) / fps);
  };
  const annotationByKey = new Map<string, boolean>();
  let annotationFrames = 0;
  for (const frame of frames) {
    const seconds = frame / fps;
    try {
      const wanted = wantsAnnotations(seconds);
      let restartedPng: Buffer | null = null;
      if (tourRestartFrames.has(frame)) {
        // A hard page reload re-creates the external imagery provider. During a
        // long export that turned every 0.5 s flight checkpoint into a fresh
        // metadata request, so one transient network error could invalidate an
        // otherwise healthy 6,000+ frame capture. Re-seeking three times gives
        // the camera the same deterministic warm restart without discarding the
        // already-ready Cesium/imagery state.
        restartedPng = await warmRestartFrame(page, cdp, seconds);
      }
      // `staticAnchorForKey` also moves the anchor to the label window's first
      // frame, so a still stretch inside a window is not filled with the
      // label-free picture captured before the window opened.
      const staticAnchor = !sampleOnly ? staticAnchorForKey(seconds) : null;
      const staticKey = staticAnchor === null ? null : staticAnchor.toFixed(3);
      let png: Buffer;
      if (restartedPng) {
        png = restartedPng;
      } else if (frame === 0 && initialPng) {
        png = initialPng;
      } else if (endpointsOnly && tourStops.length === 0 && frame === Math.round(8 * fps) && selectedEndpointPng) {
        png = selectedEndpointPng;
      } else if (staticKey && staticPngByAnchor.has(staticKey)) {
        png = staticPngByAnchor.get(staticKey)!;
      } else {
        const captureTime = staticAnchor === null ? seconds : staticAnchor;
        await page.evaluate((time) => window.geoVideo.seek(time), captureTime);
        const readyState = await waitReady(page);
        annotationByKey.set(staticKey ?? `f${frame}`, Boolean(readyState.annotationVisible));
        const captured = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true });
        png = Buffer.from(captured.data, "base64");
        if (staticKey) staticPngByAnchor.set(staticKey, png);
      }
      if (selectedSampleFrames.has(frame)) await writeFile(resolve(sampleDir, `frame-${String(frame).padStart(6, "0")}.png`), png);
      if (ffmpeg?.stdin) await writeWithBackpressure(ffmpeg.stdin, png);
    } catch (error) {
      const diagnosticPng = await page.screenshot({ type: "png", animations: "disabled" });
      await writeFile(resolve(diagnosticsDir, `failed-frame-${String(frame).padStart(6, "0")}.png`), diagnosticPng);
      const diagnostics = await page.evaluate(() => window.geoVideo?.getDiagnostics?.());
      await writeFile(resolve(diagnosticsDir, `failed-frame-${String(frame).padStart(6, "0")}.json`), JSON.stringify({ frame, seconds, error: String(error), diagnostics, consoleErrors }, null, 2), "utf8");
      throw error;
    }
    if (!sampleOnly && frame > 0 && frame % Math.max(1, fps * 5) === 0) process.stdout.write(`CAPTURE_PROGRESS ${regionId} ${frame}/${totalFrames}\n`);
  }
  if (ffmpeg) {
    ffmpeg.stdin?.end();
    const [code] = await once(ffmpeg, "exit") as [number | null];
    if (code !== 0) throw new Error(`FFmpeg exited with ${code}: ${ffmpegErrors}`);
    await rm(outputPath, { force: true });
    await rename(temporaryOutputPath, outputPath);
  }
  const finalDiagnostics = await page.evaluate(() => window.geoVideo.getDiagnostics());
  // Attribute every frame that should carry labels to the PNG it actually got:
  // frames captured on their own use their own result, re-used frames inherit
  // the result of the anchor they share.
  for (const frame of frames) {
    if (!wantsAnnotations(frame / fps)) continue;
    const staticAnchor = !sampleOnly ? staticAnchorForKey(frame / fps) : null;
    const key = staticAnchor === null ? `f${frame}` : staticAnchor.toFixed(3);
    if (annotationByKey.get(key) === true) annotationFrames += 1;
  }
  await writeFile(resolve(diagnosticsDir, sampleOnly ? "capture-report-samples.json" : "capture-report-full.json"), JSON.stringify({
    regionId, fromRegionId, profile: profileName, width: profile.width, height: profile.height, fps, duration,
    capturedStartTime: startTime,
    capturedEndTime: endTime,
    openingDescentSeconds: openingSeconds,
    totalFrames: sampleOnly ? selectedSampleFrames.size : totalFrames,
    endpointsOnly,
    uniqueFrameOptimization: sampleOnly ? false : true,
    staticReuseAnchorsSeconds: [...staticPngByAnchor.keys()].map((key) => Number(key.split(":")[0])),
    dynamicRanges,
    fullCapture: !sampleOnly,
    outputPath: encode ? outputPath : null,
    elapsedSeconds: (Date.now() - startedAt) / 1000,
    // Proof, not faith: how many frames the windows asked for and how many the
    // player actually had the label layer switched on for.
    annotation: {
      windowCount: annotationWindows.length,
      framesExpected: annotationFrameBudget,
      framesWithLabels: annotationFrames,
      tiles: (finalDiagnostics as { annotationTiles?: unknown } | null)?.annotationTiles ?? null
    },
    consoleErrors,
    finalDiagnostics
  }, null, 2), "utf8");
  if (annotationFrameBudget > 0 && annotationFrames === 0) {
    // The scene toggles say "labels on" but the recording has none of them. That
    // used to fail silently — the film simply shipped without the labels. Refuse
    // the capture instead of encoding a map video that contradicts the project.
    throw new Error(
      `注记未录进画面：${annotationWindows.length} 个场景开启了影像注记（应覆盖 ${annotationFrameBudget} 帧），`
      + `但没有任何一帧的注记图层是打开的。检查区域记录的 annotationWindows 是否写进抓帧用的 data/regions/${regionId}.json，`
      + `以及天地图 token 是否可用。`
    );
  }
  process.stdout.write(`CAPTURE_COMPLETE ${regionId} ${profileName} ${sampleOnly ? "samples" : outputPath}\n`);
  if (annotationFrameBudget > 0) {
    process.stdout.write(`CAPTURE_ANNOTATION ${regionId} frames ${annotationFrames}/${annotationFrameBudget}\n`);
  }
} finally {
  await browser.close();
  server.kill();
}
