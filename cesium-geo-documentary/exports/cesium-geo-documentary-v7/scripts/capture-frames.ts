import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { resolve } from "node:path";
import { chromium, type CDPSession, type Page } from "playwright";
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
const seriesOrder = ["440800", "440802", "440803", "440804", "440811", "440823", "440825", "440881", "440882", "440883"];
const seriesIndex = seriesOrder.indexOf(regionId);
const defaultFromRegion = seriesIndex > 0 ? seriesOrder[seriesIndex - 1] : regionId;
const fromRegionId = valueAfter("--from-region", defaultFromRegion)!;
const profileName = valueAfter("--profile", "landscape")!;
const requestedFps = Number(valueAfter("--fps", "30"));
const sampleOnly = args.includes("--sample");
const endpointsOnly = args.includes("--endpoints-only");
const encode = args.includes("--encode") || !sampleOnly;
const port = Number(valueAfter("--port", String(4300 + Number(regionId.slice(-2)) % 200)));
const cacheKey = (valueAfter("--cache-key", "default") ?? "default").replaceAll(/[^a-zA-Z0-9_-]/g, "-");

const profiles = YAML.parse(await (await import("node:fs/promises")).readFile(resolve(root, "config/render-profiles.yaml"), "utf8")) as {
  profiles: Record<string, { width: number; height: number }>;
};
const profile = profiles.profiles[profileName];
if (!profile) throw new Error(`Unknown render profile ${profileName}`);
const timeline = JSON.parse(await (await import("node:fs/promises")).readFile(resolve(root, `data/regions/${regionId}.timeline.json`), "utf8")) as { duration: number };
const duration = Number(valueAfter("--duration", String(timeline.duration)));
const fps = requestedFps;
const totalFrames = Math.ceil(duration * fps);

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
  let identicalPasses = 0;
  while (Date.now() - started < 30_000) {
    await page.evaluate((seconds) => window.geoVideo.seek(seconds), time);
    await waitReady(page);
    const captured = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true });
    const current = Buffer.from(captured.data, "base64");
    identicalPasses = previous?.equals(current) ? identicalPasses + 1 : 0;
    previous = current;
    if (Date.now() - started >= minimumMs && identicalPasses >= 2) return current;
    await page.waitForTimeout(250);
  }
  throw new Error(`${label} satellite frame did not stabilize before timeout`);
}

async function prewarmCameraPath(page: Page, parentOverviewOnly: boolean, endpointsOnly: boolean): Promise<void> {
  const times = parentOverviewOnly
    ? [0]
    : endpointsOnly
      ? [0, 8]
      : [
          0,
          ...Array.from({ length: 17 }, (_, index) => index * 0.5)
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
const parentOverviewOnly = regionId === "440800";
const staticStartFrame = Math.round(8 * fps);
let staticPng: Buffer | null = null;
let initialPng: Buffer | null = null;
let selectedEndpointPng: Buffer | null = null;
const selectedSampleFrames = endpointsOnly
  ? new Set([0, Math.round(8 * fps), totalFrames - 1])
  : new Set([
      ...[0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map((ratio) => Math.min(totalFrames - 1, Math.round((totalFrames - 1) * ratio))),
      ...[0, 1, 2, 4, 6, 8, 10, 17, 25, 35, 40, 44, 49].map((seconds) => Math.min(totalFrames - 1, Math.round(seconds * fps)))
    ]);

try {
  await page.goto(`http://127.0.0.1:${port}/?region=${regionId}&from=${fromRegionId}&clean=1`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.geoVideo), undefined, { timeout: 30_000 });
  await waitReady(page);
  await prewarmCameraPath(page, parentOverviewOnly, endpointsOnly);
  initialPng = await stabilizeCamera(page, cdp, 0, 3_000, "Initial");
  if (endpointsOnly && !parentOverviewOnly) selectedEndpointPng = await stabilizeCamera(page, cdp, 8, 2_000, "Selected-region");
  if (parentOverviewOnly && !sampleOnly) staticPng = initialPng;
  const frames = sampleOnly ? [...selectedSampleFrames].sort((a, b) => a - b) : Array.from({ length: totalFrames }, (_, index) => index);
  for (const frame of frames) {
    const seconds = frame / fps;
    try {
      const isReusableStaticFrame = !sampleOnly && (parentOverviewOnly || frame >= staticStartFrame);
      let png: Buffer;
      if (frame === 0 && initialPng) {
        png = initialPng;
      } else if (endpointsOnly && frame === Math.round(8 * fps) && selectedEndpointPng) {
        png = selectedEndpointPng;
      } else if (isReusableStaticFrame && staticPng) {
        png = staticPng;
      } else {
        const captureTime = isReusableStaticFrame && !parentOverviewOnly ? 8 : seconds;
        await page.evaluate((time) => window.geoVideo.seek(time), captureTime);
        await waitReady(page);
        const captured = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true });
        png = Buffer.from(captured.data, "base64");
        if (isReusableStaticFrame) staticPng = png;
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
    totalFrames: sampleOnly ? selectedSampleFrames.size : totalFrames,
    endpointsOnly,
    uniqueFrameOptimization: sampleOnly ? false : true,
    staticReuseRangeSeconds: parentOverviewOnly ? [0, duration] : [8, duration],
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
