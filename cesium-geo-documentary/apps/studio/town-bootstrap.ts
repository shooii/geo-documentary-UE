import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import {
  buildChildAdjacency,
  childBoundariesFromGeoJson,
  planTouchingRoute,
  type Position
} from "../../packages/geo-utils/child-adjacency.js";
import { getAdminCatalog, locateAdminDivision, markAdminDivisionReady } from "./admin-catalog.js";
import { resolveWorkspacePath } from "./boundary-snapshot.js";

interface GeneratedChild {
  id: string;
  name: string;
  labelPoint?: [number, number];
}

interface GeneratedRegion {
  name?: string;
  childGeometryPath?: string;
  childRegions?: GeneratedChild[];
  /** Narrated tour order. Absent on records written before this field existed. */
  tourChildIds?: string[];
  childIds?: string[];
  /** Units that stay on the boundary layer but never get a flight or narration. */
  supplementalUnits?: Array<{ id?: string }>;
}

/** The catalogue's own node shape, so the helpers below cannot drift from it. */
type AdminNode = Awaited<ReturnType<typeof locateAdminDivision>>["node"];
const pending = new Map<string, Promise<void>>();

/**
 * Turn the importer's non-zero exit into one actionable sentence.
 *
 * The script prints a JSON payload on stdout and explains a genuine failure in a
 * `message` field inside it. Before that field existed, 草潭镇 (440823113)
 * surfaced as `自动提取乡镇边界失败（exit 1）：{"ok": false, ...}` - the payload,
 * but no cause and no next step. Prefer the importer's own explanation and fall
 * back to the raw streams so nothing is ever hidden.
 */
export function townImportFailureMessage(code: number | null, stdout: string, stderr: string): string {
  const payload = stdout.trim();
  if (payload.startsWith("{")) {
    try {
      const parsed = JSON.parse(payload) as { message?: unknown };
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
    } catch { /* not the structured payload; fall through to the raw streams */ }
  }
  return `自动提取乡镇边界失败（exit ${code}）：${stderr.trim() || payload}`;
}

function runProcess(executable: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true });
    const stdout: string[] = []; const stderr: string[] = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolvePromise(stdout.join("").trim())
      : reject(new Error(townImportFailureMessage(code, stdout.join(""), stderr.join("")))));
  });
}

function levelName(name: string): string {
  if (name.includes("街道")) return "街道";
  if (name.endsWith("乡")) return "乡";
  if (name.endsWith("镇")) return "镇";
  if (name.includes("农场") || name.includes("公司")) return "管理区";
  return "乡镇级行政区";
}

/**
 * Order the children so every flight lands in a village that shares a boundary.
 *
 * The source shapefile lists features in no spatial order, so a naive tour
 * criss-crosses the township. On 乌石镇 only 11 of 24 flights were between
 * touching villages. Planning the order here means a new plan starts with a
 * continuous route instead of acquiring one later.
 *
 * The town centre opens where possible — a tour that begins at the seat and
 * then walks the villages is the natural reading — and the planner falls back
 * to whatever start a fully touching route actually admits.
 */
async function planChildTourOrder(root: string, regionId: string, region: GeneratedRegion, children: GeneratedChild[]): Promise<string[]> {
  const fallback = children.map((child) => child.id);
  if (children.length < 2) return fallback;
  const geometryPath = resolve(root, region.childGeometryPath ?? `data/normalized/${regionId}-children.geojson`);
  if (!existsSync(geometryPath)) return fallback;
  try {
    const geoJson = JSON.parse(await readFile(geometryPath, "utf8"));
    // Only the narrated children take part: a supplemental farm polygon left in
    // the adjacency would make the plan longer than the tour and every route
    // would be discarded for the fallback order.
    const wanted = new Set(children.map((child) => child.id));
    const adjacency = buildChildAdjacency(
      childBoundariesFromGeoJson(geoJson).filter((boundary) => wanted.has(String(boundary.id)))
    );
    if (!adjacency.ids.length) return fallback;
    const points = new Map<string, Position>();
    for (const child of children) if (child.labelPoint) points.set(child.id, child.labelPoint);
    const anchor = children.find((child) => /社区|政府|镇区|圩|居委会/.test(child.name));
    const plan = planTouchingRoute(adjacency, {
      points,
      ...(anchor ? { startId: anchor.id } : {}),
      timeBudgetMs: 4_000
    });
    // A partial plan is still the better order: it keeps the flights it can.
    return plan.order.length === children.length ? plan.order : fallback;
  } catch {
    return fallback;
  }
}

function generatedNarration(
  node: Awaited<ReturnType<typeof locateAdminDivision>>["node"],
  children: Array<{ id: string; name: string }>,
  supplementalCount = 0
): string[] {
  const parentText = [node.provinceName, node.cityName, node.countyName].filter(Boolean).join("、");
  return [
    `${node.name}位于${parentText}，本方案依据全国村级行政边界数据自动建立，下辖${children.length}个村级区域。`
      + (supplementalCount ? `另按源边界数据保留${supplementalCount}个农场等补充管理单元，只显示边界、不单独出镜。` : ""),
    `镜头将从高空穿过云层抵达${node.name}，持续显示行政边界与村级名称，并依照真实边界顺序展开游览。`,
    ...children.map((child) => `${child.name}是${node.name}下辖的村级区域，镜头将沿真实边界停留，等待补充当地产业、风貌与生活素材。`),
    `从最后一个村级区域拉回${node.name}全域，这份自动方案可继续补充真实图片、地方资料、字幕和旁白后再导出成片。`
  ];
}

async function writeGeneratedContent(root: string, regionId: string): Promise<void> {
  const location = await locateAdminDivision(root, regionId);
  const node = location.node;
  const regionPath = join(root, "data", "regions", `${regionId}.json`);
  const region = JSON.parse(await readFile(regionPath, "utf8")) as GeneratedRegion;
  const allChildren = (region.childRegions ?? []).map((child) => ({ ...child, id: String(child.id) }));
  if (!allChildren.length) throw new Error(`${node.name}没有可用于自动方案的村级边界`);
  // `childRegions` also carries supplemental management units (a town's farms and
  // forest farms), which the importer keeps out of `tourChildIds`. Planning the
  // narration over every childRegion would name units that never get a flight.
  const tourIds = new Set((region.tourChildIds ?? region.childIds ?? allChildren.map((child) => child.id)).map(String));
  const children = allChildren.filter((child) => tourIds.has(child.id));
  if (!children.length) throw new Error(`${node.name}没有可用于巡游的村级边界`);
  const order = await planChildTourOrder(root, regionId, region, children);
  const childById = new Map(children.map((child) => [String(child.id), child]));
  const orderedChildren = order
    .map((id) => childById.get(id))
    .filter((child): child is GeneratedChild => Boolean(child));
  if (orderedChildren.length !== children.length) throw new Error(`${node.name}的下级行政区顺序不完整`);
  const masterPath = join(root, "content", "regions.zh-CN.json");
  const master = JSON.parse(await readFile(masterPath, "utf8")) as Record<string, Record<string, unknown>>;
  master[regionId] = {
    name: node.name,
    title: `地理乡土情·${node.countyName ?? ""}${node.name}`,
    province: node.provinceName,
    city: node.cityName ?? "",
    county: node.countyName ?? "",
    town: node.name,
    generated: true,
    generationSource: node.sourcePath,
    generationNotice: "由全国村级行政边界数据自动生成初始方案；地方事实、图片与旁白需在发布前复核。",
    narration: generatedNarration(node, orderedChildren, allChildren.length - children.length),
    tourOrder: orderedChildren.map((child) => child.id),
    voiceId: "zh-CN-YunyangNeural",
    voiceRate: "-4%",
    subtitleLeadSeconds: 0.05
  };
  const temporary = `${masterPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(master, null, 2), "utf8");
  await rename(temporary, masterPath);
}

/**
 * The importer invocation for one town, without running it.
 *
 * The command line is built from the catalogue's own view of the source file:
 * its id/name/town fields, its encoding, and the number of children the source
 * is expected to yield. Separating it from the run keeps one definition of "how
 * this town is imported" for the plan generator and for any later caller.
 */
async function townImportCommand(
  root: string,
  regionId: string
): Promise<{ node: AdminNode; shpPath: string; args: string[] }> {
  const location = await locateAdminDivision(root, regionId);
  const node = location.node;
  if (node.level !== "town") throw new Error("自动方案只能从乡镇或街道创建");
  if (!node.villageCount) throw new Error(`${node.name}在源数据中没有村级边界`);
  if (!node.idField || !node.nameField) throw new Error(`${node.name}的源数据缺少村级代码或名称字段，暂不能自动创建方案`);
  const catalog = await getAdminCatalog(root);
  const dbfPath = resolve(catalog.sourceRoot, node.sourcePath);
  const shpPath = dbfPath.slice(0, -extname(dbfPath).length) + ".shp";
  if (!existsSync(shpPath)) throw new Error(`缺少对应 SHP 文件：${shpPath}`);
  const script = join(root, ".agents", "skills", "cesium-geo-documentary", "scripts", "import-shapefile.py");
  const args = [
    script, shpPath,
    "--region-id", node.code,
    "--region-name", node.name,
    "--parent-id", node.countyCode ?? node.parentCode ?? "",
    "--level-role", "township",
    "--level-name", levelName(node.name),
    "--id-field", node.idField,
    "--name-field", node.nameField,
    "--encoding", node.encoding ?? "gb18030",
    "--source-label", `全国村级行政边界数据 · ${node.sourcePath}`,
    "--expected-children", String(node.villageCount),
    "--title", `${node.countyName ?? ""}${node.name}`,
    "--simplify-meters", "1"
  ];
  if (node.townField) args.push("--filter-field", node.townField, "--filter-prefix", node.code);
  else args.push("--id-prefix", node.code);
  // A few towns were appended to their province table without the village code
  // field filled in (调风镇/440882111 is one). The official 2025 code table then
  // supplies the real codes by name; without this the importer can only fail
  // with "Record N has no value in PAC".
  const codeIndex = join(root, "data", "regions", "2025全国行政区划编码", "village-code-index.tsv");
  if (existsSync(codeIndex)) args.push("--code-index", codeIndex);
  return { node, shpPath, args };
}

async function generateTownPlan(root: string, regionId: string): Promise<void> {
  const { args } = await townImportCommand(root, regionId);
  await runProcess(process.env.PYTHON_EXECUTABLE ?? "python", args, root);
  await writeGeneratedContent(root, regionId);
  await markAdminDivisionReady(root, regionId);
}

/**
 * How much newer the source may be before a record counts as stale.
 *
 * An import writes the record right after reading the source, so the record is
 * normally the newer of the two. File timestamps on Windows carry sub-second
 * noise (and a copy can land a millisecond behind), so the comparison tolerates
 * a couple of seconds instead of demanding a strict ordering.
 */
const SOURCE_FRESHNESS_SLACK_MS = 2_000;

export interface SourceFreshness {
  stale: boolean;
  /** When the record was last written, or null when the town has no record. */
  importedAt: number | null;
  /** Newest mtime among the source shapefile sidecars the record names. */
  newestSourceAt: number | null;
  /** The files that were compared, so a failure can name what moved. */
  sourceFiles: string[];
}

/**
 * Does the record still describe the source file it was imported from?
 *
 * `data/regions/<id>.json` names the shapefile sidecars it was read from, and
 * nothing tracks those files afterwards. An operator who edits the province SHP
 * (河头镇's data was edited on 2026-10-12) therefore gets a *new plan* built from
 * the pre-edit record: `ensureTownPlan` only imports towns that have no record
 * at all, so an edited source keeps producing old boundaries until someone
 * notices. Comparing the record's mtime with the sidecars it names is what makes
 * that drift visible before a scheme bakes it in.
 */
export async function sourceFreshness(root: string, regionId: string): Promise<SourceFreshness> {
  const empty: SourceFreshness = { stale: false, importedAt: null, newestSourceAt: null, sourceFiles: [] };
  const recordPath = join(root, "data", "regions", `${regionId}.json`);
  const recordStat = await stat(recordPath).catch(() => null);
  if (!recordStat) return empty;
  let record: GeneratedRegion & { sourceFiles?: unknown };
  try {
    record = JSON.parse(await readFile(recordPath, "utf8")) as GeneratedRegion & { sourceFiles?: unknown };
  } catch {
    return { ...empty, importedAt: recordStat.mtimeMs };
  }
  // A record that does not name its source cannot be compared against it.
  // Guessing from the catalogue instead would make every hand-authored region
  // look stale, and a needless re-import rewrites curated metadata.
  const sourceFiles = (Array.isArray(record.sourceFiles) ? record.sourceFiles : [])
    .map((value) => String(value))
    .filter((value) => Boolean(value));
  if (!sourceFiles.length) return { ...empty, importedAt: recordStat.mtimeMs };
  let newest: number | null = null;
  for (const relative of sourceFiles) {
    const absolute = resolveWorkspacePath(root, relative);
    if (!absolute) continue;
    const info = await stat(absolute).catch(() => null);
    if (info && (newest === null || info.mtimeMs > newest)) newest = info.mtimeMs;
  }
  if (newest === null) return { ...empty, importedAt: recordStat.mtimeMs, sourceFiles };
  return {
    stale: newest > recordStat.mtimeMs + SOURCE_FRESHNESS_SLACK_MS,
    importedAt: recordStat.mtimeMs,
    newestSourceAt: newest,
    sourceFiles
  };
}

/** Local wall-clock stamp for an operator-facing message. */
function localStamp(milliseconds: number): string {
  const date = new Date(milliseconds);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Say so when a scheme is about to be built from a record the source moved past.
 *
 * The refresh itself is deliberately not automatic. Guangdong is one province
 * table, so a single edit to 河头镇's rows re-stamps every town's sidecars —
 * measured on 2026-10-12, 25 of the workspace's 27 records looked "stale" while
 * only one had actually changed. Re-importing all of them with the current
 * importer would rewrite two dozen records nobody asked to touch, so the Studio
 * names the drift and leaves the decision (and the single re-import) to the
 * operator. See the skill's workflow notes for the exact command.
 */
export async function warnIfSourceDataMovedOn(root: string, regionId: string): Promise<SourceFreshness> {
  const freshness = await sourceFreshness(root, regionId);
  if (freshness.stale) {
    process.stderr.write(
      `SOURCE_DATA_STALE ${regionId} source=${localStamp(freshness.newestSourceAt ?? Date.now())}`
      + ` record=${localStamp(freshness.importedAt ?? Date.now())}`
      + " 该镇源边界数据比本地记录更新，新方案仍按记录中的旧边界建立；"
      + "如要改用编辑后的源数据，请先重新导入该镇边界\n"
    );
  }
  return freshness;
}

export async function ensureTownPlan(root: string, regionId: string): Promise<{ generated: boolean }> {
  const master = JSON.parse(await readFile(join(root, "content", "regions.zh-CN.json"), "utf8")) as Record<string, unknown>;
  if (master[regionId] && existsSync(join(root, "data", "regions", `${regionId}.json`))) return { generated: false };
  let task = pending.get(regionId);
  if (!task) {
    task = generateTownPlan(root, regionId).finally(() => pending.delete(regionId));
    pending.set(regionId, task);
  }
  await task;
  return { generated: true };
}
