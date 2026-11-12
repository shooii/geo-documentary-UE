/**
 * 瓦片预抓：把一次导出会用到的天地图影像 + cia 注记瓦片提前灌进
 * ImageryService 的磁盘缓存（workspace/imagery-cache）。录制期 UE 的瓦片
 * 请求走本地 server，命中磁盘缓存后不再回源 —— 每帧 HTTP 抖动和 429 重试
 * 都消失，同一区域二次导出即完全离线。
 *
 * 预抓集合是「兴趣点 × 层级 × 半径」的保守覆盖：UE 的 RefreshTiles 以相机
 * 目标点为中心开 12 格窗口、层级 3..15，逐帧精确预抓需要整个 render-spec，
 * 这里按镇中心 + 每个村的 labelPoint，在高频层级抓一个能覆盖巡游镜头的
 * 窗口。漏掉的瓦片由磁盘缓存兜底（首次回源后即持久）。
 *
 * 用法：tsx scripts/imagery-precache.ts --region 440882112 [--imagery tianditu-imagery]
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ImageryService } from '../apps/ue-player/imagery.js';

const root = resolve(process.cwd());
const option = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] || fallback : fallback;
};
const region = option('region');
if (!/^[\w-]+$/.test(region)) throw new Error('A valid --region is required');
const imagery = option('imagery', 'tianditu-imagery');

const data = JSON.parse(await readFile(join(root, 'data/regions', `${region}.json`), 'utf8'));
const points: [number, number][] = [];
if (Array.isArray(data.center)) points.push([Number(data.center[0]), Number(data.center[1])]);
if (Array.isArray(data.labelPoint)) points.push([Number(data.labelPoint[0]), Number(data.labelPoint[1])]);
for (const child of data.childRegions ?? []) {
  const p = child.labelPoint ?? child.center;
  if (Array.isArray(p)) points.push([Number(p[0]), Number(p[1])]);
}
if (!points.length) throw new Error(`${region}.json 缺少 center/labelPoint，无法定位预抓范围`);
console.log(`PRECACHE region=${region} imagery=${imagery} points=${points.length}`);

// 层级 × 半径：越高频的巡游层级窗口越大。UE 取父级做注记（Z-1），so annotation
// levels overlap the imagery's and both are fetched here.
const LEVELS: [number, number][] = [
  [15, 4], [14, 4], [13, 3], [12, 3], [11, 2], [10, 2], [9, 1], [8, 1], [6, 1], [4, 0], [3, 0],
];
const tileAt = (lon: number, lat: number, z: number) => {
  const n = 2 ** z;
  const x = Math.floor((((lon + 180) % 360) + 360) % 360 / 360 * n);
  const latR = Math.max(-85, Math.min(85, lat)) * Math.PI / 180;
  const y = Math.floor((1 - Math.asinh(Math.tan(latR)) / Math.PI) / 2 * n);
  return [x, y] as const;
};

const imageryService = new ImageryService(root);
const annotationService = imagery === 'tianditu-imagery' ? new ImageryService(root) : undefined;
const tasks: Promise<void>[] = [];
let queued = 0, done = 0, failed = 0;
const CONCURRENCY = 8;
const workers: Promise<void>[] = [];
const queue: { provider: string; z: number; x: number; y: number }[] = [];
for (const [lon, lat] of points)
  for (const [z, radius] of LEVELS) {
    const [cx, cy] = tileAt(lon, lat, z);
    for (let dx = -radius; dx <= radius; dx++)
      for (let dy = -radius; dy <= radius; dy++) {
        const x = cx + dx, y = cy + dy, n = 2 ** z;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        queue.push({ provider: imagery, z, x, y });
        if (annotationService && z >= 7 && z <= 15) queue.push({ provider: 'tianditu-annotation', z, x, y });
      }
  }
queued = queue.length;
console.log(`PRECACHE queued ${queued} tiles`);
let cursor = 0;
const worker = async () => {
  while (cursor < queue.length) {
    const task = queue[cursor++]!;
    try {
      const service = task.provider === 'tianditu-annotation' ? annotationService! : imageryService;
      await service.tile(task.provider, task.z, task.x, task.y, 'precache');
      done++;
    } catch {
      failed++;
    }
    if ((done + failed) % 200 === 0) console.log(`PRECACHE ${done + failed}/${queued} (failed=${failed})`);
  }
};
for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
await Promise.all(workers);
console.log(`PRECACHE done=${done} failed=${failed} of ${queued}`);
await imageryService.close();
await annotationService?.close();
if (failed > queued / 4) throw new Error(`预抓失败率过高：${failed}/${queued}`);
