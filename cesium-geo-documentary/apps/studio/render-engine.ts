import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, readFile, readdir, readlink, rm, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { buildRenderSpec, parseSrt, planVisualClip, selectSceneAssetsForRender, updateProjectMeasuredDurations, type RenderSpec } from "../../packages/render-spec/index.js";
import { normalizeSemanticText, validateVideoProject, type StudioScene, type VideoProject } from "../../packages/project-schema/index.js";
import { buildProjectRenderSpec, geometrySignature, makeProject, mapRendererSignature } from "./project-service.js";
import { snapshotFile } from "./boundary-snapshot.js";
import { runGoldenQa } from "./golden-qa.js";
import { applyProjectTiming, writeSubtitleOverrides } from "./render-timing.js";

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
export function isRetryableRenderFailure(message: string): boolean {
  if (/exited with (?!0\b)\S+/.test(message)) return true;
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
  const sourceAudio = join(root, "assets", "audio", project.regionId);
  if (existsSync(sourceAudio)) await cp(sourceAudio, join(sandbox, "assets", "audio", project.regionId), { recursive: true, force: true });
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
  for (const path of [region.geometryPath, region.childGeometryPath].filter((value): value is string => Boolean(value))) await copyIfExists(await boundarySource(path), join(sandbox, path));
  for (const asset of project.assets) {
    if (asset.path.startsWith("/workspace-assets/")) {
      const name = asset.path.slice("/workspace-assets/".length);
      await copyIfExists(join(root, "workspace", "assets", name), join(sandbox, "workspace", "assets", name));
    } else {
      await copyIfExists(join(root, asset.path), join(sandbox, asset.path));
    }
  }
  return sandbox;
}

function command(callbacks: RenderCallbacks, cwd: string, executable: string, args: string[], status: RenderJobStatus, stage: string, progress: number, envOverrides: Record<string, string> = {}): Promise<void> {
  if (callbacks.cancelled()) throw new Error("Render cancelled");
  callbacks.update({ status, stage, progress });
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, env: { ...process.env, GEO_VIDEO_PROJECT_ROOT: cwd, ...envOverrides } });
    callbacks.registerProcess(child);
    const append = (chunk: unknown) => callbacks.update({ logs: [String(chunk).trim()] });
    child.stdout.on("data", append); child.stderr.on("data", append);
    child.once("error", reject);
    child.once("close", (code) => {
      callbacks.registerProcess(null);
      if (callbacks.cancelled()) reject(new Error("Render cancelled"));
      else if (code === 0) resolve();
      else reject(new Error(`${stage} exited with ${code}`));
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
      name: childDisplayNames.get(String(child.id)) || child.name
    }));
  }
  region.openingDescent = {
    enabled: project.template.openingDescentSeconds > 0,
    seconds: project.template.openingDescentSeconds,
    startHeightMeters: project.template.openingStartHeightMeters,
    startPitchDegrees: project.template.openingStartPitchDegrees,
    cloudDeckHeightMeters: project.template.cloudDeckHeightMeters,
    clouds: true,
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
  // Narration begins with the boundary pen-down. Preserve enough uninterrupted
  // map time to read the outline and parent name before evidence imagery enters.
  const openingAssetDelayFromNarrationSeconds = 2.8;
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
      const plan = planVisualClip({
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

async function cacheMap(root: string, sandbox: string, project: VideoProject, spec: RenderSpec): Promise<boolean> {
  const cacheDir = join(root, "workspace", "render-cache", spec.cacheSignature.replace("sha256:", ""));
  const cached = join(cacheDir, `${project.regionId}-map-${project.output.profile}.mp4`);
  const target = join(sandbox, "renders", "intermediate", `${project.regionId}-map-${project.output.profile}.mp4`);
  if (existsSync(cached)) { await copyFile(cached, target); return true; }
  const baseline = await makeProject(root, project.regionId, { projectId: project.id });
  const baselineSpec = await buildProjectRenderSpec(root, baseline);
  const legacy = join(root, "renders", "intermediate", `${project.regionId}-map-${project.output.profile}.mp4`);
  if (baselineSpec.cacheSignature === spec.cacheSignature && existsSync(legacy)) {
    await mkdir(cacheDir, { recursive: true });
    await copyFile(legacy, cached); await copyFile(cached, target);
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
function runCaptured(executable: string, args: string[], options: { cwd: string; env?: Record<string, string>; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      env: options.env ? { ...process.env, ...options.env } : process.env
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // The check drives a real browser, so the CLI's own PID is the head of a
      // tree. Killing only that head on Windows would leave the browser holding
      // the profile lock until it exits on its own.
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }).once("exit", () => undefined);
      }
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
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
    timeoutMs
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

export async function executeRender(root: string, job: RenderJobRecord, projectInput: VideoProject, callbacks: RenderCallbacks): Promise<void> {
  validateVideoProject(projectInput);
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
  spec = buildRenderSpec({ project, cues: generatedCues, geometrySignature: await geometrySignature(root, project.regionId, project.id), rendererSignature: await mapRendererSignature(root) });
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
  const timeline = JSON.parse(await readFile(join(sandbox, "data", "regions", `${project.regionId}.timeline.json`), "utf8")) as { duration: number };
  spec = buildRenderSpec({ project, cues: generatedCues, geometrySignature: await geometrySignature(root, project.regionId, project.id), rendererSignature: await mapRendererSignature(root), narrationDurationSeconds: duration.durationSeconds, timelineDurationSeconds: timeline.duration });
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
  if (preflightEnabled()) {
    await ensureFfmpegTools(sandbox);
    await runTsx(".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts", ["--region", project.regionId, "--profile", project.output.profile, "--cover-intro-seconds", String(project.cover.introSeconds), "--map-fallback"], "composing", "录制前预检：预演合成（地图用占位）", 36);
    await preflightComposition(sandbox, callbacks, (message) => callbacks.update({ logs: [message] }), {
      stage: "录制前预检成片",
      progress: 38,
      stopMessage: "已在地图录制前中止，省下了整段录制时间。"
    });
  } else {
    callbacks.update({ logs: ["PREFLIGHT_SKIPPED STUDIO_PREFLIGHT=off（录制前的预检已按配置关闭）"] });
  }
  const mapStartedAt = Date.now();
  const hit = await cacheMap(root, sandbox, project, spec);
  if (hit) callbacks.update({ status: "capturing", stage: "复用完整签名匹配的 Cesium 地图缓存", progress: 48, logs: [`MAP_CACHE_HIT ${spec.cacheSignature}`] });
  else {
    const port = 4600 + Number.parseInt(job.id.replaceAll("-", "").slice(0, 4), 16) % 1000;
    await runTsx("apps/ue-player/capture.ts", ["--region", project.regionId, "--profile", project.output.profile, "--port", String(port), "--imagery", project.imagery.provider], "capturing", "录制 UE 地图、行政区巡游和返回镜头", 42);
    const cacheDir = join(root, "workspace", "render-cache", spec.cacheSignature.replace("sha256:", ""));
    await mkdir(cacheDir, { recursive: true });
    await copyFile(join(sandbox, "renders", "intermediate", `${project.regionId}-map-${project.output.profile}.mp4`), join(cacheDir, `${project.regionId}-map-${project.output.profile}.mp4`));
    await pruneSupersededMapCache(root, project.regionId, project.output.profile, spec.cacheSignature);
  }
  const mapEndedAt = Date.now();
  // Everything that is not narration and not the map: sandbox setup, child-tour
  // scheduling, materials, cover, both preflights.
  const setupSeconds = secondsBetween(exportStartedAt, narrationStartedAt) + secondsBetween(narrationEndedAt, mapStartedAt);
  const narrationSeconds = secondsBetween(narrationStartedAt, narrationEndedAt);
  const mapSeconds = secondsBetween(mapStartedAt, mapEndedAt);
  const compositionStartedAt = Date.now();
  await runTsx(".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts", ["--region", project.regionId, "--profile", project.output.profile, "--cover-intro-seconds", String(project.cover.introSeconds)], "composing", "合成素材、字幕、配音与地图", 68);
  const quality = project.output.quality === "draft" ? "draft" : "high";
  const rendered = join(sandbox, "renders", quality === "high" ? "final" : "previews", `${project.regionId}-${project.output.profile}-${quality === "high" ? "final" : "draft"}.mp4`);
  await mkdir(dirname(rendered), { recursive: true });
  await ensureFfmpegTools(sandbox);
  // The staged ffmpeg is already on disk by now, so the preflight can decode
  // the same media the encoder is about to read.
  await preflightComposition(sandbox, callbacks, (message) => callbacks.update({ logs: [message] }));
  const compositorDir = join(sandbox, "apps", "video-compositor");
  const hyperframesCli = join(sandbox, "node_modules", "hyperframes", "dist", "cli.js");
  await command(callbacks, compositorDir, process.execPath,
    [hyperframesCli, "render", ".", "--composition", `compositions/${project.regionId}-${project.output.profile}.html`, "--output", rendered, "--quality", quality, "--fps", "30", "--workers", String(renderWorkerCount()), "--strict", "--sdr", "--browser-timeout", "120", "--quiet"],
    "composing", "编码新的 MP4", 79,
    { PATH: `${ffmpegToolDir}${pathDelimiter}${process.env.PATH ?? ""}` });
  const compositionSeconds = secondsBetween(compositionStartedAt, Date.now());
  const qaStartedAt = Date.now();
  const outputDir = join(jobRoot, "output"); await mkdir(outputDir, { recursive: true });
  const output = join(outputDir, `${project.regionId}-${project.output.profile}-${job.id.slice(0, 8)}.mp4`);
  await copyFile(rendered, output);
  await runTsx(".agents/skills/cesium-geo-documentary/scripts/validate-delivery.ts", ["--region", project.regionId, "--profile", project.output.profile, "--stage", quality === "high" ? "final" : "draft"], "validating", "执行项目交付 QA", 89);
  // Perceptual comparison is meaningful only against the same region/profile.
  // A different town can share the opening grammar while necessarily having a
  // different satellite view, boundary shape, route and duration.
  const goldenCandidate = join(root, "renders", "final", `${project.regionId}-${project.output.profile}-final.mp4`);
  const golden = existsSync(goldenCandidate) ? goldenCandidate : undefined;
  await runGoldenQa({ root, jobRoot, renderRoot: sandbox, output, golden, spec, jobCreatedAt: job.createdAt });
  const outputInfo = await stat(output);
  if (outputInfo.mtimeMs < new Date(job.createdAt).getTime() - 1000) throw new Error("输出文件不是本任务新生成");
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
  const source = join(job.jobRoot, "sandbox", "renders", "diagnostics", `${job.regionId}-${job.profile}`);
  if (!existsSync(source)) return null;
  const entries = (await readdir(source, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile());
  // The report first: if the byte budget only fits a few files, they are the ones
  // that explain the failure, not the hundredth `failed-frame-*.png`.
  const rank = (name: string) => (/^capture-report/.test(name) ? 0 : name.endsWith(".json") ? 1 : name.endsWith(".log") ? 2 : name.endsWith(".png") ? 3 : 4);
  const ordered = [...entries].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  const outDir = join(job.jobRoot, "diagnostics");
  const files: string[] = [];
  let bytes = 0;
  for (const entry of ordered) {
    if (files.length >= DIAGNOSTIC_FILE_LIMIT) break;
    const from = join(source, entry.name);
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
  const stats = await lstat(link).catch(() => null);
  if (stats?.isSymbolicLink()) await removeDirectoryLink(link);
  else if (stats?.isDirectory() && options.includeMaterializedSandbox) await rm(link, { recursive: true, force: true });
  const tempRoot = join(tmpdir(), "geo-video-studio");
  const tempJobRoot = join(tempRoot, basename(job.jobRoot));
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
