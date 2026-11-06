/**
 * Reclaim what finished (and failed) exports leave behind.
 *
 * Two accumulations grew without bound in this workspace:
 *
 * 1. Each export works inside a full copy of the pipeline — the map video
 *    (200-400 MB), the narration WAV, the composed media and every bound photo
 *    — and nothing ever removed it. Terminal jobs now give it back on their
 *    own, but the historical ones are still there: 44 of them hold a real
 *    directory (moving this workspace between drives materialised the sandbox
 *    junctions into real copies) plus the abandoned entries under
 *    `%TEMP%\geo-video-studio`.
 * 2. Every save writes a new immutable snapshot into `workspace/projects`, so
 *    one scheme had reached 514 revisions.
 *
 * Dry run by default: this prints exactly what it would remove, and only
 * `--apply` touches the disk. Nothing outside a job's own `sandbox` entry, the
 * temp working copy named after that job, and expired project snapshots is ever
 * a candidate.
 *
 *   tsx .agents/skills/cesium-geo-documentary/scripts/prune-workspace.ts
 *   tsx .agents/skills/cesium-geo-documentary/scripts/prune-workspace.ts --apply
 */
import { existsSync } from "node:fs";
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pruneJobIntermediates, type RenderJobRecord } from "../../../../apps/studio/render-engine.js";
import { readJsonResilient } from "../../../../apps/studio/fs-resilience.js";
import { selectProjectRevisionsToPrune, type ProjectRevisionEntry } from "../../../../apps/studio/project-revisions.js";

const apply = process.argv.includes("--apply");
const root = resolve(process.cwd());
const jobsRoot = join(root, "workspace", "jobs");
const projectsRoot = join(root, "workspace", "projects");
const tempRoot = join(tmpdir(), "geo-video-studio");
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** Bytes under `path`, without following links — the digits here are the space
 *  that a delete would actually return. */
async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  const pending = [path];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const info = await lstat(current).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      for (const entry of await readdir(current).catch(() => [] as string[])) pending.push(join(current, entry));
      continue;
    }
    total += info.size;
  }
  return total;
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

interface Candidate {
  label: string;
  bytes: number;
  tempPath?: string;
  realSandbox?: string;
  job?: RenderJobRecord;
}

const candidates: Candidate[] = [];
let skipped = 0;
for (const name of (await readdir(jobsRoot).catch(() => [] as string[])).sort()) {
  const jobRoot = join(jobsRoot, name);
  const jobPath = join(jobRoot, "job.json");
  if (!existsSync(jobPath)) continue;
  let job: RenderJobRecord;
  try {
    job = await readJsonResilient<RenderJobRecord>(jobPath);
  } catch {
    continue;
  }
  if (!TERMINAL.has(job.status)) { skipped += 1; continue; }
  const sandbox = join(jobRoot, "sandbox");
  const sandboxInfo = await lstat(sandbox).catch(() => null);
  const tempJobRoot = join(tempRoot, name);
  const tempBytes = existsSync(tempJobRoot) ? await directoryBytes(tempJobRoot) : 0;
  const realBytes = sandboxInfo?.isDirectory() && !sandboxInfo.isSymbolicLink() ? await directoryBytes(sandbox) : 0;
  if (tempBytes === 0 && realBytes === 0) continue;
  candidates.push({
    label: `${name.slice(0, 8)} ${job.regionId ?? ""} ${job.status}`,
    bytes: tempBytes + realBytes,
    ...(existsSync(tempJobRoot) ? { tempPath: tempJobRoot } : {}),
    ...(realBytes > 0 ? { realSandbox: sandbox } : {}),
    job
  });
}

const jobBytes = candidates.reduce((sum, item) => sum + item.bytes, 0);
process.stdout.write(`\n导出中间产物（终态任务 ${candidates.length} 个，进行中跳过 ${skipped} 个）\n`);
for (const item of candidates.sort((a, b) => b.bytes - a.bytes)) {
  process.stdout.write(`  ${mb(item.bytes).padStart(10)}  ${item.label}\n`);
  // The exact paths, not just the job id: a reclaim command is only safe to run
  // if its output names every directory it intends to remove.
  if (item.realSandbox) process.stdout.write(`              → ${item.realSandbox}\n`);
  if (item.tempPath) process.stdout.write(`              → ${item.tempPath}\n`);
}
process.stdout.write(`  ${mb(jobBytes).padStart(10)}  合计\n`);

const revisionEntries: ProjectRevisionEntry[] = [];
for (const name of (await readdir(projectsRoot).catch(() => [] as string[])).filter((entry) => entry.endsWith(".json"))) {
  const match = /^(.+)\.v(\d+)\.json$/.exec(name);
  if (!match) continue;
  const info = await stat(join(projectsRoot, name)).catch(() => null);
  if (info) revisionEntries.push({ name, revision: Number(match[2]), mtimeMs: info.mtimeMs });
}
const byProject = new Map<string, ProjectRevisionEntry[]>();
for (const entry of revisionEntries) {
  const projectId = entry.name.slice(0, entry.name.lastIndexOf(".v"));
  byProject.set(projectId, [...(byProject.get(projectId) ?? []), entry]);
}
const expired: ProjectRevisionEntry[] = [];
const expiredByProject = new Map<string, number>();
for (const [projectId, entries] of byProject) {
  const doomed = new Set(selectProjectRevisionsToPrune(entries));
  const names = entries.filter((entry) => doomed.has(entry.name));
  expired.push(...names);
  if (names.length > 0) expiredByProject.set(projectId, names.length);
}
let revisionBytes = 0;
for (const entry of expired) revisionBytes += (await stat(join(projectsRoot, entry.name)).catch(() => null))?.size ?? 0;

// 960 file names would bury the paths that matter, and the rule is
// deterministic: everything but the newest 30 revisions and one snapshot per
// day for the last 14 days.
process.stdout.write(`\n方案版本快照：共 ${revisionEntries.length} 个 / ${byProject.size} 个方案，过期 ${expired.length} 个 / ${mb(revisionBytes)}\n`);
for (const [projectId, count] of [...expiredByProject].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  process.stdout.write(`              ${projectId} 删 ${count} 个，保留 ${(byProject.get(projectId)?.length ?? 0) - count} 个（全在 ${projectsRoot}）\n`);
}
if (expiredByProject.size > 10) process.stdout.write(`              …另有 ${expiredByProject.size - 10} 个方案，各自删除数量更少\n`);

if (!apply) {
  process.stdout.write(`\n合计可回收约 ${mb(jobBytes + revisionBytes)}。这是只读预览，加 --apply 才会真正删除。\n`);
  process.exit(0);
}

let removed = 0;
for (const item of candidates) {
  if (!item.job) continue;
  await pruneJobIntermediates(item.job, { includeMaterializedSandbox: true });
  removed += 1;
}
for (const entry of expired) await rm(join(projectsRoot, entry.name), { force: true });
process.stdout.write(`\n已回收约 ${mb(jobBytes + revisionBytes)}：清理了 ${removed} 个任务的中间产物和 ${expired.length} 个过期快照。\n`);
