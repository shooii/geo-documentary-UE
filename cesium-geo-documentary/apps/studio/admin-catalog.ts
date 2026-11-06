import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { writeJsonAtomicResilient } from "./fs-resilience.js";

export type AdminLevel = "province" | "city" | "county" | "town";

export interface AdminDivisionNode {
  code: string;
  name: string;
  level: AdminLevel;
  parentCode: string | null;
  provinceCode: string;
  cityCode?: string;
  countyCode?: string;
  provinceName: string;
  cityName?: string;
  countyName?: string;
  villageCount: number;
  sourcePath: string;
  idField?: string;
  nameField?: string;
  townField?: string;
  encoding?: string;
  productionReady: boolean;
  breadcrumb: string;
}

export interface AdminCatalog {
  version: 3;
  sourceRoot: string;
  sourceSignature: string;
  generatedAt: string;
  nodes: AdminDivisionNode[];
}

interface ProvinceSource {
  code: string;
  name: string;
  folder: string;
}

interface DbfField {
  name: string;
  normalizedName: string;
  type: string;
  length: number;
  offset: number;
}

interface DbfHeader {
  recordCount: number;
  headerLength: number;
  recordLength: number;
  fields: DbfField[];
}

const DATA_FOLDER = "01【25096】全国村级行政边界数据";
const CACHE_VERSION = 3;

const PROVINCES: ProvinceSource[] = [
  ["11", "北京市", "北京村界"], ["12", "天津市", "天津市村界"], ["13", "河北省", "河北村界"],
  ["14", "山西省", "山西省村界"], ["15", "内蒙古自治区", "内蒙村界"], ["21", "辽宁省", "辽宁省村界"],
  ["22", "吉林省", "吉林省国土村界"], ["23", "黑龙江省", "黑龙江"], ["31", "上海市", "上海村界"],
  ["32", "江苏省", "江苏村界"], ["33", "浙江省", "浙江村界"], ["34", "安徽省", "安徽村界"],
  ["35", "福建省", "福建村界"], ["36", "江西省", "江西村界"], ["37", "山东省", "山东村界"],
  ["41", "河南省", "河南村界"], ["42", "湖北省", "湖北村界"], ["43", "湖南省", "湖南村界"],
  ["44", "广东省", "广东村界"], ["45", "广西壮族自治区", "广西村界"], ["46", "海南省", "海南村界"],
  ["50", "重庆市", "重庆村界"], ["51", "四川省", "四川村界"], ["52", "贵州省", "贵州村界"],
  ["53", "云南省", "云南村界"], ["54", "西藏自治区", "西藏"], ["61", "陕西省", "陕西市县镇村行政边界"],
  ["62", "甘肃省", "甘肃省村界"], ["63", "青海省", "青海村界"], ["64", "宁夏回族自治区", "宁夏村界"],
  ["65", "新疆维吾尔自治区", "新疆"], ["71", "台湾省", "台湾村界"], ["81", "香港特别行政区", "香港村界"],
  ["82", "澳门特别行政区", "澳门"]
].map(([code, name, folder]) => ({ code: code!, name: name!, folder: folder! }));

const FIELD_ALIASES = {
  fullCode: ["pac", "code", "xzqdm", "djzqdm", "村代码", "村级码", "村级代码", "cundm", "sqcdm", "cjdcqdm", "entiid", "sqbm", "行政区代码"],
  villageName: ["name", "xzqmc", "djzqmc", "村名称", "村级名", "村级", "cunmc", "sqcmc", "cjdcqmc", "cjgzqymc", "blockname", "comname"],
  townCode: ["乡镇码", "乡镇代码", "towncode", "xiangdm", "xzjdm", "xjdm", "xzxzqdm", "streetcode"],
  countyCode: ["区县码", "区县代码", "countycode", "xiandm", "qxdm", "xjxzqdm", "distcode"],
  cityCode: ["市代码", "市级代码", "citycode", "shidm", "sjxzqdm"],
  townName: ["乡镇级", "乡镇街道名", "乡镇名", "乡名称", "townname", "xiangmc", "xiangname", "xzjmc", "xjmc", "xzjgzqymc", "xzxzqmc", "streetname", "upname", "xjxzqmc"],
  countyName: ["区县级", "区县名称", "区县名", "countynam", "countyname", "xianmc", "xianname", "县名", "县区名", "县名称", "qxmc", "xjmc1", "qxjgzqymc", "xjxzqmc", "distname", "adname"],
  cityName: ["市级", "市级名称", "地市名", "地市级", "市名", "市名称", "cityname", "shimc", "shiname", "dsjgzqymc", "sjxzqmc", "dqmc", "市区名"],
  provinceName: ["省级", "省名称", "省名", "provincename", "shengmc", "shengname", "sheng"]
} as const;

function normalizeFieldName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_\-()（）]/g, "");
}

function cleanText(value: string | undefined): string {
  return (value ?? "").replace(/\0/g, "").trim();
}

function digits(value: string | undefined): string {
  return cleanText(value).replace(/\.0+$/, "").replace(/\D/g, "");
}

function codeFor(value: string | undefined, length: number): string {
  const raw = digits(value);
  if (!raw) return "";
  if (raw.length >= length) return raw.slice(0, length);
  return raw.padEnd(length, "0");
}

function fieldFor(fields: DbfField[], aliases: readonly string[]): DbfField | undefined {
  const wanted = new Set(aliases.map(normalizeFieldName));
  return fields.find((field) => wanted.has(field.normalizedName));
}

function decoderFor(path: string, cpg?: string): TextDecoder {
  const declared = cleanText(cpg).toLowerCase().replace(/[-_]/g, "");
  if (declared.includes("utf8") || declared.includes("65001")) return new TextDecoder("utf-8");
  if (declared.includes("big5") || path.includes("台湾")) return new TextDecoder("big5");
  return new TextDecoder("gb18030");
}

export function parseDbfHeader(buffer: Buffer, decoder = new TextDecoder("gb18030")): DbfHeader {
  if (buffer.length < 33) throw new Error("DBF header is truncated");
  const recordCount = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  if (headerLength < 33 || recordLength < 2) throw new Error("Invalid DBF header");
  const fields: DbfField[] = [];
  let offset = 1;
  for (let cursor = 32; cursor + 31 < Math.min(buffer.length, headerLength) && buffer[cursor] !== 0x0d; cursor += 32) {
    const end = buffer.subarray(cursor, cursor + 11).indexOf(0);
    const nameBytes = buffer.subarray(cursor, cursor + (end < 0 ? 11 : end));
    const name = decoder.decode(nameBytes).trim();
    const length = buffer[cursor + 16] ?? 0;
    fields.push({ name, normalizedName: normalizeFieldName(name), type: String.fromCharCode(buffer[cursor + 11] ?? 67), length, offset });
    offset += length;
  }
  return { recordCount, headerLength, recordLength, fields };
}

export function parseDbfBuffer(buffer: Buffer, encoding: "gb18030" | "utf-8" | "big5" = "gb18030"): Array<Record<string, string>> {
  const decoder = new TextDecoder(encoding);
  const header = parseDbfHeader(buffer, decoder);
  const rows: Array<Record<string, string>> = [];
  for (let index = 0; index < header.recordCount; index += 1) {
    const start = header.headerLength + index * header.recordLength;
    if (start + header.recordLength > buffer.length) break;
    if (buffer[start] === 0x2a) continue;
    const row: Record<string, string> = {};
    for (const field of header.fields) row[field.name] = decoder.decode(buffer.subarray(start + field.offset, start + field.offset + field.length)).trim();
    rows.push(row);
  }
  return rows;
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(folder: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === ".dbf") result.push(path);
    }
  }
  if (existsSync(root)) await walk(root);
  return result;
}

async function inspectDbf(path: string): Promise<{ header: DbfHeader; decoder: TextDecoder; score: number }> {
  const handle = await open(path, "r");
  try {
    const first = Buffer.alloc(32); await handle.read(first, 0, first.length, 0);
    const headerLength = first.readUInt16LE(8);
    const headerBuffer = Buffer.alloc(headerLength); await handle.read(headerBuffer, 0, headerLength, 0);
    const cpgPath = join(dirname(path), `${basename(path, extname(path))}.cpg`);
    const cpg = existsSync(cpgPath) ? await readFile(cpgPath, "utf8") : undefined;
    const decoder = decoderFor(path, cpg);
    const header = parseDbfHeader(headerBuffer, decoder);
    const has = (aliases: readonly string[]) => Boolean(fieldFor(header.fields, aliases));
    const score = (has(FIELD_ALIASES.fullCode) ? 50 : 0) + (has(FIELD_ALIASES.townName) ? 40 : 0) + (has(FIELD_ALIASES.countyName) ? 20 : 0) + (has(FIELD_ALIASES.cityName) ? 10 : 0) + Math.log10(Math.max(1, header.recordCount));
    return { header, decoder, score };
  } finally { await handle.close(); }
}

async function bestDbf(folder: string): Promise<{ path: string; header: DbfHeader; decoder: TextDecoder } | null> {
  const candidates = await listFiles(folder);
  let best: { path: string; header: DbfHeader; decoder: TextDecoder; score: number } | null = null;
  for (const path of candidates) {
    try {
      const inspected = await inspectDbf(path);
      if (!best || inspected.score > best.score || (inspected.score === best.score && inspected.header.recordCount > best.header.recordCount)) best = { path, ...inspected };
    } catch { /* Ignore unrelated or damaged DBF sidecars. */ }
  }
  return best;
}

function readField(record: Buffer, field: DbfField | undefined, decoder: TextDecoder): string {
  return field ? decoder.decode(record.subarray(field.offset, field.offset + field.length)).trim() : "";
}

export async function buildProvinceCatalog(sourceRoot: string, provinceCode: string, productionIds = new Set<string>()): Promise<AdminDivisionNode[]> {
  const province = PROVINCES.find((item) => item.code === provinceCode);
  if (!province) throw new Error(`Unknown province code ${provinceCode}`);
  const source = await bestDbf(join(sourceRoot, province.folder));
  const provinceNode: AdminDivisionNode = {
    code: `${province.code}0000`, name: province.name, level: "province", parentCode: null, provinceCode: `${province.code}0000`, provinceName: province.name,
    villageCount: 0, sourcePath: source ? relative(sourceRoot, source.path).replaceAll("\\", "/") : province.folder, productionReady: productionIds.has(`${province.code}0000`), breadcrumb: province.name
  };
  if (!source) return [provinceNode];

  const fields = source.header.fields;
  const picked = {
    fullCode: fieldFor(fields, FIELD_ALIASES.fullCode), townCode: fieldFor(fields, FIELD_ALIASES.townCode), countyCode: fieldFor(fields, FIELD_ALIASES.countyCode), cityCode: fieldFor(fields, FIELD_ALIASES.cityCode),
    townName: fieldFor(fields, FIELD_ALIASES.townName), countyName: fieldFor(fields, FIELD_ALIASES.countyName), cityName: fieldFor(fields, FIELD_ALIASES.cityName), provinceName: fieldFor(fields, FIELD_ALIASES.provinceName)
  };
  const villageNameField = fieldFor(fields, FIELD_ALIASES.villageName);
  const sourceMetadata = {
    ...(picked.fullCode?.name ? { idField: picked.fullCode.name } : {}),
    ...(villageNameField?.name ? { nameField: villageNameField.name } : {}),
    ...(picked.townCode?.name ? { townField: picked.townCode.name } : {}),
    encoding: source.decoder.encoding
  };
  const cities = new Map<string, { name: string; count: number }>();
  const counties = new Map<string, { name: string; cityCode: string; cityName: string; count: number }>();
  const towns = new Map<string, { name: string; countyCode: string; countyName: string; cityCode: string; cityName: string; count: number }>();
  const handle = await open(source.path, "r");
  try {
    const recordsPerChunk = Math.max(1, Math.floor(4_194_304 / source.header.recordLength));
    for (let startIndex = 0; startIndex < source.header.recordCount; startIndex += recordsPerChunk) {
      const count = Math.min(recordsPerChunk, source.header.recordCount - startIndex);
      const buffer = Buffer.alloc(count * source.header.recordLength);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, source.header.headerLength + startIndex * source.header.recordLength);
      const readable = Math.floor(bytesRead / source.header.recordLength);
      for (let index = 0; index < readable; index += 1) {
        const record = buffer.subarray(index * source.header.recordLength, (index + 1) * source.header.recordLength);
        if (record[0] === 0x2a) continue;
        const fullCode = digits(readField(record, picked.fullCode, source.decoder));
        const townCode = codeFor(readField(record, picked.townCode, source.decoder) || fullCode, 9);
        const countyCode = codeFor(readField(record, picked.countyCode, source.decoder) || fullCode, 6);
        const cityCode = codeFor(readField(record, picked.cityCode, source.decoder) || fullCode, 4).padEnd(6, "0");
        if (!townCode.startsWith(province.code) || townCode.length !== 9 || countyCode.length !== 6 || cityCode.length !== 6) continue;
        const cityName = cleanText(readField(record, picked.cityName, source.decoder)) || `${cityCode}地市`;
        const countyName = cleanText(readField(record, picked.countyName, source.decoder)) || `${countyCode}区县`;
        const townName = cleanText(readField(record, picked.townName, source.decoder)) || `${townCode}乡镇`;
        const city = cities.get(cityCode); cities.set(cityCode, { name: city?.name && !city.name.endsWith("地市") ? city.name : cityName, count: (city?.count ?? 0) + 1 });
        const county = counties.get(countyCode); counties.set(countyCode, { name: county?.name && !county.name.endsWith("区县") ? county.name : countyName, cityCode, cityName, count: (county?.count ?? 0) + 1 });
        const town = towns.get(townCode); towns.set(townCode, { name: town?.name && !town.name.endsWith("乡镇") ? town.name : townName, countyCode, countyName, cityCode, cityName, count: (town?.count ?? 0) + 1 });
      }
    }
  } finally { await handle.close(); }
  provinceNode.villageCount = [...cities.values()].reduce((sum, item) => sum + item.count, 0);
  provinceNode.provinceName = cleanText(provinceNode.provinceName);
  const sourcePath = relative(sourceRoot, source.path).replaceAll("\\", "/");
  const nodes: AdminDivisionNode[] = [provinceNode];
  for (const [code, item] of [...cities].sort(([a], [b]) => a.localeCompare(b))) nodes.push({
    code, name: item.name, level: "city", parentCode: provinceNode.code, provinceCode: provinceNode.code, cityCode: code, provinceName: province.name, cityName: item.name,
    villageCount: item.count, sourcePath, ...sourceMetadata, productionReady: productionIds.has(code), breadcrumb: `${province.name} / ${item.name}`
  });
  for (const [code, item] of [...counties].sort(([a], [b]) => a.localeCompare(b))) nodes.push({
    code, name: item.name, level: "county", parentCode: item.cityCode, provinceCode: provinceNode.code, cityCode: item.cityCode, countyCode: code, provinceName: province.name, cityName: item.cityName, countyName: item.name,
    villageCount: item.count, sourcePath, ...sourceMetadata, productionReady: productionIds.has(code), breadcrumb: `${province.name} / ${item.cityName} / ${item.name}`
  });
  for (const [code, item] of [...towns].sort(([a], [b]) => a.localeCompare(b))) nodes.push({
    code, name: item.name, level: "town", parentCode: item.countyCode, provinceCode: provinceNode.code, cityCode: item.cityCode, countyCode: item.countyCode, provinceName: province.name, cityName: item.cityName, countyName: item.countyName,
    villageCount: item.count, sourcePath, ...sourceMetadata, productionReady: productionIds.has(code), breadcrumb: `${province.name} / ${item.cityName} / ${item.countyName} / ${item.name}`
  });
  return nodes;
}

async function productionIds(root: string): Promise<Set<string>> {
  const masterPath = join(root, "content", "regions.zh-CN.json");
  if (!existsSync(masterPath)) return new Set();
  const master = JSON.parse(await readFile(masterPath, "utf8")) as Record<string, unknown>;
  const ready = new Set<string>();
  for (const id of Object.keys(master)) {
    const path = join(root, "data", "regions", `${id}.json`);
    if (!existsSync(path)) continue;
    try {
      const region = JSON.parse(await readFile(path, "utf8")) as { childRegions?: unknown[] };
      if (region.childRegions?.length) ready.add(id);
    } catch { /* A malformed production record remains unavailable. */ }
  }
  return ready;
}

async function sourceSignature(sourceRoot: string): Promise<string> {
  const hash = createHash("sha256");
  for (const path of (await listFiles(sourceRoot)).sort()) {
    const info = await stat(path);
    hash.update(`${relative(sourceRoot, path).replaceAll("\\", "/")}:${info.size}:${Math.floor(info.mtimeMs)}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * The signature above is computed from paths relative to the source root, so a
 * byte-identical copy of the boundary data elsewhere on disk produces the same
 * signature. Without also comparing the absolute root, a workspace that was
 * moved (e.g. off the desktop) would keep reusing a cache whose `sourceRoot`
 * still points at the old location, and every boundary import would silently
 * read from a directory the user no longer works in.
 */
function sameSourceRoot(cached: Pick<AdminCatalog, "sourceRoot">, sourceRoot: string): boolean {
  if (typeof cached.sourceRoot !== "string" || cached.sourceRoot.length === 0) return false;
  const normalize = (value: string): string => resolve(value).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return normalize(cached.sourceRoot) === normalize(sourceRoot);
}

let catalogPromise: Promise<AdminCatalog> | undefined;
let catalogPromiseSignature: string | undefined;

async function buildCatalog(root: string, sourceRoot: string, signature: string): Promise<AdminCatalog> {
  const cacheRoot = join(root, "workspace", "render-cache");
  const cachePath = join(cacheRoot, `admin-divisions.v${CACHE_VERSION}.json`);
  const readyIds = await productionIds(root);
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as AdminCatalog;
      if (cached.version === CACHE_VERSION && cached.sourceSignature === signature && sameSourceRoot(cached, sourceRoot)) {
        for (const node of cached.nodes) node.productionReady = readyIds.has(node.code);
        return cached;
      }
    } catch { /* Rebuild invalid cache. */ }
  }
  const nodes: AdminDivisionNode[] = [];
  for (const province of PROVINCES) nodes.push(...await buildProvinceCatalog(sourceRoot, province.code, readyIds));
  const catalog: AdminCatalog = { version: CACHE_VERSION, sourceRoot, sourceSignature: signature, generatedAt: new Date().toISOString(), nodes };
  try {
    if (!existsSync(cacheRoot)) await mkdir(cacheRoot, { recursive: true });
    await writeJsonAtomicResilient(cachePath, catalog);
    // The cache file is versioned by name, so raising CACHE_VERSION writes a new
    // one and strands every earlier version. Nothing reads them again.
    const keep = basename(cachePath);
    await Promise.all((await readdir(cacheRoot))
      .filter((name) => name.startsWith("admin-divisions.v") && name !== keep)
      .map((name) => rm(join(cacheRoot, name), { force: true }).catch(() => { /* Best effort. */ })));
  } catch {
    // The catalog remains usable in memory when a read-only deployment blocks cache writes.
  }
  return catalog;
}

/**
 * The catalog is memoized, but the memo is keyed on the source signature instead of on
 * process lifetime. Hand-correcting the boundary `.dbf` in place is routine here, and a memo
 * that never revalidates keeps serving pre-edit child counts to the division picker (and to
 * `generateTownPlan`) until the server happens to be restarted. Revalidating costs one
 * directory walk plus a `stat` per `.dbf`, which is orders of magnitude below parsing them.
 *
 * The walk itself is not free though: 538 files in a 15 GB directory measured ~135 ms, and
 * it used to run on *every* catalog use. The division picker loads all four levels at once,
 * so one picker open paid it four times (~540 ms of Windows file I/O, all of it blocking the
 * single event loop while the operator waited on a dropdown). The signature only has to
 * notice a boundary file edited by hand -- a change no automation here performs, and one a
 * human makes minutes apart at the closest. So it is memoized for a short window, which
 * collapses the four picker requests into one walk while still picking up an edit on the
 * next interaction. Tune with STUDIO_CATALOG_SIGNATURE_TTL_MS; 0 restores per-call checks.
 */
const CATALOG_SIGNATURE_TTL_MS = Number(process.env.STUDIO_CATALOG_SIGNATURE_TTL_MS ?? 5_000);
let signatureCache: { root: string; signature: string; at: number } | undefined;

async function cachedSourceSignature(sourceRoot: string): Promise<string> {
  const now = Date.now();
  if (
    CATALOG_SIGNATURE_TTL_MS > 0
    && signatureCache
    && signatureCache.root === sourceRoot
    && now - signatureCache.at < CATALOG_SIGNATURE_TTL_MS
  ) {
    return signatureCache.signature;
  }
  const signature = await sourceSignature(sourceRoot);
  signatureCache = { root: sourceRoot, signature, at: Date.now() };
  return signature;
}

export async function getAdminCatalog(root: string): Promise<AdminCatalog> {
  const sourceRoot = resolve(root, "data", "regions", DATA_FOLDER);
  if (!existsSync(sourceRoot)) throw new Error(`全国村级行政边界数据不存在：${sourceRoot}`);
  const signature = await cachedSourceSignature(sourceRoot);
  if (!catalogPromise || catalogPromiseSignature !== signature) {
    catalogPromiseSignature = signature;
    catalogPromise = buildCatalog(root, sourceRoot, signature);
  }
  try { return await catalogPromise; }
  catch (error) { catalogPromise = undefined; catalogPromiseSignature = undefined; throw error; }
}

export async function markAdminDivisionReady(root: string, code: string): Promise<void> {
  const catalog = await getAdminCatalog(root);
  const node = catalog.nodes.find((item) => item.code === code);
  if (node) node.productionReady = true;
}

export async function listAdminDivisions(root: string, level: AdminLevel, parent?: string): Promise<AdminDivisionNode[]> {
  const catalog = await getAdminCatalog(root);
  return catalog.nodes.filter((node) => node.level === level && (level === "province" || node.parentCode === parent));
}

export async function locateAdminDivision(root: string, code: string): Promise<{ node: AdminDivisionNode; chain: AdminDivisionNode[] }> {
  const catalog = await getAdminCatalog(root);
  const byCode = new Map(catalog.nodes.map((node) => [node.code, node]));
  const node = byCode.get(code);
  if (!node) throw new Error(`全国行政区目录中未找到 ${code}`);
  const chain: AdminDivisionNode[] = [];
  let current: AdminDivisionNode | undefined = node;
  while (current) { chain.unshift(current); current = current.parentCode ? byCode.get(current.parentCode) : undefined; }
  return { node, chain };
}

export async function searchAdminDivisions(root: string, query: string, limit = 30): Promise<AdminDivisionNode[]> {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return [];
  const catalog = await getAdminCatalog(root);
  return filterAdminDivisions(catalog.nodes, keyword, limit);
}

export function filterAdminDivisions(nodes: AdminDivisionNode[], query: string, limit = 30): AdminDivisionNode[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return [];
  const levelWeight: Record<AdminLevel, number> = { town: 0, county: 1, city: 2, province: 3 };
  return nodes
    .filter((node) => node.name.toLowerCase().includes(keyword) || node.code.includes(keyword) || node.breadcrumb.toLowerCase().includes(keyword))
    .sort((a, b) => {
      const aExact = a.name.toLowerCase() === keyword || a.code === keyword ? 0 : a.name.toLowerCase().startsWith(keyword) ? 1 : 2;
      const bExact = b.name.toLowerCase() === keyword || b.code === keyword ? 0 : b.name.toLowerCase().startsWith(keyword) ? 1 : 2;
      return aExact - bExact || levelWeight[a.level] - levelWeight[b.level] || a.code.localeCompare(b.code);
    })
    .slice(0, Math.max(1, Math.min(100, limit)));
}
