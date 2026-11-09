import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { loadScene, within } from './scene.js';
import { ImageryService, ImageryError } from './imagery.js';
import { DEFAULT_IMAGERY_PROVIDER } from '../../packages/project-schema/index.js';

const root = resolve(process.cwd());
const publicRoot = resolve(root, 'apps/ue-player/public');
const port = Number(process.argv.find(x => x.startsWith('--port='))?.split('=')[1] ?? process.env.UE_PLAYER_PORT ?? 4174);
const signallingUrl = process.env.UE_SIGNALLING_URL || 'ws://127.0.0.1:8888';
const imagery = new ImageryService(root);
await build({ entryPoints: [resolve(root, 'apps/ue-player/client.ts')], outfile: resolve(publicRoot, 'player.js'), bundle: true, format: 'esm', sourcemap: true, target: 'es2022' });
createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/runtime-config.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ engine: 'unreal', version: '5.7', signallingUrl })); return;
    }
    if (url.pathname === '/api/scene') {
      const scene = await loadScene(root, url.searchParams.get('region') || '', url.searchParams.get('boundary'));
      const session = url.searchParams.get('session') || randomUUID();
      const source = await imagery.descriptor(url.searchParams.get('imagery') || DEFAULT_IMAGERY_PROVIDER, `http://127.0.0.1:${port}`, session);
      if (url.searchParams.get('warm') === '1' && Array.isArray(scene.region.center)) {
        imagery.warmCenter(source.provider, session, Number(scene.region.center[0]), Number(scene.region.center[1]));
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ...scene, imagery: source })); return;
    }
    const tile = /^\/api\/imagery\/([\w-]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(url.pathname);
    if (tile) {
      const result = await imagery.tile(tile[1]!, Number(tile[2]), Number(tile[3]), Number(tile[4]), url.searchParams.get('session') || '');
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
