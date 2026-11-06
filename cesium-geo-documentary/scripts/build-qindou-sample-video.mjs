import { readdir, writeFile, rm, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const region = "440882116";
const fps = 30;
const duration = 163;
const sampleDir = resolve(root, `renders/frames/${region}-portrait-samples`);
const names = (await readdir(sampleDir)).filter((n) => /^frame-\d{6}\.png$/.test(n)).sort();
if (names.length < 100) throw new Error(`Expected full timeline samples, found ${names.length}`);
const concatPath = resolve(root, `renders/diagnostics/${region}-portrait/sample-sequence.ffconcat`);
const tempPath = resolve(root, `renders/intermediate/${region}-map-portrait.samples.tmp.mp4`);
const outputPath = resolve(root, `renders/intermediate/${region}-map-portrait.mp4`);
const lines = ["ffconcat version 1.0"];
for (let i = 0; i < names.length; i++) {
  const frame = Number(names[i].slice(6, 12));
  const nextFrame = i + 1 < names.length ? Number(names[i + 1].slice(6, 12)) : Math.round(duration * fps);
  const imagePath = `../../frames/${region}-portrait-samples/${names[i]}`;
  lines.push(`file '${imagePath}'`);
  lines.push(`duration ${Math.max(1 / fps, (nextFrame - frame) / fps).toFixed(6)}`);
}
lines.push(`file '../../frames/${region}-portrait-samples/${names.at(-1)}'`);
await writeFile(concatPath, `${lines.join("\n")}\n`, "utf8");
const ffmpeg = resolve(root, "node_modules/ffmpeg-static/ffmpeg.exe");
const args = [
  "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concatPath,
  "-vf", "fps=30,format=yuv420p",
  "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-t", String(duration),
  "-movflags", "+faststart", tempPath
];
let stderr = "";
const child = spawn(ffmpeg, args, { cwd: root, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
const [code] = await once(child, "exit");
if (code !== 0) throw new Error(`sample video encode failed ${code}: ${stderr}`);
await rm(outputPath, { force: true });
await rename(tempPath, outputPath);
console.log(`SAMPLE_MAP_COMPLETE ${names.length} ${outputPath}`);
