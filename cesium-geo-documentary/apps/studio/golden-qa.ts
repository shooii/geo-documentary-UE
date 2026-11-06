import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { RenderSpec } from "../../packages/render-spec/index.js";

interface ProbeResult {
  format?: { duration?: string };
  streams?: Array<{ codec_type?: string; width?: number; height?: number; avg_frame_rate?: string }>;
}

interface VisualSyncReport {
  pass?: boolean;
  selectedVisualCount?: number;
  renderedVisualCount?: number;
  visuals?: Array<{ pass?: boolean; displayDurationSeconds?: number; selectionKey?: string }>;
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited with ${code}: ${stderr.slice(-3000)}`)));
  });
}

async function probe(ffprobe: string, path: string): Promise<ProbeResult> {
  return JSON.parse(await run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", path])) as ProbeResult;
}

function frameRate(value = "0/1"): number {
  const [a, b] = value.split("/").map(Number);
  return b ? a! / b : 0;
}

async function extract(ffmpeg: string, video: string, time: number, output: string): Promise<void> {
  await run(ffmpeg, ["-y", "-ss", time.toFixed(3), "-i", video, "-frames:v", "1", "-vf", "scale=270:480:force_original_aspect_ratio=decrease,pad=270:480:(ow-iw)/2:(oh-ih)/2:black", output]);
}

async function grayscale(path: string): Promise<Buffer> {
  return sharp(await readFile(path)).resize(270, 480, { fit: "fill" }).grayscale().raw().toBuffer();
}

function globalSsim(a: Buffer, b: Buffer): number {
  const count = Math.min(a.length, b.length);
  let meanA = 0; let meanB = 0;
  for (let index = 0; index < count; index += 1) { meanA += a[index]!; meanB += b[index]!; }
  meanA /= count; meanB /= count;
  let varianceA = 0; let varianceB = 0; let covariance = 0;
  for (let index = 0; index < count; index += 1) {
    const deltaA = a[index]! - meanA; const deltaB = b[index]! - meanB;
    varianceA += deltaA * deltaA; varianceB += deltaB * deltaB; covariance += deltaA * deltaB;
  }
  varianceA /= Math.max(1, count - 1); varianceB /= Math.max(1, count - 1); covariance /= Math.max(1, count - 1);
  const c1 = (0.01 * 255) ** 2; const c2 = (0.03 * 255) ** 2;
  return ((2 * meanA * meanB + c1) * (2 * covariance + c2)) / ((meanA ** 2 + meanB ** 2 + c1) * (varianceA + varianceB + c2));
}

function meanLuma(buffer: Buffer): number {
  let sum = 0; for (const value of buffer) sum += value; return sum / Math.max(1, buffer.length);
}

export function goldenDurationIsComparable(outputDuration: number, goldenDuration: number | null): boolean {
  if (!Number.isFinite(outputDuration) || outputDuration <= 0 || goldenDuration === null || !Number.isFinite(goldenDuration) || goldenDuration <= 0) return false;
  return Math.abs(outputDuration - goldenDuration) <= Math.max(1.25, outputDuration * 0.02);
}

export function allChildrenPresent(spec: {
  childTourOrder: readonly string[];
  scenes: ReadonlyArray<{ section?: string | undefined; childId?: string | undefined }>;
}): boolean {
  const childScenes = spec.scenes.filter((scene) => scene.section === "child");
  const expectedIds = childScenes.map((scene) => scene.childId).filter((id): id is string => Boolean(id));
  if (expectedIds.length === 0 || expectedIds.length !== childScenes.length) return false;

  const expected = new Set(expectedIds);
  const actual = new Set(spec.childTourOrder);
  return expected.size === expectedIds.length
    && actual.size === spec.childTourOrder.length
    && actual.size === expected.size
    && expectedIds.every((id) => actual.has(id));
}

export async function runGoldenQa(input: {
  root: string;
  jobRoot: string;
  /** Root of the executable render sandbox. Composition diagnostics are
   * written there, while the durable QA report remains under jobRoot. */
  renderRoot: string;
  output: string;
  golden?: string | undefined;
  spec: RenderSpec;
  jobCreatedAt: string;
}): Promise<Record<string, unknown>> {
  const ffmpeg = join(input.root, "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const ffprobe = join(input.root, "node_modules", "ffprobe-static", "bin", process.platform === "win32" ? "win32/x64/ffprobe.exe" : "linux/x64/ffprobe");
  if (!existsSync(input.output)) throw new Error("QA output video is missing");
  const hasGolden = Boolean(input.golden && existsSync(input.golden));
  const [outputProbe, outputStat] = await Promise.all([probe(ffprobe, input.output), stat(input.output)]);
  const goldenProbe = hasGolden ? await probe(ffprobe, input.golden!) : undefined;
  const outputVideo = outputProbe.streams?.find((stream) => stream.codec_type === "video");
  const outputAudio = outputProbe.streams?.find((stream) => stream.codec_type === "audio");
  const outputDuration = Number(outputProbe.format?.duration ?? 0);
  const goldenDuration = hasGolden ? Number(goldenProbe?.format?.duration ?? 0) : null;
  const compareGolden = hasGolden && goldenDurationIsComparable(outputDuration, goldenDuration);
  const visualSyncPath = join(input.renderRoot, "renders", "diagnostics", `${input.spec.regionId}-${input.spec.output.profile}-visual-sync.json`);
  const visualSync = existsSync(visualSyncPath)
    ? JSON.parse(await readFile(visualSyncPath, "utf8")) as VisualSyncReport
    : null;
  const allSelectedVisualsRendered = Boolean(
    visualSync?.pass
    && Number(visualSync.selectedVisualCount) === Number(visualSync.renderedVisualCount)
    && Number(visualSync.selectedVisualCount) === (visualSync.visuals?.length ?? -1)
    && visualSync.visuals?.every((visual) => visual.pass && Number(visual.displayDurationSeconds) >= 0.5)
  );
  const fractions = [0.003, 0.018, 0.038, 0.075, 0.22, 0.32, 0.47, 0.66, 0.84, 0.895, 0.94, 0.992];
  const names = ["cover", "cloud-before", "cloud-after", "overview", "overview-visual", "overview-ecology", "child-early", "child-middle", "child-late", "return", "outro", "final"];
  const qaDir = join(input.jobRoot, "qa", "keyframes");
  await mkdir(qaDir, { recursive: true });
  const frames: Array<{ name: string; outputTime: number; goldenTime?: number; ssim?: number; meanLuma: number; black: boolean }> = [];
  for (let index = 0; index < fractions.length; index += 1) {
    const outputTime = Math.max(0, Math.min(outputDuration - 0.05, outputDuration * fractions[index]!));
    const outputFrame = join(qaDir, `${String(index + 1).padStart(2, "0")}-${names[index]}-output.png`);
    await extract(ffmpeg, input.output, outputTime, outputFrame);
    const a = await grayscale(outputFrame);
    const luma = meanLuma(a);
    if (compareGolden && goldenDuration !== null) {
      const goldenTime = Math.max(0, Math.min(goldenDuration - 0.05, goldenDuration * fractions[index]!));
      const goldenFrame = join(qaDir, `${String(index + 1).padStart(2, "0")}-${names[index]}-golden.png`);
      await extract(ffmpeg, input.golden!, goldenTime, goldenFrame);
      const b = await grayscale(goldenFrame);
      frames.push({ name: names[index]!, outputTime, goldenTime, ssim: globalSsim(a, b), meanLuma: luma, black: luma < 4 });
    } else {
      frames.push({ name: names[index]!, outputTime, meanLuma: luma, black: luma < 4 });
    }
  }
  const averageSsim = compareGolden
    ? frames.reduce((sum, frame) => sum + (frame.ssim ?? 0), 0) / frames.length
    : null;
  const structuralChecks = {
    resolution: outputVideo?.width === input.spec.output.width && outputVideo?.height === input.spec.output.height,
    frameRate: Math.abs(frameRate(outputVideo?.avg_frame_rate) - input.spec.output.fps) < 0.05,
    audioPresent: Boolean(outputAudio),
    duration: Math.abs(outputDuration - input.spec.totalDurationSeconds) <= 1.25,
    freshOutput: outputStat.mtimeMs >= new Date(input.jobCreatedAt).getTime() - 1000,
    allChildrenPresent: allChildrenPresent(input.spec),
    persistentBoundaryContract: input.spec.scenes.filter((scene) => scene.section === "child").every((scene) => Boolean(scene.childId && scene.childName && scene.camera)),
    allSelectedVisualsRendered,
    parentReturn: input.spec.outro.action === "pullBackToParent" && input.spec.outro.target === input.spec.regionId,
    noBlackFrames: frames.every((frame) => !frame.black),
    perceptualParity: averageSsim === null || averageSsim >= 0.55
  };
  const report = {
    generatedAt: new Date().toISOString(),
    output: input.output,
    golden: hasGolden ? input.golden : null,
    perceptualParityEvaluated: compareGolden,
    perceptualParityReason: compareGolden
      ? "same-region/profile golden with comparable duration available"
      : hasGolden
        ? "skipped: existing golden duration is incompatible with the current edit"
        : "skipped: no same-region/profile golden",
    outputDuration,
    goldenDuration,
    averageSsim,
    checks: structuralChecks,
    keyframes: frames,
    pass: Object.values(structuralChecks).every(Boolean)
  };
  await writeFile(join(input.jobRoot, "qa", "golden-report.json"), JSON.stringify(report, null, 2), "utf8");
  if (!report.pass) throw new Error(`黄金成片 QA 未通过：${Object.entries(structuralChecks).filter(([, pass]) => !pass).map(([name]) => name).join("、")}`);
  return report;
}
