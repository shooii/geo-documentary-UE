import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

interface ProbeStream {
  codec_name?: string;
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
}

interface ProbeResult {
  streams: ProbeStream[];
  format: { duration?: string; size?: string; bit_rate?: string };
}

interface ValidationResult {
  regionId: string;
  profile: string;
  path: string;
  ok: boolean;
  duration: number;
  width: number;
  height: number;
  fps: string;
  hasAudio: boolean;
  blackEvents: string[];
  silenceEvents: string[];
  errors: string[];
}

const root = resolve(process.cwd());
const args = process.argv.slice(2);
const valueAfter = (flag: string, fallback?: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const stage = valueAfter("--stage", "draft")!;
if (!new Set(["draft", "final"]).has(stage)) throw new Error(`Unknown stage ${stage}`);
const requestedRegion = valueAfter("--region");
const requestedProfile = valueAfter("--profile");
const contentIndex = JSON.parse(await readFile(resolve(root, "content/regions.zh-CN.json"), "utf8")) as Record<string, unknown>;
const ids = requestedRegion
  ? [requestedRegion]
  : Object.keys(contentIndex);
const profileDefinitions = {
  landscape: { width: 1920, height: 1080, subtitleMaximum: 26, subtitleLines: 1 },
  portrait: { width: 1080, height: 1920, subtitleMaximum: 14, subtitleLines: 1 },
  square: { width: 1080, height: 1080, subtitleMaximum: 16, subtitleLines: 1 }
} as const;
const profiles = requestedProfile
  ? [requestedProfile]
  : Object.keys(profileDefinitions);

const ffmpegPath = process.platform === "win32"
  ? resolve(root, "node_modules/ffmpeg-static/ffmpeg.exe")
  : resolve(root, "node_modules/ffmpeg-static/ffmpeg");
const ffprobePath = process.platform === "win32"
  ? resolve(root, "node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe")
  : resolve(root, "node_modules/ffprobe-static/bin/linux/x64/ffprobe");
if (!existsSync(ffmpegPath) || !existsSync(ffprobePath)) throw new Error("FFmpeg or FFprobe static binary is missing");

function run(executable: string, commandArgs: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, commandArgs, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise({ code: code ?? -1, output }));
  });
}

async function validateVideo(regionId: string, profile: string): Promise<ValidationResult> {
  const definition = profileDefinitions[profile as keyof typeof profileDefinitions];
  if (!definition) throw new Error(`Unknown profile ${profile}`);
  const directory = stage === "final" ? "renders/final" : "renders/previews";
  const suffix = stage === "final" ? "final" : "draft";
  const relativePath = `${directory}/${regionId}-${profile}-${suffix}.mp4`;
  const absolutePath = resolve(root, relativePath);
  const errors: string[] = [];
  if (!existsSync(absolutePath)) {
    return { regionId, profile, path: relativePath, ok: false, duration: 0, width: 0, height: 0, fps: "", hasAudio: false, blackEvents: [], silenceEvents: [], errors: ["file-missing"] };
  }

  const probeCommand = await run(ffprobePath, [
    "-v", "error",
    "-show_entries", "format=duration,size,bit_rate",
    "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
    "-of", "json",
    absolutePath
  ]);
  if (probeCommand.code !== 0) throw new Error(`FFprobe failed for ${relativePath}: ${probeCommand.output}`);
  const probe = JSON.parse(probeCommand.output) as ProbeResult;
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format.duration ?? 0);
  if (Math.abs(duration - 50) > 0.05) errors.push(`duration:${duration}`);
  if (!video) errors.push("video-stream-missing");
  if (video?.width !== definition.width || video.height !== definition.height) errors.push(`resolution:${video?.width ?? 0}x${video?.height ?? 0}`);
  if (video?.r_frame_rate !== "30/1") errors.push(`fps:${video?.r_frame_rate ?? "missing"}`);
  if (!audio) errors.push("audio-stream-missing");

  const detection = await run(ffmpegPath, [
    "-hide_banner", "-nostats", "-i", absolutePath,
    "-filter_complex", "[0:v]blackdetect=d=0.2:pix_th=0.02[v];[0:a]silencedetect=noise=-50dB:d=1[a]",
    "-map", "[v]", "-map", "[a]", "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"
  ]);
  if (detection.code !== 0) throw new Error(`FFmpeg validation failed for ${relativePath}: ${detection.output.slice(-4000)}`);
  const blackEvents = detection.output.split(/\r?\n/).filter((line) => line.includes("black_start") || line.includes("black_end"));
  const silenceEvents = detection.output.split(/\r?\n/).filter((line) => line.includes("silence_start") || line.includes("silence_end"));
  if (blackEvents.length > 0) errors.push("black-frame-event");
  if (silenceEvents.length > 0) errors.push("silence-event");

  return {
    regionId,
    profile,
    path: relativePath,
    ok: errors.length === 0,
    duration,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: video?.r_frame_rate ?? "",
    hasAudio: Boolean(audio),
    blackEvents,
    silenceEvents,
    errors
  };
}

async function runWithConcurrency<T, R>(items: T[], concurrency: number, operation: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await operation(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

const targets = ids.flatMap((regionId) => profiles.map((profile) => ({ regionId, profile })));
const videoResults = await runWithConcurrency(targets, 3, ({ regionId, profile }) => validateVideo(regionId, profile));

const subtitleErrors: string[] = [];
function decodeCompositionText(html: string): string {
  return html
    .replaceAll(/<br\s*\/?>/gi, "\n")
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"');
}
for (const { regionId, profile } of targets) {
  const definition = profileDefinitions[profile as keyof typeof profileDefinitions];
  if (!definition) continue;
  const captionPath = resolve(root, `apps/video-compositor/captions/${regionId}.json`);
  const compositionPath = resolve(root, `apps/video-compositor/compositions/${regionId}-${profile}.html`);
  const captionData = JSON.parse(await readFile(captionPath, "utf8")) as { cues: Array<{ text: string }> };
  const expectedText = captionData.cues.map((cue) => cue.text).join("");
  const html = await readFile(compositionPath, "utf8");
  const clips = [...html.matchAll(/<div id="caption-\d+"[^>]*>([\s\S]*?)<\/div>/g)].map((match) => match[1] ?? "");
  const actualText = clips.map((clip) => decodeCompositionText(clip).replaceAll("\n", "")).join("");
  if (actualText !== expectedText) subtitleErrors.push(`${regionId}-${profile}:text-mismatch`);
  for (const [index, clip] of clips.entries()) {
    const lines = decodeCompositionText(clip).split("\n");
    if (lines.length > definition.subtitleLines) subtitleErrors.push(`${regionId}-${profile}:caption-${index}:too-many-lines`);
    if (lines.some((line) => [...line].length > definition.subtitleMaximum)) subtitleErrors.push(`${regionId}-${profile}:caption-${index}:line-too-long`);
  }
}

const failedVideos = videoResults.filter((result) => !result.ok);
const report = {
  stage,
  generatedAt: new Date().toISOString(),
  ok: failedVideos.length === 0 && subtitleErrors.length === 0,
  summary: {
    expectedVideos: targets.length,
    passedVideos: videoResults.length - failedVideos.length,
    failedVideos: failedVideos.length,
    subtitleErrors: subtitleErrors.length
  },
  subtitleErrors,
  videos: videoResults
};
const diagnosticsDirectory = resolve(root, "renders/diagnostics");
await mkdir(diagnosticsDirectory, { recursive: true });
await writeFile(resolve(diagnosticsDirectory, `${stage}-delivery-validation.json`), JSON.stringify(report, null, 2), "utf8");
process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
