import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { loadScene, within } from './scene.js';
import { labelPlate } from './label-plate.js';
import { ImageryService, ImageryError } from './imagery.js';
import { DEFAULT_IMAGERY_PROVIDER } from '../../packages/project-schema/index.js';

const root = resolve(process.cwd());
const publicRoot = resolve(root, 'apps/ue-player/public');
const port = Number(process.argv.find(x => x.startsWith('--port='))?.split('=')[1] ?? process.env.UE_PLAYER_PORT ?? 4174);
const signallingUrl = process.env.UE_SIGNALLING_URL || 'ws://127.0.0.1:8888';
const imagery = new ImageryService(root);
async function readJsonBody(request: IncomingMessage, limit = 4096) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > limit) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {} as Record<string, unknown>;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}
// One UE instance drives one video stream, and the streamer only accepts a single
// subscriber. Without a lease two open windows keep evicting each other and both look
// broken. The first window holds this slot; later ones are told the instance is busy
// and poll until the holder releases it (or its heartbeat times out), then join by
// themselves — no manual reconnect.
let viewerSlot: { id: string; seen: number } = { id: '', seen: 0 };
const VIEWER_SLOT_TTL = 12000;
const viewerSlotFree = () => !viewerSlot.id || Date.now() - viewerSlot.seen > VIEWER_SLOT_TTL;
await build({ entryPoints: [resolve(root, 'apps/ue-player/client.ts')], outfile: resolve(publicRoot, 'player.js'), bundle: true, format: 'esm', sourcemap: true, target: 'es2022' });
createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/runtime-config.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      // The page drives the camera, so it has to send frames at the same rate the
      // renderer streams them; the cap lives in one env var (GEO_STREAM_FPS) and both
      // ends read it, otherwise the two clocks fight and the motion judders.
      const streamFps = Number(process.env.GEO_STREAM_FPS || 0) || 30;
      res.end(JSON.stringify({ engine: 'unreal', version: '5.7', signallingUrl, streamFps })); return;
    }
    if (url.pathname === '/api/imagery-descriptor') {
      // Used when the basemap is switched from the studio: only the tile source is
      // resolved, the scene stays exactly as it is and no reconnect is needed.
      const session = url.searchParams.get('session') || randomUUID();
      const source = await imagery.descriptor(url.searchParams.get('imagery') || DEFAULT_IMAGERY_PROVIDER, `http://127.0.0.1:${port}`, session);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(source)); return;
    }
    if (url.pathname === '/api/viewer-slot' || url.pathname === '/api/viewer-slot/release') {
      const body = await readJsonBody(req);
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ granted: false, error: '缺少窗口标识' })); return;
      }
      if (url.pathname === '/api/viewer-slot/release') {
        if (viewerSlot.id === id) viewerSlot = { id: '', seen: 0 };
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end(); return;
      }
      if (viewerSlot.id === id || viewerSlotFree()) {
        viewerSlot = { id, seen: Date.now() };
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ granted: true })); return;
      }
      res.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ granted: false, busy: true, since: viewerSlot.seen })); return;
    }
    if (url.pathname === '/api/scene') {
      const scene = await loadScene(root, url.searchParams.get('region') || '', url.searchParams.get('boundary'));
      const plates = new Map<string, string>();
      const ensurePlate = async (name: string | undefined) => {
        if (!name) return '';
        if (!plates.has(name)) plates.set(name, await labelPlate(root, name));
        return plates.get(name)!;
      };
      scene.region.labelPlate = await ensurePlate(scene.region.name);
      for (const layer of scene.layers || []) {
        if (layer.parent) continue;
        const name = layer.properties?.name;
        if (name) layer.properties.labelPlate = await ensurePlate(name);
      }
      const session = url.searchParams.get('session') || randomUUID();
      const source = await imagery.descriptor(url.searchParams.get('imagery') || DEFAULT_IMAGERY_PROVIDER, `http://127.0.0.1:${port}`, session);
      if (process.env.GEO_ACCESS_LOG) console.log(`GEO_SCENE ${url.search} -> ${source.provider} ${source.tileTemplate}`);
      if (url.searchParams.get('warm') === '1' && Array.isArray(scene.region.center)) {
        imagery.warmCenter(source.provider, session, Number(scene.region.center[0]), Number(scene.region.center[1]));
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ...scene, imagery: source })); return;
    }
    const tile = /^\/api\/imagery\/([\w-]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(url.pathname);
    if (tile) {
      const result = await imagery.tile(tile[1]!, Number(tile[2]), Number(tile[3]), Number(tile[4]), url.searchParams.get('session') || '');
      if (process.env.GEO_ACCESS_LOG) console.log(`GEO_TILE ${url.pathname} ${result.type} ${result.bytes.length}`);
      res.writeHead(200, { 'content-type': result.type, 'cache-control': 'private, max-age=3600' });
      res.end(result.bytes); return;
    }
    const file = within(publicRoot, decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1)));
    const bytes = await readFile(file);
    res.writeHead(200, { 'content-type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.map': 'application/json' } as Record<string, string>)[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(bytes);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    res.writeHead(error instanceof ImageryError ? error.status : missing ? 404 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error instanceof ImageryError ? error.message : missing ? '场景数据或文件不存在' : '地图请求处理失败' }));
  }
}).listen(port, '127.0.0.1', () => console.log(`UE_PLAYER http://127.0.0.1:${port}`));
