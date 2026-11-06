import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { parse } from 'yaml';
import { fetch, ProxyAgent, type Dispatcher } from 'undici';

export class ImageryError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export async function ionToken(root: string, env: NodeJS.ProcessEnv) {
  if (env.CESIUM_ION_TOKEN?.trim()) return env.CESIUM_ION_TOKEN.trim();
  const local = await readFile(join(root, '.env.local'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return parseEnv(local).CESIUM_ION_TOKEN?.trim() || '';
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

export async function resolveIonTiles(assetId: number, token: string, dispatcher?: Dispatcher): Promise<BingTiles> {
  const endpoint = await json(new URL('https://api.cesium.com/v1/assets/' + assetId + '/endpoint'), dispatcher, token) as {
    type?: string; externalType?: string;
    options?: { url?: string; key?: string; mapStyle?: string; culture?: string; mapLayer?: string };
  };
  const options = endpoint.options;
  if (endpoint.type !== 'IMAGERY' || endpoint.externalType !== 'BING' || !options?.url || !options.key) {
    throw new ImageryError(502, 'Cesium ion 资产未返回 Bing Maps 航拍影像。');
  }

  const base = httpsUrl(options.url);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const metadata = httpsUrl('REST/v1/Imagery/Metadata/' + encodeURIComponent(options.mapStyle || 'Aerial'), base);
  metadata.searchParams.set('incl', 'ImageryProviders');
  metadata.searchParams.set('key', options.key);
  metadata.searchParams.set('uriScheme', 'https');
  if (options.mapLayer) metadata.searchParams.set('mapLayer', options.mapLayer);
  if (options.culture) metadata.searchParams.set('culture', options.culture);
  const data = await json(metadata, dispatcher) as {
    resourceSets?: { resources?: { imageUrl?: string; imageUrlSubdomains?: string[]; imageryProviders?: { attribution?: string }[] }[] }[];
  };
  const imagery = data.resourceSets?.[0]?.resources?.[0];
  if (!imagery?.imageUrl?.includes('{quadkey}') || !imagery.imageUrlSubdomains?.length) {
    throw new ImageryError(502, 'Cesium ion 影像缺少可用的瓦片地址。');
  }
  const names = new Set(['Cesium ion', 'Microsoft Bing Maps']);
  for (const provider of imagery.imageryProviders ?? []) {
    const credit = provider.attribution?.replace(/<[^>]*>/g, '').replace(/&copy;/gi, '©').replace(/&amp;/gi, '&').trim();
    if (credit) names.add(credit);
  }
  return { template: imagery.imageUrl, subdomains: imagery.imageUrlSubdomains, culture: options.culture || '', attribution: [...names].join(' · ') };
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
export class ImageryService {
  private readonly cache = new Map<string, { bytes: Buffer; type: string; expires: number }>();
  private readonly pending = new Map<string, Promise<{ bytes: Buffer; type: string; expires: number }>>();
  private readonly ionSessions = new Map<string, Promise<BingTiles>>();
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
    if (provider === 'esri-world-imagery') {
      const base = String(settings.esri_world_imagery_url || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer').replace(/\/$/, '');
      const url = new URL(`${base}/tile/${z}/${y}/${x}`);
      if (url.protocol !== 'https:') throw new ImageryError(400, '卫星影像服务必须使用 HTTPS');
      return url;
    }
    if (provider === 'mapbox-satellite') {
      const token = this.env.MAPBOX_ACCESS_TOKEN ?? String(settings.mapbox_access_token || '');
      if (!token.trim()) throw new ImageryError(503, 'Mapbox 尚未配置访问令牌，请设置 MAPBOX_ACCESS_TOKEN 或项目影像配置。');
      let style = String(settings.mapbox_map_id || 'mapbox/satellite-v9');
      if (style === 'mapbox.satellite') style = 'mapbox/satellite-v9';
      if (!style.includes('/')) style = `mapbox/${style}`;
      if (!/^[\w-]+\/[\w-]+$/.test(style)) throw new ImageryError(400, 'Mapbox 地图样式配置无效');
      const url = new URL(`https://api.mapbox.com/styles/v1/${style}/tiles/256/${z}/${x}/${y}`);
      url.searchParams.set('access_token', token);
      return url;
    }
    throw new ImageryError(400, '该卫星影像源尚未接入 UE，请选择 Cesium ion、Esri 或 Mapbox。');
  }
  async descriptor(provider: string, origin: string, session = '') {
    const tileTemplate = `${origin}/api/imagery/${provider}/{z}/{x}/{y}`;
    if (provider === 'cesium-ion-world-imagery') {
      const tiles = await this.ionTiles(session);
      return { provider, tileTemplate: `${tileTemplate}?session=${session}`, attribution: tiles.attribution };
    }
    await this.source(provider, 0, 0, 0, session);
    return { provider, tileTemplate, attribution: provider === 'mapbox-satellite' ? '© Mapbox © OpenStreetMap' : 'Esri World Imagery' };
  }
  async tile(provider: string, z: number, x: number, y: number, session = '') {
    if (![z, x, y].every(Number.isSafeInteger) || z < 0 || z > 22 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
      throw new ImageryError(400, '影像瓦片坐标无效');
    }
    const url = await this.source(provider, z, x, y, session);
    const ion = provider === 'cesium-ion-world-imagery';
    const key = ion ? `${session}/${z}/${x}/${y}` : url.href;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) { this.cache.delete(key); this.cache.set(key, cached); return cached; }
    const existing = this.pending.get(key);
    if (existing) return existing;
    const request = (async () => {
      let response;
      try { response = await fetch(url, { signal: AbortSignal.timeout(20000), ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}) }); }
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
      const type = response.headers.get('content-type')?.split(';')[0] || '';
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) {
        await response.body?.cancel(); throw new ImageryError(502, '影像服务未返回有效图片');
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 4 * 1024 * 1024) throw new ImageryError(502, '影像瓦片超出大小限制');
      const result = { bytes, type, expires: Date.now() + 3600000 };
      this.cache.set(key, result);
      while (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
      return result;
    })();
    this.pending.set(key, request);
    try { return await request; } finally { this.pending.delete(key); }
  }
  async close() { await this.dispatcher?.close(); }
}
