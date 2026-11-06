import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface PronunciationRecord { term: string; pinyin: string }
interface RegionContent {
  name: string;
  voiceRate?: string;
  voiceId?: string;
  narration: string[];
  pronunciations?: PronunciationRecord[];
}
const root = resolve(process.cwd());
const args = process.argv.slice(2);
const regionIndex = args.indexOf("--region");
const requested = regionIndex >= 0 ? args[regionIndex + 1] : undefined;
const force = args.includes("--force");
const draftMode = args.includes("--draft") || args.includes("--allow-sapi-fallback");
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

function narrationInput(content: RegionContent): string {
  return `${content.narration
    .map((paragraph) => paragraph.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n\n")}\n`;
}

function loudnessNormalize(input: string, output: string): Record<string, string> {
  const target = "loudnorm=I=-16:TP=-1.5:LRA=11";
  const nullTarget = process.platform === "win32" ? "NUL" : "/dev/null";
  const analysis = spawnSync(ffmpeg, [
    "-hide_banner", "-i", input, "-af", `${target}:print_format=json`, "-f", "null", nullTarget
  ], { cwd: root, encoding: "utf8", windowsHide: true });
  if (analysis.status !== 0) {
    throw new Error(`ffmpeg loudness analysis failed\n${analysis.stdout}\n${analysis.stderr}`);
  }
  const reports = `${analysis.stdout}\n${analysis.stderr}`.match(/\{[\s\S]*?"target_offset"\s*:\s*"[^"]+"[\s\S]*?\}/g);
  const report = JSON.parse(reports?.at(-1) ?? "null") as Record<string, string> | null;
  if (!report) throw new Error("ffmpeg loudness analysis did not return a JSON report");
  const measured = [
    target,
    `measured_I=${report.input_i}`,
    `measured_TP=${report.input_tp}`,
    `measured_LRA=${report.input_lra}`,
    `measured_thresh=${report.input_thresh}`,
    `offset=${report.target_offset}`,
    "linear=true",
    "print_format=summary"
  ].join(":");
  run(ffmpeg, ["-y", "-i", input, "-af", measured, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", output]);
  return report;
}

function srtTimestamp(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
  const secs = Math.floor(milliseconds % 60_000 / 1000);
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

async function writeProportionalSrt(path: string, narration: string[], duration: number): Promise<void> {
  const weights = narration.map((text) => Math.max(1, [...text].length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const startPadding = 0.1;
  const endPadding = 0.15;
  const usable = Math.max(1, duration - startPadding - endPadding);
  let cursor = startPadding;
  const blocks = narration.map((text, index) => {
    const end = index === narration.length - 1
      ? Math.max(cursor + 0.25, duration - endPadding)
      : cursor + usable * weights[index]! / totalWeight;
    const block = `${index + 1}\n${srtTimestamp(cursor)} --> ${srtTimestamp(end)}\n${text}`;
    cursor = end;
    return block;
  });
  await writeFile(path, `${blocks.join("\n\n")}\n`, "utf8");
}

async function synchronizeEditorialDuration(regionId: string, audioDuration: number): Promise<number> {
  const editorialDuration = Math.max(50, Math.ceil(audioDuration + 1));
  const timelinePath = resolve(root, `data/regions/${regionId}.timeline.json`);
  if (existsSync(timelinePath)) {
    const timeline = JSON.parse(await readFile(timelinePath, "utf8")) as {
      duration: number;
      actions: Array<{ id: string; time: number; duration: number; type: string }>;
    };
    timeline.duration = editorialDuration;
    timeline.actions = timeline.actions.map((action) => {
      if (action.id === "summary-01") return { ...action, duration: Math.max(0.5, editorialDuration - action.time) };
      if (action.id === "camera-hold" || action.id === "hold-01") {
        return { ...action, duration: Math.max(0.5, editorialDuration - action.time) };
      }
      if (action.type === "showParentOverview" && action.time === 0 && action.duration >= 40) {
        return { ...action, duration: editorialDuration };
      }
      return action;
    });
    await writeFile(timelinePath, JSON.stringify(timeline, null, 2), "utf8");
  }
  const storyboardPath = resolve(root, `content/storyboards/${regionId}.json`);
  if (existsSync(storyboardPath)) {
    const storyboard = JSON.parse(await readFile(storyboardPath, "utf8")) as {
      duration: number;
      scenes: Array<{ start: number; duration: number }>;
    };
    storyboard.duration = editorialDuration;
    if (storyboard.scenes.length > 0) {
      const last = storyboard.scenes.at(-1)!;
      last.duration = Math.max(0.5, editorialDuration - last.start);
    }
    await writeFile(storyboardPath, JSON.stringify(storyboard, null, 2), "utf8");
  }
  return editorialDuration;
}

for (const id of ids) {
  if (!master[id]) throw new Error(`Unknown region ${id}`);
  const content = master[id];
  const audioDir = resolve(root, `assets/audio/${id}`);
  const mp3 = resolve(audioDir, "narration.mp3");
  const wav = resolve(audioDir, "narration.wav");
  const edgeSrt = resolve(audioDir, "narration-edge.srt");
  const sapiWav = resolve(audioDir, "narration-sapi.wav");
  const metadataPath = resolve(audioDir, "duration.json");
  const ttsInputPath = resolve(audioDir, "narration-input.txt");
  const pronunciationPath = resolve(audioDir, "pronunciation-map.json");
  const requestedRate = content.voiceRate ?? "-4%";
  const requestedVoiceId = content.voiceId ?? "zh-CN-YunyangNeural";
  const requestedRatePercent = Number.parseInt(requestedRate.replace("%", ""), 10) || 0;
  const sapiRate = Math.max(-10, Math.min(10, Math.round(requestedRatePercent / 10)));
  await mkdir(audioDir, { recursive: true });
  await writeFile(ttsInputPath, narrationInput(content), "utf8");
  await writeFile(pronunciationPath, JSON.stringify({
    regionId: id,
    records: content.pronunciations ?? [],
    policy: "Canonical captions remain unchanged; pronunciation records are reviewed against the generated formal narration."
  }, null, 2), "utf8");
  const existingMetadata = existsSync(metadataPath)
    ? JSON.parse(await readFile(metadataPath, "utf8")) as { provider?: string; voiceId?: string; rate?: string; edgeTtsFallbackReason?: string | null }
    : null;
  let provider = existingMetadata?.provider ?? "edge-tts";
  let actualVoiceId = existingMetadata?.voiceId ?? requestedVoiceId;
  let fallbackReason: string | null = existingMetadata?.edgeTtsFallbackReason ?? null;
  const shouldGenerate = force
    || !existsSync(mp3)
    || !existsSync(edgeSrt)
    || existingMetadata?.voiceId !== requestedVoiceId
    || existingMetadata?.rate !== requestedRate
    || (!draftMode && existingMetadata?.provider !== "edge-tts");
  if (shouldGenerate) {
    provider = "edge-tts";
    actualVoiceId = requestedVoiceId;
    fallbackReason = null;
    try {
      run(python, [
        "-m", "edge_tts", "--voice", requestedVoiceId, `--rate=${requestedRate}`,
        "--file", ttsInputPath, "--write-media", mp3, "--write-subtitles", edgeSrt
      ], { ...process.env, PYTHONPATH: pythonPath });
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
      if (!draftMode) {
        throw new Error(`Formal narration failed for ${id} with ${requestedVoiceId}. Windows SAPI fallback is draft-only.\n${fallbackReason}`);
      }
      provider = "windows-sapi";
      actualVoiceId = "Microsoft Huihui Desktop";
      run("powershell", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
        ".agents/skills/cesium-geo-documentary/scripts/generate-windows-sapi.ps1",
        "-TextPath", ttsInputPath,
        "-OutputPath", sapiWav,
        "-Voice", actualVoiceId,
        "-Rate", String(sapiRate)
      ]);
      run(ffmpeg, ["-y", "-i", sapiWav, "-c:a", "libmp3lame", "-b:a", "192k", mp3]);
      const fallbackDuration = durationFromFfmpeg(mp3);
      await writeProportionalSrt(edgeSrt, content.narration, fallbackDuration);
    }
  }
  if (!draftMode && provider !== "edge-tts") {
    throw new Error(`Formal narration for ${id} is not premium TTS; regenerate with Edge TTS before release.`);
  }
  const loudness = loudnessNormalize(mp3, wav);
  const duration = durationFromFfmpeg(wav);
  const editorialDuration = await synchronizeEditorialDuration(id, duration);
  await writeFile(metadataPath, JSON.stringify({
    regionId: id,
    provider,
    voiceId: actualVoiceId,
    rate: requestedRate,
    sapiRate: provider === "windows-sapi" ? sapiRate : null,
    durationSeconds: duration,
    timelineDurationSeconds: editorialDuration,
    sampleRate: 48000,
    generatedAt,
    edgeTtsFallbackReason: fallbackReason,
    timingMode: provider === "edge-tts" ? "provider-sentence-boundaries" : "paragraph-proportional",
    pauseProfile: "sentence punctuation with blank-line paragraph pauses",
    loudnessTargetLufs: -16,
    truePeakTargetDbtp: -1.5,
    measuredInputLufs: Number(loudness.input_i),
    measuredInputTruePeakDbtp: Number(loudness.input_tp),
    formalReleaseReady: provider === "edge-tts",
    pronunciationRecordPath: `assets/audio/${id}/pronunciation-map.json`
  }, null, 2), "utf8");
  run(python, [".agents/skills/cesium-geo-documentary/scripts/generate-subtitles.py", "--region", id]);
  process.stdout.write(`NARRATION_READY ${id} ${duration.toFixed(2)}s\n`);
}
