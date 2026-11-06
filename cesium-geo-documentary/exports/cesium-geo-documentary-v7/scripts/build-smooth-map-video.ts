import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const args = process.argv.slice(2);
const valueAfter = (flag: string, fallback?: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};

const regionId = valueAfter("--region");
if (!regionId) throw new Error("--region is required");
const profile = valueAfter("--profile", "landscape")!;
const fps = Number(valueAfter("--fps", "30"));
const timeline = JSON.parse(await readFile(resolve(root, `data/regions/${regionId}.timeline.json`), "utf8")) as { duration: number };
const duration = timeline.duration;
const sampleDir = resolve(root, `renders/frames/${regionId}-${profile}-samples`);
const parentPng = resolve(sampleDir, "frame-000000.png");
const selectedPng = resolve(sampleDir, `frame-${String(Math.round(8 * fps)).padStart(6, "0")}.png`);
if (!existsSync(parentPng) || !existsSync(selectedPng)) {
  throw new Error(`Missing resolved endpoint PNGs in ${sampleDir}`);
}

const outputDir = resolve(root, "renders/intermediate");
const outputPath = resolve(outputDir, `${regionId}-map-${profile}.mp4`);
const temporaryPath = resolve(outputDir, `${regionId}-map-${profile}.smooth.tmp.mp4`);
const reportPath = resolve(root, `renders/diagnostics/${regionId}-${profile}/smooth-map-report.json`);
const ffmpegPath = process.platform === "win32"
  ? resolve(root, "node_modules/ffmpeg-static/ffmpeg.exe")
  : resolve(root, "node_modules/ffmpeg-static/ffmpeg");
if (!existsSync(ffmpegPath)) throw new Error(`FFmpeg binary not found at ${ffmpegPath}`);
await mkdir(outputDir, { recursive: true });
await mkdir(resolve(root, `renders/diagnostics/${regionId}-${profile}`), { recursive: true });

const commonOutput = [
  "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "13",
  "-pix_fmt", "yuv420p", "-r", String(fps), "-t", String(duration),
  "-movflags", "+faststart", temporaryPath
];
const selectedEndpointFilter = "null";

const ffmpegArgs = regionId === "440800"
  ? [
      "-y", "-loglevel", "error", "-nostats",
      "-loop", "1", "-framerate", String(fps), "-t", String(duration), "-i", parentPng,
      ...commonOutput
    ]
  : [
      "-y", "-loglevel", "error", "-nostats",
      "-loop", "1", "-framerate", String(fps), "-t", "6", "-i", parentPng,
      "-loop", "1", "-framerate", String(fps), "-t", "46.5", "-i", selectedPng,
      "-loop", "1", "-framerate", String(fps), "-t", "6", "-i", parentPng,
      "-filter_complex",
      "[0:v]settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p[p];" +
      `[1:v]${selectedEndpointFilter},settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p[s];` +
      "[2:v]settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p[p2];" +
      "[p][s]xfade=transition=fadeslow:duration=4:offset=2[arrived];" +
      "[arrived][p2]xfade=transition=fadeslow:duration=4.5:offset=44,format=yuv420p[v]",
      "-map", "[v]",
      ...commonOutput
    ];

let stderr = "";
const child = spawn(ffmpegPath, ffmpegArgs, { cwd: root, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_000); });
const [code] = await once(child, "exit") as [number | null];
if (code !== 0) throw new Error(`FFmpeg smooth map render failed with ${code}: ${stderr}`);
await rm(outputPath, { force: true });
await rename(temporaryPath, outputPath);
await writeFile(reportPath, JSON.stringify({
  regionId,
  profile,
  fps,
  duration,
  mode: regionId === "440800" ? "stable-parent-overview" : "resolved-endpoint-satellite-crossfade",
  selectedEndpointFilter: regionId === "440800" ? null : selectedEndpointFilter,
  arrival: regionId === "440800" ? null : { start: 2, duration: 4, transition: "fadeslow" },
  departure: regionId === "440800" ? null : { start: 44, duration: 4.5, transition: "fadeslow" },
  parentPng,
  selectedPng,
  outputPath
}, null, 2), "utf8");
process.stdout.write(`SMOOTH_MAP_COMPLETE ${regionId} ${profile} ${outputPath}\n`);
