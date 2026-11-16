import { randomUUID } from "node:crypto";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { acquireExportLease, type ExportLease } from "../ue-player/export-lease.js";
import { CAPTURE_CLEANUP_FATAL } from "../ue-player/capture-lifecycle.js";
import { previewRendererMatches } from "../ue-player/runtime.js";
import { existsSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { assertTourPlanExportable, normalizeTourCamera } from "../../packages/render-spec/tour-plan.js";
import { buildRenderSpec, parseSrt, planVisualClip, selectSceneAssetsForRender, updateProjectMeasuredDurations, type RenderSpec } from "../../packages/render-spec/index.js";
import { normalizeSemanticText, validateVideoProject, type StudioScene, type VideoProject } from "../../packages/project-schema/index.js";
import { buildProjectRenderSpec, geometrySignature, makeProject, mapRendererSignature } from "./project-service.js";
import { snapshotFile } from "./boundary-snapshot.js";
import { runGoldenQa } from "./golden-qa.js";
import { applyProjectTiming, writeSubtitleOverrides } from "./render-timing.js";
import { stageNarrationCache } from "../../packages/narration-cache/index.js";
import { openingClipMapSeconds, parseOpeningClipDuration, runOpeningClipQa } from "./opening-clip.js";

export type RenderJobStatus = "queued" | "preparing" | "synthesizing" | "capturing" | "composing" | "validating" | "completed" | "failed" | "cancelled";
/**
 * What one export actually cost, per stage.
 *
 * The export estimate used to be `finishedMinutes × 15`, which this workspace's
 * own history contradicts: 21 completed portrait exports (2026-09-14 … 2026-10-12)
 * ran 7.0–15.6 wall minutes per finished minute and 97–132 MB per finished minute,
 * i.e. the old pair was 2–5× off, and the difference between a run that has to
 * record the map and one that copies it out of `workspace/render-cache` is the
 * single biggest term. Measuring the stages is what lets the panel estimate from
 * this machine instead of from a constant.
 */
export interface RenderStageTimings {
  setupSeconds: number;
  narrationSeconds: number;
  mapSeconds: number;
  mapCacheHit: boolean;
  compositionSeconds: number;
  qaSeconds: number;
  totalSeconds: number;
}

export interface RenderJobRecord {
  id: string;
  projectId: string;
  status: RenderJobStatus;
  stage: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
  logs: string[];
  jobRoot: string;
  renderSpecPath?: string;
  /** Render the opening prefix from this job's frozen project, never an old MP4. */
  openingClipSeconds?: number;
  output?: string;
  qaReport?: string;
  error?: string;
  queuePosition?: number;
  startedAt?: string;
  regionId?: string;
  projectTitle?: string;
  profile?: VideoProject["output"]["profile"];
  quality?: VideoProject["output"]["quality"];
  /** How many times this job has been automatically re-queued after a service
   *  restart interrupted its execution. Capped so a genuinely broken render is
   *  surfaced to the user instead of being retried forever. */
  recoveryAttempt?: number;
  /** Which execution attempt produced the current record. `1` is the original
   *  run; higher values mean the job was retried after a transient failure.
   *  Distinct from `recoveryAttempt`, which counts restarts of the service. */
  attempt?: number;
  /** Measured stage costs, so the next estimate comes from measurements. */
  timings?: RenderStageTimings;
  /** Length of the finished film — the denominator of every measured rate. */
  videoDurationSeconds?: number;
  /** Size of the published MP4, so the size estimate stops being a guess. */
  outputBytes?: number;
  /** Where a failed export's capture report was kept after the sandbox was pruned. */
  diagnosticsDir?: string;
  diagnosticsFiles?: string[];
}

export interface RenderCallbacks {
  update(patch: Partial<RenderJobRecord>): void;
  registerProcess(child: ChildProcess | null): void;
  cancelled(): boolean;
}

/**
 * A failure worth another run?
 *
 * Only transport- and process-level failures qualify. A project that fails the
 * schema, misses its configuration, has a visual with no display window, or
 * fails golden QA will fail identically on the second run — retrying those
 * would append another twenty minutes to a failure the user has already been
 * told about.
 *
 * The messages this has to classify are the real ones: `编码新的 MP4 exited
 * with 1` (10 of 29 failed exports), `生成或复用正式配音 exited with 1` (5), and
 * `生成或复用正式配音 exited with null` (1) — an Edge TTS request that never
 * answered. Authored failures such as `Project configuration is incomplete`,
 * `黄金成片 QA 未通过` and `输出文件不是本任务新生成` must stay non-retryable.
 */
export const DELIVERY_QA_DETERMINISTIC = "DELIVERY_QA_DETERMINISTIC";

export async function deliveryValidationFailure(error: Error, reportPath: string, startedAt: number): Promise<Error> {
  if (!/^执行项目交付 QA exited with (?!0\b|null\b)\S+$/.test(error.message)) return error;
  let report: { ok?: boolean; generatedAt?: string; errors?: unknown[]; subtitleErrors?: unknown[]; videos?: Array<{ errors?: unknown[] }> };
  try {
    report = JSON.parse(await readFile(reportPath, "utf8")) as typeof report;
  } catch { return error; }
  if (!report || report.ok !== false || !report.generatedAt || !(Date.parse(report.generatedAt) >= startedAt)) return error;
  const errors = [...(Array.isArray(report.errors) ? report.errors : []), ...(Array.isArray(report.subtitleErrors) ? report.subtitleErrors : []),
    ...(Array.isArray(report.videos) ? report.videos.flatMap(video => Array.isArray(video?.errors) ? video.errors : []) : [])]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (errors.length === 0) return error;
  return new Error(`${DELIVERY_QA_DETERMINISTIC}: 交付 QA 未通过：${errors.join("、")}；报告：${reportPath}`, { cause: error });
}

export function isRetryableRenderFailure(message: string): boolean {
  if (message.includes(DELIVERY_QA_DETERMINISTIC) || message.includes(CAPTURE_CLEANUP_FATAL)) return false;
  if (/exited with (?!0\b)\S+/.test(message)) return true;
  // A stage watchdog firing means the pipeline deadlocked, not that the project is
  // wrong — the retry restarts from the cached narration / map clip.
  if (/timed out after \d+s/.test(message)) return true;
  return /(EPIPE|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|net::ERR_|Target closed|Navigation failed|Protocol error|failed to launch|Timeout \d+ ?ms exceeded)/i.test(message);
}

async function copyIfExists(source: string, target: string): Promise<void> {
  if (!existsSync(source)) return;
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

const pathDelimiter = process.platform === "win32" ? ";" : ":";
const ffmpegToolDir = join(tmpdir(), "cesium-geo-documentary-tools");

/**
 * Capture workers for the HyperFrames render.
 *
 * The flag was pinned to 1 conservatively; the capture phase is the longest
 * single step of an export (34 minutes for a 400 s portrait film) and it is
 * embarrassingly parallel - every frame is rendered against the same
 * deterministic clock - so more workers change *when* frames are captured, not
 * what they contain. Measured on the same 13.6 s composition: 1 worker 74.7 s
 * total, 4 workers 41.1 s (capture 62 s -> 29.9 s), i.e. ~2.1x on the phase that
 * dominates a real export. The encoder stays a single process either way.
 *
 * Overridable because the right number depends on the host: each worker is its
 * own Chrome process. `STUDIO_RENDER_WORKERS=1` restores the old behaviour.
 */
function renderWorkerCount(): number {
  const requested = Number(process.env.STUDIO_RENDER_WORKERS ?? 4);
  if (!Number.isFinite(requested)) return 4;
  return Math.max(1, Math.min(8, Math.floor(requested)));
}

/**
 * HyperFrames shells out to FFmpeg/FFprobe through a child-process boundary
 * that can still receive an ANSI-decoded PATH on Windows, so the executables
 * are staged into an ASCII system-temp path and put first on PATH. This mirrors
 * what render-profile.ps1 used to do, but runs inside the render engine so the
 * encode step never depends on a PowerShell child resolving `node`.
 */
async function ensureFfmpegTools(sandbox: string): Promise<void> {
  await mkdir(ffmpegToolDir, { recursive: true });
  const stage = async (source: string, name: string): Promise<void> => {
    if (!existsSync(source)) return;
    const target = join(ffmpegToolDir, name);
    try {
      if (!existsSync(target) || (await stat(source)).size !== (await stat(target)).size) {
        await copyFile(source, target);
      }
    } catch {
      await copyFile(source, target);
    }
  };
  if (process.platform === "win32") {
    await stage(join(sandbox, "node_modules", "ffmpeg-static", "ffmpeg.exe"), "ffmpeg.exe");
    await stage(join(sandbox, "node_modules", "ffprobe-static", "bin", "win32", "x64", "ffprobe.exe"), "ffprobe.exe");
  } else {
    await stage(join(sandbox, "node_modules", "ffmpeg-static", "ffmpeg"), "ffmpeg");
    await stage(join(sandbox, "node_modules", "ffprobe-static", "bin", "ffprobe"), "ffprobe");
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => resolve(value).replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
  const a = normalize(left);
  const b = normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Remove a directory link itself. Windows needs `rmdir` for a junction and
 *  `unlink` for a symlink, and neither call is portable on its own. */
async function removeDirectoryLink(target: string): Promise<void> {
  for (const attempt of [() => rm(target, { force: true }), () => rmdir(target), () => unlink(target)]) {
    try {
      await attempt();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    }
  }
  throw new Error(`无法替换已有的沙箱目录链接：${target}`);
}

/**
 * Point `target` at `source`, reusing an identical link that is already there.
 *
 * The executable sandbox lives under the system temp directory and survives a
 * retry, a service restart, and the interrupted-job recovery that re-runs the
 * same job id — so this is not a first-run-only path. Linking unconditionally
 * made the second run of any job die at once with `EEXIST: file already
 * exists, symlink ... node_modules`, which is how two exports failed before
 * doing any work and why recovery could never actually resume a render.
 *
 * A stale link (one whose target is gone, or that points somewhere else) is
 * replaced; a real directory is left untouched, because deleting it would
 * delete its contents and the only way one appears at these paths is a sandbox
 * that was copied rather than linked.
 */
export async function ensureDirectoryLink(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  let stats: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    stats = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (stats) {
    if (!stats.isSymbolicLink()) return;
    const current = await readlink(target).catch(() => null);
    if (current && samePath(resolve(dirname(target), current), source)) return;
    await removeDirectoryLink(target);
  }
  await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
}

async function prepareSandbox(root: string, jobRoot: string, project: VideoProject): Promise<string> {
  // Python on Windows can corrupt a non-ASCII current working directory. Keep the
  // executable sandbox under an ASCII temp root and expose it from the job folder.
  const visibleSandbox = join(jobRoot, "sandbox");
  const sandbox = join(tmpdir(), "geo-video-studio", basename(jobRoot), "sandbox");
  await mkdir(sandbox, { recursive: true });
  // Unconditional: a junction left over from an earlier attempt can point at a
  // temp directory that has since been cleaned, and `existsSync` reports that
  // as "missing" while the directory entry itself is still on disk. Only
  // re-linking fixes it.
  await ensureDirectoryLink(sandbox, visibleSandbox);
  for (const directory of ["node_modules", ".agents", "packages", "design", ".python-packages"]) {
    const source = join(root, directory);
    if (existsSync(source)) await ensureDirectoryLink(source, join(sandbox, directory));
  }
  await Promise.all([
    cp(join(root, "content"), join(sandbox, "content"), { recursive: true }),
    cp(join(root, "config"), join(sandbox, "config"), { recursive: true }),
    cp(join(root, "scripts"), join(sandbox, "scripts"), { recursive: true }),
    cp(join(root, "apps", "cesium-player"), join(sandbox, "apps", "cesium-player"), { recursive: true }),
    cp(join(root, "apps", "ue-player"), join(sandbox, "apps", "ue-player"), { recursive: true }),
    copyFile(join(root, "package.json"), join(sandbox, "package.json"))
  ]);
  const compositor = join(sandbox, "apps", "video-compositor");
  await Promise.all([
    mkdir(join(compositor, "captions"), { recursive: true }), mkdir(join(compositor, "compositions"), { recursive: true }),
    mkdir(join(compositor, "media"), { recursive: true }), mkdir(join(sandbox, "assets", "audio", project.regionId), { recursive: true }),
    mkdir(join(sandbox, "assets", "music"), { recursive: true }), mkdir(join(sandbox, "workspace", "assets"), { recursive: true }),
    mkdir(join(sandbox, "data", "regions"), { recursive: true }), mkdir(join(sandbox, "data", "normalized"), { recursive: true }),
    mkdir(join(sandbox, "renders", "intermediate"), { recursive: true }), mkdir(join(sandbox, "renders", "final", "covers"), { recursive: true }),
    mkdir(join(sandbox, "renders", "previews"), { recursive: true }), mkdir(join(sandbox, "tmp"), { recursive: true })
  ]);
  for (const file of ["index.html", "package.json", "meta.json"]) await copyIfExists(join(root, "apps", "video-compositor", file), join(compositor, file));
  await copyIfExists(join(root, "assets", "music", "ambient-map-bed.wav"), join(sandbox, "assets", "music", "ambient-map-bed.wav"));
  await copyIfExists(join(root, "assets", "music", "boundary-pen.wav"), join(sandbox, "assets", "music", "boundary-pen.wav"));
  /* 合成器要把思源黑体 Medium 抄进 video-compositor/media/fonts 才会给字幕上字体，
     但沙箱只搬了 assets/music 与 assets/audio，字体目录一直没进来：导出在
     「录制前预检」这一步就 ENOENT（copyfile assets/fonts/NotoSansSC-Medium.woff2），
     每 40 分钟的录制都能白等一场。字体是只读的构建输入，整目录搬过去。 */
  const sourceFonts = join(root, "assets", "fonts");
  if (existsSync(sourceFonts)) await cp(sourceFonts, join(sandbox, "assets", "fonts"), { recursive: true, force: true });
  await stageNarrationCache(root, sandbox, jobRoot, project);
  // The sandbox is the export's whole world, so this is where the scheme's
  // frozen boundary is applied: staging the snapshot's copy instead of the live
  // file means an export always renders the boundary the scheme was authored
  // against, even when the region was re-imported in the meantime.
  const boundarySource = async (relative: string): Promise<string> =>
    (await snapshotFile(root, project.id, relative)) ?? join(root, relative);
  const regionRelative = `data/regions/${project.regionId}.json`;
  const regionSource = await boundarySource(regionRelative);
  const region = JSON.parse(await readFile(regionSource, "utf8")) as { geometryPath?: string; childGeometryPath?: string };
  await copyFile(regionSource, join(sandbox, regionRelative));
  await copyIfExists(await boundarySource(`data/regions/${project.regionId}.timeline.json`), join(sandbox, "data", "regions", `${project.regionId}.timeline.json`));
  // 开场闸门：穿云下降已按需求移除（2026-11-11），旁白与字幕在乡镇边界开始描绘
  // （约 0.35s）后即起拍；descent 恒为 0，这个闸门不会再等待任何穿云时间。
  {
    const timelinePath = join(sandbox, "data", "regions", `${project.regionId}.timeline.json`);
    if (existsSync(timelinePath)) {
      const timeline = JSON.parse(await readFile(timelinePath, "utf8")) as {
        actions?: { id?: string; time?: number }[];
      } & Record<string, unknown>;
      const beam = Number(timeline.actions?.find((action) => action.id === "parent-outline")?.time ?? 0.35) || 0;
      timeline.openingGateSeconds = Math.max(0, beam);
      await writeFile(timelinePath, JSON.stringify(timeline, null, 2), "utf8");
    }
  }
  for (const path of [region.geometryPath, region.childGeometryPath].filter((value): value is string => Boolean(value))) await copyIfExists(await boundarySource(path), join(sandbox, path));
  // The scene endpoint also reads the parent county (its outline carries the
  // establishing shot's context layer) and the parent of that. Staging only the town
  // left `loadScene` throwing ENOENT, so /api/scene answered 404 and the capture page
  // sat on "正在加载 UE 地图场景" until the 180 s wait expired.
  let parentId = (region as { parentId?: string }).parentId;
  while (parentId) {
    const parentRelative = `data/regions/${parentId}.json`;
    const parentSource = await boundarySource(parentRelative);
    if (!existsSync(parentSource)) break;
    await copyIfExists(parentSource, join(sandbox, parentRelative));
    await copyIfExists(await boundarySource(`data/regions/${parentId}.timeline.json`), join(sandbox, "data", "regions", `${parentId}.timeline.json`));
    const parent = JSON.parse(await readFile(parentSource, "utf8")) as { geometryPath?: string; parentId?: string };
    if (parent.geometryPath) await copyIfExists(await boundarySource(parent.geometryPath), join(sandbox, parent.geometryPath));
    parentId = parent.parentId;
  }
  for (const asset of project.assets) {
    if (asset.path.startsWith("/workspace-assets/")) {
      const name = asset.path.slice("/workspace-assets/".length);
      await copyIfExists(join(root, "workspace", "assets", name), join(sandbox, "workspace", "assets", name));
    } else {
      await copyIfExists(join(root, asset.path), join(sandbox, asset.path));
    }
  }
  // The sandbox is a trimmed copy of the repo. Narration runs inside it and reads its
  // provider credentials from `.env.local` (Cesium ion, 天地图, 讯飞…); without this
  // the export dies at “生成或复用正式配音” with “缺少凭据”.
  await copyIfExists(join(root, ".env.local"), join(sandbox, ".env.local"));
  return sandbox;
}

/**
 * Windows `child.kill()` terminates the node wrapper only. The real work — the UE
 * renderer, the signalling server, chromium, ffmpeg — keeps running as orphans, holding
 * the GPU and the capture ports. That is what made the *next* attempt flakier than the
 * one that had just failed, so every teardown path goes through taskkill /t.
 */
export function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    // Kill the tree before its parent: killing the wrapper first can orphan UE,
    // Chromium and FFmpeg, so taskkill can no longer discover their ancestry.
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", () => { child.kill(); });
    killer.once("exit", (code) => { if (code !== 0 && child.exitCode === null) child.kill(); });
  } else {
    child.kill();
  }
}

/**
 * A stage that never returns used to hang the job forever: `command()` only settled on
 * `close`, and there was no watchdog anywhere above it. Limits are deliberately loose —
 * they exist to break a deadlock, not to police a slow machine.
 */
function commandTimeoutMs(status: RenderJobStatus): number {
  const override = Number(process.env.STUDIO_STAGE_TIMEOUT_MS ?? 0);
  if (override > 0) return override;
  switch (status) {
    case "synthesizing": return 45 * 60_000;
    // 400 s of portrait film has taken 34 minutes here; a 20-minute film on a loaded
    // machine is the reason this is hours, not minutes.
    case "capturing": return 5 * 60 * 60_000;
    case "composing": return 3 * 60 * 60_000;
    case "validating": return 45 * 60_000;
    default: return 30 * 60_000;
  }
}

function command(callbacks: RenderCallbacks, cwd: string, executable: string, args: string[], status: RenderJobStatus, stage: string, progress: number, envOverrides: Record<string, string> = {}): Promise<void> {
  if (callbacks.cancelled()) throw new Error("Render cancelled");
  callbacks.update({ status, stage, progress });
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, env: { ...process.env, GEO_VIDEO_PROJECT_ROOT: cwd, ...envOverrides } });
    callbacks.registerProcess(child);
    let cleanupFatal = false;
    let outputTail = "";
    const append = (chunk: unknown) => {
      const text = String(chunk);
      if ((outputTail + text).includes(CAPTURE_CLEANUP_FATAL)) cleanupFatal = true;
      outputTail = (outputTail + text).slice(-CAPTURE_CLEANUP_FATAL.length);
      callbacks.update({ logs: [text.trim()] });
    };
    const failure = (message: string) => new Error(cleanupFatal ? `${CAPTURE_CLEANUP_FATAL}: ${message}` : message);
    child.stdout.on("data", append); child.stderr.on("data", append);
    const timeoutMs = commandTimeoutMs(status);
    let timedOut = false;
    let settled = false;
    let killDeadline: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelPoll);
      if (killDeadline) clearTimeout(killDeadline);
      callbacks.registerProcess(null);
      return true;
    };
    const timer = setTimeout(() => {
      if (settled || killDeadline) return;
      timedOut = true;
      callbacks.update({ logs: [`${stage} 超过 ${Math.round(timeoutMs / 60_000)} 分钟没有结束，已终止并清理进程树`] });
      killProcessTree(child);
      // Inherited pipes can remain open even after the wrapper exits. The
      // watchdog must settle the stage even when no close event ever arrives.
      killDeadline = setTimeout(() => {
        if (settle()) reject(failure(`${stage} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, 15000);
    }, timeoutMs);
    const cancelPoll = setInterval(() => {
      if (!callbacks.cancelled() || settled || killDeadline) return;
      killProcessTree(child);
      killDeadline = setTimeout(() => {
        if (settle()) reject(new Error("Render cancelled"));
      }, 15_000);
    }, 100);
    child.once("error", (error) => { if (settle()) reject(callbacks.cancelled() ? new Error("Render cancelled") : cleanupFatal ? failure(error.message) : error); });
    child.once("close", (code) => {
      if (!settle()) return;
      if (cleanupFatal) reject(failure(`${stage} exited with ${code}`));
      else if (callbacks.cancelled()) reject(new Error("Render cancelled"));
      else if (timedOut) reject(failure(`${stage} timed out after ${Math.round(timeoutMs / 1000)}s`));
      else if (code === 0) resolve();
      else reject(failure(`${stage} exited with ${code}`));
    });
  });
}

function relativeAssetPath(path: string): string {
  return path.startsWith("/workspace-assets/") ? `workspace/assets/${path.slice("/workspace-assets/".length)}` : path.replaceAll("\\", "/");
}

/**
 * Count narration sentences the same way Edge TTS emits sentence cues:
 * paragraph lines and Chinese sentence punctuation are hard boundaries.
 * This must stay independent of any estimated cue list so the intro count
 * written into the region master matches the real measured SRT sentence
 * boundaries (a per-scene estimated spec would under-count multi-sentence
 * overview paragraphs and shift every child cue index).
 */
export function countNarrationSentences(text: string): number {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/[。！？；;…]+/))
    .map((part) => part.replace(/[」』"'“”‘’）)\]】》〉,，、：:\s]+$/u, "").trim())
    .filter((part) => part.length > 0).length;
}

export async function materializeProject(sandbox: string, project: VideoProject, spec: RenderSpec): Promise<void> {
  const masterPath = join(sandbox, "content", "regions.zh-CN.json");
  const master = JSON.parse(await readFile(masterPath, "utf8")) as Record<string, Record<string, unknown>>;
  // Saved schemes own the narration. A rollback can remove a generated town
  // from the shared catalog without invalidating its saved project/boundary.
  // Recreate only the sandbox entry; never rewrite the shared content file.
  const current = master[project.regionId] ??= {
    generated: true,
    province: project.cover.province,
    city: project.cover.city,
    county: project.cover.county,
    town: project.cover.town
  };
  const spoken = project.scenes.filter((scene) => scene.section !== "cover");
  current.name = project.cover.town;
  current.title = `${project.cover.topic}·${project.cover.administrativeLabel}`;
  // One narration paragraph per spoken scene, in film order. The pause planner inserts
  // the parent-return silence at the boundary where the OUTRO's narration begins, so it
  // needs that paragraph's identity. It used to be "the last paragraph", which held only
  // while the outro was final: 结尾补充 now plays after the pull-back, so record the
  // index explicitly. Paragraphs that normalize to nothing are skipped by the same
  // paragraph-to-cue mapper the generator uses, so count only the survivors or the index
  // would drift whenever a scene carries empty narration.
  current.narration = spoken.map((scene) => scene.narration);
  const spokenParagraphs = spoken.filter((scene) => normalizeSemanticText(scene.narration ?? "").length > 0);
  const outroParagraphIndex = spokenParagraphs.findIndex((scene) => scene.section === "outro");
  if (outroParagraphIndex >= 0) current.outroParagraphIndex = outroParagraphIndex;
  current.tourOrder = spec.childTourOrder;
  // Counts every paragraph that precedes the child tour, not just `overview`:
  // an outro-lead block sits *after* the tour, so it must not inflate this.
  current.tourIntroSentences = project.scenes
    .filter((scene) => scene.section === "overview")
    .reduce((total, scene) => total + countNarrationSentences(scene.narration), 0);
  current.tourReturnSeconds = project.template.tourReturnSeconds;
  current.tourFlightSeconds = Math.max(3.2, Math.min(5.4, 4.2));
  current.tourMapHoldSeconds = Object.fromEntries(project.scenes.filter((scene) => scene.section === "child" && scene.childId).map((scene) => [scene.childId!, scene.timing?.mapHoldSeconds ?? 2]));
  current.voiceId = project.voice.voiceId;
  const voiceRatePercent = Math.round((project.voice.speed - 1) * 100);
  current.voiceRate = `${voiceRatePercent >= 0 ? "+" : ""}${voiceRatePercent}%`;
  await writeFile(masterPath, JSON.stringify(master, null, 2), "utf8");
  const regionPath = join(sandbox, "data", "regions", `${project.regionId}.json`);
  const region = JSON.parse(await readFile(regionPath, "utf8")) as Record<string, unknown>;
  const childDisplayNames = new Map(project.scenes
    .filter((scene) => scene.section === "child" && scene.childId && scene.childName)
    .map((scene) => [scene.childId!, scene.childName!]));
  if (Array.isArray(region.childRegions)) {
    region.childRegions = (region.childRegions as Array<Record<string, unknown>>).map((child) => ({
      ...child,
      name: childDisplayNames.get(String(child.id)) || child.name,
      ...(() => {
        const camera = project.scenes.find(scene => scene.section === "child" && scene.childId === String(child.id))?.camera;
        if (!camera) return {};
        const cameraPreset = normalizeTourCamera(camera);
        return { cameraPreset, cameraProfiles: { ...((child.cameraProfiles ?? {}) as Record<string, unknown>), portrait: cameraPreset } };
      })()
    }));
  }
  // A verified village point can be authored before its boundary is available.
  // Materialize its camera only inside the export sandbox; never invent a
  // polygon/bbox or mutate the project's frozen boundary snapshot.
  const children = (region.childRegions ?? []) as Array<Record<string, unknown>>;
  for (const scene of project.scenes) {
    const camera = scene.camera;
    if (scene.section !== "child" || !scene.childId || !camera
      || children.some((child) => String(child.id) === scene.childId)
      || !Number.isFinite(camera.longitude) || Math.abs(camera.longitude) > 180
      || !Number.isFinite(camera.latitude) || Math.abs(camera.latitude) > 90
      || !Number.isFinite(camera.height) || camera.height <= 0) continue;
    const cameraPreset = normalizeTourCamera(camera);
    children.push({ id: scene.childId, name: scene.childName || scene.title, cameraPreset, cameraProfiles: { portrait: { ...cameraPreset } } });
    for (const key of ["childIds", "tourChildIds"] as const) {
      const ids = Array.isArray(region[key]) ? (region[key] as unknown[]).map(String) : children.map((child) => String(child.id));
      region[key] = [...new Set([...ids, scene.childId])];
    }
  }
  region.childRegions = children;
  // 穿云开场已移除（2026-11-11）：region 永远携带禁用的 openingDescent，
  // 前端 presentation 与巡游构建器据此得到 descent = 0，直接落在乡镇边界。
  region.openingDescent = {
    enabled: false,
    seconds: 0,
    startHeightMeters: project.template.openingStartHeightMeters,
    startPitchDegrees: project.template.openingStartPitchDegrees,
    cloudDeckHeightMeters: project.template.cloudDeckHeightMeters,
    clouds: false,
    cloudAlphaPeak: project.template.cloudAlphaPeak
  };
  await writeFile(regionPath, JSON.stringify(region, null, 2), "utf8");
  await mkdir(join(sandbox, "content", "covers"), { recursive: true });
  await writeFile(join(sandbox, "content", "covers", `${project.regionId}.json`), JSON.stringify({
    topic: project.cover.administrativeLabel,
    regionPath: [project.cover.province, project.cover.city, project.cover.county].filter(Boolean).join(" · "),
    subtitle: project.cover.subtitle,
    contentMeta: project.cover.contentMeta,
    coverIntroSeconds: project.cover.introSeconds,
    coverImagePath: `renders/final/covers/${project.regionId}-studio-cover.png`,
    studioManifest: project.cover
  }, null, 2), "utf8");
}

/**
 * Write the narration-cue-required visual manifest consumed by the compositor.
 *
 * This must run only after the real TTS narration has been measured and the
 * final render spec has been rebuilt from actual sentence cues. Writing it from
 * the early estimated spec (one cue per scene) shifts every visual that lives
 * in a multi-sentence overview by the number of extra overview sentences and
 * makes the compositor reject the visual (keyword absent from the cue it was
 * pointed at).
 *
 * Every placement marked "includeInRender" contributes a photo to the final
 * film. Multiple selected photos share the scene's measured narration window
 * in their saved order; unselected library bindings stay out of the export.
 */

/**
 * Persist the per-scene Tianditu label windows next to the frozen region record.
 *
 * The Cesium player reads this field while seeking the exported timeline, so the
 * annotation layer follows scene boundaries without Studio having to drive the
 * capture browser. Windows are presentation-relative, exactly like
 * `sceneCueRanges`, because the player subtracts its own opening descent.
 */
async function writeRegionAnnotationWindows(sandbox: string, regionId: string, spec: RenderSpec): Promise<void> {
  const regionPath = join(sandbox, "data", "regions", `${regionId}.json`);
  const region = JSON.parse(await readFile(regionPath, "utf8")) as Record<string, unknown>;
  region.annotationWindows = spec.annotationWindows;
  region.mapViewTrack = spec.mapViewTrack;
  await writeFile(regionPath, JSON.stringify(region, null, 2), "utf8");
}

/**
 * Persist the exact scene->cue ranges for a region next to the master content.
 * The child tour builder consumes this to schedule every village stop over its
 * full narration window (a village paragraph often spans several TTS sentence
 * cues). It must be written after the real narration SRT has been measured and
 * the render spec rebuilt from actual cues.
 */
async function writeChildCueRanges(sandbox: string, regionId: string, spec: RenderSpec): Promise<void> {
  const masterPath = join(sandbox, "content", "regions.zh-CN.json");
  const master = JSON.parse(await readFile(masterPath, "utf8")) as Record<string, Record<string, unknown>>;
  const current = master[regionId];
  if (!current) return;
  const childRanges: Array<{ childId: string; cueStartIndex: number; cueEndIndex: number }> = [];
  for (const range of spec.sceneCueRanges) {
    const sceneId = String(range.sceneId);
    const childPrefix = "child-";
    if (!sceneId.startsWith(childPrefix)) continue;
    childRanges.push({
      childId: sceneId.slice(childPrefix.length),
      cueStartIndex: range.cueStartIndex,
      cueEndIndex: range.cueEndIndex
    });
  }
  if (childRanges.length > 0) {
    current.tourChildCueRanges = childRanges;
    await writeFile(masterPath, JSON.stringify(master, null, 2), "utf8");
  }
}

// The selection rule lives in the render-spec package so the workbook export can
// reuse the exact same logic; re-exported here to keep Studio import paths stable.
export { selectSceneAssetsForRender };

async function writeVisualsManifest(sandbox: string, project: VideoProject, spec: RenderSpec, log?: (message: string) => void): Promise<void> {
  const rangeBySceneId = new Map(spec.sceneCueRanges.map((range) => [range.sceneId, range]));
  const openingSceneId = project.scenes.find((scene) => scene.section !== "cover")?.id;
  // Narration starts after the 0.35 s boundary pen-down gate. The county wipe
  // expands and retracts by map time 1.8 s; keep the first photo off screen until
  // at least map time 2.05 s so the entire gesture finishes before the image.
  const openingAssetDelayFromNarrationSeconds = 1.7;
  const visuals: Array<Record<string, unknown>> = [];
  for (const scene of project.scenes) {
    if (scene.section === "cover") continue;
    const range = rangeBySceneId.get(scene.id);
    const sceneAssets = spec.assets.filter((asset) => asset.sceneId === scene.id);
    if (sceneAssets.length === 0) continue;
    const kept = selectSceneAssetsForRender(scene, sceneAssets);
    if (kept.length < sceneAssets.length && log) {
      log(`场景「${scene.title}」绑定了 ${sceneAssets.length} 张素材，已选择 ${kept.length} 张进入成片，其余 ${sceneAssets.length - kept.length} 张不进入成片`);
    }
    for (const [sequenceIndex, asset] of kept.entries()) {
      /* Every field below comes from `planVisualClip()`, the same function the
         timeline panel uses. Two copies of "when may this picture appear" is how
         the export and the editor drifted apart in the first place; the picture
         may only live inside its own scene's narration window, and the panel now
         shows the resulting seconds before anyone renders. */
      const tourStop = spec.tourPlan?.tourStops.find(stop => stop.sceneId === scene.id);
      const plan = planVisualClip({
        ...(tourStop ? { childVisualReadySeconds: tourStop.visualReadySeconds } : {}),
        scene,
        placement: asset,
        sequenceIndex,
        ...(openingSceneId !== undefined ? { openingSceneId } : {}),
        openingDelaySeconds: openingAssetDelayFromNarrationSeconds,
        ...(range ? {
          range,
          cueStartSeconds: spec.narrationCues[asset.cueStartIndex]?.start ?? range.start,
          cueEndSeconds: spec.narrationCues[asset.cueEndIndex]?.end ?? range.end
        } : {})
      });
      if (kept.length > 1 && range && plan.availableSeconds !== undefined && plan.availableSeconds / kept.length < 0.5 && log) {
        log(`场景「${scene.title}」旁白只有 ${(range.end - range.start).toFixed(1)} 秒，装不下 ${kept.length} 张图（每张不到 0.5 秒），合成会拒绝；请减少这一场进入成片的图片`);
      }
      if (plan.minimumDisplaySeconds < plan.configuredMinimumSeconds && log) {
        log(`场景「${scene.title}」的「${asset.name}」最短展示 ${plan.configuredMinimumSeconds} 秒超过本场旁白长度，已压到 ${plan.minimumDisplaySeconds.toFixed(2)} 秒`);
      }
      visuals.push({
        id: asset.id,
        selectionKey: `${scene.id}:${sequenceIndex}:${asset.id}`,
        path: relativeAssetPath(asset.path),
        label: asset.name,
        fit: asset.fit,
        sourceType: asset.sourceType,
        narrationCueIndex: asset.cueStartIndex,
        narrationCueEndIndex: asset.cueEndIndex,
        requiredKeywords: asset.requiredKeywords,
        leadSeconds: asset.leadSeconds,
        tailSeconds: asset.tailSeconds,
        minimumDisplaySeconds: plan.minimumDisplaySeconds,
        crop: asset.crop,
        focalPoint: asset.focalPoint,
        scale: asset.scale,
        offsetX: asset.offsetX,
        offsetY: asset.offsetY,
        animation: asset.animation,
        entrance: asset.entrance,
        targetDisplaySeconds: asset.targetDisplaySeconds,
        ...(kept.length > 1 ? { sequenceIndex, sequenceCount: kept.length } : {}),
        // Every picture stops at its own scene's narration boundary. A child
        // photo must not run into the next stop of the tour, and an overview or
        // outro card must not run into a scene that has no picture of its own.
        ...(plan.notAfterNarrationSeconds !== undefined ? { notAfterNarrationSeconds: plan.notAfterNarrationSeconds } : {}),
        ...(plan.notBeforeNarrationSeconds !== undefined ? { notBeforeNarrationSeconds: plan.notBeforeNarrationSeconds } : {})
      });
    }
  }
  await mkdir(join(sandbox, "content", "visuals"), { recursive: true });
  await writeFile(join(sandbox, "content", "visuals", `${project.regionId}.json`), JSON.stringify({ regionId: project.regionId, profilePriority: project.output.profile, timingMode: "narration-cue-required", clips: visuals }, null, 2), "utf8");
}

/**
 * A region+profile has exactly one current map video. The cache directory is
 * named after the whole spec signature, so any change to the camera, the cue
 * timing, the geometry or the renderer writes a new directory and strands the
 * previous copy at roughly 200-400 MB each — one region had already accumulated
 * twelve revisions (~3 GB) and nothing ever reclaimed them.
 *
 * Only superseded revisions of the *same* artifact are removed, and only once
 * they have settled. With `STUDIO_EXPORT_CONCURRENCY` raised above its default
 * of 1, a second job may still be copying from an older signature directory
 * while this one finishes, so a freshly written copy is never a candidate.
 */
const MAP_CACHE_SETTLE_MS = 30 * 60 * 1000;

async function pruneSupersededMapCache(root: string, regionId: string, profile: string, keepSignature: string): Promise<void> {
  const cacheRoot = join(root, "workspace", "render-cache");
  const artifact = `${regionId}-map-${profile}.mp4`;
  const keep = keepSignature.replace("sha256:", "");
  const cutoff = Date.now() - MAP_CACHE_SETTLE_MS;
  const names = await readdir(cacheRoot).catch(() => [] as string[]);
  await Promise.all(names.filter((name) => name !== keep).map(async (name) => {
    const directory = join(cacheRoot, name);
    try {
      const info = await stat(join(directory, artifact));
      if (!info.isFile() || info.mtimeMs > cutoff) return;
      await rm(directory, { recursive: true, force: true });
    } catch { /* Not this artifact, already gone, or in use: leave it for the next render. */ }
  }));
}

/**
 * Length of a captured map clip, in seconds (0 when it cannot be measured).
 *
 * The map cache is keyed by the capture signature, which cannot see inside the
 * file. A truncated clip — `capture.ts --qa --frames 1` used to overwrite the
 * real capture — therefore looked like a finished asset and every export built
 * on it played a blank white board with only the subtitles left on it. Reading
 * the container duration is the cheapest way to notice that before it ships.
 */
const MIN_USABLE_MAP_SECONDS = 2;
function mapVideoSeconds(root: string, file: string): Promise<number> {
  return new Promise((resolveSeconds) => {
    const ffmpeg = join(root, "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    if (!existsSync(ffmpeg)) { resolveSeconds(0); return; }
    const probe = spawn(ffmpeg, ["-hide_banner", "-i", file], { windowsHide: true });
    let text = "";
    probe.stderr.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    let settled = false;
    const finish = (seconds: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveSeconds(seconds);
    };
    const timer = setTimeout(() => { killProcessTree(probe); finish(0); }, 15000);
    probe.once("error", () => finish(0));
    probe.once("close", () => {
      const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
      finish(match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0);
    });
  });
}
async function usableMapClip(root: string, file: string, expectedSeconds = 0): Promise<boolean> {
  const seconds = await mapVideoSeconds(root, file);
  if (seconds < MIN_USABLE_MAP_SECONDS) return false;
  // A clip shorter than the timeline it has to cover is not usable: the map track ends
  // early, the last frames freeze while the narration keeps going, and the export still
  // reports success because the composition's own duration is written from the timeline.
  // The old 2 s threshold called a 5 s take "fine" for a 400 s film and cached it.
  if (expectedSeconds > 0 && seconds < expectedSeconds * 0.98) return false;
  return true;
}

export async function publishMapCache(source: string, target: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.partial`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function cacheMap(root: string, sandbox: string, project: VideoProject, spec: RenderSpec): Promise<boolean> {
  const cacheDir = join(root, "workspace", "render-cache", spec.cacheSignature.replace("sha256:", ""));
  const cached = join(cacheDir, `${project.regionId}-map-${project.output.profile}.mp4`);
  const target = join(sandbox, "renders", "intermediate", `${project.regionId}-map-${project.output.profile}.mp4`);
  const expected = Number(spec.timelineDurationSeconds) || 0;
  if (existsSync(cached) && await usableMapClip(root, cached, expected)) { await copyFile(cached, target); return true; }
  // A cache entry too short to be a real capture is a leftover from a probe;
  // leaving it in place would keep seeding every later render with it.
  if (existsSync(cached)) await rm(cached, { force: true }).catch(() => { /* Re-captured below either way. */ });
  const baseline = await makeProject(root, project.regionId, { projectId: project.id });
  const baselineSpec = await buildProjectRenderSpec(root, baseline);
  const legacy = join(root, "renders", "intermediate", `${project.regionId}-map-${project.output.profile}.mp4`);
  const baselineExpected = Number(baselineSpec.timelineDurationSeconds) || 0;
  if (baselineSpec.cacheSignature === spec.cacheSignature && existsSync(legacy) && await usableMapClip(root, legacy, baselineExpected)) {
    await mkdir(cacheDir, { recursive: true });
    await publishMapCache(legacy, cached); await copyFile(cached, target);
    await writeFile(join(cacheDir, "cache.json"), JSON.stringify({ signature: spec.cacheSignature, seededFrom: legacy, createdAt: new Date().toISOString() }, null, 2), "utf8");
    await pruneSupersededMapCache(root, project.regionId, project.output.profile, spec.cacheSignature);
    return true;
  }
  return false;
}

interface PreflightSection {
  ok?: boolean;
  errorCount?: number;
  warningCount?: number;
  infoCount?: number;
  findings?: Array<{
    severity?: string;
    code?: string;
    message?: string;
    selector?: string;
    containerSelector?: string;
    time?: number;
    fixHint?: string;
  }>;
}

export interface PreflightReport {
  ok?: boolean;
  strict?: boolean;
  lint?: PreflightSection;
  runtime?: PreflightSection;
  layout?: PreflightSection;
  motion?: PreflightSection;
  contrast?: PreflightSection;
}

const PREFLIGHT_SECTIONS = ["lint", "runtime", "layout", "motion", "contrast"] as const;

/**
 * Roll a `hyperframes check --json` report up to what the export gate needs.
 *
 * Pure, so the gate can be tested against captured reports instead of by
 * running a browser: the decision is "does any section report an error", and
 * warnings must never gate — a real composition already produces hundreds of
 * them (`pointer_events_none`, `duplicate_audio_track`), so treating warnings
 * as blocking would refuse every export in the workspace.
 */
export function summarizePreflightReport(report: PreflightReport | null | undefined): { errors: number; warnings: number; perSection: string[]; findings: string[] } {
  if (!report || typeof report !== "object") return { errors: 0, warnings: 0, perSection: [], findings: [] };
  let errors = 0;
  let warnings = 0;
  const perSection: string[] = [];
  const findings: string[] = [];
  for (const name of PREFLIGHT_SECTIONS) {
    const section = report[name];
    if (!section || typeof section !== "object") continue;
    const sectionErrors = Math.max(0, Number(section.errorCount ?? 0));
    const sectionWarnings = Math.max(0, Number(section.warningCount ?? 0));
    errors += sectionErrors;
    warnings += sectionWarnings;
    perSection.push(`${name} ${sectionErrors}错/${sectionWarnings}警`);
    for (const finding of section.findings ?? []) {
      if (finding?.severity !== "error" || findings.length >= 3) continue;
      /* Name the elements. A bare "Two text blocks overlap and may render
         unreadable." cost a round trip through the operator (and one export) to
         find out that it meant `#provider-credit ↔ #visual-caption-15`; the
         report already carries the selectors and the timestamp. */
      const where = [finding.selector, finding.containerSelector].filter((value): value is string => Boolean(value)).join(" ↔ ");
      const at = Number.isFinite(Number(finding.time)) ? ` @${Number(finding.time).toFixed(1)}s` : "";
      findings.push(`${name}: ${String(finding.message ?? finding.code ?? "未命名问题").slice(0, 200)}${where ? ` [${where}]` : ""}${at}`);
    }
  }
  return { errors, warnings, perSection, findings };
}

/** Run a tool and keep its output, with a hard deadline. The preflight is a
 *  gate, not a render step: it must never be able to hang a job. */
export function runCaptured(executable: string, args: string[], options: { cwd: string; env?: Record<string, string>; timeoutMs: number; lifecycle?: Pick<RenderCallbacks, "cancelled" | "registerProcess"> }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  if (options.lifecycle?.cancelled()) return Promise.reject(new Error("Render cancelled"));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      env: options.env ? { ...process.env, ...options.env } : process.env
    });
    options.lifecycle?.registerProcess(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let killDeadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (killDeadline) clearTimeout(killDeadline);
      options.lifecycle?.registerProcess(null);
      if (cancelled || options.lifecycle?.cancelled()) reject(new Error("Render cancelled"));
      else resolvePromise({ code, stdout, stderr, timedOut });
    };
    const stop = () => {
      if (settled || killDeadline) return;
      killProcessTree(child);
      // 子进程继承的管道可能一直不关闭，清理宽限期后也必须结束预检。
      killDeadline = setTimeout(() => finish(null), 15_000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    const poll = setInterval(() => {
      if (options.lifecycle?.cancelled()) { cancelled = true; stop(); }
    }, 100);
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      if (settled) return;
      stderr += error.message;
      finish(null);
    });
    child.once("close", finish);
  });
}

function preflightEnabled(): boolean {
  return (process.env.STUDIO_PREFLIGHT ?? "on").trim().toLowerCase() !== "off";
}

/**
 * HyperFrames' own preflight, between composition and encoding.
 *
 * `编码新的 MP4 exited with 1` was the largest failure bucket in this
 * workspace (10 of 29 failed exports) and it fires at 79% — after the whole map
 * capture and after the encoder has already burnt twenty minutes to an hour.
 * `hyperframes check` exercises the same composition in the same browser
 * (lint, runtime, layout, motion, contrast) in a small fraction of that, so a
 * composition that cannot render is rejected while it is still cheap. It runs
 * here rather than before the capture because the composition does not exist
 * until the map video has been recorded.
 *
 * A preflight that cannot run is not a verdict. A missing CLI, a crash, a
 * timeout or unparseable output all pass the export through: the tool failing
 * says nothing about the composition, and blocking on it would trade a working
 * export for a brand-new failure mode.
 */
async function preflightComposition(
  sandbox: string,
  callbacks: RenderCallbacks,
  log: (message: string) => void,
  options: { stage: string; progress: number; stopMessage: string } = {
    stage: "编码前预检成片",
    progress: 76,
    stopMessage: "已在编码前中止，未浪费编码时间。"
  }
): Promise<void> {
  if (!preflightEnabled()) { log("PREFLIGHT_SKIPPED STUDIO_PREFLIGHT=off"); return; }
  const cli = join(sandbox, "node_modules", "hyperframes", "dist", "cli.js");
  if (!existsSync(cli)) { log("PREFLIGHT_SKIPPED 缺少 hyperframes CLI"); return; }
  const samples = Math.max(1, Math.min(40, Number(process.env.STUDIO_PREFLIGHT_SAMPLES ?? 8) || 8));
  const timeoutMs = Math.max(30_000, Number(process.env.STUDIO_PREFLIGHT_TIMEOUT_MS ?? 480_000) || 480_000);
  // HyperFrames 0.7.x defaults diagnostic page.goto to 10 seconds. That is
  // enough for small compositions but not for a long portrait export with
  // dozens of scene assets: the preflight can report a synthetic runtime error
  // before it has even reached the composition. Keep the gate, but give its
  // browser enough time to load the same composition the encoder will use.
  //
  // 60 s turned out to be too tight once a scheme grew past ~35 scenes: the
  // preflight failed twice in a row with `runtime: Navigation timeout of
  // 60000 ms exceeded` while the same composition had passed at 33 scenes. The
  // compositions carry one <img>/<video> per selected visual (~70 here) and the
  // machine also holds a multi-gigabyte frame-extract cache, so page load is
  // I/O bound rather than CPU bound. 180 s costs nothing when loading is fast
  // (the timeout is a ceiling, not a wait) and stops a healthy film from being
  // refused before the map has even been recorded.
  const navigationTimeoutMs = Math.max(10_000, Number(process.env.STUDIO_PREFLIGHT_NAVIGATION_TIMEOUT_MS ?? 180_000) || 180_000);
  const playerReadyTimeoutMs = Math.max(30_000, Number(process.env.STUDIO_PREFLIGHT_PLAYER_READY_TIMEOUT_MS ?? 120_000) || 120_000);
  const compositorDir = join(sandbox, "apps", "video-compositor");
  callbacks.update({ status: "composing", stage: options.stage, progress: options.progress });
  const result = await runCaptured(process.execPath, [cli, "check", ".", "--json", "--samples", String(samples)], {
    cwd: compositorDir,
    env: {
      PATH: `${ffmpegToolDir}${pathDelimiter}${process.env.PATH ?? ""}`,
      PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS: String(navigationTimeoutMs),
      PRODUCER_PLAYER_READY_TIMEOUT_MS: String(playerReadyTimeoutMs)
    },
    timeoutMs,
    lifecycle: callbacks
  });
  const start = result.stdout.indexOf("{");
  const end = result.stdout.lastIndexOf("}");
  let report: PreflightReport | null = null;
  if (start >= 0 && end > start) {
    try { report = JSON.parse(result.stdout.slice(start, end + 1)) as PreflightReport; } catch { report = null; }
  }
  if (!report) {
    log(`PREFLIGHT_INCONCLUSIVE 预检未产出可解析报告（退出码 ${result.code ?? "null"}${result.timedOut ? "，超时" : ""}）`);
    return;
  }
  const summary = summarizePreflightReport(report);
  if (summary.errors === 0) {
    log(`PREFLIGHT_OK 成片预检通过：${summary.perSection.join("，")}`);
    return;
  }
  throw new Error(`成片预检未通过（${summary.errors} 项错误）：${summary.findings.join("；") || "详见预检报告"}。${options.stopMessage}`);
}

// —— 导出录制期间暂停预览渲染器，避免双 UE 抢显存/内存触发 OOM ——
// 录制（apps/ue-player/capture.ts）会拉起 1080×1920 的录制 UE；预览 UE（720×1280）
// 与它同抢资源时，实测二者之一会 OOM 退出（exit 4294967295，日志无 fatal）。
// 内核租约跨进程互斥且崩溃自动释放；旧守护器通过持续更新的锁文件兼容。
const PREVIEW_PID_FILE = "workspace/ue-preview.pid";
const previewExec = promisify(execFile);

export function previewStopCommand(pid: string): string {
  if (!/^[1-9]\d*$/.test(pid)) throw new Error("预览 PID 无效");
  return `$ErrorActionPreference='Stop'; $same = { param($p) $p -and ($p.CommandLine -ceq $env:GEO_PREVIEW_COMMAND) -and ([string]$p.CreationDate.Ticks -ceq $env:GEO_PREVIEW_CREATED) -and ($p.ExecutablePath -ieq $env:GEO_PREVIEW_EXECUTABLE) }; $p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if (& $same $p) { & taskkill.exe /pid ${pid} /t /f; $killCode = $LASTEXITCODE; if ($killCode -ne 0) { $remaining = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if (& $same $remaining) { exit $killCode } } }; exit 0`;
}

async function pausePreviewRenderer(root: string, cancelled: () => boolean): Promise<ExportLease> {
  const lease = await acquireExportLease(root, cancelled);
  try {
    let pid: string;
    try { pid = (await readFile(join(root, PREVIEW_PID_FILE), "utf8")).trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return lease;
      throw error;
    }
    if (!/^[1-9]\d*$/.test(pid)) return lease;
    const runtimeFile = process.env.GEO_UE_RUNTIME || join(root, "workspace", "ue-runtime.json");
    const config = JSON.parse((await readFile(runtimeFile, "utf8")).replace(/^\uFEFF/, "")) as { project?: string; engineRoot?: string };
    if (!config.project || !config.engineRoot) throw new Error("无法确认预览 UE 所属项目，运行时配置不完整");
    const streamer = Number(process.env.UE_STREAMER_PORT || 8889);
    if (process.platform === "win32") {
      const { stdout } = await previewExec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object Name,CommandLine,ExecutablePath,@{Name='CreatedTicks';Expression={[string]$_.CreationDate.Ticks}} | ConvertTo-Json -Compress`], { windowsHide: true, timeout: 10000 });
      if (!stdout.trim()) return lease;
      const info = JSON.parse(stdout.replace(/^\uFEFF/, "")) as { Name?: string; CommandLine?: string; ExecutablePath?: string; CreatedTicks?: string };
      if (info.Name?.toLowerCase() !== "unrealeditor.exe" || !info.CommandLine || !info.ExecutablePath
        || !samePath(info.ExecutablePath, join(config.engineRoot, "Engine/Binaries/Win64/UnrealEditor.exe"))
        || !previewRendererMatches(info.CommandLine, config.project, streamer)) return lease;
      // 再次核验同一进程，避免探测期间旧 PID 被其他程序复用后误杀。
      await previewExec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", previewStopCommand(pid)], { windowsHide: true, timeout: 15000, env: { ...process.env, GEO_PREVIEW_COMMAND: info.CommandLine, GEO_PREVIEW_CREATED: String(info.CreatedTicks ?? ""), GEO_PREVIEW_EXECUTABLE: info.ExecutablePath } });
    }
    return lease;
  } catch (error) {
    await lease.release();
    throw error;
  }
}

export interface CaptureProcessInfo { ProcessId: number; ParentProcessId?: number; CommandLine?: string | null }

export function taskCaptureProcesses(processes: CaptureProcessInfo[], sandbox: string): CaptureProcessInfo[] {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
  const base = normalize(sandbox);
  const scripts = new Set(["capture.ts", "server.ts", "signalling.ts"].map(name => `${base}/apps/ue-player/${name}`));
  const selected = new Set<number>();
  for (const info of processes) {
    const args = (info.CommandLine?.match(/(?:[^\s"]|"[^"]*")+/g) ?? []).map(arg => normalize(arg.replaceAll('"', '')));
    if (args.some(arg => scripts.has(arg) || arg.startsWith(`-geocaptureroot=${base}/renders/ue-frames/`))) selected.add(info.ProcessId);
  }
  // 根进程还在时，同一次只读快照中的后代也必须全部退出。
  let added: boolean;
  do {
    added = false;
    for (const info of processes) if (info.ParentProcessId && selected.has(info.ParentProcessId) && !selected.has(info.ProcessId)) {
      selected.add(info.ProcessId); added = true;
    }
  } while (added);
  return processes.filter(info => selected.has(info.ProcessId));
}

async function probeTaskCaptureProcesses(sandbox: string): Promise<boolean> {
  let processes: CaptureProcessInfo[];
  if (process.platform === "win32") {
    const { stdout } = await previewExec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine)"], { windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    processes = JSON.parse(stdout.replace(/^\uFEFF/, ""));
    if (!Array.isArray(processes)) throw new Error("进程查询没有返回完整快照");
  } else {
    const { stdout } = await previewExec("ps", ["-eo", "pid=,ppid=,args="], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    processes = stdout.split(/\r?\n/).flatMap(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      return match ? [{ ProcessId: Number(match[1]), ParentProcessId: Number(match[2]), CommandLine: match[3]! }] : [];
    });
  }
  return taskCaptureProcesses(processes, sandbox).length > 0;
}

// 此保护由当前服务的内核租约维持；强制终止服务仍会释放它，不提供跨服务重启恢复协议。
const recoveringCaptureSandboxes = new Set<string>();

export async function releaseCaptureLeaseWhenSafe(
  lease: ExportLease, sandbox: string, log: (message: string) => void,
  probe: () => Promise<boolean> = () => probeTaskCaptureProcesses(sandbox), intervalMs = 5_000
): Promise<boolean> {
  const safe = async () => {
    try { return !await probe(); } catch { return false; }
  };
  if (await safe()) { await lease.release(); return true; }
  recoveringCaptureSandboxes.add(sandbox);
  log(`${CAPTURE_CLEANUP_FATAL}: 尚未确认本任务录制进程树退出，继续保留渲染保护并后台检查`);
  let lastLog = Date.now();
  const check = async () => {
    if (await safe()) {
      try {
        await lease.release();
        recoveringCaptureSandboxes.delete(sandbox);
        log("本任务录制进程已退出，渲染保护已恢复");
        return;
      } catch { /* 释放异常也保持检查，不丢失租约。 */ }
    }
    if (Date.now() - lastLog >= 60_000) {
      lastLog = Date.now(); log("仍未确认本任务录制进程完全退出，渲染保护保持中");
    }
    setTimeout(() => { void check(); }, intervalMs);
  };
  setTimeout(() => { void check(); }, intervalMs);
  return false;
}

export async function executeRender(root: string, job: RenderJobRecord, projectInput: VideoProject, callbacks: RenderCallbacks): Promise<void> {
  validateVideoProject(projectInput);
  const openingClipSeconds = parseOpeningClipDuration(job.openingClipSeconds);
  const clipComposeArgs = openingClipSeconds === undefined ? [] : ["--opening-clip-seconds", String(openingClipSeconds)];
  const project = structuredClone(projectInput);
  const jobRoot = job.jobRoot;
  // Stage stopwatch. Wall time is what the operator waits for, so that is what
  // gets recorded — the estimator turns these into per-finished-minute rates.
  const exportStartedAt = Date.now();
  const secondsBetween = (from: number, to: number): number => Math.round(((to - from) / 1000) * 10) / 10;
  const sandbox = await prepareSandbox(root, jobRoot, project);
  callbacks.update({ status: "preparing", stage: "生成项目快照与 RenderSpec", progress: 5 });
  await writeFile(join(jobRoot, "project.snapshot.json"), JSON.stringify(project, null, 2), "utf8");
  let spec = await buildProjectRenderSpec(root, project);
  await materializeProject(sandbox, project, spec);
  await writeFile(join(jobRoot, "render-spec.initial.json"), JSON.stringify(spec, null, 2), "utf8");
  const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const runTsx = (script: string, args: string[], status: RenderJobStatus, stage: string, progress: number) => command(callbacks, sandbox, process.execPath, [tsx, script, ...args], status, stage, progress, { GEO_UE_RUNTIME: join(root, "workspace", "ue-runtime.json") });
  const narrationStartedAt = Date.now();
  await runTsx(".agents/skills/cesium-geo-documentary/scripts/generate-narration.ts", ["--region", project.regionId], "synthesizing", "生成或复用正式配音", 14);
  const narrationEndedAt = Date.now();
  const generatedSrtPath = join(sandbox, "assets", "audio", project.regionId, "narration-edge.srt");
  let generatedCues = parseSrt(await readFile(generatedSrtPath, "utf8"));
  spec = buildRenderSpec({ project, cues: generatedCues, parentCamera: spec.tourPlan.parentCamera, geometrySignature: await geometrySignature(root, project.regionId, project.id), rendererSignature: await mapRendererSignature(root) });
  assertTourPlanExportable(spec.tourPlan);
  // A child scene's narration may be split across several TTS sentence cues
  // (a village paragraph with two sentences produces two cues). The compositor
  // and visuals already consume the exact scene->cue ranges; persist them next
  // to the master content so build-child-tour can schedule each tour stop over
  // the child's *complete* narration window instead of assuming one cue each.
  await writeChildCueRanges(sandbox, project.regionId, spec);
  const timingResult = await applyProjectTiming(sandbox, project, spec);
  generatedCues = timingResult.cues;
  await runTsx(".agents/skills/cesium-geo-documentary/scripts/build-child-tour.ts", ["--region", project.regionId], "synthesizing", "生成实际 cue 时间轴与行政区巡游", 27);
  const duration = JSON.parse(await readFile(join(sandbox, "assets", "audio", project.regionId, "duration.json"), "utf8")) as { durationSeconds: number; timelineDurationSeconds: number };
  const timeline = JSON.parse(await readFile(join(sandbox, "data", "regions", `${project.regionId}.timeline.json`), "utf8")) as { duration: number; narrationStartSeconds?: number; openingGateSeconds?: number };
  spec = buildRenderSpec({
    project,
    cues: generatedCues,
    parentCamera: spec.tourPlan.parentCamera,
    geometrySignature: await geometrySignature(root, project.regionId, project.id),
    rendererSignature: await mapRendererSignature(root),
    narrationDurationSeconds: duration.durationSeconds,
    timelineDurationSeconds: timeline.duration,
    // build-child-tour just rewrote this; the composition reads the same field, so
    // the spec the editor shows and the file ffmpeg renders can never disagree.
    timelineNarrationStartSeconds: Number(timeline.narrationStartSeconds ?? NaN),
    timelineOpeningGateSeconds: Number(timeline.openingGateSeconds ?? 0)
  });
  if (openingClipSeconds !== undefined && openingClipSeconds > spec.totalDurationSeconds) throw new Error("片段时长不能超过方案总时长");
  if (openingClipSeconds !== undefined) callbacks.update({ logs: [`OPENING_CLIP project=${project.id} revision=${project.revision} seconds=${openingClipSeconds} fresh-map=true`] });
  await writeRegionAnnotationWindows(sandbox, project.regionId, spec);
  updateProjectMeasuredDurations(project, spec);
  await writeSubtitleOverrides(sandbox, project, spec);
  const specPath = join(jobRoot, "render-spec.json");
  await writeFile(specPath, JSON.stringify(spec, null, 2), "utf8");
  callbacks.update({ renderSpecPath: specPath });
  await writeVisualsManifest(sandbox, project, spec, (message) => callbacks.update({ logs: [message] }));
  await runTsx(".agents/skills/cesium-geo-documentary/scripts/generate-video-cover.ts", ["--region", project.regionId, "--manifest", `content/covers/${project.regionId}.json`], "composing", "生成统一封面", 34);
  /* Lint the composition *before* the map is recorded.
     Composition depends on media existing, not on what the map recorded, so a
     black stand-in in the map slot lets the whole preflight run now. It used to
     run only after the capture: one lint error (a <video> nested in a timed
     <figure>) cost a full ~40-minute recording before the export was refused.
     The post-capture preflight below still runs - this one is the cheap gate,
     that one is the authoritative one against the real map. */
  // 字幕真实排版是地图捕获的输入，即使关闭预检也必须先生成，不能复用旧合成页。
  await ensureFfmpegTools(sandbox);
  await runTsx(".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts", ["--region", project.regionId, "--profile", project.output.profile, "--cover-intro-seconds", String(project.cover.introSeconds), "--map-fallback", ...clipComposeArgs], "composing", "录制前生成字幕排版与合成预演", 36);
  if (preflightEnabled()) {
    await preflightComposition(sandbox, callbacks, (message) => callbacks.update({ logs: [message] }), {
      stage: "录制前预检成片",
      progress: 38,
      stopMessage: "已在地图录制前中止，省下了整段录制时间。"
    });
  } else {
    callbacks.update({ logs: ["PREFLIGHT_SKIPPED STUDIO_PREFLIGHT=off（录制前的预检已按配置关闭）"] });
  }
  const mapStartedAt = Date.now();
  // A short take must neither reuse an older map nor enter the full-film cache.
  const hit = openingClipSeconds === undefined && await cacheMap(root, sandbox, project, spec);
  if (hit) callbacks.update({ status: "capturing", stage: "复用完整签名匹配的 Cesium 地图缓存", progress: 48, logs: [`MAP_CACHE_HIT ${spec.cacheSignature}`] });
  else {
    const port = 4600 + Number.parseInt(job.id.replaceAll("-", "").slice(0, 4), 16) % 1000;
    // 录制 UE 与预览 UE 同抢显存/内存会 OOM；录制前停掉预览渲染器，录完（无论成败）恢复。
    const exportLease = await pausePreviewRenderer(root, callbacks.cancelled);
    try {
      await runTsx(join(sandbox, "apps/ue-player/capture.ts"), ["--region", project.regionId, "--profile", project.output.profile, "--port", String(port), "--imagery", project.imagery.provider, "--subtitle-composition", "apps/video-compositor/index.html", ...(openingClipSeconds === undefined ? [] : ["--frames", String(Math.round(openingClipMapSeconds(openingClipSeconds, project.cover.introSeconds) * 30))])], "capturing", "录制 UE 地图、行政区巡游和返回镜头", 42);
      // Verify the take before it becomes the cache: a short capture used to be written to
      // the cache unconditionally, so one bad take poisoned every later export of this
      // signature. capture.ts already checks frame count and encoded duration; this is the
      // second pair of eyes that catches a truncated copy or a stale file.
      const capturedFile = join(sandbox, "renders", "intermediate", `${project.regionId}-map-${project.output.profile}.mp4`);
      const capturedSeconds = await mapVideoSeconds(root, capturedFile);
      const expectedMapSeconds = openingClipSeconds === undefined ? Number(spec.timelineDurationSeconds) || 0 : openingClipMapSeconds(openingClipSeconds, project.cover.introSeconds);
      if (capturedSeconds <= 0) throw new Error("地图录制没有产出可用的视频文件");
      if (expectedMapSeconds > 0 && capturedSeconds < expectedMapSeconds * 0.98) {
        throw new Error(`地图录制只有 ${capturedSeconds.toFixed(1)}s，时间轴需要 ${expectedMapSeconds.toFixed(1)}s`);
      }
      if (openingClipSeconds !== undefined) {
        const frameRoot = join(sandbox, "renders", "ue-frames");
        const takes = (await readdir(frameRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse();
        const report = takes.map(name => join(frameRoot, name, "capture-report.json")).find(path => existsSync(path));
        if (!report) throw new Error("片段缺少本次地图录制报告");
        await mkdir(join(jobRoot, "qa"), { recursive: true });
        await copyFile(report, join(jobRoot, "qa", "capture-report.json"));
      }
      if (openingClipSeconds === undefined) {
        const cacheDir = join(root, "workspace", "render-cache", spec.cacheSignature.replace("sha256:", ""));
        await mkdir(cacheDir, { recursive: true });
        await publishMapCache(capturedFile, join(cacheDir, `${project.regionId}-map-${project.output.profile}.mp4`));
        await pruneSupersededMapCache(root, project.regionId, project.output.profile, spec.cacheSignature);
      }
    } finally {
      if (!await releaseCaptureLeaseWhenSafe(exportLease, sandbox, message => callbacks.update({ logs: [message] }))) {
        throw new Error(`${CAPTURE_CLEANUP_FATAL}: 本任务录制进程退出尚未确认，禁止重试`);
      }
    }
  }
  const mapEndedAt = Date.now();
  // Everything that is not narration and not the map: sandbox setup, child-tour
  // scheduling, materials, cover, both preflights.
  const setupSeconds = secondsBetween(exportStartedAt, narrationStartedAt) + secondsBetween(narrationEndedAt, mapStartedAt);
  const narrationSeconds = secondsBetween(narrationStartedAt, narrationEndedAt);
  const mapSeconds = secondsBetween(mapStartedAt, mapEndedAt);
  const compositionStartedAt = Date.now();
  await runTsx(".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts", ["--region", project.regionId, "--profile", project.output.profile, "--cover-intro-seconds", String(project.cover.introSeconds), ...clipComposeArgs], "composing", "合成素材、字幕、配音与地图", 68);
  const quality = project.output.quality === "draft" ? "draft" : "high";
  const rendered = join(sandbox, "renders", quality === "high" ? "final" : "previews", `${project.regionId}-${project.output.profile}-${quality === "high" ? "final" : "draft"}.mp4`);
  await mkdir(dirname(rendered), { recursive: true });
  await ensureFfmpegTools(sandbox);
  // The staged ffmpeg is already on disk by now, so the preflight can decode
  // the same media the encoder is about to read.
  await preflightComposition(sandbox, callbacks, (message) => callbacks.update({ logs: [message] }));
  const compositorDir = join(sandbox, "apps", "video-compositor");
  const hyperframesCli = join(sandbox, "node_modules", "hyperframes", "dist", "cli.js");
  // 重试必须证明本次编码确实生成了文件，不能让退出码0掩盖上次遗留的成片。
  await rm(rendered, { force: true });
  // A long portrait composition must decode a multi-hundred-MB map clip and
  // dozens of scene assets before its first frame. Parallel workers then race
  // each other on page.goto; a hard 120 s ceiling timed out every worker with
  // zero navigation starts on this host. Make the ceiling configurable (and
  // generous by default) so it can be raised without rebuilding the engine.
  const renderNavigationTimeoutMs = Math.max(60_000, Number(process.env.STUDIO_RENDER_NAVIGATION_TIMEOUT_MS ?? 300_000) || 300_000);
  await command(callbacks, compositorDir, process.execPath,
    [hyperframesCli, "render", ".", "--composition", `compositions/${project.regionId}-${project.output.profile}.html`, "--output", rendered, "--quality", quality, "--fps", "30", "--workers", String(renderWorkerCount()), "--strict", "--sdr", "--browser-timeout", String(Math.ceil(renderNavigationTimeoutMs / 1000)), "--quiet"],
    "composing", "编码新的 MP4", 79,
    { PATH: `${ffmpegToolDir}${pathDelimiter}${process.env.PATH ?? ""}`, PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS: String(renderNavigationTimeoutMs) });
  const compositionSeconds = secondsBetween(compositionStartedAt, Date.now());
  const qaStartedAt = Date.now();
  const outputDir = join(jobRoot, "output"); await mkdir(outputDir, { recursive: true });
  const output = join(outputDir, `${project.regionId}-${project.output.profile}-${job.id.slice(0, 8)}.mp4`);
  await copyFile(rendered, output);
  if (openingClipSeconds !== undefined) {
    callbacks.update({ status: "validating", stage: "验收开头片段规格、黑帧与新生成证据", progress: 89 });
    await runOpeningClipQa({ root, jobRoot, output, spec, durationSeconds: openingClipSeconds, jobCreatedAt: job.createdAt, lifecycle: { cancelled: callbacks.cancelled, registerProcess: callbacks.registerProcess } });
    const outputInfo = await stat(output);
    if (callbacks.cancelled()) throw new Error("Render cancelled");
    callbacks.update({ status: "completed", stage: `开头 ${openingClipSeconds} 秒片段导出与专项 QA 已通过`, progress: 100, output, qaReport: join(jobRoot, "qa", "opening-clip-report.json"), videoDurationSeconds: openingClipSeconds, outputBytes: outputInfo.size });
    return;
  }
  const deliveryStage = quality === "high" ? "final" : "draft";
  const deliveryStartedAt = Date.now();
  try {
    await runTsx(".agents/skills/cesium-geo-documentary/scripts/validate-delivery.ts", ["--region", project.regionId, "--profile", project.output.profile, "--stage", deliveryStage], "validating", "执行项目交付 QA", 89);
  } catch (error) {
    if (callbacks.cancelled()) throw new Error("Render cancelled");
    throw error instanceof Error ? await deliveryValidationFailure(error, join(sandbox, "renders", "diagnostics", `${deliveryStage}-delivery-validation.json`), deliveryStartedAt) : error;
  }
  // Perceptual comparison is meaningful only against the same region/profile.
  // A different town can share the opening grammar while necessarily having a
  // different satellite view, boundary shape, route and duration.
  const goldenCandidate = join(root, "renders", "final", `${project.regionId}-${project.output.profile}-final.mp4`);
  const golden = existsSync(goldenCandidate) ? goldenCandidate : undefined;
  await runGoldenQa({ root, jobRoot, renderRoot: sandbox, output, golden, spec, jobCreatedAt: job.createdAt, lifecycle: { cancelled: callbacks.cancelled, registerProcess: callbacks.registerProcess } });
  const outputInfo = await stat(output);
  if (outputInfo.mtimeMs < new Date(job.createdAt).getTime() - 1000) throw new Error("输出文件不是本任务新生成");
  if (callbacks.cancelled()) throw new Error("Render cancelled");
  callbacks.update({
    status: "completed",
    stage: "导出与黄金成片 QA 已通过",
    progress: 100,
    output,
    qaReport: join(jobRoot, "qa", "golden-report.json"),
    videoDurationSeconds: Math.round(Number(spec.totalDurationSeconds) * 10) / 10,
    outputBytes: outputInfo.size,
    timings: {
      setupSeconds,
      narrationSeconds,
      mapSeconds,
      mapCacheHit: hit,
      compositionSeconds,
      qaSeconds: secondsBetween(qaStartedAt, Date.now()),
      totalSeconds: secondsBetween(exportStartedAt, Date.now())
    }
  });
}

/**
 * A terminal export keeps what a person needs — the film, its subtitles, the QA
 * report and the durable record — and hands the executable sandbox back.
 *
 * The sandbox is a full working copy of the pipeline plus every intermediate it
 * produced: the map video (200-400 MB), the narration WAV, the composed media
 * and every bound photo. Left in place it cost roughly 0.8 GB per finished
 * export, and because `deleteTerminalJob` unlinks the job-directory junction
 * without touching what it points at, deleting the record never reclaimed any
 * of it — sixty-seven abandoned sandboxes were still sitting in the system temp
 * directory.
 *
 * The measured narration is copied into the job directory first, because the
 * Studio's narration preview and every later export look it up through the job
 * history. Only the reusable audio is kept; the WAV is regenerated from it.
 */
export const NARRATION_REUSE_FILES = ["narration.mp3", "duration.json", "narration-edge.srt"];

/** A failed export is worth a handful of files, not a gigabyte of frames. */
const DIAGNOSTIC_FILE_LIMIT = 12;
const DIAGNOSTIC_BYTES_LIMIT = 8 * 1024 * 1024;

export interface JobDiagnostics {
  dir: string;
  files: string[];
}

/**
 * Keep the evidence a failed export leaves behind.
 *
 * The capture report — tile/imagery errors, per-frame failures, the annotation
 * counters — is written into the sandbox, and the sandbox is deleted as soon as
 * the job reaches a terminal state. So the only thing a failed job kept was
 * `job.error`, a single line that usually reads like "timed out", while the
 * `job.logs` ring buffer had already been overwritten by the retry attempt.
 * Copying the report out before the prune is what turns "导出失败" into something
 * an operator can act on (or hand over without re-running a two-hour export to
 * reproduce it).
 */
export async function collectJobDiagnostics(
  job: Pick<RenderJobRecord, "jobRoot" | "regionId" | "profile">
): Promise<JobDiagnostics | null> {
  if (!job.regionId || !job.profile) return null;
  const slot = `${job.regionId}-${job.profile}`;
  const framesRoot = join(job.jobRoot, "sandbox", "renders", "ue-frames");
  // 只查看本任务沙箱；精确匹配时间戳，避免混入 QA 或其他 region/profile。
  const timestamped = (await readdir(framesRoot, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && entry.name.startsWith(`${slot}-`) && /^\d+$/.test(entry.name.slice(slot.length + 1)))
    .sort((a, b) => Number(b.name.slice(slot.length + 1)) - Number(a.name.slice(slot.length + 1)));
  const candidates = [
    ...timestamped.map(entry => join(framesRoot, entry.name)),
    join(framesRoot, slot),
    join(job.jobRoot, "sandbox", "renders", "diagnostics", slot),
    join(job.jobRoot, "sandbox", "renders", "diagnostics"),
    join(job.jobRoot, "qa")
  ];
  const entries = (await Promise.all(candidates.map(async (source, sourceIndex) => {
    const names = await readdir(source, { withFileTypes: true }).catch(() => []);
    return names.filter(entry => entry.isFile()
      && (sourceIndex < candidates.length - 2
        || (sourceIndex === candidates.length - 1 ? ["golden-report.json", "opening-clip-report.json"].includes(entry.name)
          : /(?:delivery-validation|preflight|visual-sync).*\.json$/i.test(entry.name))))
      .map(entry => ({ name: entry.name, from: join(source, entry.name), sourceIndex }));
  }))).flat();
  // 核心成片 QA 先于捕获日志进入同一份12文件/8MiB预算。
  const rank = (name: string) => (/^(?:(?:golden|opening-clip)-report\.json)$|(?:delivery-validation|preflight|visual-sync).*\.json$/i.test(name) ? 0 : /^capture-report/.test(name) ? 1 : name.endsWith(".json") ? 2 : name.endsWith(".log") ? 3 : name.endsWith(".png") ? 4 : 5);
  const ordered = entries.sort((a, b) => rank(a.name) - rank(b.name) || a.sourceIndex - b.sourceIndex || b.name.localeCompare(a.name, undefined, { numeric: true }));
  const outDir = join(job.jobRoot, "diagnostics");
  const files: string[] = [];
  let bytes = 0;
  for (const entry of ordered) {
    if (files.length >= DIAGNOSTIC_FILE_LIMIT) break;
    if (files.includes(entry.name)) continue;
    const { from } = entry;
    const info = await stat(from).catch(() => null);
    if (!info || bytes + info.size > DIAGNOSTIC_BYTES_LIMIT) continue;
    await mkdir(outDir, { recursive: true });
    await copyFile(from, join(outDir, entry.name));
    bytes += info.size;
    files.push(entry.name);
  }
  return files.length > 0 ? { dir: outDir, files } : null;
}

export async function pruneJobIntermediates(
  job: Pick<RenderJobRecord, "id" | "jobRoot" | "regionId">,
  options: { includeMaterializedSandbox?: boolean } = {}
): Promise<void> {
  const link = join(job.jobRoot, "sandbox");
  if (job.regionId) {
    const source = join(link, "assets", "audio", job.regionId);
    const target = join(job.jobRoot, "audio");
    const keep = NARRATION_REUSE_FILES.filter((name) => existsSync(join(source, name)));
    if (keep.length > 0) {
      await mkdir(target, { recursive: true });
      for (const name of keep) await copyFile(join(source, name), join(target, name));
    }
  }
  // The junction itself, then whatever it pointed at. The target lives in the
  // system temp directory under this job's own name, so the path is derived
  // rather than read back — `readlink` returns a device-prefixed path on
  // Windows and would need its own unescaping.
  //
  // A *real* directory here is a sandbox that was copied instead of linked —
  // moving this workspace between drives materialised every junction into a
  // full copy, which is where most of the stranded gigabytes came from. It is
  // only removed when the caller asks for it, because a recursive delete is not
  // something an automatic housekeeping pass should decide on its own.
  const tempRoot = join(tmpdir(), "geo-video-studio");
  const tempJobRoot = join(tempRoot, basename(job.jobRoot));
  if (recoveringCaptureSandboxes.has(join(tempJobRoot, "sandbox"))) return;
  const stats = await lstat(link).catch(() => null);
  if (stats?.isSymbolicLink()) await removeDirectoryLink(link);
  else if (stats?.isDirectory() && options.includeMaterializedSandbox) await rm(link, { recursive: true, force: true });
  if (basename(job.jobRoot) !== job.id || !tempJobRoot.startsWith(`${tempRoot}${sep}`)) return;
  if (existsSync(tempJobRoot)) await rm(tempJobRoot, { recursive: true, force: true });
}

export function newRenderJob(projectId: string, jobsRoot: string, project?: VideoProject): RenderJobRecord {
  const id = randomUUID(); const now = new Date().toISOString();
  return {
    id, projectId, status: "queued", stage: "等待导出", progress: 0, createdAt: now, updatedAt: now, logs: [], jobRoot: join(jobsRoot, id), attempt: 1,
    ...(project ? { regionId: project.regionId, projectTitle: project.name, profile: project.output.profile, quality: project.output.quality } : {})
  };
}
