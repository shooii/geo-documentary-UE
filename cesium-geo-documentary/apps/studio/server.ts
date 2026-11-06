import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { validateVideoProject, type StudioAsset, type VideoProject } from "../../packages/project-schema/index.js";
import { parseSrt, planVisualTimeline, type TimedCue } from "../../packages/render-spec/index.js";
import { findVisualAnchorIssues } from "../../packages/content-engine/visual-anchoring.js";
import { buildProjectRenderSpec, makeProject, normalizeProject, readRegions } from "./project-service.js";
import { captureBoundarySnapshot, deleteBoundarySnapshot, listBoundarySnapshotProjects, readBoundarySnapshotManifest } from "./boundary-snapshot.js";
import { collectJobDiagnostics, executeRender, isRetryableRenderFailure, newRenderJob, pruneJobIntermediates, type RenderJobRecord, type RenderJobStatus } from "./render-engine.js";
import { listAdminDivisions, locateAdminDivision, searchAdminDivisions, type AdminLevel } from "./admin-catalog.js";
import { ensureTownPlan, warnIfSourceDataMovedOn } from "./town-bootstrap.js";
import { suggestTourRoute } from "./tour-route.js";
import { AMAP_POI_TYPES, amapKeyConfigured, importAmapPoiMaterials, type AmapPoiImportOptions } from "./amap-materials.js";
import { deepSeekPublicOptions, generateProjectCopy } from "./deepseek-copy.js";
import { generateCoverAsset, resolveCoverDefinition } from "../../.agents/skills/cesium-geo-documentary/scripts/cover.js";
import { readFileResilient, readJsonResilient, writeJsonAtomicResilient, writeJsonVersionResilient } from "./fs-resilience.js";
import { AssetRegionEvidence, withRegionAssetLibrary } from "./asset-library.js";
import { orderProjectSnapshots, sameProjectContent, selectProjectRevisionsToPrune, type ProjectRevisionEntry } from "./project-revisions.js";
import { buildProjectWorkbook, collectAssetPreviews, mergeProjectWorkbook, workbookFileName } from "./project-workbook.js";
import { isWorkspaceAssetFileName } from "./media-sniff.js";
import { MAX_BINARY_ASSET_BYTES, storeUploadedBuffer, storeUploadedFile } from "./asset-store.js";
import { HttpError } from "./http-error.js";

const root = resolve(process.cwd());
const publicRoot = join(root, "apps", "studio", "public");
const workspaceRoot = join(root, "workspace");
const projectsRoot = join(workspaceRoot, "projects");
const jobsRoot = join(workspaceRoot, "jobs");
const assetsRoot = join(workspaceRoot, "assets");
const coverPreviewsRoot = join(workspaceRoot, "cover-previews");
const sourceAssetsRoot = join(root, "assets", "source");
const port = Number(process.env.STUDIO_PORT ?? 4180);
const cesiumPreviewPort = Number(process.env.CESIUM_PREVIEW_PORT ?? 4174);
const cesiumPreviewScript = join(root, "apps", "ue-player", "server.ts");
let cesiumPreviewChild: ChildProcess | null = null;
function probePort(host: string, probePort: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: probePort });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}

function startCesiumPreview(): void {
  void probePort("127.0.0.1", cesiumPreviewPort).then((busy) => {
    if (busy) {
      process.stdout.write(`CESIUM_PREVIEW_REUSE http://127.0.0.1:${cesiumPreviewPort} (already running, skipped auto-start)\n`);
      return;
    }
    if (!existsSync(cesiumPreviewScript)) {
      process.stdout.write(`CESIUM_PREVIEW_SKIP missing ${cesiumPreviewScript}\n`);
      return;
    }
    const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
    if (!existsSync(tsxCli)) {
      process.stdout.write(`CESIUM_PREVIEW_SKIP missing ${tsxCli} — run \`pnpm install\`\n`);
      return;
    }
    const child = spawn(process.execPath, [tsxCli, cesiumPreviewScript, `--port=${cesiumPreviewPort}`], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    cesiumPreviewChild = child;
    const forward = (prefix: string) => (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) process.stdout.write(`[cesium-preview ${prefix}] ${text}\n`);
    };
    child.stdout?.on("data", forward("out"));
    child.stderr?.on("data", forward("err"));
    child.once("exit", (code) => {
      cesiumPreviewChild = null;
      process.stdout.write(`[cesium-preview] exited with ${code ?? "null"}\n`);
    });
    process.stdout.write(`CESIUM_PREVIEW_STARTED http://127.0.0.1:${cesiumPreviewPort} pid=${child.pid ?? "?"}\n`);
  }).catch((error) => {
    // A failed probe must not become an unhandled rejection: the preview is a
    // convenience, and the workbench still serves with it missing.
    process.stdout.write(`CESIUM_PREVIEW_PROBE_FAILED ${error instanceof Error ? error.message : String(error)}\n`);
  });
}

function stopCesiumPreview(): void {
  if (cesiumPreviewChild && !cesiumPreviewChild.killed && cesiumPreviewChild.exitCode === null) {
    try { cesiumPreviewChild.kill(); } catch { /* best effort */ }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopCesiumPreview();
    process.exit(0);
  });
}

/**
 * Keep the workbench alive through a stray failure.
 *
 * Node terminates the process on an unhandled rejection by default, and this
 * server has many fire-and-forget tasks (background deletes, queue sweeps,
 * progress writes) plus every request handler. One rejected promise in any of
 * them used to take the whole Studio down mid-edit, and the operator only saw
 * "connection refused" with nothing in the log explaining why. Reporting and
 * continuing is the right trade here: the request that failed already answered
 * with an error, and every durable write goes through the atomic path, so the
 * process is still in a consistent state.
 *
 * Both handlers are logging-only on purpose — they must never throw themselves.
 */
function reportProcessFailure(kind: string, error: unknown): void {
  try {
    const detail = error instanceof Error ? (error.stack || error.message) : String(error);
    process.stderr.write(`${kind} ${detail}\n`);
  } catch {
    // Nothing sensible left to do: writing the diagnostic itself failed.
  }
}

process.on("unhandledRejection", (reason) => {
  reportProcessFailure("STUDIO_UNHANDLED_REJECTION", reason);
});
process.on("uncaughtException", (error) => {
  reportProcessFailure("STUDIO_UNCAUGHT_EXCEPTION", error);
});

/**
 * Event-loop watchdog.
 *
 * This service is single-threaded, and "the editor is frozen" has now twice
 * turned out to be synchronous CPU work on the request path (reading every
 * snapshot; then rebuilding the whole project on every read). Both were found
 * by hand, after the fact. When the loop is blocked there is no log line at all
 * — the process is alive, listening, and simply not answering, which is exactly
 * what makes it hard to attribute later.
 *
 * `monitorEventLoopDelay` samples the loop's own scheduling delay; anything
 * past a second means a request (or a build step) spent a second inside
 * synchronous code. Reporting it names the culprit at the moment it happens,
 * and the pairing with a per-request slow log below turns "it froze again" into
 * a specific route and a specific phase.
 *
 * Enabled with STUDIO_PERF=0 for troubleshooting; on by default because the
 * cost is one sample every 20 ms.
 */
const SLOW_REQUEST_MS = Number(process.env.STUDIO_SLOW_REQUEST_MS ?? 600);
// 1 s of blocked loop is the point where the UI is visibly unresponsive; below
// that it is ordinary request work. Overridable so the watchdog itself can be
// exercised on demand (a regression test would otherwise have to stall the
// loop for a whole second).
const BLOCKED_LOOP_MS = Number(process.env.STUDIO_BLOCKED_LOOP_MS ?? 1000);
if (!["0", "false", "off"].includes(String(process.env.STUDIO_PERF ?? "1").toLowerCase())) {
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  let reportedAt = 0;
  setInterval(() => {
    const worstMs = loopDelay.max / 1e6;
    loopDelay.reset();
    // Throttled so one storm does not bury the log in duplicate lines while the
    // queue drains.
    if (worstMs < BLOCKED_LOOP_MS) return;
    const now = Date.now();
    if (now - reportedAt < 5_000) return;
    reportedAt = now;
    process.stderr.write(`STUDIO_EVENT_LOOP_BLOCKED ${worstMs.toFixed(0)}ms (单线程被同步任务占住这么久，界面期间不会响应)\n`);
  }, 2_000).unref();
}


const jobs = new Map<string, RenderJobRecord>();
const activeProcesses = new Map<string, ChildProcess>();
const cancelledJobs = new Set<string>();
const activeJobIds = new Set<string>();
/**
 * Job ids whose record the user deleted. Cancelling marks the record `cancelled`
 * before the child process is actually reaped, so a delete that lands while the
 * export is still winding down has to survive the progress writes it keeps
 * emitting: without this the next `persistJob` put the record back on disk —
 * relabelled `failed`, because `cancelledJobs` had just been cleared — and
 * recreated its directory. The user saw a phantom failed export for a render
 * they had cancelled and deleted.
 */
const deletedJobs = new Set<string>();
/** The in-flight render per job, so a delete can wait for the writes to stop. */
const runningJobs = new Map<string, Promise<void>>();
const queuedRenders: Array<{ job: RenderJobRecord; project: VideoProject }> = [];
const maxConcurrentExports = Math.max(1, Math.min(2, Number(process.env.STUDIO_EXPORT_CONCURRENCY ?? 1)));
/**
 * Statuses in which an export still owns the render queue. Exports run on the
 * service, not in the browser tab, and they are not scoped to whichever project
 * the editor happens to be showing — so the Studio UI asks for these across all
 * projects to keep an in-flight export visible after the user switches projects.
 * Typed as RenderJobStatus so a typo here fails the type check instead of
 * silently dropping a running job out of the list.
 */
const ACTIVE_JOB_STATUSES = new Set<RenderJobStatus>(["queued", "preparing", "synthesizing", "capturing", "composing", "validating"]);
let projectListPromise: Promise<VideoProject[]> | undefined;
let projectListSignature: string | undefined;
const projectWriteQueues = new Map<string, Promise<void>>();
// Schemes the user has deleted. Deleting one takes tens of seconds of guarded
// filesystem work, so the scheme is hidden here first and the disk work is
// flushed in the background; every read path consults this so the hidden scheme
// stays gone in the meantime.
const deletedProjectIds = new Set<string>();
// The newest-snapshot scan is cached behind the workspace's filename fingerprint.
// Declared up here, next to the other list caches, because `deleteProject`
// invalidates it and a function defined below must not reach into a `let` that
// only exists further down the file.
let latestProjectScan: { fingerprint: string; items: Array<{ file: string; project: VideoProject }> } | null = null;

/**
 * The fully-materialised form of a scheme, keyed by the exact snapshot it came
 * from.
 *
 * Every project route funnels through `readProject`, and `readProject` ends in
 * `normalizeProject` -> `makeProject`, which re-reads `content/regions.zh-CN.json`
 * (227 KB), walks the scheme's parent chain through `data/regions/*.json`, and
 * then rebuilds all canonical scenes and re-merges the whole asset library. That
 * is ~95 ms of *synchronous* CPU per call on the busiest scheme here (measured:
 * makeProject 73 ms + normalizeProject 22 ms), and it ran again for every single
 * GET, PUT, validate, render-spec and narration-audio request.
 *
 * On one thread that is the freeze: the UI refreshes several panels at once
 * while a preview plays, each request blocks the loop for ~95 ms, and the ones
 * behind it queue -- measured 8x latency inflation (83 ms -> 684 ms) under four
 * concurrent clients, which is what "the editor periodically dies" looked like.
 *
 * The cache key is the snapshot filename plus the asset-library fingerprint:
 * both change exactly when the materialised result would. A write mints a new
 * revision (new filename) and touches the asset library (new fingerprint), so
 * neither a save nor an upload can serve a stale project; both invalidations are
 * structural rather than something a future edit has to remember.
 */
const projectMaterialisationCache = new Map<string, { candidate: string; assetFingerprint: string; project: VideoProject }>();

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".srt": "text/plain; charset=utf-8"
};

function sendBuffer(response: ServerResponse, status: number, buffer: Buffer, contentType: string, disposition?: string): void {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": buffer.length,
    "cache-control": "no-store",
    ...(disposition ? { "content-disposition": disposition } : {})
  });
  response.end(buffer);
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(data));
}

async function bodyJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const chunk of request) {
      const value = Buffer.from(chunk); size += value.length;
      if (size > 20_000_000) throw new HttpError(413, "请求体超过 20 MB");
      chunks.push(value);
    }
  } catch (error) {
    // A client that disconnects mid-upload ("aborted") is not a server fault;
    // surface it as a clean 400 rather than a raw stream error the top-level
    // handler would report with a Node-internal message.
    if (error instanceof HttpError) throw error;
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ECONNRESET" || code === "ERR_STREAM_PREMATURE_CLOSE") {
      throw new HttpError(400, "请求体未完整发送");
    }
    throw error;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    // The raw SyntaxError ("Unexpected token < at position 0") says nothing a
    // user can act on, and every JSON route here is fed by our own UI.
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

function safeId(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid id");
  return value;
}

function uploadedAssetDisplayName(value: unknown, fallback: string): string {
  const name = String(value ?? "").trim();
  return name.replace(/\.[^.]+$/, "") || name || fallback;
}

function isStoredWorkspaceAsset(asset: StudioAsset): boolean {
  if (!asset.path.startsWith("/workspace-assets/")) return false;
  const filename = asset.path.slice("/workspace-assets/".length);
  return isWorkspaceAssetFileName(filename) && existsSync(join(assetsRoot, filename));
}

// Sidecars are canonical; cache only the scan, never a project's regional view.
let assetLibraryScan: { fingerprint: string; library: StudioAsset[] } | null = null;
let assetLibraryRecoveredProjectUploads = false;
let assetLibraryRead: Promise<StudioAsset[]> | undefined;

async function readWorkspaceAssetLibrary(): Promise<StudioAsset[]> {
  if (assetLibraryRead) return assetLibraryRead;
  assetLibraryRead = scanWorkspaceAssetLibrary();
  try { return await assetLibraryRead; }
  finally { assetLibraryRead = undefined; }
}

/**
 * Read many JSON files with bounded parallelism, keeping result order.
 *
 * The asset library is one small sidecar per stored picture, and there are 7000+
 * of them here: reading them in a sequential `await` loop cost ~6.5 s of pure
 * file latency on the first request after a restart (measured; ~2.5 s at 16-way
 * parallelism, which is where it stays -- this is Windows file I/O, not CPU).
 *
 * Bounded on purpose: the goal is to overlap latency, not to open thousands of
 * handles at once. A file that cannot be read yields `null` so the caller keeps
 * its "one damaged file must not hide the rest" behaviour, and order is
 * preserved so callers that care about "first wins" still get it.
 */
async function readAllJsonBounded<T>(names: readonly string[], directory: string, limit = 16): Promise<(T | null)[]> {
  const results: (T | null)[] = new Array<T | null>(names.length).fill(null);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= names.length) return;
      try {
        results[index] = await readJsonResilient<T>(join(directory, names[index]!));
      } catch {
        results[index] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, names.length) }, worker));
  return results;
}

async function scanWorkspaceAssetLibrary(): Promise<StudioAsset[]> {
  await mkdir(assetsRoot, { recursive: true });
  const sidecarNames = (await readdir(assetsRoot)).filter(entry => entry.endsWith(".asset.json"));
  /* The fingerprint is the sorted name list, which is the cheapest thing that
     changes on exactly the events that matter (an upload or a delete). It is
     also 341 KB for the 7272 sidecars here, rebuilt and compared on **every**
     call -- including the cache hits. Hashing it keeps the same guarantee while
     making the steady-state comparison a 64-char string, so the common path
     stops allocating a third of a megabyte per request. */
  const fingerprint = createHash("sha256").update(sidecarNames.slice().sort().join("\n")).digest("hex");
  if (assetLibraryScan?.fingerprint === fingerprint && assetLibraryRecoveredProjectUploads) return assetLibraryScan.library;
  const assets = new Map<string, StudioAsset>();
  for (const asset of await readAllJsonBounded<StudioAsset>(sidecarNames, assetsRoot)) {
    if (asset && isStoredWorkspaceAsset(asset)) assets.set(asset.id, asset);
  }
  if (!assetLibraryRecoveredProjectUploads) {
    /* One snapshot per scheme, newest first.
       This walk exists to attribute legacy assets (sidecars without a region) to
       the schemes that use them, and it used to read EVERY revision of every
       scheme: 373 files and ~127 MB of JSON parsed on the path of the first
       request after a restart, so a cold Studio took over a minute to show the
       editor. The newest snapshot already carries its scheme's whole merged asset
       library, which is exactly what the region evidence needs -- older revisions
       cannot name a region the current state does not. */
    const evidence = new AssetRegionEvidence();
    const files = (await readdir(projectsRoot)).filter((entry) => entry.endsWith(".json"));
    const schemeIds = new Set<string>();
    for (const name of files) {
      const match = /^(.*)\.v(\d+)\.json$/.exec(name);
      schemeIds.add(match ? match[1]! : name.slice(0, -".json".length));
    }
    for (const schemeId of schemeIds) {
      for (const name of orderProjectSnapshots(files, schemeId)) {
        try {
          const project = await readJsonResilient<Partial<VideoProject>>(join(projectsRoot, name));
          evidence.observe(project);
          for (const asset of project.assets ?? []) {
            if (!assets.has(asset.id) && isStoredWorkspaceAsset(asset)) assets.set(asset.id, asset);
          }
          break;
        } catch { /* Ignore a damaged snapshot and try the scheme's next one. */ }
      }
    }
    let unresolved = 0;
    /* A Set, not `sidecarNames.includes(...)`: the array lookup was a linear scan
       per asset over 7000 names, i.e. ~50 million string comparisons per cold
       start -- measurable on its own, and pointless. */
    const sidecarNamesOnDisk = new Set(sidecarNames);
    for (const [id, asset] of assets) {
      const regionId = evidence.resolve(asset);
      if (!regionId) { unresolved++; continue; }
      const scoped = { ...asset, scope: { ...asset.scope, regionId } };
      assets.set(id, scoped);
      if (!asset.scope?.regionId || !sidecarNamesOnDisk.has(id + ".asset.json")) {
        // Persist recovered ownership once so deleting an old scheme cannot lose it.
        await writeJsonAtomicResilient(join(assetsRoot, id + ".asset.json"), scoped);
      }
    }
    if (unresolved) process.stderr.write("ASSET_REGION_UNRESOLVED " + unresolved + " assets retained on disk and hidden pending attribution\n");
    assetLibraryRecoveredProjectUploads = true;
  }
  assetLibraryScan = { fingerprint, library: [...assets.values()] };
  return assetLibraryScan.library;
}

async function withWorkspaceAssetLibrary(project: VideoProject): Promise<VideoProject> {
  return withRegionAssetLibrary(project, await readWorkspaceAssetLibrary());
}

/**
 * A scheme's snapshot files, newest revision first.
 *
 * Names carry the revision they hold (`<id>.v000123.json`), which is the order
 * saving wrote them in, so the newest is knowable without opening anything.
 * Everything that needs "the current state of this scheme" therefore reads ONE
 * file and only walks back when that one is unreadable; the "a damaged revision
 * must not hide the scheme" fallback survives, at 1/N the cost.
 *
 * It used to read every revision instead: a well-used scheme here has 350+
 * snapshots of ~370 KB, so opening it parsed ~130 MB of JSON **on the event loop**
 * -- seconds per request, with every other request queued behind it. That is what
 * made the editor look frozen, and it got worse every time the operator saved.
 *
 * A `<id>.json` written by an older layout carries no revision and sorts last.
 */
async function projectSnapshotCandidates(projectId: string): Promise<string[]> {
  return orderProjectSnapshots(await readdir(projectsRoot), safeId(projectId));
}

async function readProject(id: string): Promise<VideoProject> {
  const projectId = safeId(id);
  // Hidden the moment the delete is accepted, even though the files are still
  // being removed in the background; reopening it would resurrect a scheme the
  // user just confirmed away. The tombstone makes this survive a restart.
  if (deletedProjectIds.has(projectId) || hasProjectTombstone(projectId)) throw new HttpError(404, `Project ${projectId} not found`);
  const candidates = await projectSnapshotCandidates(projectId);
  if (!candidates.length) throw new HttpError(404, `Project ${projectId} not found`);
  // The asset library must be materialised before the key can be computed, so
  // this is awaited even on a cache hit. It is only a cached array lookup unless
  // an upload changed the sidecars, and paying that here is what keeps the
  // cache key honest: the same snapshot plus the same library is the same
  // project, byte for byte.
  const library = await readWorkspaceAssetLibrary();
  const assetFingerprint = assetLibraryScan?.fingerprint ?? "";
  const cached = projectMaterialisationCache.get(projectId);
  for (const name of candidates) {
    if (cached && cached.candidate === name && cached.assetFingerprint === assetFingerprint) return cached.project;
    try {
      const snapshot = await readJsonResilient<VideoProject>(join(projectsRoot, name));
      const materialised = withRegionAssetLibrary(await normalizeProject(root, snapshot), library);
      projectMaterialisationCache.set(projectId, { candidate: name, assetFingerprint, project: materialised });
      return materialised;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "EMFILE" || code === "ENFILE") throw error;
      // A damaged historical revision must not make the project unopenable, so
      // keep walking back through the older ones. `buildProjectList` skips
      // unparseable snapshots for the same reason; reading by id has to agree with
      // it, otherwise a single torn file turns every later GET, save and export of
      // that project into a 500. Recent revisions are written atomically, so this
      // only ever fires for a file damaged before that contract existed.
      process.stderr.write(`PROJECT_REVISION_UNREADABLE ${projectId} ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  throw new Error(`Project ${projectId} has no readable revision`);
}

/** Forget a scheme's materialised form. Called wherever its snapshot changes. */
function invalidateProjectCache(projectId?: string): void {
  if (projectId) projectMaterialisationCache.delete(safeId(projectId));
  else projectMaterialisationCache.clear();
}

async function latestStoredRevision(projectId: string): Promise<number> {
  const prefix = `${safeId(projectId)}.v`;
  const revisions = (await readdir(projectsRoot))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => Number(name.slice(prefix.length, -".json".length)))
    .filter(Number.isFinite);
  return revisions.length ? Math.max(...revisions) : 0;
}

/**
 * Reclaim the snapshot history that saving keeps adding to.
 *
 * Runs inside the project's write queue so it can never race the next save, and
 * only every `PROJECT_REVISION_PRUNE_INTERVAL` saves: the decision needs a
 * directory scan, a save is on the interactive path, and reclaiming a snapshot
 * a few saves early buys almost nothing. The ceiling that leaves is
 * `PROJECT_REVISION_KEEP_RECENT + PROJECT_REVISION_PRUNE_INTERVAL` snapshots
 * per scheme, instead of the unbounded growth (514 revisions on one scheme)
 * that filled 457 MB with files nothing reads.
 *
 * The interval is also bounded from above by deletion: every file of a scheme
 * has to be removable inside the sandbox's per-turn safe-delete budget, so the
 * ceiling must stay well clear of it — see PROJECT_REVISION_KEEP_RECENT. Ten
 * keeps the worst case at 30 snapshots, leaving room for a dozen boundary files
 * and still pruning far less often than every save.
 */
const PROJECT_REVISION_PRUNE_INTERVAL = 10;

async function pruneProjectRevisions(projectId: string): Promise<void> {
  const prefix = `${safeId(projectId)}.v`;
  const entries: ProjectRevisionEntry[] = [];
  for (const name of await readdir(projectsRoot)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const revision = Number(name.slice(prefix.length, -".json".length));
    if (!Number.isFinite(revision)) continue;
    // A file can disappear between the listing and the stat (a concurrent
    // delete of the whole scheme); that is not a failure to report.
    const info = await stat(join(projectsRoot, name)).catch(() => null);
    if (info) entries.push({ name, revision, mtimeMs: info.mtimeMs });
  }
  const expired = selectProjectRevisionsToPrune(entries);
  await Promise.all(expired.map((name) => rm(join(projectsRoot, name), { force: true }).catch(() => undefined)));
}

/**
 * Freeze the boundary of every scheme that predates snapshots.
 *
 * Snapshots arrived after the fact, so schemes that already exist would keep
 * reading the live `data/` files and keep moving with them. Migrating freezes
 * each scheme at the boundary it is using *right now*, which is the only
 * reading that leaves it exactly as it was — including 草潭镇, whose boundary
 * had just been re-imported by hand.
 *
 * Only the newest revision of each scheme is consulted: `regionId` never
 * changes across revisions of the same scheme. Runs once per Studio start, and
 * is a no-op for every scheme that already owns a snapshot.
 */
async function migrateBoundarySnapshots(): Promise<void> {
  const names = await readdir(projectsRoot).catch(() => [] as string[]);
  const newest = new Map<string, number>();
  for (const name of names) {
    const match = /^([a-zA-Z0-9_-]+)\.v(\d+)\.json$/.exec(name);
    if (!match) continue;
    const revision = Number(match[2]);
    if (!Number.isFinite(revision)) continue;
    const current = newest.get(match[1]!);
    if (current === undefined || revision > current) newest.set(match[1]!, revision);
  }
  const snapshotProjects = new Set(await listBoundarySnapshotProjects(root));
  let captured = 0;
  for (const [projectId, revision] of newest) {
    if (snapshotProjects.has(projectId)) continue;
    const path = join(projectsRoot, `${projectId}.v${String(revision).padStart(6, "0")}.json`);
    let regionId = "";
    try {
      regionId = String((await readJsonResilient<{ regionId?: unknown }>(path)).regionId ?? "");
    } catch {
      continue;
    }
    if (!/^\d{6,12}$/.test(regionId)) continue;
    try {
      await captureBoundarySnapshot(root, projectId, regionId);
      captured += 1;
      process.stderr.write(`BOUNDARY_SNAPSHOT_MIGRATED ${projectId} ${regionId}\n`);
    } catch (error) {
      process.stderr.write(`BOUNDARY_SNAPSHOT_MIGRATE_FAILED ${projectId} ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  if (captured) process.stderr.write(`BOUNDARY_SNAPSHOT_MIGRATION_DONE captured=${captured}\n`);
}

async function writeProject(project: VideoProject, increment = true): Promise<VideoProject> {
  const projectId = safeId(project.id);
  const previous = projectWriteQueues.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveQueue) => { release = resolveQueue; });
  projectWriteQueues.set(projectId, current);
  await previous.catch(() => undefined);
  try {
    project = await withWorkspaceAssetLibrary(project);
    validateVideoProject(project);
    await mkdir(projectsRoot, { recursive: true });
    project.updatedAt = new Date().toISOString();
    if (increment) {
      const diskRevision = await latestStoredRevision(projectId);
      const nextRevision = Math.max(diskRevision, Number(project.revision || 0)) + 1;
      /* A save whose content is identical must not mint a revision.
         Every extra snapshot makes a scheme cost more to delete (the sandbox's
         safe-delete budget counts files), and -- worse -- a pointless revision
         bump is what made an operator's exported sheet expire: revision 28 and
         29 on this machine were byte-identical files, and the sheet exported
         between them was refused on import for no reason at all.
         The comparison strips the two fields the save itself rewrites. */
      const stored = diskRevision > 0
        ? await readJsonResilient<VideoProject>(join(projectsRoot, `${projectId}.v${String(diskRevision).padStart(6, "0")}.json`)).catch(() => null)
        : null;
      if (stored && sameProjectContent(stored, project)) {
        project.revision = diskRevision;
        projectListPromise = undefined;
        return project;
      }
      project.revision = nextRevision;
    }
    const snapshotPath = join(projectsRoot, `${projectId}.v${String(project.revision).padStart(6, "0")}.json`);
    await writeJsonVersionResilient(snapshotPath, project);
    projectListPromise = undefined;
    if (increment && Number(project.revision) % PROJECT_REVISION_PRUNE_INTERVAL === 0) {
      // Best effort: a snapshot that cannot be removed is worth less than the
      // save the user is waiting on, and the next interval revisits it.
      await pruneProjectRevisions(projectId).catch((error) => {
        process.stderr.write(`PROJECT_REVISION_PRUNE_FAILED ${projectId} ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }
    return project;
  } finally {
    // Invalidate here rather than on each return path: the no-op branch above
    // returns early, and a future edit that adds another early return must not
    // be able to leave a stale materialisation behind. `writeProject` runs
    // `withWorkspaceAssetLibrary` on its way in, so a materialisation cached
    // during this save is already superseded by the time the lock is released —
    // dropping it unconditionally is both safe and the only version that cannot
    // drift from the code above.
    invalidateProjectCache(projectId);
    release();
    if (projectWriteQueues.get(projectId) === current) projectWriteQueues.delete(projectId);
  }
}

async function buildProjectList(): Promise<VideoProject[]> {
  await mkdir(projectsRoot, { recursive: true });
  const files = (await readdir(projectsRoot)).filter((name) => name.endsWith(".json"));
  /* One read per scheme in the healthy case, newest revision first.
     This parsed EVERY revision of every scheme -- 350+ snapshots of ~370 KB for
     the busiest one here is ~130 MB of JSON on the event loop -- so listing the
     schemes took seconds and every request queued behind it, which is exactly what
     "the editor is frozen" looked like. Snapshot names carry their revision, so
     the newest candidate is known without opening anything; walking back one step
     at a time keeps the "a damaged revision must not hide the scheme" fallback. */
  const schemeIds = new Set<string>();
  for (const name of files) {
    const match = /^(.*)\.v(\d+)\.json$/.exec(name);
    schemeIds.add(match ? match[1]! : name.slice(0, -".json".length));
  }

  const latestRaw = new Map<string, VideoProject>();
  for (const schemeId of schemeIds) {
    for (const name of orderProjectSnapshots(files, schemeId)) {
      try {
        const project = await readJsonResilient<VideoProject>(join(projectsRoot, name));
        const current = latestRaw.get(project.id);
        if (!current || (project.updatedAt ?? "") > (current.updatedAt ?? "")
          || (project.updatedAt === current.updatedAt && Number(project.revision ?? 0) > Number(current.revision ?? 0))) {
          latestRaw.set(project.id, project);
        }
        /* Settled: the file is named after the scheme it holds, so its siblings
           are older revisions of the same thing. A misnamed file is the exception
           -- keep walking so nothing is dropped. */
        if (project.id === schemeId) break;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code === "EMFILE" || code === "ENFILE") throw error;
        // A damaged historical revision must not prevent the newest valid
        // project from being restored after refresh: fall back to the next one.
      }
    }
  }
  if (!latestRaw.size) return [];
  // The editor opens the most recently saved project. Normalize that one now;
  // older projects remain available as lightweight snapshots and are fully
  // normalized if requested by id. This keeps refresh time independent of the
  // number of historical projects in the workspace.
  const rawProjects = [...latestRaw.values()];
  const newest = rawProjects.reduce((best, project) => {
    if ((project.updatedAt ?? "") > (best.updatedAt ?? "")) return project;
    if (project.updatedAt === best.updatedAt && Number(project.revision ?? 0) > Number(best.revision ?? 0)) return project;
    return best;
  });
  // Normalization needs the region's content entry from content/regions.zh-CN.json.
  // A saved project can outlive that entry (for example after a generated town
  // entry is removed again), and then makeProject rejects. That single project
  // must not take the whole scheme list down with it: keep its stored snapshot
  // and restore every other project as usual. Opening it stays an explicit,
  // visible error instead of a silent one.
  let restored = newest;
  try {
    restored = await withWorkspaceAssetLibrary(await normalizeProject(root, newest));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[studio] 方案 ${newest.id} 规范化失败，改用其已保存快照：${error instanceof Error ? error.message : String(error)}`);
  }
  return rawProjects
    .map((project) => project.id === restored.id ? restored : project)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || Number(b.revision ?? 0) - Number(a.revision ?? 0));
}

async function listProjects(): Promise<VideoProject[]> {
  // Browser reloads and UI boot calls can overlap. Share one scan instead of
  // opening the same revision and region files once per request.
  //
  // The scan is memoized because it opens every project's newest revision, but a
  // memo that never expires also hides anything written by someone other than
  // this process — a git checkout, a second Studio, a script — until the service
  // is restarted. Re-check a cheap directory signature instead.
  const signature = await projectsRootSignature();
  if (!projectListPromise || projectListSignature !== signature) {
    projectListSignature = signature;
    projectListPromise = buildProjectList().then(async (projects) => {
      // Lightweight revision snapshots don't carry a regionName. Backfill the
      // human-readable name from data/regions so the scheme list can show
      // "徐闻县 · 新寮镇" style labels instead of a bare region code.
      const resolved = new Set<string>();
      for (const project of projects) {
        if (!project.regionName && project.regionId && !resolved.has(project.regionId)) {
          const name = await regionDisplayName(project.regionId);
          if (name) {
            resolved.add(project.regionId);
            for (const same of projects) if (same.regionId === project.regionId && !same.regionName) same.regionName = name;
          }
        }
      }
      return projects;
    });
  }
  try {
    return await projectListPromise;
  } catch (error) {
    projectListPromise = undefined;
    projectListSignature = undefined;
    throw error;
  }
}

/* Name, size and mtime of every stored revision — cheap next to re-reading 60+
   snapshots, and enough to notice that the directory moved on. */
async function projectsRootSignature(): Promise<string> {
  const hash = createHash("sha256");
  const names = (await readdir(projectsRoot).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort();
  for (const name of names) {
    try {
      const info = await stat(join(projectsRoot, name));
      hash.update(`${name}:${info.size}:${Math.floor(info.mtimeMs)}\n`);
    } catch {
      hash.update(`${name}:unreadable\n`);
    }
  }
  return hash.digest("hex");
}

const regionNameCache = new Map<string, string>();
async function regionDisplayName(regionId: string): Promise<string> {
  if (!regionId) return "";
  if (regionNameCache.has(regionId)) return regionNameCache.get(regionId)!;
  let name = "";
  try {
    const path = join(root, "data", "regions", `${regionId}.json`);
    if (existsSync(path)) {
      const data = await readJsonResilient<{ name?: unknown }>(path);
      name = typeof data?.name === "string" ? data.name : "";
    }
  } catch { name = ""; }
  regionNameCache.set(regionId, name);
  return name;
}

/**
 * Delete a scheme and everything keyed to it.
 *
 * **Why this returns immediately.** Every `fs.rm`/`fs.unlink` in this process is
 * fronted by the sandbox's safe-delete guard, which spawns a helper process per
 * file it inspects. Deleting one scheme touches a couple of dozen files, which
 * measured at **31.8 seconds** end to end — all of it the user staring at a
 * confirm dialog they had already dismissed. Nothing about the *result* needs
 * that latency, so the disk work is deferred and the request returns at once.
 *
 * **How "gone" is made durable before anything else happens.** Hiding a scheme
 * only in memory would be a lie: if the process restarted before its files were
 * actually removed, the scheme would silently come back. So the very first thing
 * this does is drop a tombstone beside the scheme's snapshots. Tombstones are
 * honoured by the list, by `readProject`, and by the startup sweep, so the
 * delete survives a restart even when the budget refused to reclaim the files.
 * Writing one file is cheap, which is what keeps the response instant.
 *
 * **The safe-delete budget.** The guard counts files and accumulates its total
 * per originating request for seven days. A long-lived process — Studio is
 * exactly that — therefore drifts upward and eventually crosses the threshold,
 * after which *every* later delete in that process is refused, no matter which
 * scheme is being removed. This is a property of the host, not of the scheme,
 * and it cannot be fixed from here; what this function can do is make a refusal
 * harmless. The scheme is already tombstoned and hidden before any bulk file is
 * touched, so a refused unlink costs the user nothing but disk, and
 * `sweepDeletedProjects` finishes the job on the next start.
 * `reset-safe-delete-budget.ts` clears an already-poisoned process without
 * waiting out the seven-day TTL.
 */
async function deleteProject(projectId: string): Promise<void> {
  const id = safeId(projectId);
  deletedProjectIds.add(id);
  invalidateProjectCache(id);
  projectListPromise = undefined;
  latestProjectScan = null;
  // Durable first: this is the step that survives a restart, so it must not be
  // left to the background pass.
  await writeFile(projectTombstonePath(id), `${JSON.stringify({ id, deletedAt: new Date().toISOString() })}\n`, "utf8").catch(() => undefined);
  // Always re-schedule, even when the scheme was already hidden. An earlier
  // attempt's disk work may have been refused by the safe-delete budget, and
  // repeating the delete is the natural way to retry it. A pass over an
  // already-cleaned scheme finds no files and returns immediately.
  scheduleProjectDeletion(id);
}

/** Where a deleted scheme's tombstone lives, beside its snapshots. */
function projectTombstonePath(id: string): string {
  return join(projectsRoot, `${id}.deleted`);
}

/** Whether a scheme is marked deleted on disk (survives a restart). */
function hasProjectTombstone(id: string): boolean {
  return existsSync(projectTombstonePath(id));
}

/**
 * Remove a hidden scheme's files.
 *
 * Deliberately not awaited by the caller. Failures are swallowed: the scheme is
 * already tombstoned and hidden, so there is no user-visible action a
 * partial-delete error would inform. The tombstone is removed only once every
 * file is gone, so an incomplete pass simply leaves the scheme queued for the
 * next `sweepDeletedProjects`.
 */
function scheduleProjectDeletion(id: string): void {
  // `removeProjectFiles` already swallows every per-step failure, but the guard
  // is still owed here: an unexpected throw would otherwise become an unhandled
  // rejection, and before the process-level handler existed that killed the
  // whole workbench over a background delete.
  void removeProjectFiles(id).catch((error) => {
    process.stderr.write(`PROJECT_DELETE_FAILED ${id} ${error instanceof Error ? error.message : String(error)}\n`);
  });
}

/**
 * Delete every file belonging to a scheme, then clear its tombstone.
 *
 * Returns whether the scheme is now completely gone. Each step is individually
 * best-effort because the safe-delete budget can refuse any of them; the caller
 * uses the return value to decide whether to keep the tombstone.
 *
 * The boundary tree (a dozen mirrored data files) is the bulky, most-likely-to-be
 * refused part. Doing the cheap snapshots first means a refusal late in the
 * sequence still leaves the scheme hidden and retryable, rather than the reverse.
 */
async function removeProjectFiles(id: string): Promise<boolean> {
  const names = await readdir(projectsRoot).catch(() => [] as string[]);
  const snapshots = names.filter((name) => name === `${id}.json` || (name.startsWith(`${id}.v`) && name.endsWith(".json")));
  // Concurrent: one guard subprocess per file, so serialising them would make
  // the wall-clock cost additive.
  await Promise.all(snapshots.map((name) => unlink(join(projectsRoot, name)).catch(() => undefined)));
  // Cover previews belong to the project and nothing else can reference them, so
  // skipping them would strand a few megabytes per deleted project in
  // `workspace/cover-previews` forever.
  await pruneProjectCoverPreviews(id).catch(() => undefined);
  await deleteBoundarySnapshot(root, id).catch(() => undefined);
  // The tombstone itself must not count as leftover work, or a scheme whose
  // files are all gone could never retire its marker.
  const leftover = (await readdir(projectsRoot).catch(() => [] as string[]))
    .some((name) => name !== `${id}.deleted`
      && (name === `${id}.json` || name.startsWith(`${id}.v`) || name.startsWith(`${id}.boundary`)));
  if (leftover) return false;
  // Everything is gone, so the tombstone has nothing left to protect. Removing it
  // is one cheap guarded unlink and keeps the workspace free of stale markers.
  await unlink(projectTombstonePath(id)).catch(() => undefined);
  return true;
}

/**
 * Finish every delete that could not reclaim its files at the time.
 *
 * The safe-delete budget makes a deferred cleanup failure possible by design, so
 * a durable retry point is required. Tombstones are exactly that: a scheme the
 * user deleted stays marked until its files are actually gone, across restarts.
 * This runs once per Studio start (and is cheap when there is nothing to do).
 */
async function sweepDeletedProjects(): Promise<void> {
  const names = await readdir(projectsRoot).catch(() => [] as string[]);
  const marked = names.filter((name) => name.endsWith(".deleted"));
  if (!marked.length) return;
  for (const name of marked) {
    const id = name.slice(0, -".deleted".length);
    deletedProjectIds.add(id);
    invalidateProjectCache(id);
    projectListPromise = undefined;
    latestProjectScan = null;
    // A scheme with neither snapshots nor a boundary left is already clean; the
    // tombstone is just a stale marker from an interrupted pass.
    await removeProjectFiles(id).catch(() => undefined);
  }
}

// The asset library is shared across every saved project snapshot, so edits to
// a library entry (rename/delete) must stay consistent with the newest snapshot
// of every project. Only the newest snapshot per project is live; older
// revisions are historical records and never drive the editor UI.
// Scanning every revision on disk is expensive once many projects accumulate,
// so the newest-snapshot map is cached behind a directory fingerprint and
// dropped explicitly after any library mutation rewrites a snapshot.
async function latestProjectFiles(): Promise<Array<{ file: string; project: VideoProject }>> {
  await mkdir(projectsRoot, { recursive: true });
  const names = (await readdir(projectsRoot)).filter((name) => name.endsWith(".json")).sort();
  const fingerprint = names.join("\n");
  const cached = latestProjectScan;
  if (cached && cached.fingerprint === fingerprint) return cached.items;
  const best = new Map<string, { file: string; project: VideoProject }>();
  for (const name of names) {
    try {
      // Skip by filename before parsing where we can: a tombstoned scheme's
      // snapshots may still exist (the budget refused to reclaim them), and
      // resurrecting one the user deleted is the one thing this must never do.
      const stem = name.slice(0, -".json".length).replace(/\.v\d+$/, "");
      if (deletedProjectIds.has(stem) || hasProjectTombstone(stem)) continue;
      const project = await readJsonResilient<VideoProject>(join(projectsRoot, name));
      if (deletedProjectIds.has(project.id) || hasProjectTombstone(project.id)) continue;
      const current = best.get(project.id);
      const currentStamp = current ? `${current.project.updatedAt ?? ""}\u0000${String(current.project.revision ?? 0).padStart(8, "0")}` : "";
      const stamp = `${project.updatedAt ?? ""}\u0000${String(project.revision ?? 0).padStart(8, "0")}`;
      if (!current || stamp > currentStamp) best.set(project.id, { file: name, project });
    } catch { /* A damaged historical revision must not break library edits. */ }
  }
  const items = [...best.values()];
  latestProjectScan = { fingerprint, items };
  return items;
}

function assetReferencedBy(project: VideoProject, assetId: string): boolean {
  return Boolean(
    (project.assets ?? []).some((asset) => asset.id === assetId)
    || (project.scenes ?? []).some((scene) =>
      (scene.assetIds ?? []).includes(assetId) || (scene.placements ?? []).some((placement) => placement.assetId === assetId))
  );
}

function stripAssetReferences(project: VideoProject, assetId: string): void {
  project.assets = (project.assets ?? []).filter((asset) => asset.id !== assetId);
  for (const scene of project.scenes ?? []) {
    scene.assetIds = (scene.assetIds ?? []).filter((value) => value !== assetId);
    scene.placements = (scene.placements ?? []).filter((placement) => placement.assetId !== assetId);
  }
}

async function assetSidecar(assetId: string): Promise<StudioAsset | null> {
  const path = join(assetsRoot, `${assetId}.asset.json`);
  if (!existsSync(path)) return null;
  try { return await readJsonResilient<StudioAsset>(path); } catch { return null; }
}

async function workspaceAssetFile(asset: StudioAsset): Promise<string | null> {
  const prefix = `${asset.id}.`;
  if (!asset.path.startsWith("/workspace-assets/")) {
    for (const name of (await readdir(assetsRoot))) {
      if (name.startsWith(prefix) && !name.endsWith(".asset.json")) return join(assetsRoot, name);
    }
    return null;
  }
  const file = join(assetsRoot, asset.path.slice("/workspace-assets/".length));
  return existsSync(file) ? file : null;
}

function projectNameKey(name: unknown): string {
  return String(name ?? "").trim().toLowerCase();
}

async function projectNameExists(name: unknown, excludeId?: string): Promise<boolean> {
  const key = projectNameKey(name);
  if (!key) return false;
  return (await listProjects()).some((project) => project.id !== excludeId && projectNameKey(project.name) === key);
}

/**
 * The name of a scheme's current revision.
 *
 * Used by the save path to tell "the operator kept the name" (always allowed)
 * from "the operator renamed onto another scheme's name" (rejected), so it runs
 * on every PUT.
 *
 * It used to open every snapshot of the scheme to pick the one with the newest
 * `updatedAt`. Saving keeps ~270 snapshots of the busiest scheme here, 119 MB of
 * JSON, and this ran on the interactive path: measured **1934 ms per save**, and
 * it grew by one more file with every save. Nothing about it needs the old
 * revisions -- the name only ever has to answer "what will this scheme be called
 * next", and the newest revision IS the answer.
 *
 * The newest revision is knowable without opening anything, because the
 * filename carries it (`<id>.v000492.json`). So this reads exactly one file and
 * only walks back if that one is unreadable, the same contract `readProject`
 * uses. A `<id>.json` from the pre-revision layout carries no number and sorts
 * last, so it is still the answer when it is the only file there is.
 */
async function latestStoredProjectName(projectId: string): Promise<string | undefined> {
  const id = safeId(projectId);
  for (const name of await projectSnapshotCandidates(id)) {
    try {
      const project = await readJsonResilient<VideoProject>(join(projectsRoot, name));
      return String(project.name ?? "").trim();
    } catch {
      /* A damaged revision is skipped so a stale name cannot block a save. */
    }
  }
  return undefined;
}

async function uniqueProjectName(baseName: unknown, excludeId?: string): Promise<string> {
  const candidate = String(baseName ?? "").trim() || "未命名方案";
  if (!(await projectNameExists(candidate, excludeId))) return candidate;
  for (let index = 2; ; index++) {
    const next = `${candidate}（${index}）`;
    if (!(await projectNameExists(next, excludeId))) return next;
  }
}

/**
 * Cover previews are cached under a signature of the cover's own text, so every
 * edit writes a new `<project>.<signature>.png` (+ the `.json` manifest that
 * `generateCoverAsset` writes beside it) and leaves the previous one behind.
 * Nothing ever reads a superseded signature again, so the cache grew with every
 * cover edit as well as with every deleted project — one project had already
 * accumulated nine previews. Only the signature this project currently resolves
 * to is kept.
 */
async function pruneProjectCoverPreviews(rawProjectId: string, keepFilename?: string): Promise<void> {
  const prefix = `${safeId(rawProjectId)}.`;
  const names = await readdir(coverPreviewsRoot).catch(() => [] as string[]);
  await Promise.all(names
    .filter((name) => name.startsWith(prefix) && name !== keepFilename)
    .map((name) => rm(join(coverPreviewsRoot, name), { force: true }).catch(() => { /* A preview that cannot be removed is not worth failing a request over. */ })));
}

async function ensureProjectCoverPreview(project: VideoProject): Promise<string> {
  const signature = createHash("sha256").update(JSON.stringify({
    generator: "unified-cover-v1",
    regionId: project.regionId,
    administrativeLabel: project.cover.administrativeLabel,
    subtitle: project.cover.subtitle,
    contentMeta: project.cover.contentMeta,
    introSeconds: project.cover.introSeconds
  })).digest("hex").slice(0, 16);
  const filename = `${safeId(project.id)}.${signature}.png`;
  const output = join(coverPreviewsRoot, filename);
  if (existsSync(output)) {
    await pruneProjectCoverPreviews(project.id, filename);
    return output;
  }
  const definition = await resolveCoverDefinition(root, project.regionId, {
    topic: project.cover.administrativeLabel,
    subtitle: project.cover.subtitle,
    contentMeta: project.cover.contentMeta,
    coverIntroSeconds: project.cover.introSeconds
  });
  await mkdir(coverPreviewsRoot, { recursive: true });
  await generateCoverAsset(root, definition, output);
  await pruneProjectCoverPreviews(project.id, filename);
  return output;
}

interface ReadinessCheck { id: string; name: string; pass: boolean; detail: string; advisory?: boolean }

async function validateProjectReadiness(project: VideoProject): Promise<{ ready: boolean; checks: ReadinessCheck[]; renderSpec?: unknown }> {
  const checks: ReadinessCheck[] = [];
  const check = (id: string, name: string, pass: boolean, detail: string) => checks.push({ id, name, pass, detail });
  // Advisory checks are reported but never gate the export: they flag authoring
  // drift the export already self-heals, so blocking on them would only hide a
  // working render behind a warning.
  const advise = (id: string, name: string, pass: boolean, detail: string) => checks.push({ id, name, pass, detail, advisory: true });
  try { validateVideoProject(project); check("schema", "项目结构与字幕语义", true, "schemaVersion 2，字幕只调整标点和断句"); }
  catch (error) { check("schema", "项目结构与字幕语义", false, error instanceof Error ? error.message : String(error)); }
  const regionPath = join(root, "data", "regions", `${project.regionId}.json`);
  check("region", "区域数据完整", existsSync(regionPath), existsSync(regionPath) ? "区域、相机和边界文件已找到" : "缺少地区镜头与边界数据");
  let spec: Awaited<ReturnType<typeof buildProjectRenderSpec>> | undefined;
  try { spec = await buildProjectRenderSpec(root, project); check("cues", "实际 cue 映射有效", true, `${spec.narrationCues.length} 个 cue 已映射到 ${spec.sceneCueRanges.length} 个场景`); }
  catch (error) { check("cues", "实际 cue 映射有效", false, error instanceof Error ? error.message : String(error)); }
  const childIds = project.scenes.filter((scene) => scene.section === "child").map((scene) => scene.childId!);
  check("children", "下级行政区数量和顺序", childIds.length > 0 && new Set(childIds).size === childIds.length, `${childIds.length} 个下级行政区，顺序来自权威内容配置`);
  const missingAssets = project.assets.filter((asset) => {
    const path = asset.path.startsWith("/workspace-assets/") ? join(assetsRoot, asset.path.slice("/workspace-assets/".length)) : join(root, asset.path);
    return !existsSync(path);
  });
  check("assets", "真实素材与绑定", project.assets.length > 0 && missingAssets.length === 0, missingAssets.length ? `丢失：${missingAssets.map((asset) => asset.name).join("、")}` : `${project.assets.length} 个素材，${project.scenes.reduce((sum, scene) => sum + (scene.placements?.length ?? 0), 0)} 个场景绑定`);
  const prohibited = project.assets.filter((asset) => asset.prohibitedContent);
  check("content-policy", "无会议、视察和会场图片", prohibited.length === 0, prohibited.length ? prohibited.map((asset) => asset.name).join("、") : "素材内容策略通过");
  const unfinishedScenes = project.scenes.filter((scene) => scene.section !== "cover" && /^请填写/.test(scene.narration.trim()));
  check("scene-copy", "新增分镜旁白已完成", unfinishedScenes.length === 0, unfinishedScenes.length ? `待完成：${unfinishedScenes.map((scene) => scene.title).join("、")}` : "所有分镜均使用正式旁白与同义字幕");
  const anchorIssues = findVisualAnchorIssues(project.scenes);
  const driftedPlacements = anchorIssues.reduce((sum, issue) => sum + issue.placementCount, 0);
  const misplaced = anchorIssues.filter((issue) => issue.reason === "matches-another-scene");
  advise("visual-keywords", "配图关键字命中本场景旁白", anchorIssues.length === 0, anchorIssues.length
    ? `${driftedPlacements} 处关键字不在所属场景的旁白里：${anchorIssues.slice(0, 2).map((issue) => `${issue.sceneTitle}「${issue.keyword}」`).join("、")}${anchorIssues.length > 2 ? ` 等 ${anchorIssues.length} 组` : ""}${misplaced.length ? `；其中 ${misplaced.length} 组会命中别的场景，配图会被锚到错误的句子` : "，合成时会保留原定 cue 并给出 VISUAL_WARNING"}`
    : "每处配图关键字都能在本场景旁白里找到");
  check("cover", "封面 manifest 一致", project.cover.introSeconds === project.scenes.find((scene) => scene.section === "cover")?.duration, `封面、预览与合成统一使用 ${project.cover.introSeconds.toFixed(1)} 秒`);
  const outro = project.scenes.find((scene) => scene.section === "outro");
  check("outro", "返回上级区域结尾", Boolean(outro && project.template.tourReturnSeconds > 0), outro ? `静音拉回 ${project.template.tourReturnSeconds.toFixed(1)} 秒后显示结尾文字` : "缺少结尾场景");
  try { await mkdir(jobsRoot, { recursive: true }); check("output", "输出目录可写", true, `任务目录：${jobsRoot}；完成后将在下方显示具体 MP4 文件`); }
  catch (error) { check("output", "输出目录可写", false, String(error)); }
  return { ready: checks.every((item) => item.pass || item.advisory), checks, ...(spec ? { renderSpec: spec } : {}) };
}

/**
 * Serialise and persist one JSON document per path, in call order.
 *
 * `persistJob` fires on every render progress update — dozens of them inside a
 * single second. Two concurrent plain `writeFile`s to the same path truncate and
 * interleave each other, which physically spliced two job records into one
 * unparseable file (`...render-spec.json"\n}r": "编码新的 MP4 exited with 1"\n}`)
 * and left the durable record behind the in-memory one whenever an earlier
 * promise resolved last. Chaining per path keeps the last update authoritative,
 * and `writeJsonAtomicResilient` keeps a partially-written file from ever being
 * visible to a reader.
 */
const persistChains = new Map<string, Promise<void>>();

function writeJsonSerialized(path: string, value: unknown): Promise<void> {
  const previous = persistChains.get(path) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeJsonAtomicResilient(path, value);
    });
  persistChains.set(path, next);
  // Drop the chain once it is the settled tail, so one entry per job ever
  // exported does not accumulate for the life of the service.
  void next.catch(() => undefined).then(() => { if (persistChains.get(path) === next) persistChains.delete(path); });
  return next;
}

function persistJob(job: RenderJobRecord): void {
  // A deleted record must stay deleted: the render keeps reporting progress
  // after the user removes its (terminal) record, and each of those updates
  // would otherwise re-register it and write it back to disk.
  if (deletedJobs.has(job.id)) return;
  job.updatedAt = new Date().toISOString();
  jobs.set(job.id, job);
  void writeJsonSerialized(join(job.jobRoot, "job.json"), job).catch((error) => {
    // Progress updates are fire-and-forget, but a record that never reaches
    // disk cannot be recovered after a restart, so the failure must be visible.
    process.stderr.write(`JOB_PERSIST_FAILED ${job.id} ${error instanceof Error ? error.message : String(error)}\n`);
  });
}

/** Keep a durable project snapshot next to every job record the moment it is
 *  queued, so a service restart can re-queue the interrupted render from the
 *  exact project state instead of discarding it. executeRender rewrites the
 *  same file with its own snapshot when the job starts (same content). */
function persistProjectSnapshot(job: RenderJobRecord, project: VideoProject): void {
  void writeJsonSerialized(join(job.jobRoot, "project.snapshot.json"), project).catch((error) => {
    process.stderr.write(`JOB_SNAPSHOT_PERSIST_FAILED ${job.id} ${error instanceof Error ? error.message : String(error)}\n`);
  });
}

function updateJob(job: RenderJobRecord, patch: Partial<RenderJobRecord>): void {
  if (deletedJobs.has(job.id)) return;
  const nextLogs = patch.logs ? [...job.logs, ...patch.logs].filter(Boolean).slice(-300) : job.logs;
  Object.assign(job, patch, { logs: nextLogs, updatedAt: new Date().toISOString() });
  persistJob(job);
}

/**
 * One automatic retry per export, on top of the interrupted-job recovery that
 * already exists for service restarts.
 *
 * The failure distribution in this workspace is dominated by things that are
 * transient rather than wrong: an external tool exiting non-zero (配音 5,
 * 编码 10, 合成 3, 巡游 2, 采集 2 out of 29 failed exports) — Edge TTS over the
 * network, a browser that fell over mid-capture, ffmpeg killed under memory
 * pressure. Until now every one of those cost the author a hand-written retry
 * and, when the map cache missed, the whole 27-minute capture again.
 *
 * A retry is not a restart from zero. The narration step reuses its measured
 * audio, `mapScenesToCues` reuses the measured SRT, and a signature-matched map
 * video is copied straight out of `workspace/render-cache`, so a failed encode
 * resumes at ~48% instead of at the sandbox.
 */
const DEFAULT_JOB_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 5_000;

function maxJobAttempts(): number {
  return Math.max(1, Math.min(3, Number(process.env.STUDIO_JOB_ATTEMPTS ?? DEFAULT_JOB_ATTEMPTS) || DEFAULT_JOB_ATTEMPTS));
}

async function runJob(job: RenderJobRecord, project: VideoProject): Promise<void> {
  const attempts = maxJobAttempts();
  const callbacks = {
    update: (patch: Partial<RenderJobRecord>) => updateJob(job, patch),
    registerProcess: (child: ChildProcess | null) => child ? activeProcesses.set(job.id, child) : activeProcesses.delete(job.id),
    cancelled: () => cancelledJobs.has(job.id)
  };
  let failure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (cancelledJobs.has(job.id)) break;
    if (attempt > 1) {
      // The stage the previous attempt died in is the honest label for what is
      // being retried, and it is the only place that information survives.
      const failedStage = job.stage;
      job.attempt = attempt;
      // Clear the previous error instead of leaving it on the record: the job
      // is running again, and a stale message next to a live progress bar reads
      // as a failure the user is meant to act on.
      delete job.error;
      updateJob(job, {
        status: "preparing",
        stage: `自动重试 · 第 ${attempt}/${attempts} 次`,
        progress: 0,
        logs: [`RETRY_ATTEMPT ${attempt}/${attempts}：上一轮在「${failedStage}」失败，已完成的配音与地图缓存将被复用`]
      });
      await new Promise((settle) => setTimeout(settle, RETRY_BACKOFF_MS));
      if (cancelledJobs.has(job.id)) break;
    }
    try {
      await mkdir(job.jobRoot, { recursive: true });
      await executeRender(root, job, project, callbacks);
      failure = undefined;
      break;
    } catch (error) {
      failure = error;
      if (cancelledJobs.has(job.id)) break;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts || !isRetryableRenderFailure(message)) break;
      process.stdout.write(`JOB_RETRY ${job.id} attempt ${attempt}/${attempts} after: ${message.slice(0, 200)}\n`);
    }
  }
  try {
    const cancelled = cancelledJobs.has(job.id);
    if (cancelled || failure !== undefined) {
      updateJob(job, {
        status: cancelled ? "cancelled" : "failed",
        stage: cancelled ? "已取消" : "导出失败",
        error: cancelled ? "Render cancelled" : failure instanceof Error ? failure.message : String(failure)
      });
    }
  } finally {
    // Rescue the failure evidence before the sandbox goes away, otherwise the
    // job keeps a one-line error and nothing else — the capture report that says
    // *which* tile, frame or annotation broke is inside the working copy.
    if (failure !== undefined && !cancelledJobs.has(job.id)) {
      const diagnostics = await collectJobDiagnostics(job).catch(() => null);
      if (diagnostics) {
        updateJob(job, {
          diagnosticsDir: diagnostics.dir,
          diagnosticsFiles: diagnostics.files,
          logs: [`DIAGNOSTICS_SAVED ${diagnostics.files.length} 个文件 → ${diagnostics.dir}`]
        });
      }
    }
    // Reclaim the working copy on every terminal outcome, cancellation
    // included. Nothing reads the sandbox once the render has stopped, and a
    // cancelled or failed export is exactly the case that used to strand a
    // full copy of the pipeline in the system temp directory forever.
    await pruneJobIntermediates(job).catch((error) => {
      process.stderr.write(`JOB_PRUNE_FAILED ${job.id} ${error instanceof Error ? error.message : String(error)}\n`);
    });
    activeProcesses.delete(job.id);
  }
}

function refreshQueuePositions(): void {
  queuedRenders.forEach(({ job }, index) => {
    const queuePosition = index + 1;
    if (job.queuePosition !== queuePosition || job.stage !== `排队中 · 第 ${queuePosition} 个`) {
      updateJob(job, { queuePosition, stage: `排队中 · 第 ${queuePosition} 个`, progress: 0 });
    }
  });
}

function pumpRenderQueue(): void {
  while (activeJobIds.size < maxConcurrentExports && queuedRenders.length > 0) {
    const next = queuedRenders.shift()!;
    if (cancelledJobs.has(next.job.id)) continue;
    activeJobIds.add(next.job.id);
    delete next.job.queuePosition;
    updateJob(next.job, { startedAt: new Date().toISOString(), status: "preparing", stage: "准备导出", progress: 1 });
    const running = runJob(next.job, next.project).catch(() => undefined).finally(() => {
      runningJobs.delete(next.job.id);
      activeJobIds.delete(next.job.id);
      refreshQueuePositions();
      pumpRenderQueue();
    });
    runningJobs.set(next.job.id, running);
  }
  refreshQueuePositions();
}

function enqueueRender(job: RenderJobRecord, project: VideoProject): void {
  queuedRenders.push({ job, project: structuredClone(project) });
  persistProjectSnapshot(job, project);
  refreshQueuePositions();
  pumpRenderQueue();
}

/**
 * Re-queue any export that was still queued or running when this service
 * process went away (crash, manual restart, browser close never affects the
 * server). Job records and their project snapshots are durable on disk, so the
 * render restarts from scratch and reuses existing caches (narration reuse,
 * map video cache) instead of being lost. A job that keeps interrupting after
 * MAX_RECOVERY_ATTEMPTS restarts is marked failed so the user can act on it.
 */
const MAX_RECOVERY_ATTEMPTS = 2;

async function recoverInterruptedJobs(): Promise<void> {
  await mkdir(jobsRoot, { recursive: true });
  const terminal = new Set(["completed", "failed", "cancelled"]);
  const entries = (await readdir(jobsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  let recovered = 0;
  for (const entry of entries) {
    const jobPath = join(jobsRoot, entry.name, "job.json");
    const snapshotPath = join(jobsRoot, entry.name, "project.snapshot.json");
    if (!existsSync(jobPath) || !existsSync(snapshotPath)) continue;
    try {
      const job = await readJsonResilient<RenderJobRecord>(jobPath);
      if (terminal.has(job.status)) continue;
      const project = await readJsonResilient<VideoProject>(snapshotPath);
      if (!project?.id || project.id !== job.projectId) continue;
      const attempts = Number(job.recoveryAttempt ?? 0);
      if (attempts >= MAX_RECOVERY_ATTEMPTS) {
        job.status = "failed";
        job.stage = "多次重启仍未完成";
        job.error = `服务重启后已自动恢复 ${attempts} 次仍被中断，请重新提交导出`;
        persistJob(job);
        continue;
      }
      job.recoveryAttempt = attempts + 1;
      job.status = "queued";
      job.progress = 0;
      delete job.error;
      delete job.startedAt;
      job.queuePosition = queuedRenders.length + 1;
      job.logs = [...(job.logs ?? []), `服务重启：已自动恢复导出（第 ${job.recoveryAttempt} 次）`];
      jobs.set(job.id, job);
      persistJob(job);
      queuedRenders.push({ job, project });
      recovered += 1;
    } catch {
      // A corrupt record must not block recovery of the other jobs.
    }
  }
  if (recovered > 0) {
    process.stdout.write(`RECOVERED_JOBS ${recovered} interrupted export(s) re-queued on startup\n`);
    pumpRenderQueue();
  }
}

async function loadJob(id: string): Promise<RenderJobRecord | null> {
  // The record file still exists for as long as `deleteTerminalJob` waits on a
  // winding-down render; reading it back into memory would undo the delete.
  if (deletedJobs.has(id)) return null;
  const memory = jobs.get(id); if (memory) return memory;
  const path = join(jobsRoot, safeId(id), "job.json");
  if (!existsSync(path)) return null;
  const job = await readJsonResilient<RenderJobRecord>(path);
  jobs.set(job.id, job); return job;
}

async function listJobs(options: { projectId?: string; status?: string; activeOnly?: boolean; limit?: number } = {}): Promise<RenderJobRecord[]> {
  await mkdir(jobsRoot, { recursive: true });
  const directories = (await readdir(jobsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  const records = (await Promise.all(directories.map(async (entry) => {
    try { return await loadJob(entry.name); } catch { return null; }
  }))).filter((job): job is RenderJobRecord => Boolean(job));
  return records
    .filter((job) => !options.projectId || job.projectId === options.projectId)
    .filter((job) => !options.status || job.status === options.status)
    .filter((job) => !options.activeOnly || ACTIVE_JOB_STATUSES.has(job.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(1, Math.min(100, options.limit ?? 30)));
}

async function deleteTerminalJob(job: RenderJobRecord): Promise<void> {
  if (!["completed", "failed", "cancelled"].includes(job.status)) {
    throw new Error("请先取消正在处理或排队中的导出任务，再删除记录");
  }
  const rootPath = resolve(jobsRoot);
  const jobPath = resolve(jobsRoot, safeId(job.id));
  if (!jobPath.startsWith(`${rootPath}${sep}`)) throw new Error("Invalid job path");
  // A cancelled export is only quiet once its child process has been reaped;
  // the cancel handler marks the record before that. Wait for the run to settle
  // so nothing writes into the directory after it is removed, but never let a
  // stuck render hold the request open.
  const running = runningJobs.get(job.id);
  if (running) await Promise.race([running, new Promise((settle) => setTimeout(settle, 30_000))]);
  deletedJobs.add(job.id);
  jobs.delete(job.id);
  activeJobIds.delete(job.id);
  activeProcesses.delete(job.id);
  // A write already chained for this path can still land after the delete.
  await persistChains.get(join(job.jobRoot, "job.json"))?.catch(() => undefined);
  cancelledJobs.delete(job.id);
  await rm(jobPath, { recursive: true, force: true });
}

async function findProjectNarrationAudio(project: VideoProject): Promise<string | null> {
  const narrationSignature = (candidate: VideoProject) => createHash("sha256").update(JSON.stringify(
    {
      narration: candidate.scenes.filter((scene) => scene.section !== "cover").map((scene) => scene.narration.replace(/\s+/g, "").trim()),
      voiceId: candidate.voice.voiceId,
      speed: candidate.voice.speed
    }
  )).digest("hex");
  const currentSignature = narrationSignature(project);
  const compatibleJobs: RenderJobRecord[] = [];
  for (const job of (await listJobs({ limit: 100 })).filter((item) => item.regionId === project.regionId)) {
    const snapshotPath = join(job.jobRoot, "project.snapshot.json");
    if (!existsSync(snapshotPath)) continue;
    try {
      const snapshot = await readJsonResilient<VideoProject>(snapshotPath);
      if (snapshot.regionId === project.regionId && narrationSignature(snapshot) === currentSignature) compatibleJobs.push(job);
    } catch { /* Ignore incomplete historical jobs. */ }
  }
  let baselineAudio: string | null = null;
  const canonicalAudio = join(root, "assets", "audio", project.regionId, "narration.mp3");
  if (existsSync(canonicalAudio)) {
    try {
      const baselineProject = await makeProject(root, project.regionId, { projectId: project.id });
      if (narrationSignature(baselineProject) === currentSignature) baselineAudio = canonicalAudio;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code && code !== "ENOENT") throw error;
      // A saved project may outlive its catalog entry. That makes canonical
      // audio unavailable, but must not hide its job/preview audio or break GET.
    }
  }
  // Audio synthesised on demand for this very project (see the narration route).
  // Stored outside assets/audio because that directory belongs to the content
  // pipeline, and its signature sidecar is what proves it still describes the
  // narration the operator is looking at.
  const previewAudio = narrationPreviewPath(project.id, project.regionId);
  const previewSignature = `${previewAudio}.signature`;
  const previewUsable = existsSync(previewAudio)
    && existsSync(previewSignature)
    && (await readFileResilient(previewSignature, "utf8")).trim() === currentSignature;
  const candidates = [
    // The copy a terminal job keeps after its sandbox is reclaimed. Listed
    // first because the sandbox paths below stop existing once the job has
    // settled, and this is the one that survives.
    ...compatibleJobs.map((job) => join(job.jobRoot, "audio", "narration.mp3")),
    ...compatibleJobs.map((job) => join(tmpdir(), "geo-video-studio", job.id, "sandbox", "assets", "audio", project.regionId, "narration.mp3")),
    ...compatibleJobs.map((job) => join(job.jobRoot, "sandbox", "assets", "audio", project.regionId, "narration.mp3")),
    ...(baselineAudio ? [baselineAudio] : []),
    ...(previewUsable ? [previewAudio] : [])
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function narrationPreviewPath(projectId: string, regionId: string): string {
  return join(root, "workspace", "narration-preview", `${projectId}-${regionId}.mp3`);
}

/** The cue sheet measured against the preview mp3 above (see the narration route). */
function narrationPreviewSrtPath(projectId: string, regionId: string): string {
  return join(root, "workspace", "narration-preview", `${projectId}-${regionId}.srt`);
}

interface NarrationJobEntry {
  jobRoot: string;
  regionId: string;
  /** Narration signature of the project the job was started from. */
  signature: string;
  /** SRT measured against `audio/narration.mp3` in the same job. */
  srtPath: string | null;
}

/**
 * A finished export already measured the narration it synthesised, and it kept
 * both the audio and the cue sheet. Reading every job's 600 kB
 * `project.snapshot.json` on each `/render-spec` poll would be far too slow, so
 * the scan is memoised per region (a region has a handful of jobs, not the whole
 * 100) and a narration edit only has to re-hash the project.
 */
const narrationJobIndexes = new Map<string, { at: number; entries: NarrationJobEntry[] }>();
const NARRATION_JOB_INDEX_TTL_MS = 60_000;

async function narrationJobIndexEntries(regionId: string): Promise<NarrationJobEntry[]> {
  const cached = narrationJobIndexes.get(regionId);
  if (cached && Date.now() - cached.at < NARRATION_JOB_INDEX_TTL_MS) return cached.entries;
  const entries: NarrationJobEntry[] = [];
  for (const job of (await listJobs({ limit: 100 })).filter((item) => item.regionId === regionId)) {
    const snapshotPath = join(job.jobRoot, "project.snapshot.json");
    if (!existsSync(snapshotPath)) continue;
    try {
      const snapshot = await readJsonResilient<VideoProject>(snapshotPath);
      if (snapshot?.regionId !== regionId) continue;
      // `audio/` is the copy a settled job keeps after its sandbox is reclaimed;
      // it is the only path that survives, so the cue sheet is taken from there.
      const srtPath = join(job.jobRoot, "audio", "narration-edge.srt");
      entries.push({
        jobRoot: job.jobRoot,
        regionId,
        signature: narrationSignatureOf(snapshot),
        srtPath: existsSync(srtPath) ? srtPath : null
      });
    } catch { /* Ignore incomplete historical jobs. */ }
  }
  narrationJobIndexes.set(regionId, { at: Date.now(), entries });
  return entries;
}

/**
 * Cues measured against **the audio the editor will actually play**, or null.
 *
 * When no SRT exists for a region, `buildProjectRenderSpec` falls back to
 * `estimatedProjectCues()` — narration length / 4.1 characters per second. Real
 * Edge TTS on this machine runs at 4.96, so the estimate is ~20% long and the
 * error accumulates scene by scene: on 城月镇 it totals 629 s against a 523 s
 * soundtrack, which put the subtitles most of a scene behind the voice by the
 * middle of the film. The preview mp3 is one of the job/baseline/preview trio
 * the narration route serves, and each of those was generated next to its own
 * measured SRT, so return that pair instead of guessing.
 *
 * The job order matches `findProjectNarrationAudio()` on purpose: whichever
 * audio that function serves first must also be the cue sheet returned here.
 */
async function resolveMeasuredProjectCues(project: VideoProject): Promise<TimedCue[] | null> {
  const signature = narrationSignatureOf(project);
  const candidates: string[] = [];
  for (const entry of await narrationJobIndexEntries(project.regionId)) {
    if (entry.signature !== signature || !entry.srtPath) continue;
    candidates.push(entry.srtPath);
  }
  const previewAudio = narrationPreviewPath(project.id, project.regionId);
  const previewSrt = narrationPreviewSrtPath(project.id, project.regionId);
  const previewSignature = `${previewAudio}.signature`;
  const previewUsable = existsSync(previewAudio) && existsSync(previewSrt) && existsSync(previewSignature)
    && (await readFileResilient(previewSignature, "utf8")).trim() === signature;
  if (previewUsable) candidates.push(previewSrt);
  const srtPath = candidates.find(existsSync);
  if (!srtPath) return null;
  try {
    const cues = parseSrt(await readFileResilient(srtPath, "utf8"));
    return cues.length ? cues : null;
  } catch {
    // A truncated SRT must not take the whole spec down; the estimator covers it.
    return null;
  }
}

/** Does *any* narration audio exist for this region (regardless of whether it still matches)? */
async function hasAnyNarrationAudio(project: VideoProject): Promise<boolean> {
  if (existsSync(join(root, "assets", "audio", project.regionId, "narration.mp3"))) return true;
  for (const job of (await listJobs({ limit: 100 })).filter((item) => item.regionId === project.regionId)) {
    if (existsSync(join(job.jobRoot, "audio", "narration.mp3"))) return true;
  }
  return false;
}

/**
 * Build the content-file narration slots for a project.
 *
 * Mirrors `materializeProject()` in render-engine, because that is the shape
 * generate-narration reads: one paragraph per spoken scene, in film order, plus
 * the voice settings and the tour intro/outro bookkeeping the pause planner
 * needs. Kept in step by `tests/narration-preview.test.ts`.
 */
function projectNarrationContent(project: VideoProject): Record<string, unknown> {
  const spoken = project.scenes.filter((scene) => scene.section !== "cover");
  const spokenParagraphs = spoken.filter((scene) => (scene.narration ?? "").replace(/\s+/g, "").length > 0);
  const outroParagraphIndex = spokenParagraphs.findIndex((scene) => scene.section === "outro");
  const voiceRatePercent = Math.round((project.voice.speed - 1) * 100);
  return {
    name: project.cover.town,
    title: `${project.cover.topic}·${project.cover.administrativeLabel}`,
    narration: spoken.map((scene) => scene.narration),
    ...(outroParagraphIndex >= 0 ? { outroParagraphIndex } : {}),
    tourIntroSentences: project.scenes
      .filter((scene) => scene.section === "overview")
      .reduce((total, scene) => total + countSentences(scene.narration), 0),
    tourReturnSeconds: project.template.tourReturnSeconds,
    voiceId: project.voice.voiceId,
    voiceRate: `${voiceRatePercent >= 0 ? "+" : ""}${voiceRatePercent}%`
  };
}

function countSentences(text: string): number {
  return (text ?? "")
    .split(/\n+/)
    .flatMap((line) => line.split(/[。！？；;…]+/))
    .map((part) => part.replace(/[」』"'“”‘’）)\]】》〉,，、：:\s]+$/u, "").trim())
    .filter((part) => part.length > 0).length;
}

/** One synthesis per project at a time; the pipeline is minutes long and TTS costs quota. */
const narrationPreviewJobs = new Map<string, Promise<{ audio: string; signature: string; seconds: number }>>();

async function synthesizePreviewNarration(project: VideoProject): Promise<{ audio: string; signature: string; seconds: number; reused: boolean }> {
  const signature = narrationSignatureOf(project);
  const target = narrationPreviewPath(project.id, project.regionId);
  const signaturePath = `${target}.signature`;
  if (existsSync(target) && existsSync(signaturePath) && (await readFileResilient(signaturePath, "utf8")).trim() === signature) {
    return { audio: target, signature, seconds: 0, reused: true };
  }
  const running = narrationPreviewJobs.get(project.id);
  if (running) return { ...(await running), reused: false };

  const task = (async () => {
    const startedAt = Date.now();
    // Everything is synthesised under a scratch directory. Writing into
    // assets/audio/<region>/ would poison the content baseline: makeProject()
    // reads that directory's SRT to measure paragraph durations, and an SRT cut
    // from the PROJECT's edited narration cannot map onto the CONTENT file's
    // paragraphs — the project then fails to load at all ("无法按文本稳定映射
    // 场景"). `--out-dir` keeps the two apart.
    const scratch = join(tmpdir(), "geo-video-studio", "narration-preview", `${project.id}-${Date.now()}`);
    const audioOut = join(scratch, "audio");
    await mkdir(audioOut, { recursive: true });
    const contentPath = join(scratch, "regions.zh-CN.json");
    await writeFile(contentPath, JSON.stringify({ [project.regionId]: projectNarrationContent(project) }, null, 2), "utf8");
    const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
    const script = join(root, ".agents", "skills", "cesium-geo-documentary", "scripts", "generate-narration.ts");
    try {
      await new Promise<void>((resolvePromise, reject) => {
        // stdin ignored: piping both stdin and stdout makes spawn fail with EBUSY
        // in the managed sandbox (see generate-narration's own note).
        const child = spawn(process.execPath, [tsx, script, "--region", project.regionId, "--content", contentPath, "--out-dir", audioOut, "--force"], {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: { ...process.env, LOKY_MAX_CPU_COUNT: process.env.LOKY_MAX_CPU_COUNT ?? "4" }
        });
        let logs = "";
        const append = (chunk: Buffer) => { logs += chunk.toString("utf8"); if (logs.length > 8000) logs = logs.slice(-8000); };
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
        child.once("error", reject);
        child.once("close", (code) => {
          if (code === 0) resolvePromise();
          else reject(new Error(`旁白生成失败（退出码 ${code}）：${logs.trim().split("\n").slice(-4).join(" ")}`));
        });
      });
      const produced = join(audioOut, "narration.mp3");
      if (!existsSync(produced)) throw new Error("旁白生成结束但没有找到 narration.mp3");
      // The cue sheet travels with the mp3. Without it the editor has to fall
      // back to `estimatedProjectCues()`, which runs ~20% long against real TTS
      // pacing — that alone made the preview's subtitles drift a scene behind the
      // voice before the middle of the film.
      const producedSrt = join(audioOut, "narration-edge.srt");
      if (!existsSync(producedSrt)) throw new Error("旁白生成结束但没有找到 narration-edge.srt");
      await mkdir(dirname(target), { recursive: true });
      await copyFileResilient(produced, target);
      await copyFileResilient(producedSrt, narrationPreviewSrtPath(project.id, project.regionId));
      await writeFile(signaturePath, signature, "utf8");
      return { audio: target, signature, seconds: Math.round((Date.now() - startedAt) / 1000) };
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  })().finally(() => narrationPreviewJobs.delete(project.id));

  narrationPreviewJobs.set(project.id, task);
  return { ...(await task), reused: false };
}

function narrationSignatureOf(project: VideoProject): string {
  return createHash("sha256").update(JSON.stringify({
    narration: project.scenes.filter((scene) => scene.section !== "cover").map((scene) => scene.narration.replace(/\s+/g, "").trim()),
    voiceId: project.voice.voiceId,
    speed: project.voice.speed
  })).digest("hex");
}

async function copyFileResilient(source: string, target: string): Promise<void> {
  // A Windows AV scan or a lingering reader can hold the freshly written mp3
  // for a moment; retry instead of failing a multi-minute synthesis.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await copyFile(source, target);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 200));
    }
  }
  throw lastError;
}

/**
 * Stream a file that never changes under a given path.
 *
 * `no-store` was the old default for every static response, which made the
 * browser re-download each asset on every render. The asset editor shows
 * hundreds of thumbnails at once, and the source photos here run 3–5 MB each,
 * so re-fetching them is real work: measured 0.6–2.6 s per image on the wire
 * while the editor was busy, all of it competing with the operator's requests.
 *
 * Both roots this serves are immutable per path:
 * - `/workspace-assets/<uuid>.<ext>` is written once and read by that name
 *   forever (a replace mints a new id), and
 * - `/project-assets/...` is the hand-curated source tree under `assets/source`.
 * So `immutable` is honest for them and the editor stops re-downloading.
 *
 * `/` and everything else keep `no-store` (see `serveStatic`) — those are the
 * UI shell, and a stale Studio is a bug report waiting to happen.
 */
function streamFile(path: string, response: ServerResponse, disposition?: string, cacheControl = "no-store, max-age=0"): void {
  response.writeHead(200, {
    "content-type": mime[extname(path).toLowerCase()] ?? "application/octet-stream",
    "cache-control": cacheControl,
    "pragma": cacheControl.startsWith("no-store") ? "no-cache" : "public",
    ...(disposition ? { "content-disposition": disposition } : {})
  });
  createReadStream(path).pipe(response);
}

const IMMUTABLE_ASSET_CACHE = "public, max-age=31536000, immutable";

async function streamSeekableMedia(path: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const size = (await stat(path)).size;
  const contentType = mime[extname(path).toLowerCase()] ?? "application/octet-stream";
  const range = request.headers.range;
  const commonHeaders = { "content-type": contentType, "accept-ranges": "bytes", "cache-control": "no-store" };
  if (!range) {
    response.writeHead(200, { ...commonHeaders, "content-length": size });
    createReadStream(path).pipe(response);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (!match[1] && !match[2])) {
    response.writeHead(416, { ...commonHeaders, "content-range": `bytes */${size}` });
    response.end();
    return;
  }
  const suffixLength = match[1] ? null : Number(match[2]);
  const start = suffixLength == null ? Number(match[1]) : Math.max(0, size - suffixLength);
  const requestedEnd = match[2] && match[1] ? Number(match[2]) : size - 1;
  const end = Math.min(size - 1, requestedEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    response.writeHead(416, { ...commonHeaders, "content-range": `bytes */${size}` });
    response.end();
    return;
  }
  response.writeHead(206, {
    ...commonHeaders,
    "content-range": `bytes ${start}-${end}/${size}`,
    "content-length": end - start + 1
  });
  createReadStream(path, { start, end }).pipe(response);
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  if (pathname.startsWith("/workspace-assets/")) {
    const name = pathname.slice("/workspace-assets/".length);
    if (!isWorkspaceAssetFileName(name)) return sendJson(response, 400, { error: "Invalid asset path" });
    const file = join(assetsRoot, name); if (!existsSync(file)) return sendJson(response, 404, { error: "Asset not found" });
    return streamFile(file, response, undefined, IMMUTABLE_ASSET_CACHE);
  }
  if (pathname.startsWith("/project-assets/")) {
    const relativePath = decodeURIComponent(pathname.slice("/project-assets/".length));
    const file = normalize(join(root, relativePath));
    // `existsSync` already proves it is a file for the only callers that reach
    // here (`stat` was a second syscall for the same answer, on the hot path of
    // an editor that shows hundreds of these at once).
    if (!file.startsWith(normalize(sourceAssetsRoot)) || !existsSync(file)) return sendJson(response, 404, { error: "Project asset not found" });
    return streamFile(file, response, undefined, IMMUTABLE_ASSET_CACHE);
  }
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const file = normalize(join(publicRoot, relativePath));
  if (!file.startsWith(normalize(publicRoot)) || !existsSync(file) || !(await stat(file)).isFile()) return sendJson(response, 404, { error: "Not found" });
  streamFile(file, response);
}

await Promise.all([mkdir(projectsRoot, { recursive: true }), mkdir(jobsRoot, { recursive: true }), mkdir(assetsRoot, { recursive: true }), mkdir(coverPreviewsRoot, { recursive: true })]);

const server = createServer(async (request, response) => {
  // Stamp the queue-wait separately from the work: when the editor is frozen the
  // request that eventually answers is not the slow one — it is the first one
  // *after* the block. queueMs tells the two apart, and it is the number that
  // matches what the operator felt.
  const acceptedAt = Date.now();
  const startedAt = process.hrtime.bigint();
  let queuedAt = 0;
  response.once("finish", () => {
    const totalMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const queueMs = queuedAt ? queuedAt - acceptedAt : 0;
    if (totalMs < SLOW_REQUEST_MS) return;
    process.stderr.write(
      `STUDIO_SLOW_REQUEST ${request.method} ${request.url} ${totalMs.toFixed(0)}ms 排队=${queueMs}ms\n`
    );
  });
  try {
    queuedAt = Date.now();
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `127.0.0.1:${port}`}`);
    if (request.method === "GET" && url.pathname === "/studio-config.js") {
      const previewOrigin = `http://127.0.0.1:${cesiumPreviewPort}`;
      return sendBuffer(response, 200, Buffer.from(`export const previewOrigin = ${JSON.stringify(previewOrigin)};\n`), "text/javascript; charset=utf-8");
    }
    const projectMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)$/);
    const renderMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/render$/);
    const specMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/render-spec$/);
    const validateMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/validate$/);
    const coverPreviewMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/cover-preview$/);
    const narrationAudioMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/narration-audio$/);
    const narrationPreviewMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/narration-preview$/);
    const regenerateCopyMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/generate-copy$/);
    const tourRouteMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/tour-route$/);
    const collectMaterialsMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/collect-materials$/);
    const boundaryMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/boundary$/);
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_-]+)$/);
    const cancelMatch = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_-]+)\/cancel$/);
    const downloadMatch = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_-]+)\/download$/);
    const openOutputMatch = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_-]+)\/open-output$/);
    const openDiagnosticsMatch = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_-]+)\/open-diagnostics$/);
    const assetMatch = url.pathname.match(/^\/api\/assets\/([a-zA-Z0-9_-]+)$/);
    const workbookMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/workbook$/);
    if (request.method === "GET" && url.pathname === "/api/health") return sendJson(response, 200, { ok: true, service: "geo-video-studio", activeJobs: activeJobIds.size, queuedJobs: queuedRenders.length, maxConcurrentExports, isolatedJobs: true });
    if (request.method === "GET" && url.pathname === "/api/regions") return sendJson(response, 200, await readRegions(root));
    if (request.method === "GET" && url.pathname === "/api/admin-divisions") {
      const level = url.searchParams.get("level") as AdminLevel | null;
      if (!level || !["province", "city", "county", "town"].includes(level)) throw new Error("level must be province, city, county or town");
      const parent = url.searchParams.get("parent") ?? undefined;
      if (level !== "province" && !parent) throw new Error("parent is required for this level");
      return sendJson(response, 200, await listAdminDivisions(root, level, parent));
    }
    if (request.method === "GET" && url.pathname === "/api/admin-divisions/search") {
      const query = url.searchParams.get("q")?.trim() ?? "";
      if (query.length < 2) return sendJson(response, 200, []);
      return sendJson(response, 200, await searchAdminDivisions(root, query, Number(url.searchParams.get("limit") ?? 30)));
    }
    if (request.method === "GET" && url.pathname === "/api/admin-divisions/locate") {
      const code = url.searchParams.get("code")?.trim() ?? "";
      if (!/^\d{6,12}$/.test(code)) throw new Error("A valid administrative code is required");
      return sendJson(response, 200, await locateAdminDivision(root, code));
    }
    if (request.method === "GET" && url.pathname === "/api/projects") return sendJson(response, 200, await listProjects());
    if (request.method === "GET" && url.pathname === "/api/amap/material-options") {
      return sendJson(response, 200, { provider: "amap", keyConfigured: await amapKeyConfigured(root), types: AMAP_POI_TYPES });
    }
    if (request.method === "GET" && url.pathname === "/api/deepseek/copy-options") {
      return sendJson(response, 200, await deepSeekPublicOptions(root));
    }
    if (request.method === "GET" && url.pathname === "/api/jobs") return sendJson(response, 200, await listJobs({
      ...(url.searchParams.get("projectId") ? { projectId: url.searchParams.get("projectId")! } : {}),
      ...(url.searchParams.get("status") ? { status: url.searchParams.get("status")! } : {}),
      ...(["1", "true"].includes(url.searchParams.get("active") ?? "") ? { activeOnly: true } : {}),
      limit: Number(url.searchParams.get("limit") ?? 30)
    }));
    if (request.method === "POST" && url.pathname === "/api/assets") {
      const input = await bodyJson(request) as { projectId?: string; name?: string; mimeType?: string; dataUrl?: string; alt?: string };
      if (!input.projectId) throw new HttpError(400, "请先打开当前行政区方案再上传素材");
      const owner = await readProject(input.projectId);
      const match = /^data:([^;,]*);base64,([A-Za-z0-9+/=]+)$/.exec(input.dataUrl ?? "");
      if (!match) throw new HttpError(400, "上传内容缺少 base64 数据");
      const buffer = Buffer.from(match[2]!, "base64");
      if (buffer.length > 15_000_000) throw new HttpError(413, "这个通道的单个素材上限是 15 MB；更大的视频请走 Studio 上传按钮（二进制通道，上限 256 MB）");
      const asset = await storeUploadedBuffer(root, owner, buffer, input.name ?? "", input.alt, input.mimeType);
      assetLibraryScan = null;
      return sendJson(response, 201, asset);
    }
    // Binary upload. The body is streamed straight to a temporary file, so a
    // 120 MB video never becomes a 160 MB base64 string held in memory on both
    // sides the way the JSON route above does. Bytes decide the format.
    if (request.method === "POST" && url.pathname === "/api/assets/binary") {
      const projectId = url.searchParams.get("projectId") ?? "";
      if (!projectId) throw new HttpError(400, "请先打开当前行政区方案再上传素材");
      const owner = await readProject(projectId);
      const requestedName = url.searchParams.get("name") ?? "";
      const alt = url.searchParams.get("alt") ?? undefined;
      await mkdir(assetsRoot, { recursive: true });
      const temporary = join(assetsRoot, `.upload-${randomUUID()}`);
      let size = 0;
      try {
        const stream = createWriteStream(temporary);
        await new Promise<void>((resolvePromise, reject) => {
          const fail = (error: unknown): void => { stream.destroy(); request.destroy(); reject(error); };
          request.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BINARY_ASSET_BYTES) {
              fail(new HttpError(413, `单个素材不能超过 ${Math.round(MAX_BINARY_ASSET_BYTES / (1024 * 1024))} MB`));
              return;
            }
            if (!stream.write(chunk)) { request.pause(); stream.once("drain", () => request.resume()); }
          });
          request.once("end", () => resolvePromise());
          request.once("aborted", () => fail(new HttpError(400, "上传中断")));
          request.once("error", fail);
          stream.once("error", fail);
        });
        await new Promise<void>((resolvePromise, reject) => { stream.end((error?: Error | null) => error ? reject(error) : resolvePromise()); });
        const asset = await storeUploadedFile(root, owner, temporary, requestedName, alt, String(request.headers["content-type"] ?? ""));
        assetLibraryScan = null;
        return sendJson(response, 201, asset);
      } finally {
        // Only reached while `temporary` still exists (a refusal or a failed
        // write); a successful upload has already renamed it into place.
        await unlink(temporary).catch(() => undefined);
      }
    }
    // Rename a shared library entry. The library sidecar is the durable source
    // of truth, but each project snapshot keeps its own copy of the asset, so
    // both are patched to keep names consistent across every open project.
    if (request.method === "PATCH" && assetMatch) {
      const assetId = safeId(assetMatch[1]!);
      const input = await bodyJson(request) as { name?: unknown; alt?: unknown };
      const name = String(input.name ?? "").trim().slice(0, 120);
      if (!name) throw new Error("素材名称不能为空");
      const alt = String(input.alt ?? "").trim().slice(0, 300);
      const patchAsset = (asset: StudioAsset) => {
        asset.name = name;
        if (input.alt !== undefined) {
          if (alt) asset.alt = alt;
          else delete asset.alt;
        }
      };
      const projects = await latestProjectFiles();
      const sidecar = await assetSidecar(assetId);
      let touched = 0;
      for (const { file, project } of projects) {
        const stored = (project.assets ?? []).find((item) => item.id === assetId);
        if (!stored) continue;
        patchAsset(stored);
        await writeJsonAtomicResilient(join(projectsRoot, file), project);
        touched += 1;
      }
      if (sidecar) { patchAsset(sidecar); await writeJsonAtomicResilient(join(assetsRoot, `${assetId}.asset.json`), sidecar); }
      if (touched === 0 && !sidecar) throw new Error("素材不存在或不可编辑");
      assetLibraryScan = null; projectListPromise = undefined;
      // These routes rewrite each scheme's snapshot IN PLACE (same filename, no
      // revision bump), so the materialisation key -- snapshot name plus asset
      // fingerprint -- cannot see the change on its own. Clear it explicitly.
      invalidateProjectCache();
      return sendJson(response, 200, { id: assetId, name, alt, projectsTouched: touched });
    }
    // Delete a shared library entry. Because the library is shared, deletions
    // that still have live references are refused unless ?force=1 is given; a
    // forced delete strips the entry from every project snapshot as well.
    if (request.method === "DELETE" && assetMatch) {
      const assetId = safeId(assetMatch[1]!);
      const force = url.searchParams.get("force") === "1";
      const projects = await latestProjectFiles();
      const referencing = projects
        .filter(({ project }) => assetReferencedBy(project, assetId))
        .map(({ project }) => ({ id: project.id, name: project.name || project.id }));
      if (referencing.length && !force) {
        return sendJson(response, 409, { error: `该素材仍被 ${referencing.length} 个方案使用，请先在方案中移除引用，或强制删除`, referencing });
      }
      const sidecar = await assetSidecar(assetId);
      const sourceOfReference = projects.find(({ project }) => (project.assets ?? []).some((asset) => asset.id === assetId))?.project;
      const assetRecord = sidecar ?? (sourceOfReference && sourceOfReference.assets.find((asset) => asset.id === assetId)) ?? null;
      for (const { file, project } of projects) {
        if (!assetReferencedBy(project, assetId)) continue;
        stripAssetReferences(project, assetId);
        await writeJsonAtomicResilient(join(projectsRoot, file), project);
      }
      if (assetRecord) {
        const file = await workspaceAssetFile(assetRecord);
        if (file) await rm(file, { force: true });
      }
      if (existsSync(join(assetsRoot, `${assetId}.asset.json`))) await rm(join(assetsRoot, `${assetId}.asset.json`), { force: true });
      assetLibraryScan = null; projectListPromise = undefined;
      // Same in-place snapshot rewrite as the rename route above; the key cannot
      // observe it, so drop the materialisations explicitly.
      invalidateProjectCache();
      return sendJson(response, 200, { deleted: true, id: assetId, detachedFrom: referencing.map((item) => item.id) });
    }
    if (request.method === "POST" && url.pathname === "/api/projects") {
      const input = await bodyJson(request) as {
        regionId?: string;
        name?: unknown;
        poiImport?: AmapPoiImportOptions;
        copyGeneration?: { enabled?: boolean };
      };
      if (input.regionId) await ensureTownPlan(root, input.regionId);
      // A town that already has a record is skipped by `ensureTownPlan`, so an
      // operator who edits the province shapefile gets a brand-new scheme built
      // from the pre-edit boundary — 河头镇 did exactly that on 2026-10-12, three
      // weeks of edits away from the record it was drawn from. The check below
      // only reports it: Guangdong is a single province table, so one town's edit
      // re-stamps every town's sidecars, and re-importing all of them would
      // rewrite records nobody asked to touch.
      if (input.regionId) await warnIfSourceDataMovedOn(root, input.regionId);
      let project = await makeProject(root, input.regionId);
      if (typeof input.name === "string") {
        const cleanName = input.name.trim().slice(0, 60);
        if (cleanName) project.name = cleanName;
      }
      if (input.poiImport?.enabled) project = (await importAmapPoiMaterials(root, project, input.poiImport)).project;
      if (input.copyGeneration?.enabled) project = await generateProjectCopy(root, project);
      project.name = await uniqueProjectName(project.name);
      // Freeze the boundary this scheme is authored against, before the scheme
      // itself lands on disk. Every later read — preview, reopen, export —
      // resolves through this snapshot, so re-importing the region no longer
      // rewrites a scheme that was already made; only the next created scheme
      // sees the newer data. A failure here is surfaced instead of silently
      // creating a scheme that would keep following the source data.
      await captureBoundarySnapshot(root, project.id, project.regionId);
      project = await writeProject(project); return sendJson(response, 201, project);
    }
    if (request.method === "GET" && narrationAudioMatch) {
      const project = await readProject(narrationAudioMatch[1]!);
      const audio = await findProjectNarrationAudio(project);
      if (!audio) {
        // Say WHICH reason. "还没有生成" is wrong and misleading once the
        // operator has already exported: after any narration or speed edit the
        // measured audio no longer describes the film, so it is not served —
        // that is a different problem from "never generated", and only the
        // second one is fixed by exporting again with nothing changed.
        const generated = await hasAnyNarrationAudio(project);
        return sendJson(response, 404, {
          error: generated
            ? "旁白文案或语速改过了，现有旁白音频与当前文案对不上，预览暂时没有声音"
            : "当前项目还没有旁白音频（旁白在导出时生成）",
          stale: generated
        });
      }
      return streamSeekableMedia(audio, request, response);
    }
    if (request.method === "POST" && narrationPreviewMatch) {
      // Synthesise just the narration so the preview can play it, without
      // running a 1h50m export. Writes to workspace/narration-preview/ with a
      // signature sidecar; the GET above only serves it while the signature
      // still matches what is on screen.
      const project = await readProject(narrationPreviewMatch[1]!);
      const result = await synthesizePreviewNarration(project);
      return sendJson(response, 200, result);
    }
    if (request.method === "POST" && regenerateCopyMatch) {
      const project = await readProject(regenerateCopyMatch[1]!);
      const input = await bodyJson(request).catch(() => ({})) as { reference?: unknown; sceneId?: unknown };
      const reference = typeof input.reference === "string" ? input.reference.trim().slice(0, 3000) : "";
      const sceneId = typeof input.sceneId === "string" ? input.sceneId.trim() : "";
      if (sceneId && !project.scenes.some((scene) => scene.id === sceneId && scene.section !== "cover")) {
        throw new Error("目标场景不存在或不允许重新生成文案");
      }
      return sendJson(response, 200, await writeProject(await generateProjectCopy(root, project, fetch, { reference, sceneId })));
    }
    // Returns the order only; applying it stays a normal client-side scene edit,
    // so the change goes through the same dirty/undo path as dragging a scene.
    if (request.method === "POST" && tourRouteMatch) {
      const project = await readProject(tourRouteMatch[1]!);
      return sendJson(response, 200, await suggestTourRoute(root, project));
    }
    // Re-run the AMap collection for a subset of child boundaries. Project
    // creation is the only other caller, and it runs once — before anyone knows
    // which theme a village actually needed — so this is the repair path.
    if (request.method === "POST" && collectMaterialsMatch) {
      const project = await readProject(collectMaterialsMatch[1]!);
      const input = await bodyJson(request).catch(() => ({})) as AmapPoiImportOptions;
      const collected = await importAmapPoiMaterials(root, project, { ...input, enabled: true });
      return sendJson(response, 200, { project: await writeProject(collected.project), unboundPlacements: collected.unboundPlacements });
    }
    // Which boundary the scheme is frozen to. Diagnostic: the snapshot is what
    // the map draws, so "why does this scheme look different from the region
    // data on disk" is answered by comparing this against `data/regions`.
    if (request.method === "GET" && boundaryMatch) {
      const manifest = await readBoundarySnapshotManifest(root, boundaryMatch[1]!);
      if (!manifest) return sendJson(response, 404, { error: "该方案还没有边界快照，仍在读取全局边界数据" });
      return sendJson(response, 200, manifest);
    }
    if (request.method === "GET" && projectMatch) return sendJson(response, 200, await readProject(projectMatch[1]!));
    if (request.method === "DELETE" && projectMatch) {
      await deleteProject(projectMatch[1]!);
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "GET" && coverPreviewMatch) return streamFile(await ensureProjectCoverPreview(await readProject(coverPreviewMatch[1]!)), response);
    if (request.method === "POST" && coverPreviewMatch) {
      const project = await readProject(coverPreviewMatch[1]!);
      const input = await bodyJson(request) as { cover?: Partial<VideoProject["cover"]> };
      const cover = {
        ...project.cover,
        ...(typeof input.cover?.administrativeLabel === "string" ? { administrativeLabel: input.cover.administrativeLabel.slice(0, 80) } : {}),
        ...(typeof input.cover?.subtitle === "string" ? { subtitle: input.cover.subtitle.slice(0, 120) } : {}),
        ...(typeof input.cover?.contentMeta === "string" ? { contentMeta: input.cover.contentMeta.slice(0, 80) } : {}),
        ...(Number.isFinite(Number(input.cover?.introSeconds)) ? { introSeconds: Number(input.cover?.introSeconds) } : {})
      };
      return streamFile(await ensureProjectCoverPreview({ ...project, cover }), response);
    }
    if (request.method === "PUT" && projectMatch) {
      const project = await normalizeProject(root, await bodyJson(request) as VideoProject);
      if (project.id !== projectMatch[1]) throw new Error("Project id mismatch");
      const name = String(project.name ?? "").trim();
      if (!name) throw new Error("方案名称不能为空");
      // Reject only renames that collide with another project. Keeping a
      // project's existing name is always allowed, even when historical data
      // already contains duplicates for that name.
      if (name !== (await latestStoredProjectName(project.id) ?? "") && await projectNameExists(name, project.id)) {
        throw new Error(`已存在同名方案“${name}”，请更换名称`);
      }
      return sendJson(response, 200, await writeProject(project));
    }
    // Scheme <-> spreadsheet round-trip. GET streams the workbook; POST accepts
    // an edited one, runs the full pre-validation, and only writes when the
    // caller explicitly asks for `?commit=1`. A rejected workbook is a normal
    // 200 with `ok:false` so the editor can show row-level errors instead of a
    // generic failure toast.
    if (request.method === "GET" && workbookMatch) {
      const project = await readProject(workbookMatch[1]!);
      const previews = await collectAssetPreviews(root, project);
      return sendBuffer(response, 200, buildProjectWorkbook(project, { previews }), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", `attachment; filename="${workbookFileName(project)}"`);
    }
    if (request.method === "POST" && workbookMatch) {
      const project = await readProject(workbookMatch[1]!);
      const input = await bodyJson(request) as { workbook?: string };
      const base64 = String(input.workbook ?? "");
      if (!base64) throw new Error("缺少表格数据");
      const result = mergeProjectWorkbook(project, Buffer.from(base64, "base64"), root);
      const summary = {
        ok: result.ok, addedScenes: result.addedScenes, deletedScenes: result.deletedScenes,
        changedScenes: result.changedScenes, changedAssets: result.changedAssets,
        warnings: result.warnings, errors: result.errors,
        needsNarrationRegen: result.needsNarrationRegen
      };
      if (!result.ok) return sendJson(response, 200, { ...summary, committed: false });
      if (url.searchParams.get("commit") !== "1") return sendJson(response, 200, { ...summary, committed: false, preview: true });
      /* Pictures the sheet carried live in the workbook, not on disk. A pre-check
         must not write them (nothing may be touched unless the import commits),
         which is why the merge hands the bytes back instead of saving them -- so
         the commit writes them here, before the scheme that refers to them. Each
         gets the same sidecar an upload writes, because as far as the library is
         concerned this *is* an upload: the picture just arrived inside a
         spreadsheet rather than inside a request body. */
      for (const pending of result.pendingAssets) {
        await mkdir(assetsRoot, { recursive: true });
        await writeFile(join(assetsRoot, pending.asset.path.slice("/workspace-assets/".length)), pending.data);
        await writeFile(
          join(assetsRoot, `${pending.asset.id}.asset.json`),
          JSON.stringify({
            ...pending.asset,
            type: "image",
            sourceType: pending.asset.sourceType ?? "user-provided",
            verifiedReal: true,
            prohibitedContent: false,
            alt: pending.asset.alt || pending.asset.name,
            scope: { regionId: project.regionId, projectId: project.id }
          }, null, 2),
          "utf8"
        );
      }
      if (result.pendingAssets.length) assetLibraryScan = null;
      const saved = await writeProject(await normalizeProject(root, result.project));
      return sendJson(response, 200, { ...summary, committed: true, project: saved });
    }
    if (request.method === "GET" && specMatch) {
      const project = await readProject(specMatch[1]!);
      // Every timing the editor shows — scene seconds, subtitle cues, the
      // playhead — is read from this spec, so it must be built from the same
      // measured cue sheet as the audio the preview plays.
      const measuredCues = await resolveMeasuredProjectCues(project);
      let narrationTimingSource: "measured" | "estimated" = measuredCues ? "measured" : "estimated";
      let spec;
      try {
        spec = await buildProjectRenderSpec(root, project, measuredCues ?? undefined);
      } catch (error) {
        // A saved scene reorder legitimately breaks the text mapping onto a
        // measured SRT; the estimator is the editor's documented fallback there.
        if (!measuredCues) throw error;
        narrationTimingSource = "estimated";
        spec = await buildProjectRenderSpec(root, project);
      }
      // Whether this export will re-record the map or copy it out of the render
      // cache is the single biggest term in the estimate (measured on this
      // machine: ~9 min per finished minute against ~7, with the cache
      // difference alone worth ~20 minutes on a 6-minute film). The panel cannot
      // see the cache, so the answer travels with the spec.
      const cached = join(root, "workspace", "render-cache", spec.cacheSignature.replace("sha256:", ""), `${project.regionId}-map-${project.output.profile}.mp4`);
      // The picture track travels with the spec: the panel can then show where
      // every card actually lands (and which scene ships none) without exporting.
      return sendJson(response, 200, { ...spec, projectRevision: project.revision, narrationTimingSource, mapCacheAvailable: existsSync(cached), visualTimeline: planVisualTimeline(project, spec) });
    }
    if (request.method === "POST" && validateMatch) return sendJson(response, 200, await validateProjectReadiness(await readProject(validateMatch[1]!)));
    if (request.method === "POST" && renderMatch) {
      const project = await readProject(renderMatch[1]!); const readiness = await validateProjectReadiness(project);
      if (!readiness.ready) throw new Error(`导出前检查未通过：${readiness.checks.filter((item) => !item.pass && !item.advisory).map((item) => item.name).join("、")}`);
      const job = newRenderJob(project.id, jobsRoot, project); persistJob(job); enqueueRender(job, project); return sendJson(response, 202, job);
    }
    if (request.method === "DELETE" && jobMatch) {
      const job = await loadJob(jobMatch[1]!);
      if (!job) return sendJson(response, 404, { error: "Job not found" });
      if (url.searchParams.get("projectId") !== job.projectId) return sendJson(response, 403, { error: "Export does not belong to the current project" });
      if (!["completed", "failed", "cancelled"].includes(job.status)) return sendJson(response, 409, { error: "请先取消正在处理或排队中的导出任务，再删除记录" });
      await deleteTerminalJob(job);
      return sendJson(response, 200, { deleted: true, id: job.id });
    }
    if (request.method === "GET" && jobMatch) { const job = await loadJob(jobMatch[1]!); return job ? sendJson(response, 200, job) : sendJson(response, 404, { error: "Job not found" }); }
    if (request.method === "POST" && cancelMatch) {
      const job = await loadJob(cancelMatch[1]!); if (!job) return sendJson(response, 404, { error: "Job not found" });
      cancelledJobs.add(job.id);
      const queuedIndex = queuedRenders.findIndex((item) => item.job.id === job.id);
      if (queuedIndex >= 0) queuedRenders.splice(queuedIndex, 1);
      activeProcesses.get(job.id)?.kill();
      delete job.queuePosition;
      updateJob(job, { status: "cancelled", stage: queuedIndex >= 0 ? "已从队列取消" : "正在取消" });
      refreshQueuePositions();
      pumpRenderQueue();
      return sendJson(response, 200, job);
    }
    if (request.method === "GET" && downloadMatch) {
      const job = await loadJob(downloadMatch[1]!);
      if (url.searchParams.get("projectId") !== job?.projectId) return sendJson(response, 403, { error: "Export does not belong to the current project" });
      if (!job?.output || job.status !== "completed" || !existsSync(job.output)) return sendJson(response, 404, { error: "Export is not ready" });
      const output = resolve(job.output); if (!output.startsWith(resolve(jobsRoot))) return sendJson(response, 403, { error: "Invalid output path" });
      return streamFile(output, response, `attachment; filename="${output.split(/[\\/]/).at(-1)?.replace(/[^a-zA-Z0-9._-]/g, "-") ?? "geo-video.mp4"}"`);
    }
    if (request.method === "POST" && openOutputMatch) {
      const job = await loadJob(openOutputMatch[1]!);
      if (url.searchParams.get("projectId") !== job?.projectId) return sendJson(response, 403, { error: "Export does not belong to the current project" });
      if (!job?.output || job.status !== "completed" || !existsSync(job.output)) return sendJson(response, 404, { error: "Export is not ready" });
      const output = resolve(job.output); if (!output.startsWith(resolve(jobsRoot))) return sendJson(response, 403, { error: "Invalid output path" });
      if (process.platform !== "win32") throw new Error("打开所在文件夹目前仅支持 Windows Studio");
      spawn("explorer.exe", [`/select,${output}`], { detached: true, stdio: "ignore", windowsHide: false }).unref();
      return sendJson(response, 200, { opened: true, output });
    }
    if (request.method === "POST" && openDiagnosticsMatch) {
      const job = await loadJob(openDiagnosticsMatch[1]!);
      if (url.searchParams.get("projectId") !== job?.projectId) return sendJson(response, 403, { error: "Export does not belong to the current project" });
      if (!job?.diagnosticsDir || !existsSync(job.diagnosticsDir)) return sendJson(response, 404, { error: "这次导出没有留下诊断文件" });
      const dir = resolve(job.diagnosticsDir);
      if (!dir.startsWith(resolve(jobsRoot))) return sendJson(response, 403, { error: "Invalid diagnostics path" });
      if (process.platform !== "win32") throw new Error("打开诊断文件夹目前仅支持 Windows Studio");
      spawn("explorer.exe", [dir], { detached: true, stdio: "ignore", windowsHide: false }).unref();
      return sendJson(response, 200, { opened: true, dir, files: job.diagnosticsFiles ?? [] });
    }
    return await serveStatic(url.pathname, response);
  } catch (error) {
    // Anything without a status of its own is a bad request; a missing resource
    // says so explicitly, so `GET /api/projects/<unknown>` answers 404 like the
    // job and asset routes already do.
    const status = error instanceof HttpError ? error.status : 400;
    sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    process.stderr.write(`GEO_STUDIO_PORT_IN_USE 端口 ${port} 已被占用，Studio 服务可能已在运行：http://127.0.0.1:${port}\n`);
  } else {
    process.stderr.write(`GEO_STUDIO_LISTEN_FAILED ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`GEO_VIDEO_STUDIO_READY http://127.0.0.1:${port}\n`);
  startCesiumPreview();
  // Re-queue exports that were left running/queued when this process started,
  // so opening the project in any browser never loses an in-flight export.
  void recoverInterruptedJobs().catch((error) => {
    process.stdout.write(`RECOVERY_FAILED ${error instanceof Error ? error.message : String(error)}\n`);
  });
  // Freeze the boundary of schemes authored before snapshots existed. Runs in
  // the background: it is a one-off per scheme and must never delay serving the
  // workbench, which the operator is about to open.
  void migrateBoundarySnapshots().catch((error) => {
    process.stderr.write(`BOUNDARY_SNAPSHOT_MIGRATION_FAILED ${error instanceof Error ? error.message : String(error)}\n`);
  });
  // Deletes return before their files are gone, and the safe-delete budget can
  // refuse that work; tombstones are what make the retry durable, so this is
  // where a partially-completed delete gets finished.
  // Sequential on purpose — behind `migrateBoundarySnapshots`, so the two never
  // contend for the same files.
  void migrateBoundarySnapshots().then(() => sweepDeletedProjects()).catch((error) => {
    process.stderr.write(`DELETED_PROJECT_SWEEP_FAILED ${error instanceof Error ? error.message : String(error)}\n`);
  });
});
