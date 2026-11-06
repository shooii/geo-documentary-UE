import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { fetch, ProxyAgent, type Dispatcher } from 'undici';

export class ImageryError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
type Settings = { map?: Record<string, unknown> };
export class ImageryService {
  private readonly cache = new Map<string, { bytes: Buffer; type: string; expires: number }>();
  private readonly pending = new Map<string, Promise<{ bytes: Buffer; type: string; expires: number }>>();
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
  private async source(provider: string, z: number, x: number, y: number): Promise<URL> {
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
    throw new ImageryError(400, '该卫星影像源尚未接入 UE，请选择 Esri 或 Mapbox。');
  }
  async descriptor(provider: string, origin: string) {
    await this.source(provider, 0, 0, 0); // Validate configuration without returning credentials.
    return {
      provider,
      tileTemplate: `${origin}/api/imagery/${provider}/{z}/{x}/{y}`,
      attribution: provider === 'mapbox-satellite' ? '© Mapbox © OpenStreetMap' : 'Esri World Imagery'
    };
  }
  async tile(provider: string, z: number, x: number, y: number) {
    if (![z, x, y].every(Number.isSafeInteger) || z < 0 || z > 22 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
      throw new ImageryError(400, '影像瓦片坐标无效');
    }
    const url = await this.source(provider, z, x, y);
    const key = url.href;
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
        const reason = [401, 403].includes(response.status) ? 'Mapbox 访问令牌无效、已受限或没有访问权限。' : `卫星影像服务返回 HTTP ${response.status}`;
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
