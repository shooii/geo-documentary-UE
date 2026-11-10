import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  applyTourOutroPause,
  formatSrtTimestamp,
  mapParagraphsToCues,
  normalizeTourReturnSeconds,
  parseSrt,
  planTourOutroPause,
  serializeSrt,
  stableNarrationTextHash,
  type TourOutroPausePlan
} from "./narration-timing.js";
import { isXfyunVoice, synthesizeXfyun, xfyunCredentialsFromEnvFile } from "../../../../packages/xfyun-tts/index.js";
import { alignCueBoundaries, splitNarrationSentences } from "../../../../packages/render-spec/narration-align.js";

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
  /** Index of the outro's paragraph among the non-empty narration paragraphs.
   *  Recorded because 结尾补充 scenes play AFTER the pull-back, so the outro is no
   *  longer the final paragraph. Absent on projects written before that change. */
  outroParagraphIndex?: number;
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
/**
 * `--content <path>` synthesises from an alternate content file.
 *
 * The export materialises the project's narration into the sandbox's own
 * content/regions.zh-CN.json, so it never needed this. The Studio's narration
 * preview does: after the operator edits a paragraph, the audio that can serve
 * that preview has to be produced from the PROJECT, not from the curated
 * content file — and rewriting the shared content file just to synthesise
 * would fight any export running at the same time.
 */
const contentIndex = args.indexOf("--content");
const contentPath = contentIndex >= 0 ? resolve(root, args[contentIndex + 1]!) : resolve(root, "content/regions.zh-CN.json");
/**
 * `--out-dir <path>` sends every artefact somewhere other than assets/audio/<id>/.
 *
 * The Studio's narration preview must not write into assets/audio: that
 * directory is what `makeProject()` reads to measure the *content* baseline, and
 * an SRT synthesised from a project's edited narration makes that baseline fail
 * to map onto its own paragraphs — which breaks reading the project at all.
 */
const outDirIndex = args.indexOf("--out-dir");
const outDirOverride = outDirIndex >= 0 ? resolve(root, args[outDirIndex + 1]!) : null;
const master = JSON.parse(await readFile(contentPath, "utf8")) as Record<string, RegionContent>;
const ids = requested ? [requested] : Object.keys(master);
const generatedAt = new Date().toISOString().slice(0, 10);
const python = process.env.PYTHON ?? "python";
const pythonPath = resolve(root, ".python-packages");
const ffmpeg = process.platform === "win32" ? resolve(root, "node_modules/ffmpeg-static/ffmpeg.exe") : resolve(root, "node_modules/ffmpeg-static/ffmpeg");

/**
 * stdin must be ignored, not piped.
 *
 * A process whose stdin *and* stdout are both piped cannot start in the
 * managed sandbox: `spawnSync(...)` comes back with `status === null`,
 * `error.code === "EBUSY"` and no output at all, which surfaced during export
 * as `Formal narration failed ... \nundefined\nundefined`. Because a crashed
 * child also reports `status === null`, that looks like a TTS failure rather
 * than a spawn failure. `stdio: ["ignore","pipe","pipe"]` starts fine — the
 * same workaround the rest of the project already uses (apps/studio/server.ts,
 * golden-qa.ts, tests/python-runtime.ts). None of these children read stdin.
 */
const CAPTURE_STDIO: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

function run(command: string, commandArgs: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: "utf8", env, windowsHide: true, stdio: CAPTURE_STDIO });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(`${command} failed to start (${code}): ${result.error.message}\ncommand: ${command} ${commandArgs.join(" ")}`);
  }
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}

function normalizeEdgeTtsRate(value: string): string {
  const parsed = Number.parseInt(String(value).replace("%", ""), 10);
  const percent = Number.isFinite(parsed) ? Math.max(-100, Math.min(100, parsed)) : 0;
  return `${percent >= 0 ? "+" : ""}${percent}%`;
}

function runEdgeTtsWithRetry(commandArgs: string[], env: NodeJS.ProcessEnv): string {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return run(python, commandArgs, env);
    } catch (error) {
      lastError = error;
      if (attempt < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 1_000);
    }
  }
  throw lastError;
}

function durationFromFfmpeg(path: string): number {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-i", path], { cwd: root, encoding: "utf8", windowsHide: true, stdio: CAPTURE_STDIO });
  const match = `${result.stdout}\n${result.stderr}`.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) throw new Error(`Could not read audio duration for ${path}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * Name the known Edge TTS endpoint failure instead of leaving a raw traceback.
 *
 * 河头镇's export died with `WSServerHandshakeError: 403, message='Invalid response
 * status'` plus a Python stack trace, which reads like a credential or clock
 * problem and says nothing about the real cause: since October 2026 Microsoft
 * serves synthesis from api.msedgeservices.com and answers the legacy host with
 * 403 for every client, including the newest `edge-tts` release. The operator
 * cannot do anything with the traceback, so the message points at the script that
 * applies the fix (see scripts/patch-edge-tts.py).
 */
function edgeTtsFailureHint(reason: string): string {
  if (!/WSServerHandshakeError|Invalid response status|403/.test(reason)) return "";
  return " Edge TTS 已把合成端点迁到 api.msedgeservices.com，旧域名一律 403；"
    + "请在仓库根目录执行 python scripts/patch-edge-tts.py（幂等，可重复运行）后重试。";
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
  ], { cwd: root, encoding: "utf8", windowsHide: true, stdio: CAPTURE_STDIO });
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

/**
 * Midpoints of the pauses in a synthesised track.
 *
 * 讯飞 returns audio only — no per-sentence timestamps — so the subtitle timeline used
 * to be pure character counts. Chinese narration pauses at every full stop, so those
 * pauses are the ground truth the counts were guessing at: measuring them with
 * `silencedetect` and snapping each estimated boundary to the nearest one removed the
 * 1–2 s of drift that accumulated inside every paragraph (measured on 城月镇: 110 chars
 * spread over 25 s, six real pauses of 0.5–0.75 s each, all of them mis-timed).
 */
function speechPauses(path: string): number[] {
  const nullTarget = process.platform === "win32" ? "NUL" : "/dev/null";
  const result = spawnSync(ffmpeg, [
    "-hide_banner", "-i", path, "-af", "silencedetect=noise=-32dB:d=0.18", "-f", "null", nullTarget
  ], { cwd: root, encoding: "utf8", windowsHide: true, stdio: CAPTURE_STDIO });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const events: Array<{ at: number; open: boolean }> = [];
  for (const match of text.matchAll(/silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g)) {
    events.push({ at: Number(match[2]), open: match[1] === "start" });
  }
  const pauses: number[] = [];
  let opened: number | null = null;
  for (const event of events) {
    if (event.open) opened = Math.max(0, event.at);
    else if (opened !== null) { pauses.push((opened + event.at) / 2); opened = null; }
  }
  return pauses;
}

async function writeProportionalSrt(path: string, narration: string[], duration: number, audioPath?: string): Promise<void> {
  // One cue per sentence, not per paragraph: the paragraph cue is what made a 25 s
  // stretch of speech share a single subtitle window, and it is also what the
  // sentence-count based cue indices downstream (tourIntroSentences) already assume.
  const sentences = narration.flatMap(splitNarrationSentences);
  const pauses = audioPath && existsSync(audioPath) ? speechPauses(audioPath) : [];
  const ends = alignCueBoundaries(sentences.map((text) => [...text].length), duration, pauses);
  let previous = 0.1;
  const blocks = sentences.map((text, index) => {
    const end = Math.max(previous + 0.2, ends[index]!);
    const block = `${index + 1}\n${formatSrtTimestamp(previous)} --> ${formatSrtTimestamp(end)}\n${text}`;
    previous = end;
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
  // Map every narration paragraph (overview blocks, each child, the outro)
  // onto its measured sentence cues so the parent-return silence is inserted
  // after the FINAL child's last sentence. Edge TTS splits a paragraph into
  // one cue per sentence, so a village with two sentences owns two cues; the
  // legacy introCount + childCount arithmetic silently drifts every later cue
  // once any paragraph exceeds one sentence.
  const paragraphCues = mapParagraphsToCues(content.narration, sourceCues);
  // 结尾补充 plays after the pull-back, so the outro is NOT necessarily the last
  // paragraph any more. Use the index the Studio writer recorded; fall back to
  // "the final paragraph" for narration generated before that field existed.
  const recordedOutroIndex = content.outroParagraphIndex;
  const outroMapping = (Number.isInteger(recordedOutroIndex) && (recordedOutroIndex as number) >= 0
    ? paragraphCues[recordedOutroIndex as number]
    : undefined) ?? paragraphCues.at(-1);
  const outroCueIndex = outroMapping ? outroMapping.startIndex : introCount! + childCount;
  const plan = planTourOutroPause(sourceCues, introCount!, childCount, requestedSeconds, outroCueIndex);
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
  const audioDir = outDirOverride ?? resolve(root, `assets/audio/${id}`);
  const sourceMp3 = resolve(audioDir, "narration-source.mp3");
  const sourceEdgeSrt = resolve(audioDir, "narration-edge-source.srt");
  const mp3 = resolve(audioDir, "narration.mp3");
  const wav = resolve(audioDir, "narration.wav");
  const edgeSrt = resolve(audioDir, "narration-edge.srt");
  const sapiWav = resolve(audioDir, "narration-sapi.wav");
  const metadataPath = resolve(audioDir, "duration.json");
  const ttsInputPath = resolve(audioDir, "narration-input.txt");
  const pronunciationPath = resolve(audioDir, "pronunciation-map.json");
  const requestedRate = normalizeEdgeTtsRate(content.voiceRate ?? "-4%");
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
    || (!draftMode && existingMetadata?.provider !== "edge-tts" && existingMetadata?.provider !== "xfyun-tts");
  if (shouldGenerate) {
    fallbackReason = null;
    if (isXfyunVoice(requestedVoiceId)) {
      // 讯飞在线合成只返回音频，不返回句级时间戳，字幕按段落字数比例铺开。
      // 音色与音质由讯飞云端决定，和 Edge 一样可以直接进成片（不再降级）。
      provider = "xfyun-tts";
      actualVoiceId = requestedVoiceId;
      const credentials = xfyunCredentialsFromEnvFile(resolve(root, ".env.local"));
      if (!credentials) {
        throw new Error(
          `讯飞语音合成缺少凭据：请在 .env.local 配置 XFYUN_APP_ID / XFYUN_API_KEY / XFYUN_API_SECRET（当前音色 ${requestedVoiceId}）。`
        );
      }
      // Edge 的 -4% 对应讯飞 speed 约 48（50 为常速）。
      const xfyunSpeed = Math.max(0, Math.min(100, 50 + Math.round(requestedRatePercent / 2)));
      const audio = await synthesizeXfyun(ttsInput, credentials, {
        voice: requestedVoiceId.replace(/^xfyun:/, ""),
        speed: xfyunSpeed
      });
      await writeFile(sourceMp3, audio);
      await writeProportionalSrt(sourceEdgeSrt, content.narration, durationFromFfmpeg(sourceMp3), sourceMp3);
    } else {
      provider = "edge-tts";
      actualVoiceId = requestedVoiceId;
      try {
        runEdgeTtsWithRetry([
          "-m", "edge_tts", "--voice", requestedVoiceId, `--rate=${requestedRate}`,
          "--file", ttsInputPath, "--write-media", sourceMp3, "--write-subtitles", sourceEdgeSrt
        ], { ...process.env, PYTHONPATH: pythonPath });
      } catch (error) {
        fallbackReason = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
        if (!draftMode) {
          throw new Error(`Formal narration failed for ${id} with ${requestedVoiceId}. Windows SAPI fallback is draft-only.${edgeTtsFailureHint(fallbackReason)}\n${fallbackReason}`);
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
        await writeProportionalSrt(sourceEdgeSrt, content.narration, fallbackDuration, sourceMp3);
    }
    }
  }
  if (!draftMode && provider !== "edge-tts" && provider !== "xfyun-tts") {
    throw new Error(`Formal narration for ${id} is not premium TTS; regenerate with Edge TTS or 讯飞配音 before release.`);
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
    xfyunVoice: provider === "xfyun-tts" ? actualVoiceId.replace(/^xfyun:/, "") : null,
    pauseProfile: outroPause
      ? "sentence punctuation with blank-line paragraph pauses and parent-return silence"
      : "sentence punctuation with blank-line paragraph pauses",
    outroPause,
    loudnessTargetLufs: -16,
    truePeakTargetDbtp: -1.5,
    measuredInputLufs: Number(loudness.input_i),
    measuredInputTruePeakDbtp: Number(loudness.input_tp),
    formalReleaseReady: provider === "edge-tts" || provider === "xfyun-tts",
    pronunciationRecordPath: `assets/audio/${id}/pronunciation-map.json`
  }, null, 2), "utf8");
  // Subtitles go to the same override directory as the audio, otherwise this run
  // would overwrite the repo's canonical captions with project-specific text.
  run(python, [
    ".agents/skills/cesium-geo-documentary/scripts/generate-subtitles.py",
    "--region", id,
    "--narration-srt", edgeSrt,
    ...(outDirOverride ? ["--captions-dir", outDirOverride] : [])
  ]);
  process.stdout.write(`NARRATION_READY ${id} ${duration.toFixed(2)}s\n`);
}
