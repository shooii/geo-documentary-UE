import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { writeFileAtomicResilient, writeJsonAtomicResilient } from "./fs-resilience.js";
import { sniffMediaType } from "./media-sniff.js";
import type { AssetPlacement, StudioAsset, StudioScene, VideoProject } from "../../packages/project-schema/index.js";

export const AMAP_POI_TYPES = [
  { code: "010000", name: "汽车服务" },
  { code: "020000", name: "汽车销售" },
  { code: "030000", name: "汽车维修" },
  { code: "040000", name: "摩托车服务" },
  { code: "050000", name: "餐饮服务" },
  { code: "060000", name: "购物服务" },
  { code: "070000", name: "生活服务" },
  { code: "080000", name: "体育休闲服务" },
  { code: "090000", name: "医疗保健服务" },
  { code: "100000", name: "住宿服务" },
  { code: "110000", name: "风景名胜" },
  { code: "120000", name: "商务住宅" },
  { code: "130000", name: "政府机构及社会团体" },
  { code: "140000", name: "科教文化服务" },
  { code: "150000", name: "交通设施服务" },
  { code: "160000", name: "金融保险服务" },
  { code: "170000", name: "公司企业" },
  { code: "180000", name: "道路附属设施" },
  { code: "190000", name: "地名地址信息" },
  { code: "200000", name: "公共设施" }
] as const;

export interface AmapPoiImportOptions {
  enabled?: boolean;
  typeCodes?: string[];
  keyword?: string;
  apiKey?: string;
  /**
   * Restrict the run to these child boundaries. Omitted means every child scene,
   * which is what project creation wants — the first run cannot know which theme
   * a village actually needed, so the village editor passes a single id to change
   * one village without re-querying the whole town.
   */
  childIds?: string[];
  /**
   * What happens to photos an earlier run already bound inside the requested type
   * groups. `append` is the create-time behaviour and only ever adds. `unbind`
   * detaches them from the scene first, so "re-collect with a better keyword"
   * refreshes the village instead of piling a second theme on top of the first.
   */
  mode?: "append" | "unbind";
}

interface Point { lng: number; lat: number }
type LinearRing = number[][];
type PolygonCoordinates = LinearRing[];
type MultiPolygonCoordinates = PolygonCoordinates[];

interface ChildFeature {
  type: "Feature";
  properties?: Record<string, unknown>;
  geometry?: { type: "Polygon"; coordinates: PolygonCoordinates } | { type: "MultiPolygon"; coordinates: MultiPolygonCoordinates };
}

interface AmapPhoto { title?: string; url?: string }
interface AmapPoi {
  id?: string;
  name?: string;
  type?: string;
  typecode?: string;
  location?: string;
  photos?: AmapPhoto[];
}

interface AmapResponse {
  status?: string;
  info?: string;
  count?: string;
  pois?: AmapPoi[];
}

export interface AmapImportSummary {
  enabled: true;
  provider: "amap";
  typeCodes: string[];
  keyword: string;
  importedAt: string;
  totalPois: number;
  totalPhotos: number;
  /**
   * Per-child results, merged across runs: a village-scoped re-collect overwrites
   * only its own entry, so the coverage of every other village survives. Order
   * follows the scene list, not the run.
   */
  children: Array<{ childId: string; childName: string; poiCount: number; photoCount: number; error?: string }>;
}

const settingsPath = (root: string) => join(root, "workspace", "amap-settings.json");
const CACHE_VERSION = 1;
const searchCacheRoot = (root: string) => join(root, "workspace", "amap-cache", `v${CACHE_VERSION}`, "search");
const photoCacheRoot = (root: string) => join(root, "workspace", "amap-cache", `v${CACHE_VERSION}`, "photos");
const searchRequests = new Map<string, Promise<AmapPoi[]>>();
const photoRequests = new Map<string, Promise<CachedPhoto>>();

interface SearchCacheEntry {
  version: number;
  createdAt: string;
  pois: AmapPoi[];
}

interface CachedPhoto {
  sourceUrl: string;
  filename: string;
  contentType: string;
  bytes: number;
  createdAt: string;
}

function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

async function readJsonIfPresent<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch { return null; }
}

export async function amapKeyConfigured(root: string): Promise<boolean> {
  if (process.env.AMAP_WEB_SERVICE_KEY || process.env.AMAP_API_KEY || process.env.GAODE_API_KEY) return true;
  if (!existsSync(settingsPath(root))) return false;
  try {
    const value = JSON.parse(await readFile(settingsPath(root), "utf8")) as { webServiceKey?: string };
    return Boolean(value.webServiceKey?.trim());
  } catch { return false; }
}

async function resolveAmapKey(root: string, supplied?: string): Promise<string> {
  const input = supplied?.trim();
  if (input) {
    await mkdir(join(root, "workspace"), { recursive: true });
    await writeJsonAtomicResilient(settingsPath(root), { webServiceKey: input });
    return input;
  }
  const environment = process.env.AMAP_WEB_SERVICE_KEY || process.env.AMAP_API_KEY || process.env.GAODE_API_KEY;
  if (environment?.trim()) return environment.trim();
  if (existsSync(settingsPath(root))) {
    try {
      const value = JSON.parse(await readFile(settingsPath(root), "utf8")) as { webServiceKey?: string };
      if (value.webServiceKey?.trim()) return value.webServiceKey.trim();
    } catch { /* A clear setup error is reported below. */ }
  }
  throw new Error("自动采集素材需要高德 Web 服务 Key；请在创建项目前填写，或设置 AMAP_WEB_SERVICE_KEY");
}

const a = 6378245;
const ee = 0.006693421622965943;

function outsideChina(lng: number, lat: number): boolean { return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271; }
function transformLat(x: number, y: number): number {
  let value = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  value += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  value += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  return value + (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
}
function transformLng(x: number, y: number): number {
  let value = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  value += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  value += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  return value + (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
}

export function wgs84ToGcj02(lng: number, lat: number): Point {
  if (outsideChina(lng, lat)) return { lng, lat };
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const radLat = lat / 180 * Math.PI;
  let magic = Math.sin(radLat); magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = dLat * 180 / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLng = dLng * 180 / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lng: lng + dLng, lat: lat + dLat };
}

export function gcj02ToWgs84(lng: number, lat: number): Point {
  if (outsideChina(lng, lat)) return { lng, lat };
  const converted = wgs84ToGcj02(lng, lat);
  return { lng: lng * 2 - converted.lng, lat: lat * 2 - converted.lat };
}

function pointInRing(point: Point, ring: LinearRing): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const current = ring[i]; const previous = ring[j];
    if (!current || !previous) continue;
    const intersects = ((current[1]! > point.lat) !== (previous[1]! > point.lat))
      && point.lng < (previous[0]! - current[0]!) * (point.lat - current[1]!) / (previous[1]! - current[1]!) + current[0]!;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointInFeature(point: Point, feature: ChildFeature): boolean {
  if (!feature.geometry) return false;
  const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  return polygons.some((polygon) => Boolean(polygon[0] && pointInRing(point, polygon[0]) && !polygon.slice(1).some((hole) => pointInRing(point, hole))));
}

function featureBounds(feature: ChildFeature): [number, number, number, number] {
  if (!feature.geometry) throw new Error("下级行政区缺少边界坐标");
  const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const points = polygons.flatMap((polygon) => polygon.flatMap((ring) => ring));
  return points.reduce<[number, number, number, number]>((bounds, point) => [
    Math.min(bounds[0], point[0]!), Math.min(bounds[1], point[1]!), Math.max(bounds[2], point[0]!), Math.max(bounds[3], point[1]!)
  ], [Infinity, Infinity, -Infinity, -Infinity]);
}

function parseLocation(location?: string): Point | null {
  const [lng, lat] = String(location || "").split(",").map(Number);
  return Number.isFinite(lng) && Number.isFinite(lat) ? { lng: lng!, lat: lat! } : null;
}

function defaultPlacement(asset: StudioAsset, scene: StudioScene): AssetPlacement {
  return {
    assetId: asset.id, fit: "cover", crop: { x: 0, y: 0, width: 1, height: 1 }, focalPoint: { x: 0.5, y: 0.5 },
    scale: 1, offsetX: 0, offsetY: 0, animation: "push-in", leadSeconds: 0.2, tailSeconds: 0.15,
    minimumDisplaySeconds: Math.max(1.2, Math.min(2.4, Number(scene.timing?.minimumVisualSeconds || 2))),
    requiredKeywords: scene.childName ? [scene.childName] : [], alt: asset.alt || asset.name
  };
}

async function fetchJson(fetchImpl: typeof fetch, url: URL): Promise<AmapResponse> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`高德请求失败 HTTP ${response.status}`);
  const data = await response.json() as AmapResponse;
  if (data.status !== "1") throw new Error(`高德请求失败：${data.info || "未知错误"}`);
  return data;
}

async function queryAllPois(fetchImpl: typeof fetch, apiKey: string, feature: ChildFeature, typeCodes: string[], keyword: string): Promise<AmapPoi[]> {
  const bounds = featureBounds(feature);
  const southwest = wgs84ToGcj02(bounds[0], bounds[1]);
  const northeast = wgs84ToGcj02(bounds[2], bounds[3]);
  const base = new URL("https://restapi.amap.com/v3/place/polygon");
  base.searchParams.set("key", apiKey);
  base.searchParams.set("polygon", `${southwest.lng},${southwest.lat}|${northeast.lng},${northeast.lat}`);
  base.searchParams.set("types", typeCodes.join("|"));
  if (keyword) base.searchParams.set("keywords", keyword);
  base.searchParams.set("extensions", "all");
  base.searchParams.set("offset", "25");
  const pois: AmapPoi[] = [];
  for (let page = 1; ; page += 1) {
    const url = new URL(base); url.searchParams.set("page", String(page));
    const data = await fetchJson(fetchImpl, url);
    const batch = Array.isArray(data.pois) ? data.pois : [];
    pois.push(...batch);
    const count = Math.max(0, Number(data.count || 0));
    if (!batch.length || pois.length >= count) break;
    if (page >= 400) throw new Error("高德返回超过 10000 个 POI，请缩小类型或增加关键词后重试");
  }
  return pois.filter((poi) => {
    const gcj = parseLocation(poi.location); if (!gcj) return false;
    return pointInFeature(gcj02ToWgs84(gcj.lng, gcj.lat), feature);
  });
}

async function queryAllPoisCached(root: string, fetchImpl: typeof fetch, apiKey: string, feature: ChildFeature, typeCodes: string[], keyword: string): Promise<AmapPoi[]> {
  const normalizedTypes = [...new Set(typeCodes)].sort();
  const normalizedKeyword = keyword.trim();
  const cacheKey = hash({
    version: CACHE_VERSION,
    endpoint: "amap-place-polygon-v3",
    geometry: feature.geometry,
    typeCodes: normalizedTypes,
    keyword: normalizedKeyword
  });
  const cachePath = join(searchCacheRoot(root), `${cacheKey}.json`);
  const cached = await readJsonIfPresent<SearchCacheEntry>(cachePath);
  if (cached?.version === CACHE_VERSION && Array.isArray(cached.pois)) return cached.pois;

  const active = searchRequests.get(cachePath);
  if (active) return active;
  const request = (async () => {
    const pois = await queryAllPois(fetchImpl, apiKey, feature, normalizedTypes, normalizedKeyword);
    await mkdir(searchCacheRoot(root), { recursive: true });
    const entry: SearchCacheEntry = { version: CACHE_VERSION, createdAt: new Date().toISOString(), pois };
    await writeJsonAtomicResilient(cachePath, entry);
    return pois;
  })();
  searchRequests.set(cachePath, request);
  try { return await request; }
  finally { searchRequests.delete(cachePath); }
}

/**
 * AMap photo URLs are often served through a CDN that returns
 * `application/octet-stream` (or no content type) even when the body is a
 * perfectly valid raster image. Trust the bytes first, and never save an HTML
 * error page merely because the response header says `image/*`.
 *
 * The answer comes from the shared sniffer rather than a second local table, and
 * only its `extension` is used: it is derived from the bytes, so a GIF is stored
 * as `.gif` (it used to fall through to `.jpg` and the library then refused the
 * mislabelled file — see the WebP lesson in the workbook notes).
 */
function sniffImage(buffer: Buffer): { contentType: string; extension: string } | null {
  const signature = sniffMediaType(buffer);
  if (!signature || signature.kind !== "image") return null;
  return { contentType: signature.mime, extension: signature.extension };
}

async function getCachedPhoto(root: string, fetchImpl: typeof fetch, source: URL): Promise<CachedPhoto> {
  const sourceUrl = source.toString();
  const cacheKey = hash(sourceUrl);
  const metadataPath = join(photoCacheRoot(root), `${cacheKey}.json`);
  const cached = await readJsonIfPresent<CachedPhoto>(metadataPath);
  if (cached?.sourceUrl === sourceUrl && cached.filename && existsSync(join(root, "workspace", "assets", cached.filename))) return cached;

  const active = photoRequests.get(metadataPath);
  if (active) return active;
  const request = (async () => {
    const response = await fetchImpl(source, {
      signal: AbortSignal.timeout(30_000),
      headers: {
        "user-agent": "GeoStoryStudio/1.0",
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        referer: "https://www.amap.com/"
      }
    });
    if (!response.ok) throw new Error(`图片下载失败 HTTP ${response.status}`);
    const contentTypeHeader = response.headers.get("content-type") || "";
    const contentTypeParts = contentTypeHeader.toLowerCase().split(";");
    const declaredContentType = (contentTypeParts[0] || "").trim();
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 15_000_000) throw new Error("高德图片为空或超过 15MB");
    const detected = sniffImage(buffer);
    if (!detected) {
      const detail = declaredContentType ? `（响应类型：${declaredContentType}）` : "";
      throw new Error(`高德图片响应不是可识别的图片格式${detail}`);
    }
    // Prefer the byte-detected type for extension and metadata. This handles
    // CDNs that label a JPEG as octet-stream while still rejecting HTML.
    const contentType = detected.contentType;
    const filename = `amap-${cacheKey}.${detected.extension}`;
    const assetsRoot = join(root, "workspace", "assets");
    await mkdir(assetsRoot, { recursive: true });
    // Always rewrite atomically rather than trusting `existsSync`: a truncated
    // file left behind by an interrupted download would otherwise be treated as a
    // completed cache entry forever, and this path is only reached on a cache miss.
    await writeFileAtomicResilient(join(assetsRoot, filename), buffer);
    const result: CachedPhoto = {
      sourceUrl,
      filename,
      contentType,
      bytes: buffer.length,
      createdAt: new Date().toISOString()
    };
    await mkdir(photoCacheRoot(root), { recursive: true });
    await writeJsonAtomicResilient(metadataPath, result);
    return result;
  })();
  photoRequests.set(metadataPath, request);
  try { return await request; }
  finally { photoRequests.delete(metadataPath); }
}

function existingPhotoAsset(root: string, project: VideoProject, childId: string, sourceUrl: string): StudioAsset | undefined {
  return project.assets.find((asset) => asset.sourceType === "amap-poi"
    && asset.scope?.childId === childId
    && asset.sourceUrl === sourceUrl
    && asset.path.startsWith("/workspace-assets/")
    && existsSync(join(root, "workspace", "assets", asset.path.slice("/workspace-assets/".length))));
}

async function savePoiPhoto(root: string, fetchImpl: typeof fetch, project: VideoProject, childId: string, childName: string, poi: AmapPoi, photo: AmapPhoto, photoIndex: number): Promise<StudioAsset | null> {
  if (!photo.url) return null;
  const source = new URL(photo.url);
  if (!["http:", "https:"].includes(source.protocol)) return null;
  const existing = existingPhotoAsset(root, project, childId, source.toString());
  if (existing) return existing;
  const cachedPhoto = await getCachedPhoto(root, fetchImpl, source);
  const id = randomUUID();
  const filename = cachedPhoto.filename;
  const assetsRoot = join(root, "workspace", "assets"); await mkdir(assetsRoot, { recursive: true });
  const pointGcj = parseLocation(poi.location); const pointWgs = pointGcj ? gcj02ToWgs84(pointGcj.lng, pointGcj.lat) : null;
  const poiName = String(poi.name || "现场图片");
  const asset: StudioAsset = {
    id, name: `${childName} · ${poiName}${photo.title ? ` · ${photo.title}` : ""}`,
    path: `/workspace-assets/${filename}`, type: "image", sourceType: "amap-poi", sourceUrl: source.toString(), verifiedReal: true,
    prohibitedContent: false, alt: `${childName}的${poiName}`,
    scope: { projectId: project.id, regionId: project.regionId, childId },
    poi: {
      provider: "amap", poiId: String(poi.id || ""), poiName, poiType: String(poi.type || ""), poiTypeCode: String(poi.typecode || ""),
      childId, childName, photoIndex, photoTitle: String(photo.title || ""),
      ...(pointWgs ? { location: [pointWgs.lng, pointWgs.lat] as [number, number] } : {}),
      retrievedAt: new Date().toISOString()
    }
  };
  await writeJsonAtomicResilient(join(assetsRoot, `${id}.asset.json`), asset);
  return asset;
}

async function mapLimit<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length); let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; result[index] = await task(items[index]!, index); }
  });
  await Promise.all(workers); return result;
}

/**
 * Level-one POI groups are the first two digits of a typecode, so the requested
 * `110000` (风景名胜) and a real returned `110100` belong to the same group.
 * Matching on the prefix is what keeps a re-collect from touching a theme the
 * author picked separately.
 */
function poiTypeGroup(code: string | undefined): string {
  return String(code ?? "").slice(0, 2);
}

/**
 * Detach the photos an earlier run bound in these children inside the requested
 * type groups, and report how many placements left the scenes.
 *
 * Only `amap-poi` assets inside those groups are touched: photos the author
 * uploaded, web-evidence photos, and every other type group stay where they are.
 * The asset record itself is kept in `project.assets` — it is shared library
 * stock, and keeping the id stable means re-collecting the same URL reuses the
 * same asset instead of minting a new one and losing the tuned crop/animation.
 */
function unbindChildAmapAssets(project: VideoProject, scenes: StudioScene[], typeCodes: string[]): number {
  const groups = new Set(typeCodes.map((code) => poiTypeGroup(code)));
  let unbound = 0;
  for (const scene of scenes) {
    const childId = String(scene.childId ?? "");
    const stale = new Set(project.assets
      .filter((asset) => asset.sourceType === "amap-poi"
        && String(asset.scope?.childId ?? "") === childId
        && groups.has(poiTypeGroup(asset.poi?.poiTypeCode)))
      .map((asset) => asset.id));
    if (!stale.size) continue;
    scene.placements = (scene.placements || []).filter((placement) => !stale.has(placement.assetId));
    scene.assetIds = (scene.assetIds || []).filter((id) => !stale.has(id));
    unbound += stale.size;
  }
  return unbound;
}

export async function importAmapPoiMaterials(root: string, project: VideoProject, options: AmapPoiImportOptions, fetchImpl: typeof fetch = fetch): Promise<{ project: VideoProject; summary: AmapImportSummary; unboundPlacements: number }> {
  const apiKey = await resolveAmapKey(root, options.apiKey);
  const allowed = new Set(AMAP_POI_TYPES.map((item) => item.code));
  const typeCodes = [...new Set((options.typeCodes || []).filter((code) => allowed.has(code as typeof AMAP_POI_TYPES[number]["code"])))].sort();
  if (!typeCodes.length) throw new Error("请至少选择一种 POI 类型");
  const requestedChildren = new Set((options.childIds || []).map((id) => String(id)));
  const scenes = project.scenes.filter((scene) => scene.section === "child" && scene.childId
    && (requestedChildren.size === 0 || requestedChildren.has(String(scene.childId))));
  if (!scenes.length) throw new Error("没有匹配的下级行政区场景，无法采集素材");
  const region = JSON.parse(await readFile(join(root, "data", "regions", `${project.regionId}.json`), "utf8")) as { childGeometryPath?: string };
  if (!region.childGeometryPath) throw new Error("当前乡镇没有下级行政边界文件，无法按范围采集素材");
  const collection = JSON.parse(await readFile(join(root, region.childGeometryPath), "utf8")) as { features?: ChildFeature[] };
  const features = collection.features || [];
  const byId = new Map(features.map((feature) => [String(feature.properties?.id || feature.properties?.adcode || ""), feature]));
  const unboundPlacements = options.mode === "unbind" ? unbindChildAmapAssets(project, scenes, typeCodes) : 0;
  const runChildren: AmapImportSummary["children"] = [];
  let totalPois = 0; let totalPhotos = 0;
  for (const scene of scenes) {
    const childId = scene.childId!; const childName = scene.childName || scene.title; const feature = byId.get(childId);
    if (!feature) { runChildren.push({ childId, childName, poiCount: 0, photoCount: 0, error: "未找到对应边界" }); continue; }
    try {
      const pois = await queryAllPoisCached(root, fetchImpl, apiKey, feature, typeCodes, String(options.keyword || "").trim());
      const photoRows = pois.flatMap((poi) => (Array.isArray(poi.photos) ? poi.photos : []).map((photo, photoIndex) => ({ poi, photo, photoIndex })))
        .filter((row) => Boolean(row.photo.url));
      const uniqueRows = [...new Map(photoRows.map((row) => [row.photo.url!, row])).values()];
      const photoErrors: string[] = [];
      const downloaded = (await mapLimit(uniqueRows, 4, async (row) => {
        try { return await savePoiPhoto(root, fetchImpl, project, childId, childName, row.poi, row.photo, row.photoIndex); }
        catch (error) {
          photoErrors.push(error instanceof Error ? error.message : String(error));
          return null;
        }
      })).filter((asset): asset is StudioAsset => Boolean(asset));
      scene.placements ||= []; scene.assetIds ||= [];
      for (const asset of downloaded) {
        if (!project.assets.some((item) => item.id === asset.id)) project.assets.push(asset);
        if (!scene.assetIds.includes(asset.id)) scene.assetIds.push(asset.id);
        if (!scene.placements.some((placement) => placement.assetId === asset.id)) scene.placements.push(defaultPlacement(asset, scene));
      }
      totalPois += pois.length; totalPhotos += downloaded.length;
      const photoError = photoErrors.length
        ? downloaded.length
          ? `已跳过 ${photoErrors.length} 张无法下载或识别的图片：${photoErrors[0]}`
          : photoErrors[0]
        : undefined;
      runChildren.push({ childId, childName, poiCount: pois.length, photoCount: downloaded.length, ...(photoError ? { error: photoError } : {}) });
    } catch (error) {
      runChildren.push({ childId, childName, poiCount: 0, photoCount: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }
  // Merge instead of replace: a village-scoped run must not wipe the coverage
  // record of the villages it never looked at.
  const merged = new Map<string, AmapImportSummary["children"][number]>();
  for (const entry of project.poiImport?.children || []) merged.set(String(entry.childId), entry);
  for (const entry of runChildren) merged.set(String(entry.childId), entry);
  const children = project.scenes
    .filter((scene) => scene.section === "child" && scene.childId)
    .map((scene) => merged.get(String(scene.childId)))
    .filter((entry): entry is AmapImportSummary["children"][number] => Boolean(entry));
  const summary: AmapImportSummary = {
    enabled: true, provider: "amap", typeCodes, keyword: String(options.keyword || "").trim(), importedAt: new Date().toISOString(),
    totalPois, totalPhotos, children
  };
  project.poiImport = summary;
  return { project, summary, unboundPlacements };
}
