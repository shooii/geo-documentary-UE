import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface RegionContent { name: string }
const root = resolve(process.cwd());
const args = process.argv.slice(2);
const regionIndex = args.indexOf("--region");
const requested = regionIndex >= 0 ? args[regionIndex + 1] : undefined;
const force = args.includes("--force");
const master = JSON.parse(await readFile(resolve(root, "content/regions.zh-CN.json"), "utf8")) as Record<string, RegionContent>;
const ids = requested ? [requested] : Object.keys(master);
const generatedAt = new Date().toISOString().slice(0, 10);
const python = process.env.PYTHON ?? "python";
const pythonPath = resolve(root, ".python-packages");
const ffmpeg = process.platform === "win32" ? resolve(root, "node_modules/ffmpeg-static/ffmpeg.exe") : resolve(root, "node_modules/ffmpeg-static/ffmpeg");

function run(command: string, commandArgs: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: "utf8", env, windowsHide: true });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}

function durationFromFfmpeg(path: string): number {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-i", path], { cwd: root, encoding: "utf8", windowsHide: true });
  const match = `${result.stdout}\n${result.stderr}`.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) throw new Error(`Could not read audio duration for ${path}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

for (const id of ids) {
  if (!master[id]) throw new Error(`Unknown region ${id}`);
  const audioDir = resolve(root, `assets/audio/${id}`);
  const mp3 = resolve(audioDir, "narration.mp3");
  const wav = resolve(audioDir, "narration.wav");
  const edgeSrt = resolve(audioDir, "narration-edge.srt");
  await mkdir(audioDir, { recursive: true });
  if (force || !existsSync(mp3) || !existsSync(edgeSrt)) {
    run(python, [
      "-m", "edge_tts", "--voice", "zh-CN-YunxiNeural", "--rate=+0%",
      "--file", `content/scripts/${id}.txt`, "--write-media", mp3, "--write-subtitles", edgeSrt
    ], { ...process.env, PYTHONPATH: pythonPath });
  }
  run(ffmpeg, ["-y", "-i", mp3, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
  const duration = durationFromFfmpeg(mp3);
  await writeFile(resolve(audioDir, "duration.json"), JSON.stringify({
    regionId: id,
    provider: "edge-tts",
    voiceId: "zh-CN-YunxiNeural",
    durationSeconds: duration,
    sampleRate: 48000,
    generatedAt,
    hyperframesTtsAttempt: "failed-model-download-timeout"
  }, null, 2), "utf8");
  run(python, [".agents/skills/cesium-geo-documentary/scripts/generate-subtitles.py", "--region", id]);
  process.stdout.write(`NARRATION_READY ${id} ${duration.toFixed(2)}s\n`);
}
