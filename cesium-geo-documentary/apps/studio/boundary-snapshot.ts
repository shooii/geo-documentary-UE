/**
 * Per-scheme boundary snapshots.
 *
 * `data/regions/*.json` and `data/normalized/*.geojson` are workspace-wide
 * singletons: every scheme draws from the same file, so re-importing a region
 * after the source shapefile was refreshed silently rewrote schemes that had
 * already been authored and exported. 草潭镇 proved the failure mode — 21 child
 * units kept their ids while 10 of them changed shape and 4 changed name, and
 * the finished scheme inherited all of it.
 *
 * The contract the operator asked for is the opposite one: an existing scheme
 * keeps the boundary it was authored against, and only a newly created scheme
 * picks up the newer data. That is what a snapshot gives us.
 *
 * A snapshot mirrors every data file the map reads, under
 * `workspace/projects/<projectId>.boundary/`, preserving each file's
 * workspace-relative path so a reader only has to swap the root directory. It is
 * assembled in a scratch directory and renamed into place, so the presence of
 * `snapshot.json` always means the snapshot is complete.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";

import { readJsonResilient } from "./fs-resilience.js";

export const BOUNDARY_SNAPSHOT_SUFFIX = ".boundary";
export const BOUNDARY_SNAPSHOT_MANIFEST = "snapshot.json";
export const BOUNDARY_SNAPSHOT_VERSION = 1;

export interface BoundarySnapshotManifest {
  version: number;
  projectId: string;
  /** The region the scheme tours; the chain is anchored here. */
  regionId: string;
  capturedAt: string;
  /** Content hash over every mirrored file, so drift is detectable. */
  digest: string;
  /** Region ids from the root ancestor down to `regionId`. */
  regionChain: string[];
  /** Workspace-relative paths that were mirrored, with their byte counts. */
  files: Array<{ path: string; bytes: number }>;
  /** Referenced paths that did not exist on disk when the snapshot was taken. */
  missing: string[];
}

interface RegionRecord {
  id?: string;
  parentId?: string;
  geometryPath?: string;
  childGeometryPath?: string;
}

function safeProjectId(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`Invalid project id: ${value}`);
  return value;
}

/** POSIX-style workspace-relative path, or null when the target escapes the root. */
function toWorkspaceRelative(root: string, absolutePath: string): string | null {
  const base = resolve(root);
  const target = resolve(absolutePath);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return relative(base, target).split(sep).join("/");
}

/** Resolve a workspace-relative path back to disk, refusing anything that escapes. */
export function resolveWorkspacePath(root: string, relativePath: string): string | null {
  const cleaned = normalize(relativePath).replaceAll("\\", "/").replace(/^\/+/, "");
  if (!cleaned || cleaned.startsWith("..")) return null;
  const base = resolve(root);
  const target = resolve(base, cleaned);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

export function boundarySnapshotDir(root: string, projectId: string): string {
  return join(root, "workspace", "projects", `${safeProjectId(projectId)}${BOUNDARY_SNAPSHOT_SUFFIX}`);
}

async function readManifestUnchecked(root: string, projectId: string): Promise<BoundarySnapshotManifest | null> {
  let manifest: BoundarySnapshotManifest;
  try {
    manifest = await readJsonResilient<BoundarySnapshotManifest>(join(boundarySnapshotDir(root, projectId), BOUNDARY_SNAPSHOT_MANIFEST));
  } catch {
    return null;
  }
  if (!manifest || manifest.version !== BOUNDARY_SNAPSHOT_VERSION) return null;
  if (manifest.projectId !== projectId || !manifest.regionId) return null;
  if (!Array.isArray(manifest.files)) return null;
  return manifest;
}

export async function readBoundarySnapshotManifest(root: string, projectId: string): Promise<BoundarySnapshotManifest | null> {
  return readManifestUnchecked(root, projectId);
}

export async function hasBoundarySnapshot(root: string, projectId: string): Promise<boolean> {
  return (await readManifestUnchecked(root, projectId)) !== null;
}

/**
 * The snapshot's copy of a workspace-relative file, or null when this project
 * has no snapshot or the file was never mirrored. Callers fall back to the live
 * path, so a scheme created before snapshots existed keeps working.
 */
export async function snapshotFile(root: string, projectId: string | undefined, relativePath: string): Promise<string | null> {
  if (!projectId) return null;
  const manifest = await readManifestUnchecked(root, projectId);
  if (!manifest) return null;
  const cleaned = normalize(relativePath).replaceAll("\\", "/").replace(/^\/+/, "");
  if (!manifest.files.some((entry) => entry.path === cleaned)) return null;
  const target = resolveWorkspacePath(boundarySnapshotDir(root, projectId), cleaned);
  return target && existsSync(target) ? target : null;
}

/**
 * Every data file the map reads for one region: its own record, its timeline,
 * the geometry its record points at, and the same for each ancestor. The
 * upstream chain matters because the player draws the parent outline and the
 * sibling prefecture as the opening context.
 *
 * `data/raw/<parentId>_full.geojson` is collected but never reported as missing:
 * runtime only falls back to it when the parent record has no
 * `childGeometryPath`, and it is absent for most prefectures in this workspace.
 * `missing` therefore stays a signal — a record that declares geometry the disk
 * does not have — instead of noise from the chain simply reaching its top.
 */
async function collectBoundaryFiles(root: string, regionId: string): Promise<{ files: string[]; missing: string[]; chain: string[] }> {
  const files: string[] = [];
  const missing: string[] = [];
  const chain: string[] = [];
  const visited = new Set<string>();
  const seen = new Set<string>();

  const add = (relativePath: string | undefined, absolute: string, reportMissing = true): void => {
    if (!relativePath || seen.has(relativePath)) return;
    seen.add(relativePath);
    if (existsSync(absolute)) files.push(relativePath);
    else if (reportMissing) missing.push(relativePath);
  };

  let current: string | undefined = regionId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const recordPath = join(root, "data", "regions", `${current}.json`);
    // Running out of ancestors is how the chain ends, not a missing file.
    if (!existsSync(recordPath)) break;
    const recordRelative = toWorkspaceRelative(root, recordPath);
    if (!recordRelative) break;
    add(recordRelative, recordPath);
    chain.unshift(current);

    const timelinePath = join(root, "data", "regions", `${current}.timeline.json`);
    const timelineRelative = toWorkspaceRelative(root, timelinePath);
    if (timelineRelative) add(timelineRelative, timelinePath);

    let record: RegionRecord = {};
    try {
      record = JSON.parse(await readFile(recordPath, "utf8")) as RegionRecord;
    } catch {
      // A region record that cannot be parsed is already reported by the reader
      // that needs it; the snapshot only mirrors whatever exists.
      record = {};
    }
    const referenced = [record.geometryPath, record.childGeometryPath].filter((value): value is string => Boolean(value));
    for (const reference of referenced) {
      const absolute = resolveWorkspacePath(root, reference);
      const relativePath = absolute ? toWorkspaceRelative(root, absolute) : null;
      if (absolute && relativePath) add(relativePath, absolute);
      else missing.push(reference);
    }

    const parentId = record.parentId ? String(record.parentId) : undefined;
    if (parentId) {
      // The sibling-context fallback lives next to its own parent id, not the
      // ancestor's, so it is collected per level.
      const fallback = `data/raw/${parentId}_full.geojson`;
      const fallbackAbsolute = resolveWorkspacePath(root, fallback);
      if (fallbackAbsolute) add(fallback, fallbackAbsolute, false);
    }
    current = parentId;
  }

  return { files, missing, chain };
}

/** Hash the mirrored payloads so later drift between snapshot and source is provable. */
async function digestFiles(root: string, relativePaths: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const relativePath of [...relativePaths].sort()) {
    const absolute = resolveWorkspacePath(root, relativePath);
    hash.update(relativePath);
    hash.update(absolute && existsSync(absolute) ? await readFile(absolute) : Buffer.from("(absent)"));
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Freeze the region's boundary data for one scheme.
 *
 * Called at creation time (so a new scheme starts from the newest data) and by
 * the one-off migration for schemes authored before snapshots existed (so they
 * stop moving under the operator's feet).
 */
export async function captureBoundarySnapshot(root: string, projectId: string, regionId: string): Promise<BoundarySnapshotManifest> {
  const id = safeProjectId(projectId);
  const { files, missing, chain } = await collectBoundaryFiles(root, regionId);
  if (!files.length) throw new Error(`没有可冻结的边界数据：${regionId}`);

  const target = boundarySnapshotDir(root, id);
  const scratch = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    for (const relativePath of files) {
      const absolute = resolveWorkspacePath(root, relativePath);
      if (!absolute) continue;
      const destination = join(scratch, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(absolute, destination);
    }
    const entries: Array<{ path: string; bytes: number }> = [];
    for (const relativePath of files) {
      const copied = join(scratch, relativePath);
      const info = await stat(copied).catch(() => null);
      if (info) entries.push({ path: relativePath, bytes: info.size });
    }
    const manifest: BoundarySnapshotManifest = {
      version: BOUNDARY_SNAPSHOT_VERSION,
      projectId: id,
      regionId,
      capturedAt: new Date().toISOString(),
      digest: await digestFiles(scratch, entries.map((entry) => entry.path)),
      regionChain: chain,
      files: entries,
      missing
    };
    await writeFile(join(scratch, BOUNDARY_SNAPSHOT_MANIFEST), JSON.stringify(manifest, null, 2), "utf8");
    // Swap in atomically: remove the previous snapshot first, because Windows
    // refuses to rename onto an existing directory.
    await rm(target, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    await rename(scratch, target);
    return manifest;
  } catch (error) {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function deleteBoundarySnapshot(root: string, projectId: string): Promise<void> {
  await rm(boundarySnapshotDir(root, projectId), { recursive: true, force: true });
}

/** Project ids that already own a snapshot directory. */
export async function listBoundarySnapshotProjects(root: string): Promise<string[]> {
  const directory = join(root, "workspace", "projects");
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(BOUNDARY_SNAPSHOT_SUFFIX))
    .map((entry) => entry.name.slice(0, -BOUNDARY_SNAPSHOT_SUFFIX.length));
}
