import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";

interface ProbeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  level?: number;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  time_base?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
}

interface ProbeResult {
  streams: ProbeStream[];
  format: {
    duration?: string;
    size?: string;
    bit_rate?: string;
  };
}

interface SegmentReport {
  regionId: string;
  path: string;
  duration: number;
  size: number;
  video: ProbeStream;
  audio: ProbeStream;
}

const root = resolve(process.cwd());
const args = process.argv.slice(2);
const valueAfter = (flag: string, fallback?: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};

const regions = (valueAfter("--regions") ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (regions.length === 0) throw new Error("Use --regions <id-1,id-2,...> to define the editorial order");

const profile = valueAfter("--profile", "landscape")!;
const stage = valueAfter("--stage", "final")!;
if (!new Set(["draft", "final"]).has(stage)) throw new Error(`Unknown stage ${stage}`);
const suffix = stage === "final" ? "final" : "draft";
const inputDirectory = resolve(root, stage === "final" ? "renders/final" : "renders/previews");
const outputPath = resolve(root, valueAfter("--output", "renders/final/master.mp4")!);
const outputStem = basename(outputPath, extname(outputPath));
const reportBase = resolve(root, valueAfter("--report-base", `renders/diagnostics/${outputStem}-report`)!);
const coverPath = resolve(root, valueAfter("--cover", `renders/final/covers/${outputStem}-cover.png`)!);
const deepQa = !args.includes("--skip-deep-qa");

const ffmpegPath = process.platform === "win32"
  ? resolve(root, "node_modules/ffmpeg-static/ffmpeg.exe")
  : resolve(root, "node_modules/ffmpeg-static/ffmpeg");
const ffprobePath = process.platform === "win32"
  ? resolve(root, "node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe")
  : resolve(root, "node_modules/ffprobe-static/bin/linux/x64/ffprobe");
if (!existsSync(ffmpegPath) || !existsSync(ffprobePath)) throw new Error("FFmpeg or FFprobe static binary is missing");

function run(executable: string, commandArgs: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, commandArgs, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-200_000); });
    child.stderr.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-200_000); });
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise({ code: code ?? -1, output }));
  });
}

async function probe(path: string): Promise<ProbeResult> {
  const result = await run(ffprobePath, [
    "-v", "error",
    "-show_entries", "format=duration,size,bit_rate",
    "-show_entries", "stream=index,codec_type,codec_name,profile,level,width,height,pix_fmt,r_frame_rate,avg_frame_rate,time_base,sample_rate,channels,channel_layout,color_range,color_space,color_transfer,color_primaries",
    "-of", "json",
    path
  ]);
  if (result.code !== 0) throw new Error(`FFprobe failed for ${path}: ${result.output}`);
  return JSON.parse(result.output) as ProbeResult;
}

function streamSignature(stream: ProbeStream): string {
  return JSON.stringify({
    codec_type: stream.codec_type,
    codec_name: stream.codec_name,
    profile: stream.profile,
    level: stream.level,
    width: stream.width,
    height: stream.height,
    pix_fmt: stream.pix_fmt,
    r_frame_rate: stream.r_frame_rate,
    avg_frame_rate: stream.avg_frame_rate,
    time_base: stream.time_base,
    sample_rate: stream.sample_rate,
    channels: stream.channels,
    channel_layout: stream.channel_layout,
    color_range: stream.color_range,
    color_space: stream.color_space,
    color_transfer: stream.color_transfer,
    color_primaries: stream.color_primaries
  });
}

function concatPath(path: string): string {
  return path.replaceAll("\\", "/").replaceAll("'", "'\\''");
}

await mkdir(dirname(outputPath), { recursive: true });
await mkdir(dirname(reportBase), { recursive: true });
await mkdir(dirname(coverPath), { recursive: true });

const segments: SegmentReport[] = [];
for (const regionId of regions) {
  const path = resolve(inputDirectory, `${regionId}-${profile}-${suffix}.mp4`);
  if (!existsSync(path)) throw new Error(`Missing validated segment ${path}`);
  const result = await probe(path);
  const video = result.streams.find((stream) => stream.codec_type === "video");
  const audio = result.streams.find((stream) => stream.codec_type === "audio");
  if (!video || !audio) throw new Error(`Segment requires video and audio streams: ${path}`);
  segments.push({
    regionId,
    path: relative(root, path).replaceAll("\\", "/"),
    duration: Number(result.format.duration ?? 0),
    size: Number(result.format.size ?? 0),
    video,
    audio
  });
}

const videoSignature = streamSignature(segments[0]!.video);
const audioSignature = streamSignature(segments[0]!.audio);
const incompatible = segments.filter((segment) =>
  streamSignature(segment.video) !== videoSignature || streamSignature(segment.audio) !== audioSignature
);
if (incompatible.length > 0) {
  throw new Error(`Stream-copy compatibility failed for: ${incompatible.map((segment) => segment.regionId).join(", ")}. Re-render segments consistently before building the master.`);
}

const concatListPath = resolve(root, `renders/diagnostics/${outputStem}.concat.txt`);
const concatText = regions
  .map((regionId) => `file '${concatPath(resolve(inputDirectory, `${regionId}-${profile}-${suffix}.mp4`))}'`)
  .join("\n");
await writeFile(concatListPath, `${concatText}\n`, "utf8");

const partialPath = outputPath.replace(/\.mp4$/i, ".partial.mp4");
await rm(partialPath, { force: true });
process.stdout.write(`MASTER_CONCAT_START segments=${segments.length} mode=stream-copy output=${outputPath}\n`);
const concatResult = await run(ffmpegPath, [
  "-hide_banner", "-loglevel", "warning", "-y",
  "-f", "concat", "-safe", "0", "-i", concatListPath,
  "-map", "0:v:0", "-map", "0:a:0",
  "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart",
  partialPath
]);
if (concatResult.code !== 0) throw new Error(`FFmpeg stream-copy concat failed: ${concatResult.output}`);
await rm(outputPath, { force: true });
await rename(partialPath, outputPath);

const masterProbe = await probe(outputPath);
const masterVideo = masterProbe.streams.find((stream) => stream.codec_type === "video");
const masterAudio = masterProbe.streams.find((stream) => stream.codec_type === "audio");
const expectedDuration = segments.reduce((sum, segment) => sum + segment.duration, 0);
const actualDuration = Number(masterProbe.format.duration ?? 0);
const durationTolerance = Math.max(0.5, segments.length * 0.05);
const errors: string[] = [];
if (!masterVideo || !masterAudio) errors.push("master-stream-missing");
if (masterVideo && streamSignature(masterVideo) !== videoSignature) errors.push("master-video-signature-mismatch");
if (masterAudio && streamSignature(masterAudio) !== audioSignature) errors.push("master-audio-signature-mismatch");
if (Math.abs(actualDuration - expectedDuration) > durationTolerance) {
  errors.push(`master-duration:${actualDuration.toFixed(3)} expected:${expectedDuration.toFixed(3)}`);
}

let blackEvents: string[] = [];
let silenceEvents: string[] = [];
if (deepQa) {
  process.stdout.write("MASTER_DEEP_QA_START\n");
  const qaResult = await run(ffmpegPath, [
    "-hide_banner", "-nostats", "-i", outputPath,
    "-filter_complex", "[0:v]blackdetect=d=0.2:pix_th=0.02[v];[0:a]silencedetect=noise=-50dB:d=1[a]",
    "-map", "[v]", "-map", "[a]", "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"
  ]);
  if (qaResult.code !== 0) errors.push("master-deep-qa-failed");
  blackEvents = qaResult.output.split(/\r?\n/).filter((line) => line.includes("black_start") || line.includes("black_end"));
  silenceEvents = qaResult.output.split(/\r?\n/).filter((line) => line.includes("silence_start") || line.includes("silence_end"));
  if (blackEvents.length > 0) errors.push("master-black-frame-event");
  if (silenceEvents.length > 0) errors.push("master-silence-event");
}

const coverResult = await run(ffmpegPath, [
  "-hide_banner", "-loglevel", "error", "-y", "-ss", "3", "-i", outputPath,
  "-frames:v", "1", coverPath
]);
if (coverResult.code !== 0) errors.push("master-cover-failed");

let cumulative = 0;
const joins = segments.slice(0, -1).map((segment, index) => {
  cumulative += segment.duration;
  return {
    time: Number(cumulative.toFixed(3)),
    from: segment.regionId,
    to: segments[index + 1]!.regionId
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  ok: errors.length === 0,
  stage,
  profile,
  concatMode: "stream-copy",
  output: relative(root, outputPath).replaceAll("\\", "/"),
  cover: relative(root, coverPath).replaceAll("\\", "/"),
  order: regions,
  expectedDuration,
  actualDuration,
  durationTolerance,
  size: Number(masterProbe.format.size ?? 0),
  joins,
  blackEvents,
  silenceEvents,
  errors,
  segments,
  master: masterProbe
};
await writeFile(`${reportBase}.json`, JSON.stringify(report, null, 2), "utf8");
const markdown = [
  "# Master video report",
  "",
  `- Status: ${report.ok ? "PASS" : "FAIL"}`,
  `- Output: ${report.output}`,
  `- Profile: ${profile}`,
  `- Concat mode: stream-copy (no additional video encoding)`,
  `- Order: ${regions.join(" → ")}`,
  `- Duration: ${actualDuration.toFixed(3)}s (expected ${expectedDuration.toFixed(3)}s)`,
  `- Resolution: ${masterVideo?.width ?? 0}x${masterVideo?.height ?? 0}`,
  `- Frame rate: ${masterVideo?.r_frame_rate ?? "missing"}`,
  `- Video/audio: ${masterVideo?.codec_name ?? "missing"}/${masterAudio?.codec_name ?? "missing"}`,
  `- Black events: ${blackEvents.length}`,
  `- Silence events: ${silenceEvents.length}`,
  `- Errors: ${errors.length === 0 ? "none" : errors.join(", ")}`,
  ""
].join("\n");
await writeFile(`${reportBase}.md`, markdown, "utf8");
process.stdout.write(`MASTER_COMPLETE ok=${report.ok} duration=${actualDuration.toFixed(3)} output=${outputPath}\n`);
if (!report.ok) process.exitCode = 1;
