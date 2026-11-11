import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { parse } from 'yaml';
import { fetch, ProxyAgent, type Dispatcher } from 'undici';

export class ImageryError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
/** `.env.local` is read directly: the player is often started without a shell that exported it. */
async function localEnv(root: string) {
  const local = await readFile(join(root, '.env.local'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return parseEnv(local) as Record<string, string | undefined>;
}
async function secret(root: string, env: NodeJS.ProcessEnv, key: string) {
  return env[key]?.trim() || (await localEnv(root))[key]?.trim() || '';
}
export async function ionToken(root: string, env: NodeJS.ProcessEnv) {
  return secret(root, env, 'CESIUM_ION_TOKEN');
}

type BingTiles = { template: string; subdomains: string[]; culture: string; attribution: string };

function httpsUrl(value: string, base?: URL) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password) throw new ImageryError(502, 'Cesium ion 返回的影像地址无效。');
  return url;
}

async function json(url: URL, dispatcher?: Dispatcher, authorization?: string) {
  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      ...(dispatcher ? { dispatcher } : {}),
      ...(authorization ? { headers: { Authorization: 'Bearer ' + authorization } } : {})
    });
  } catch {
    throw new ImageryError(502, '无法连接 Cesium ion 影像服务。');
  }
  if (!response.ok) {
    await response.body?.cancel();
    const denied = response.status === 401 || response.status === 403;
    throw new ImageryError(502, denied ? 'Cesium ion 令牌无效或没有影像资产的读取权限。' : 'Cesium ion 影像服务返回 HTTP ' + response.status);
  }
  return response.json();
}

async function bingMetadata(base: URL, key: string, style: string, culture: string, dispatcher?: Dispatcher, mapLayer?: string): Promise<BingTiles> {
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const metadata = httpsUrl('REST/v1/Imagery/Metadata/' + encodeURIComponent(style || 'Aerial'), base);
  metadata.searchParams.set('incl', 'ImageryProviders');
  metadata.searchParams.set('key', key);
  metadata.searchParams.set('uriScheme', 'https');
  if (mapLayer) metadata.searchParams.set('mapLayer', mapLayer);
  if (culture) metadata.searchParams.set('culture', culture);
  const data = await json(metadata, dispatcher) as {
    resourceSets?: { resources?: { imageUrl?: string; imageUrlSubdomains?: string[]; imageryProviders?: { attribution?: string }[] }[] }[];
  };
  const imagery = data.resourceSets?.[0]?.resources?.[0];
  if (!imagery?.imageUrl?.includes('{quadkey}') || !imagery.imageUrlSubdomains?.length) {
    throw new ImageryError(502, 'Bing Maps 影像缺少可用的瓦片地址。');
  }
  const names = new Set(['Microsoft Bing Maps']);
  for (const provider of imagery.imageryProviders ?? []) {
    const credit = provider.attribution?.replace(/<[^>]*>/g, '').replace(/&copy;/gi, '©').replace(/&amp;/gi, '&').trim();
    if (credit) names.add(credit);
  }
  return { template: imagery.imageUrl, subdomains: imagery.imageUrlSubdomains, culture: culture || '', attribution: [...names].join(' · ') };
}

export async function resolveIonTiles(assetId: number, token: string, dispatcher?: Dispatcher): Promise<BingTiles> {
  const endpoint = await json(new URL('https://api.cesium.com/v1/assets/' + assetId + '/endpoint'), dispatcher, token) as {
    type?: string; externalType?: string;
    options?: { url?: string; key?: string; mapStyle?: string; culture?: string; mapLayer?: string };
  };
  const options = endpoint.options;
  if (endpoint.type !== 'IMAGERY' || endpoint.externalType !== 'BING' || !options?.url || !options.key) {
    throw new ImageryError(502, 'Cesium ion 资产未返回 Bing Maps 航拍影像。');
  }
  const tiles = await bingMetadata(httpsUrl(options.url), options.key, options.mapStyle || 'Aerial', options.culture || '', dispatcher, options.mapLayer);
  // The attribution of an ion asset is credited to the asset, not just to Bing.
  return { ...tiles, attribution: ['Cesium ion', tiles.attribution].join(' · ') };
}

/** 天地图 `img` 影像（EPSG:3857 球面墨卡托，即旧项目使用的同一套瓦片）。 */
export function tiandituTile(token: string, z: number, x: number, y: number) {
  const subdomain = (x + y) % 8;
  const url = new URL(`https://t${subdomain}.tianditu.gov.cn/img_w/wmts`);
  url.searchParams.set('SERVICE', 'WMTS');
  url.searchParams.set('REQUEST', 'GetTile');
  url.searchParams.set('VERSION', '1.0.0');
  url.searchParams.set('LAYER', 'img');
  url.searchParams.set('STYLE', 'default');
  url.searchParams.set('TILEMATRIXSET', 'w');
  url.searchParams.set('FORMAT', 'tiles');
  url.searchParams.set('TILEMATRIX', String(z));
  url.searchParams.set('TILEROW', String(y));
  url.searchParams.set('TILECOL', String(x));
  url.searchParams.set('tk', token);
  return url;
}

/**
 * 天地图 `cia` 影像注记（地名/道路名）瓦片。
 *
 * 和 `img` 同属 EPSG:3857 的 `w` 矩阵集，同一套 z/x/y 编号 —— 服务端返回的仍是
 * 256 px 位图。Cesium 版靠把瓦片声明成 512 px 让请求层级整体低一级、每张瓦片被
 * 放大两倍来读清 9–10 px 的地名；UE 版用的是同一招（见 AGeoMap::RefreshAnnotations
 * 取父级 key），所以这里只需要原样代理瓦片。
 */
export function tiandituAnnotationTile(token: string, z: number, x: number, y: number) {
  const subdomain = (x + y) % 8;
  const url = new URL(`https://t${subdomain}.tianditu.gov.cn/cia_w/wmts`);
  url.searchParams.set('SERVICE', 'WMTS');
  url.searchParams.set('REQUEST', 'GetTile');
  url.searchParams.set('VERSION', '1.0.0');
  url.searchParams.set('LAYER', 'cia');
  url.searchParams.set('STYLE', 'default');
  url.searchParams.set('TILEMATRIXSET', 'w');
  url.searchParams.set('FORMAT', 'tiles');
  url.searchParams.set('TILEMATRIX', String(z));
  url.searchParams.set('TILEROW', String(y));
  url.searchParams.set('TILECOL', String(x));
  url.searchParams.set('tk', token);
  return url;
}

export function ionTileUrl(tiles: BingTiles, z: number, x: number, y: number) {
  let key = '';
  for (let bit = z - 1; bit >= 0; bit--) key += String(((x >> bit) & 1) + 2 * ((y >> bit) & 1));
  const subdomain = tiles.subdomains[(x + y + z) % tiles.subdomains.length]!;
  const url = httpsUrl(tiles.template.replaceAll('{quadkey}', key).replaceAll('{subdomain}', subdomain).replaceAll('{culture}', tiles.culture));
  url.searchParams.set('n', 'z');
  return url;
}

type Settings = { map?: Record<string, unknown> };
/**
 * Pseudo-provider for the 天地图 `cia` annotation tiles. It is not a basemap — it is a
 * second layer over one — but it goes through the same proxy/cache/UA path, because
 * 天地图 rejects the default Node UA on this endpoint exactly as it does on `img`.
 */
export const ANNOTATION_PROVIDER = 'tianditu-annotation';
export class ImageryService {
  private readonly cache = new Map<string, { bytes: Buffer; type: string; expires: number }>();
  private cacheBytes = 0;
  private readonly pending = new Map<string, Promise<{ bytes: Buffer; type: string; expires: number }>>();
  private readonly ionSessions = new Map<string, Promise<BingTiles>>();
  private readonly bingSessions = new Map<string, Promise<BingTiles>>();
  private readonly dispatcher: Dispatcher | undefined;
  constructor(private readonly root: string, private readonly env: NodeJS.ProcessEnv = process.env, dispatcher?: Dispatcher) {
    const proxy = env.UE_HTTP_PROXY || env.HTTPS_PROXY || env.HTTP_PROXY;
    this.dispatcher = dispatcher ?? (proxy ? new ProxyAgent(proxy) : undefined);
  }
  private async settings() {
    const text = await readFile(join(this.root, 'config/project.yaml'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''; throw error;
    });
    return (parse(text) as Settings | null)?.map || {};
  }
  private async ionTiles(session: string) {
    if (!/^[\w-]{1,64}$/.test(session)) throw new ImageryError(400, '缺少 Cesium ion 影像会话。');
    const existing = this.ionSessions.get(session);
    if (existing) return existing;
    const tiles = (async () => {
      const settings = await this.settings();
      const token = await ionToken(this.root, this.env) || String(settings.cesium_ion_token || '').trim();
      if (!token) throw new ImageryError(503, 'Cesium ion 尚未配置访问令牌，请在本机 .env.local 设置 CESIUM_ION_TOKEN。');
      const assetId = Number(settings.imagery_ion_asset_id || 2);
      if (!Number.isSafeInteger(assetId) || assetId < 1) throw new ImageryError(400, 'Cesium ion 影像资产编号无效。');
      return resolveIonTiles(assetId, token, this.dispatcher);
    })();
    this.ionSessions.set(session, tiles);
    if (this.ionSessions.size > 16) this.ionSessions.delete(this.ionSessions.keys().next().value!);
    try { return await tiles; }
    catch (error) { if (this.ionSessions.get(session) === tiles) this.ionSessions.delete(session); throw error; }
  }
  private async source(provider: string, z: number, x: number, y: number, session: string): Promise<URL> {
    if (provider === 'cesium-ion-world-imagery') return ionTileUrl(await this.ionTiles(session), z, x, y);
    const settings = await this.settings();
    if (provider === 'tianditu-imagery') {
      const key = await secret(this.root, this.env, 'TIANDITU_TOKEN') || String(settings.tianditu_token || '').trim();
      if (!key) throw new ImageryError(503, '天地图尚未配置访问令牌，请在本机 .env.local 设置 TIANDITU_TOKEN。');
      return tiandituTile(key, z, x, y);
    }
    if (provider === ANNOTATION_PROVIDER) {
      const key = await secret(this.root, this.env, 'TIANDITU_TOKEN') || String(settings.tianditu_token || '').trim();
      if (!key) throw new ImageryError(503, '天地图尚未配置访问令牌，请在本机 .env.local 设置 TIANDITU_TOKEN。');
      return tiandituAnnotationTile(key, z, x, y);
    }
    if (provider === 'bing-aerial') {
      const key = await secret(this.root, this.env, 'BING_MAPS_KEY') || String(settings.bing_maps_key || '').trim();
      if (!key) throw new ImageryError(503, '必应卫星尚未配置 Bing Maps Key，请设置 BING_MAPS_KEY 或项目影像配置。');
      const style = String(settings.bing_map_style || 'Aerial');
      const cacheKey = `${style}:${key}`;
      let tiles = this.bingSessions.get(cacheKey);
      if (!tiles) {
        tiles = bingMetadata(new URL('https://dev.virtualearth.net'), key, style, '', this.dispatcher);
        const pending = tiles;
        this.bingSessions.set(cacheKey, pending);
        pending.catch(() => { if (this.bingSessions.get(cacheKey) === pending) this.bingSessions.delete(cacheKey); });
      }
      return ionTileUrl(await tiles, z, x, y);
    }
    if (provider === 'esri-world-imagery') {
      const base = String(settings.esri_world_imagery_url || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer').replace(/\/$/, '');
      const url = new URL(`${base}/tile/${z}/${y}/${x}`);
      if (url.protocol !== 'https:') throw new ImageryError(400, '卫星影像服务必须使用 HTTPS');
      return url;
    }
    if (provider === 'mapbox-satellite') {
      // Every other provider goes through `secret()`, which falls back to .env.local; Mapbox
      // read process.env alone, so a token that only lived in .env.local (where the project
      // keeps its keys) still reported "not configured". Same lookup as the rest.
      const token = (await secret(this.root, this.env, 'MAPBOX_ACCESS_TOKEN')).trim()
        || String(settings.mapbox_access_token || '').trim();
      if (!token) throw new ImageryError(503, 'Mapbox 尚未配置访问令牌，请设置 MAPBOX_ACCESS_TOKEN 或项目影像配置。');
      let style = String(settings.mapbox_map_id || 'mapbox/satellite-v9');
      if (style === 'mapbox.satellite') style = 'mapbox/satellite-v9';
      if (!style.includes('/')) style = `mapbox/${style}`;
      if (!/^[\w-]+\/[\w-]+$/.test(style)) throw new ImageryError(400, 'Mapbox 地图样式配置无效');
      const url = new URL(`https://api.mapbox.com/styles/v1/${style}/tiles/256/${z}/${x}/${y}`);
      url.searchParams.set('access_token', token);
      return url;
    }
    throw new ImageryError(400, '该卫星影像源尚未接入 UE，请选择 Esri、天地图、Mapbox、Bing 或 Cesium ion。');
  }
  async descriptor(provider: string, origin: string, session = '') {
    const tileTemplate = `${origin}/api/imagery/${provider}/{z}/{x}/{y}`;
    if (provider === 'cesium-ion-world-imagery') {
      const tiles = await this.ionTiles(session);
      return { provider, tileTemplate: `${tileTemplate}?session=${session}`, attribution: tiles.attribution };
    }
    await this.source(provider, 0, 0, 0, session);
    const credit: Record<string, string> = {
      'mapbox-satellite': '© Mapbox © OpenStreetMap',
      'tianditu-imagery': '© 天地图',
      'bing-aerial': '© Microsoft Bing Maps',
      'esri-world-imagery': 'Esri World Imagery'
    };
    return { provider, tileTemplate, attribution: credit[provider] || 'Esri World Imagery' };
  }
  /**
   * The annotation layer only exists on top of 天地图 imagery: the same `w` tile matrix
   * and the same key, so any other basemap gets no template and the runtime reports
   * zero supported windows rather than drawing a mismatched label grid.
   */
  async annotationTemplate(provider: string, origin: string) {
    if (provider !== 'tianditu-imagery') return '';
    const settings = await this.settings();
    const key = await secret(this.root, this.env, 'TIANDITU_TOKEN') || String(settings.tianditu_token || '').trim();
    if (!key) return '';
    return `${origin}/api/imagery/${ANNOTATION_PROVIDER}/{z}/{x}/{y}`;
  }
  warmCenter(provider: string, session: string, lon: number, lat: number) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    const longitude = ((lon + 180) % 360 + 360) % 360 / 360;
    const latitude = Math.max(-85, Math.min(85, lat)) * Math.PI / 180;
    const row = (1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2;
    for (const z of [2, 6]) {
      const count = 2 ** z;
      void this.tile(provider, z, Math.floor(longitude * count), Math.floor(row * count), session).catch(() => undefined);
    }
  }
  async tile(provider: string, z: number, x: number, y: number, session = '') {
    if (![z, x, y].every(Number.isSafeInteger) || z < 0 || z > 22 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
      throw new ImageryError(400, '影像瓦片坐标无效');
    }
    const url = await this.source(provider, z, x, y, session);
    const ion = provider === 'cesium-ion-world-imagery';
    const key = ion ? `${session}/${z}/${x}/${y}` : url.href;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      if (cached.expires > Date.now()) { this.cache.set(key, cached); return cached; }
      this.cacheBytes -= cached.bytes.length;
    }
    const existing = this.pending.get(key);
    if (existing) return existing;
    const request = (async () => {
      let response;
      // 天地图对非浏览器 UA 直接返回 403（与 Referer 无关），而 Node 的默认 UA
      // 正是 `undici`；这里统一伪装成普通浏览器，影像服务本身都在本机代理后面。
      const headers: Record<string, string> = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' };
      if (provider === 'tianditu-imagery' || provider === ANNOTATION_PROVIDER) headers.referer = 'http://127.0.0.1/';
      try { response = await fetch(url, { signal: AbortSignal.timeout(20000), headers, ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}) }); }
      catch { throw new ImageryError(502, '卫星影像服务连接失败，请检查网络或 UE_HTTP_PROXY 代理配置。'); }
      if (!response.ok) {
        await response.body?.cancel();
        const reason = [401, 403].includes(response.status)
          ? provider === 'mapbox-satellite' ? 'Mapbox 访问令牌无效、已受限或没有访问权限。'
            : `${ion ? 'Cesium ion' : 'Esri'} 影像请求未获授权。`
          : `卫星影像服务返回 HTTP ${response.status}`;
        if (ion && [401, 403].includes(response.status)) this.ionSessions.delete(session);
        throw new ImageryError(502, reason);
      }
      // 天地图返回的是 `image/jpg`（不是标准写法 `image/jpeg`），只按白名单精确匹配
      // 会把它判成“没有返回图片”。这里归一化后再判断大类。
      const rawType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || '';
      const type = rawType === 'image/jpg' ? 'image/jpeg' : rawType;
      if (!type.startsWith('image/')) {
        await response.body?.cancel(); throw new ImageryError(502, '影像服务未返回有效图片');
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 4 * 1024 * 1024) throw new ImageryError(502, '影像瓦片超出大小限制');
      const result = { bytes, type, expires: Date.now() + 3600000 };
      this.cache.set(key, result);
      this.cacheBytes += bytes.length;
      while (this.cache.size > 1024 || this.cacheBytes > 64 * 1024 * 1024) {
        const oldest = this.cache.keys().next().value!;
        this.cacheBytes -= this.cache.get(oldest)!.bytes.length;
        this.cache.delete(oldest);
      }
      return result;
    })();
    this.pending.set(key, request);
    try { return await request; } finally { this.pending.delete(key); }
  }
  async close() { await this.dispatcher?.close(); }
}
