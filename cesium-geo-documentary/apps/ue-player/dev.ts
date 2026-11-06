import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
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
}

function startRenderer() {
  start(join(runtime.engineRoot, 'Engine/Binaries/Win64/UnrealEditor.exe'), [
    runtime.project, '/Engine/Maps/Entry', '-game', '-RenderOffscreen', '-Unattended', '-NoSplash', '-AudioMixer',
    `-PixelStreamingURL=ws://127.0.0.1:${process.env.UE_STREAMER_PORT || 8889}`,
    '-ResX=720', '-ResY=1280', '-ForceRes', `-abslog=${join(logDir, 'preview-renderer.log')}`
  ], reason => {
    console.warn(`UE preview renderer stopped (${reason}); restarting in 3 seconds.`);
    rendererRetry = setTimeout(startRenderer, 3000);
  });
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
