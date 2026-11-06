/**
 * Export a Studio scheme to a spreadsheet, let a human edit it, then import it
 * back — with a full pre-validation pass before anything is written.
 *
 *   pnpm workbook export --project project-muew4qat [--out tmp/xxx.xlsx]
 *   pnpm workbook import --project project-muew4qat --in tmp/xxx.xlsx [--commit]
 *
 * Export prefers the running Studio (`GET /api/projects/:id`, which serves the
 * full regional asset library); when Studio is not up it falls back to the
 * newest on-disk snapshot. Every film image is embedded in the sheet as a
 * thumbnail so the editor can see which picture a row describes. Import always pre-validates first: any error is
 * reported with its row number and nothing is written. `--commit` performs the
 * write — through the Studio's `PUT` while it is running, otherwise as a new
 * on-disk revision snapshot, exactly like a save.
 *
 * The actual merge/validation rules live in `apps/studio/project-workbook.ts`
 * so the CLI, the server route and the tests all share one implementation.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { VideoProject } from "../packages/project-schema/index.js";
import {
  buildProjectWorkbook,
  mergeProjectWorkbook,
  readLatestProjectSnapshot,
  collectAssetPreviews,
  workbookFileName,
  writeProjectSnapshot,
  type MergeResult
} from "../apps/studio/project-workbook.js";

const root = resolve(process.cwd());
const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args[0] : "help";

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}
function has(name: string): boolean {
  return args.includes(`--${name}`);
}

const projectId = flag("project")?.trim();
const studioPort = Number(process.env.STUDIO_PORT ?? 4180);
const studioBase = `http://127.0.0.1:${studioPort}`;

function requireProject(): string {
  if (!projectId) throw new Error("缺少 --project <方案id>，例如 --project project-muew4qat");
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error(`方案id 非法：${projectId}`);
  return projectId;
}

function resolvePath(value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

/** The Studio, when it is running, owns the merged asset library and revisions. */
async function fetchStudioProject(id: string): Promise<VideoProject | null> {
  try {
    const response = await fetch(`${studioBase}/api/projects/${id}`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    return await response.json() as VideoProject;
  } catch {
    return null;
  }
}

async function loadProject(id: string): Promise<{ project: VideoProject; source: "studio" | "snapshot" }> {
  const fromStudio = await fetchStudioProject(id);
  if (fromStudio) return { project: fromStudio, source: "studio" };
  return { project: await readLatestProjectSnapshot(root, id), source: "snapshot" };
}

function reportMerge(result: MergeResult): void {
  for (const issue of result.errors) {
    const where = issue.row ? `第${issue.row}行 ` : "";
    process.stderr.write(`错误 ${where}${issue.message}\n`);
  }
  for (const warning of result.warnings) process.stderr.write(`警告 ${warning}\n`);
  const changed = result.changedScenes.length;
  process.stdout.write(
    `校验结果：新增 ${result.addedScenes.length} 个场景，删除 ${result.deletedScenes.length} 个，修改 ${changed} 个；` +
    `错误 ${result.errors.length} 条，警告 ${result.warnings.length} 条。\n`
  );
}

async function runExport(): Promise<void> {
  const id = requireProject();
  const { project, source } = await loadProject(id);
  const previews = await collectAssetPreviews(root, project);
  const buffer = buildProjectWorkbook(project, { previews });
  const outValue = flag("out");
  const outPath = outValue ? resolvePath(outValue) : join(root, "tmp", workbookFileName(project));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, buffer);
  process.stdout.write(
    `已导出方案「${project.name}」：${project.scenes.length} 个场景 / ${project.assets.length} 个素材（来源：${source === "studio" ? "Studio" : "磁盘快照"}，revision ${project.revision}）。\n` +
    `已把 ${previews.size} 张成片素材缩略图（统一 240×180、等比缩放）内嵌到「成片预览N」列。\n` +
    `「场景」「素材库」两页已加内外边框；「素材库」页可增删改，导入同样生效。\n` +
    `表格：${outPath}\n`
  );
  process.stdout.write("提示：编辑后执行 `pnpm workbook import --project " + id + " --in <文件> --commit` 导回。\n");
}

async function runImport(): Promise<void> {
  const id = requireProject();
  const inValue = flag("in");
  if (!inValue) throw new Error("缺少 --in <编辑后的表格文件>");
  const inPath = resolvePath(inValue);
  if (!existsSync(inPath)) throw new Error(`找不到表格文件：${inPath}`);

  const buffer = await readFile(inPath);
  const { project, source } = await loadProject(id);
  const result = mergeProjectWorkbook(project, buffer, root);
  reportMerge(result);
  if (!result.ok) {
    process.stderr.write("预校验未通过，未写入任何内容。\n");
    process.exitCode = 1;
    return;
  }
  if (!has("commit")) {
    process.stdout.write("预校验通过（未加 --commit，仅预览，不写入）。加上 --commit 即保存。\n");
    return;
  }

  /* Pictures the sheet supplied have to reach the disk before anything refers to
     them, and a pre-check writes none of them -- which is why the merge returns
     their bytes instead of saving them itself. A running Studio writes them on
     its own commit path, so this is only for the on-disk route. */
  const saveLocally = async (): Promise<VideoProject> => {
    for (const pending of result.pendingAssets) {
      const file = join(root, "workspace", "assets", pending.asset.path.slice("/workspace-assets/".length));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, pending.data);
      process.stdout.write(`已保存表格里贴进来的图片：${pending.asset.path}\n`);
    }
    return writeProjectSnapshot(root, result.project);
  };
  const saved = source === "studio" ? await commitViaStudio(id, result.project) : await saveLocally();
  process.stdout.write(`已保存方案「${saved.name}」为新版本 revision ${saved.revision}。\n`);
  if (result.needsNarrationRegen) {
    process.stdout.write("注意：旁白有改动或新增了场景，请重新生成旁白音频，否则成片配音不会更新。\n");
  }
}

async function commitViaStudio(id: string, project: VideoProject): Promise<VideoProject> {
  const response = await fetch(`${studioBase}/api/projects/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(project),
    signal: AbortSignal.timeout(60_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Studio 拒绝了保存（HTTP ${response.status}）：${text.slice(0, 400)}`);
  return JSON.parse(text) as VideoProject;
}

function printHelp(): void {
  process.stdout.write(
    [
      "方案表格往返工具（导出 Excel → 人工编辑 → 预校验 → 导回）",
      "",
      "  pnpm workbook export --project <方案id> [--out <文件路径>]",
      "      导出方案为 .xlsx。默认写入 tmp/，文件名带方案 id 与时间戳。",
      "",
      "  pnpm workbook import --project <方案id> --in <文件路径> [--commit]",
      "      读取编辑后的表格并预校验。不加 --commit 只预览，加上才写入。",
      "",
      "编辑规则见表格内「说明」工作表。任何校验失败都会逐行报错并中止，绝不写入。",
      ""
    ].join("\n")
  );
}

try {
  if (command === "export") await runExport();
  else if (command === "import") await runImport();
  else printHelp();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}