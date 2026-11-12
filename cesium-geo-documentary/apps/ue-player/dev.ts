import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const runtimeFile = join(root, 'workspace/ue-runtime.json');
let runtime: { engineRoot: string; project: string };
try {
  runtime = JSON.parse((await readFile(runtimeFile, 'utf8')).replace(/^\uFEFF/, ''));
} catch {
  throw new Error('Run pnpm ue:build to compile and prepare the native UE renderer first.');
}

const tsx = join(root, 'node_modules/tsx/dist/cli.mjs');
const logDir = join(root, 'workspace/ue-logs');
await mkdir(logDir, { recursive: true });
const children = new Set<ChildProcess>();
let stopping = false;
let rendererRetry: ReturnType<typeof setTimeout> | undefined;
// 导出录制（apps/ue-player/capture.ts）会拉起一个 1080×1920 的录制 UE，与预览 UE
// 同抢显存/内存时二者之一会 OOM 退出。录制开始前 render-engine 写这个锁并杀掉预览
// UE，这里看到锁就不重启预览，等录制结束（锁删除）再恢复。
const exportLock = join(root, 'workspace/export-recording.lock');
const previewPidFile = join(root, 'workspace/ue-preview.pid');

function stop(code: number) {
  stopping = true;
  clearTimeout(rendererRetry);
  for (const child of children) child.kill();
  process.exitCode = code;
}

function start(exe: string, args: string[], onExit: (reason: string, code: number) => void) {
  const child = spawn(exe, args, { cwd: root, windowsHide: true, stdio: 'inherit' });
  children.add(child);
  child.once('error', error => {
    if (children.delete(child) && !stopping) onExit(error.message, 1);
  });
  child.once('exit', (code, signal) => {
    if (children.delete(child) && !stopping) onExit(signal || `exit ${code}`, code ?? 1);
  });
  return child;
}

async function exportLockActive() {
  // 锁文件过期（20 分钟没更新）视为失效：导出进程若被强杀，锁不会残留到预览永不复位。
  try {
    const info = await stat(exportLock);
    return Date.now() - info.mtimeMs < 20 * 60 * 1000;
  } catch {
    return false;
  }
}

async function scheduleRendererRestart() {
  clearTimeout(rendererRetry);
  if (await exportLockActive()) {
    // 导出录制进行中：不拉起预览 UE，把资源让给录制实例，轮询等锁释放。
    rendererRetry = setTimeout(() => void scheduleRendererRestart(), 2000);
    return;
  }
  rendererRetry = setTimeout(startRenderer, 3000);
}

function startRenderer() {
  const child = start(join(runtime.engineRoot, 'Engine/Binaries/Win64/UnrealEditor.exe'), [
    runtime.project, '/Engine/Maps/Entry', '-game', '-RenderOffscreen', '-Unattended', '-NoSplash', '-AudioMixer',
    `-PixelStreamingURL=ws://127.0.0.1:${process.env.UE_STREAMER_PORT || 8889}`,
    '-ResX=720', '-ResY=1280', '-ForceRes', `-abslog=${join(logDir, 'preview-renderer.log')}`,
    // Offline frame capture: `renderFrame(t)` then renders the exact scene time and writes
    // a PNG, with no dependence on the live stream or on who holds the single controller
    // seat. Off unless asked for, because it changes how the viewport is sized.
    ...(process.env.UE_CAPTURE_ROOT ? [`-GeoCaptureRoot=${process.env.UE_CAPTURE_ROOT}`] : [])
  ], reason => {
    console.warn(`UE preview renderer stopped (${reason}).`);
    void scheduleRendererRestart();
  });
  if (child.pid) void writeFile(previewPidFile, String(child.pid), 'utf8').catch(() => {});
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop(0));
if (!process.argv.includes('--renderer-only')) {
  start(process.execPath, [tsx, 'apps/ue-player/signalling.ts'], (reason, code) => {
    console.error(`UE signalling stopped (${reason}).`);
    stop(code);
  });
  start(process.execPath, [tsx, 'apps/studio/server.ts'], (_, code) => stop(code));
}
startRenderer();
