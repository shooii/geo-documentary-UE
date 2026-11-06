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

async function waitReady(page: Page): Promise<FrameStatus> {
  await page.waitForFunction(() => {
    const state = window.geoVideo?.getFrameStatus();
    return Boolean(state?.ready && state.tilesReady && state.imageryReady && state.terrainReady && state.fontsReady && state.entitiesReady && state.pendingRequests === 0);
  }, undefined, { timeout: 120_000 });
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
  await page.goto(`http://127.0.0.1:${port}/?region=${regionId}&from=${fromRegionId}&profile=${profileName}&clean=1`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.geoVideo), undefined, { timeout: 30_000 });
  await waitReady(page);
  await prewarmCameraPath(page, parentOverviewOnly, endpointsOnly);
  initialPng = await stabilizeCamera(page, cdp, 0, 3_000, "Initial");
  if (endpointsOnly && !parentOverviewOnly && tourStops.length === 0) selectedEndpointPng = await stabilizeCamera(page, cdp, 8, 2_000, "Selected-region");
  const frames = sampleOnly
    ? [...selectedSampleFrames].sort((a, b) => a - b).filter((frame) => frame >= startFrame)
    : Array.from({ length: totalFrames }, (_, index) => index).filter((frame) => frame >= startFrame);
  for (const frame of frames) {
    const seconds = frame / fps;
    try {
      let restartedPng: Buffer | null = null;
      if (tourRestartFrames.has(frame)) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForFunction(() => Boolean(window.geoVideo), undefined, { timeout: 30_000 });
        await waitReady(page);
        restartedPng = await warmRestartFrame(page, cdp, seconds);
      }
      const staticAnchor = !sampleOnly ? staticAnchorAt(seconds) : null;
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
        await waitReady(page);
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
  await writeFile(resolve(diagnosticsDir, sampleOnly ? "capture-report-samples.json" : "capture-report-full.json"), JSON.stringify({
    regionId, fromRegionId, profile: profileName, width: profile.width, height: profile.height, fps, duration,
    capturedStartTime: startTime,
    capturedEndTime: endTime,
    openingDescentSeconds: openingSeconds,
    totalFrames: sampleOnly ? selectedSampleFrames.size : totalFrames,
    endpointsOnly,
    uniqueFrameOptimization: sampleOnly ? false : true,
    staticReuseAnchorsSeconds: [...staticPngByAnchor.keys()].map(Number),
    dynamicRanges,
    fullCapture: !sampleOnly,
    outputPath: encode ? outputPath : null,
    elapsedSeconds: (Date.now() - startedAt) / 1000,
    consoleErrors,
    finalDiagnostics
  }, null, 2), "utf8");
  process.stdout.write(`CAPTURE_COMPLETE ${regionId} ${profileName} ${sampleOnly ? "samples" : outputPath}\n`);
} finally {
  await browser.close();
  server.kill();
}
