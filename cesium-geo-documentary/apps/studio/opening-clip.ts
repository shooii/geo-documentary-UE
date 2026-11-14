import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RenderSpec } from "../../packages/render-spec/index.js";
import { runQaCommand, type GoldenQaLifecycle } from "./golden-qa.js";

const OPENING_FPS = 30;

export function parseOpeningClipDuration(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 60) {
    throw new Error("开头片段时长必须是 1 到 60 秒的有限数字");
  }
  const frames = value * OPENING_FPS;
  if (Math.abs(frames - Math.round(frames)) > Number.EPSILON * Math.max(1, frames) * 8) {
    throw new Error("开头片段时长必须对应 30fps 的完整帧");
  }
  return value;
}

export function openingClipMapSeconds(duration: number, coverSeconds: number): number {
  parseOpeningClipDuration(duration);
  if (!Number.isFinite(coverSeconds) || coverSeconds < 0) throw new Error("封面时长必须是非负有限数字");
  return Math.max(1 / OPENING_FPS, Math.ceil((duration - coverSeconds) * OPENING_FPS) / OPENING_FPS);
}

export interface OpeningClipProbe {
  format?: { duration?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    nb_read_frames?: string;
  }>;
}

export interface OpeningClipInterval {
  start: number;
  end: number;
  duration: number;
}

export function openingClipMediaChecks(input: {
  probe: OpeningClipProbe;
  output: Pick<RenderSpec["output"], "width" | "height" | "fps">;
  durationSeconds: number;
  mtimeMs: number;
  jobCreatedAt: string;
}): Record<string, boolean> {
  const video = input.probe.streams?.find(stream => stream.codec_type === "video");
  const [numerator, denominator] = (video?.avg_frame_rate ?? "0/1").split("/").map(Number);
  const fps = denominator ? numerator! / denominator : 0;
  const duration = Number(input.probe.format?.duration);
  const frameCount = Number(video?.nb_read_frames);
  return {
    h264: video?.codec_name === "h264",
    resolution: video?.width === input.output.width && video?.height === input.output.height,
    frameRate: input.output.fps === OPENING_FPS && Math.abs(fps - input.output.fps) < 1e-6,
    exactFrameCount: Number.isInteger(frameCount) && frameCount === Math.round(input.durationSeconds * OPENING_FPS),
    audioPresent: Boolean(input.probe.streams?.some(stream => stream.codec_type === "audio")),
    duration: Number.isFinite(duration) && Math.abs(duration - input.durationSeconds) <= 1 / input.output.fps + 0.01,
    freshOutput: Number.isFinite(input.mtimeMs) && input.mtimeMs >= Date.parse(input.jobCreatedAt)
  };
}

export function parseOpeningClipDetections(metadata: string, kind: "black" | "silence", durationSeconds: number): OpeningClipInterval[] {
  const pattern = new RegExp(`lavfi\\.${kind}_(start|end)=(\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)`, "gi");
  const intervals: OpeningClipInterval[] = [];
  let start: number | undefined;
  const append = (end: number) => {
    if (start === undefined) return;
    const boundedStart = Math.max(0, Math.min(durationSeconds, start));
    const boundedEnd = Math.max(boundedStart, Math.min(durationSeconds, end));
    if (boundedEnd > boundedStart) intervals.push({ start: boundedStart, end: boundedEnd, duration: boundedEnd - boundedStart });
    start = undefined;
  };
  for (const match of metadata.matchAll(pattern)) {
    if (match[1]!.toLowerCase() === "start") start ??= Number(match[2]);
    else append(Number(match[2]));
  }
  append(durationSeconds);
  return intervals;
}

function checkCancelled(lifecycle: GoldenQaLifecycle): void {
  if (lifecycle.signal?.aborted || lifecycle.cancelled?.()) throw new Error("Render cancelled");
}

export async function runOpeningClipQa(input: {
  root: string;
  jobRoot: string;
  output: string;
  spec: RenderSpec & { narrationStartSeconds?: number };
  jobCreatedAt: string;
  durationSeconds: number;
  lifecycle?: GoldenQaLifecycle;
}): Promise<Record<string, unknown>> {
  const lifecycle = input.lifecycle ?? {};
  checkCancelled(lifecycle);
  parseOpeningClipDuration(input.durationSeconds);
  if (!existsSync(input.output)) throw new Error("开头片段 QA 未通过：输出视频不存在");
  const ffmpeg = join(input.root, "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const ffprobe = join(input.root, "node_modules", "ffprobe-static", "bin", process.platform === "win32" ? "win32/x64/ffprobe.exe" : "linux/x64/ffprobe");
  const probe = JSON.parse(await runQaCommand(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", input.output], lifecycle)) as OpeningClipProbe;
  const outputStat = await stat(input.output);
  const checks = openingClipMediaChecks({ probe, output: input.spec.output, durationSeconds: input.durationSeconds, mtimeMs: outputStat.mtimeMs, jobCreatedAt: input.jobCreatedAt });
  const qaDir = join(input.jobRoot, "qa");
  const keyframeDir = join(qaDir, "keyframes");
  await mkdir(keyframeDir, { recursive: true });
  const blackMetadata = await runQaCommand(ffmpeg, ["-hide_banner", "-v", "error", "-i", input.output, "-an", "-vf", "blackdetect=d=0:pix_th=0.10:pic_th=0.98,metadata=mode=print:file=-", "-f", "null", "-"], lifecycle);
  const blackSegments = parseOpeningClipDetections(blackMetadata, "black", Number(probe.format?.duration) || input.durationSeconds);
  const silenceMetadata = checks.audioPresent
    ? await runQaCommand(ffmpeg, ["-hide_banner", "-v", "error", "-i", input.output, "-vn", "-af", "silencedetect=noise=-45dB:d=1,ametadata=mode=print:file=-", "-f", "null", "-"], lifecycle)
    : "";
  const narrationStartSeconds = input.spec.narrationStartSeconds ?? input.spec.cover.introSeconds + input.spec.opening.narrationLeadSeconds;
  const plannedSpeech = input.spec.subtitleCues.map(cue => ({ start: narrationStartSeconds + cue.start, end: narrationStartSeconds + cue.end }));
  const silenceSegments = parseOpeningClipDetections(silenceMetadata, "silence", Number(probe.format?.duration) || input.durationSeconds)
    .filter(segment => segment.duration >= 1 - 1e-6)
    .map(segment => ({
      ...segment,
      classification: segment.start <= 1 / OPENING_FPS && segment.end <= narrationStartSeconds + 0.4
        ? "opening"
        : plannedSpeech.some(cue => Math.min(cue.end, segment.end - 0.4) > Math.max(cue.start, segment.start + 0.4))
          ? "unplanned"
          : "planned-gap"
    }));
  checks.noBlackSegments = blackSegments.every(segment => segment.duration < 0.1 - 1e-6);
  const keyframes: Array<{ time: number; path: string }> = [];
  for (let second = 0; second < input.durationSeconds; second += 1) {
    const path = join(keyframeDir, `opening-${String(second).padStart(2, "0")}.png`);
    await runQaCommand(ffmpeg, ["-y", "-v", "error", "-ss", second.toFixed(3), "-i", input.output, "-frames:v", "1", "-vf", "scale=270:-2", path], lifecycle);
    if (!existsSync(path)) throw new Error(`开头片段 QA 未通过：未生成 ${second} 秒关键帧`);
    keyframes.push({ time: second, path });
  }
  const report = {
    generatedAt: new Date().toISOString(),
    scope: "opening-clip-only",
    output: input.output,
    projectId: input.spec.projectId,
    projectRevision: input.spec.projectRevision,
    specGeneratedAt: input.spec.generatedAt,
    jobCreatedAt: input.jobCreatedAt,
    requestedDurationSeconds: input.durationSeconds,
    outputDurationSeconds: Number(probe.format?.duration),
    expectedFrames: Math.round(input.durationSeconds * OPENING_FPS),
    probe,
    checks,
    blackFailureThresholdSeconds: 0.1,
    blackSegments,
    silence: { evaluatedAsFailure: false, thresholdSeconds: 1, narrationStartSeconds, segments: silenceSegments, note: "静音仅供人工验收，不作为片段失败条件；未进行整片 QA。" },
    keyframes,
    pass: Object.values(checks).every(Boolean)
  };
  checkCancelled(lifecycle);
  await writeFile(join(qaDir, "opening-clip-report.json"), JSON.stringify(report, null, 2), "utf8");
  checkCancelled(lifecycle);
  if (!report.pass) throw new Error(`开头片段 QA 未通过：${Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name).join("、")}`);
  return report;
}
