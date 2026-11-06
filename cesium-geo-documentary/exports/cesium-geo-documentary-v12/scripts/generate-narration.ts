import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  applyTourOutroPause,
  formatSrtTimestamp,
  normalizeTourReturnSeconds,
  parseSrt,
  planTourOutroPause,
  serializeSrt,
  stableNarrationTextHash,
  type TourOutroPausePlan
} from "./narration-timing.js";

interface PronunciationRecord { term: string; pinyin: string; spokenForm?: string }
interface RegionContent {
  name: string;
  voiceRate?: string;
  voiceId?: string;
  narration: string[];
  pronunciations?: PronunciationRecord[];
  tourIntroSentences?: number;
  tourOrder?: string[];
  tourReturnSeconds?: number;
}

interface OutroPauseMetadata {
  applied: true;
  mode: "parent-child-tour";
  hasClosingNarration: boolean;
  requestedSeconds: number;
  insertedSeconds: number;
  insertionAtSeconds: number;
  lastChildNarrationEndSeconds: number;
  rawOutroNarrationStartSeconds: number | null;
  outroNarrationStartSeconds: number | null;
  returnWindowSeconds: number;
  outroCueIndex: number;
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
  let input = content.narration
    .map((paragraph) => paragraph.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n\n");
  for (const record of content.pronunciations ?? []) {
    if (record.spokenForm && record.term && record.spokenForm !== record.term) {
      input = input.replaceAll(record.term, record.spokenForm);
    }
  }
  return `${input}\n`;
}

function restoreCanonicalPronunciations(text: string, records: PronunciationRecord[] = []): string {
  let canonical = text;
  for (const record of records) {
    if (record.spokenForm && record.term && record.spokenForm !== record.term) {
      canonical = canonical.replaceAll(record.spokenForm, record.term);
    }
  }
  return canonical;
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
    const block = `${index + 1}\n${formatSrtTimestamp(cursor)} --> ${formatSrtTimestamp(end)}\n${text}`;
    cursor = end;
    return block;
  });
  await writeFile(path, `${blocks.join("\n\n")}\n`, "utf8");
}

function insertSilence(input: string, output: string, plan: TourOutroPausePlan): void {
  const insertionAt = plan.insertionAtSeconds.toFixed(3);
  const silenceDuration = plan.insertedSeconds.toFixed(3);
  if (!plan.hasClosingNarration) {
    run(ffmpeg, [
      "-y", "-i", input,
      "-af", `apad=pad_dur=${silenceDuration}`,
      "-ar", "48000", "-ac", "1",
      "-c:a", "libmp3lame", "-b:a", "192k",
      output
    ]);
    return;
  }
  const audioFormat = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono";
  const filter = [
    "[0:a]asplit=2[before-source][after-source]",
    `[before-source]atrim=start=0:end=${insertionAt},asetpts=PTS-STARTPTS,${audioFormat}[before]`,
    `anullsrc=r=48000:cl=mono:d=${silenceDuration},${audioFormat}[silence]`,
    `[after-source]atrim=start=${insertionAt},asetpts=PTS-STARTPTS,${audioFormat}[after]`,
    "[before][silence][after]concat=n=3:v=0:a=1[out]"
  ].join(";");
  run(ffmpeg, [
    "-y", "-i", input,
    "-filter_complex", filter,
    "-map", "[out]",
    "-ar", "48000", "-ac", "1",
    "-c:a", "libmp3lame", "-b:a", "192k",
    output
  ]);
}

async function buildFinalNarrationAssets(
  content: RegionContent,
  sourceMp3: string,
  sourceSrt: string,
  finalMp3: string,
  finalSrt: string
): Promise<OutroPauseMetadata | null> {
  const childCount = content.tourOrder?.length ?? 0;
  if (childCount === 0) {
    const canonicalCues = parseSrt(await readFile(sourceSrt, "utf8"))
      .map((cue) => ({ ...cue, text: restoreCanonicalPronunciations(cue.text, content.pronunciations) }));
    await Promise.all([copyFile(sourceMp3, finalMp3), writeFile(finalSrt, serializeSrt(canonicalCues), "utf8")]);
    return null;
  }
  const introCount = content.tourIntroSentences;
  if (!Number.isInteger(introCount) || (introCount ?? -1) < 0) {
    throw new Error("parent-child-tour narration requires a non-negative tourIntroSentences value");
  }
  const requestedSeconds = normalizeTourReturnSeconds(content.tourReturnSeconds);
  const sourceCues = parseSrt(await readFile(sourceSrt, "utf8"))
    .map((cue) => ({ ...cue, text: restoreCanonicalPronunciations(cue.text, content.pronunciations) }));
  const plan = planTourOutroPause(sourceCues, introCount!, childCount, requestedSeconds);
  insertSilence(sourceMp3, finalMp3, plan);
  await writeFile(finalSrt, serializeSrt(applyTourOutroPause(sourceCues, plan)), "utf8");
  return {
    applied: true,
    mode: "parent-child-tour",
    hasClosingNarration: plan.hasClosingNarration,
    requestedSeconds,
    insertedSeconds: plan.insertedSeconds,
    insertionAtSeconds: plan.insertionAtSeconds,
    lastChildNarrationEndSeconds: plan.lastChildNarrationEndSeconds,
    rawOutroNarrationStartSeconds: plan.rawOutroNarrationStartSeconds,
    outroNarrationStartSeconds: plan.outroNarrationStartSeconds,
    returnWindowSeconds: plan.returnWindowSeconds,
    outroCueIndex: plan.outroCueIndex
  };
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
  const sourceMp3 = resolve(audioDir, "narration-source.mp3");
  const sourceEdgeSrt = resolve(audioDir, "narration-edge-source.srt");
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
  const ttsInput = narrationInput(content);
  const narrationTextHash = stableNarrationTextHash(ttsInput);
  await mkdir(audioDir, { recursive: true });
  await writeFile(ttsInputPath, ttsInput, "utf8");
  await writeFile(pronunciationPath, JSON.stringify({
    regionId: id,
    records: content.pronunciations ?? [],
    policy: "Canonical captions remain unchanged; pronunciation records are reviewed against the generated formal narration."
  }, null, 2), "utf8");
  const existingMetadata = existsSync(metadataPath)
    ? JSON.parse(await readFile(metadataPath, "utf8")) as {
        provider?: string;
        voiceId?: string;
        rate?: string;
        narrationTextHash?: string;
        edgeTtsFallbackReason?: string | null;
      }
    : null;
  let provider = existingMetadata?.provider ?? "edge-tts";
  let actualVoiceId = existingMetadata?.voiceId ?? requestedVoiceId;
  let fallbackReason: string | null = existingMetadata?.edgeTtsFallbackReason ?? null;
  const shouldGenerate = force
    || !existsSync(sourceMp3)
    || !existsSync(sourceEdgeSrt)
    || existingMetadata?.voiceId !== requestedVoiceId
    || existingMetadata?.rate !== requestedRate
    || existingMetadata?.narrationTextHash !== narrationTextHash
    || (!draftMode && existingMetadata?.provider !== "edge-tts");
  if (shouldGenerate) {
    provider = "edge-tts";
    actualVoiceId = requestedVoiceId;
    fallbackReason = null;
    try {
      run(python, [
        "-m", "edge_tts", "--voice", requestedVoiceId, `--rate=${requestedRate}`,
        "--file", ttsInputPath, "--write-media", sourceMp3, "--write-subtitles", sourceEdgeSrt
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
      run(ffmpeg, ["-y", "-i", sapiWav, "-c:a", "libmp3lame", "-b:a", "192k", sourceMp3]);
      const fallbackDuration = durationFromFfmpeg(sourceMp3);
      await writeProportionalSrt(sourceEdgeSrt, content.narration, fallbackDuration);
    }
  }
  if (!draftMode && provider !== "edge-tts") {
    throw new Error(`Formal narration for ${id} is not premium TTS; regenerate with Edge TTS before release.`);
  }
  const outroPause = await buildFinalNarrationAssets(content, sourceMp3, sourceEdgeSrt, mp3, edgeSrt);
  const loudness = loudnessNormalize(mp3, wav);
  const duration = durationFromFfmpeg(wav);
  const editorialDuration = await synchronizeEditorialDuration(id, duration);
  await writeFile(metadataPath, JSON.stringify({
    regionId: id,
    provider,
    voiceId: actualVoiceId,
    rate: requestedRate,
    narrationTextHash,
    narrationTextHashAlgorithm: "sha256-utf8",
    sapiRate: provider === "windows-sapi" ? sapiRate : null,
    durationSeconds: duration,
    timelineDurationSeconds: editorialDuration,
    sampleRate: 48000,
    generatedAt,
    edgeTtsFallbackReason: fallbackReason,
    timingMode: provider === "edge-tts" ? "provider-sentence-boundaries" : "paragraph-proportional",
    pauseProfile: outroPause
      ? "sentence punctuation with blank-line paragraph pauses and parent-return silence"
      : "sentence punctuation with blank-line paragraph pauses",
    outroPause,
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
