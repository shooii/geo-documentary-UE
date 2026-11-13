import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { exportRecordingActive, legacyExportLockActive, tryAcquireExportGuard } from './export-lease.js';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

export interface RuntimeDependencies {
  enabled(): boolean;
  acquire(kind: 'signalling' | 'renderer'): Promise<(() => void) | null>;
  portOpen(port: number): Promise<boolean>;
  exportActive(): Promise<boolean>;
  rendererRunning(): Promise<boolean>;
  launch(kind: 'signalling' | 'renderer', allowed: () => boolean): Promise<ChildProcess>;
  kill(child: ChildProcess): void;
  log(message: string): void;
  now(): number;
  later(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout>): void;
}

// 同一守护器只串行探测；所有 await 后重新检查停止状态，避免退出时重新拉起 UE。
export function createPreviewRuntime(deps: RuntimeDependencies, ports: { player: number; streamer: number }, rendererOnly = false) {
  let stopped = false;
  let started = false;
  const releases: Array<() => void> = [];
  const owned = new Set<'signalling' | 'renderer'>();
  const reused = new Set<'signalling' | 'renderer'>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const children = new Map<'signalling' | 'renderer', ChildProcess>();
  const failures = { signalling: 0, renderer: 0 };
  const retryAt = { signalling: 0, renderer: 0 };
  const allowed = () => !stopped && deps.enabled();
  const failed = (kind: 'signalling' | 'renderer', reason: string) => {
    if (!allowed()) return;
    const delay = Math.min(30000, 2000 * 2 ** Math.min(failures[kind]++, 4));
    retryAt[kind] = deps.now() + delay;
    deps.log(`UE_RUNTIME_FAILED ${kind}: ${reason}；${delay / 1000} 秒后重试`);
  };
  function pauseRenderer() {
    const child = children.get('renderer');
    if (!child) return;
    children.delete('renderer');
    deps.kill(child);
    deps.log('UE_RUNTIME_PAUSED renderer 导出正在占用渲染资源');
  }
  async function launch(kind: 'signalling' | 'renderer') {
    if (!allowed() || children.has(kind) || deps.now() < retryAt[kind]) return;
    try {
      if (kind === 'renderer' && await deps.exportActive()) return;
      if (!allowed()) return;
      const child = await deps.launch(kind, allowed);
      if (!allowed()) { deps.kill(child); return; }
      children.set(kind, child);
      const born = deps.now();
      const ended = (reason: string) => {
        if (children.get(kind) !== child) return;
        children.delete(kind);
        if (deps.now() - born > 60000) failures[kind] = 0;
        failed(kind, reason);
      };
      // 已返回的子进程已完成 spawn；kill/send 等操作错误不代表它已经退出。
      child.on('error', error => {
        if (children.get(kind) === child) deps.log(`UE_RUNTIME_CHILD_ERROR ${kind}: ${error.message}`);
      });
      child.once('exit', (code, signal) => ended(signal || `exit ${code}`));
      if (kind === 'renderer') {
        try {
          if (await deps.exportActive()) { pauseRenderer(); return; }
        } catch (error) { pauseRenderer(); throw error; }
        if (!allowed()) { pauseRenderer(); return; }
      }
      // 启动期间子进程可能已经退出，不能漏掉它的退出事件。
      if (child.exitCode !== null || child.signalCode !== null) ended(`exit ${child.exitCode ?? child.signalCode}`);
      deps.log(`UE_RUNTIME_STARTED ${kind} pid=${child.pid ?? '?'}`);
    } catch (error) { failed(kind, String(error)); }
  }
  async function tick() {
    if (!allowed()) return;
    try {
      for (const kind of (rendererOnly ? ['renderer'] : ['signalling', 'renderer']) as Array<'signalling' | 'renderer'>) {
        if (owned.has(kind)) continue;
        const release = await deps.acquire(kind);
        if (!allowed()) { release?.(); return; }
        if (release) {
          releases.push(release);
          owned.add(kind);
          deps.log(`UE_RUNTIME_OWNER ${kind} 已取得守护权`);
        } else if (!reused.has(kind)) {
          reused.add(kind);
          deps.log(`UE_RUNTIME_REUSE ${kind} 已有守护器，本入口不重复启动`);
        }
      }
      if (!owned.size) return;
      const [player, streamer] = await Promise.all([deps.portOpen(ports.player), deps.portOpen(ports.streamer)]);
      if (!allowed()) return;
      if (owned.has('signalling') && !children.has('signalling')) {
        if (!player && !streamer) await launch('signalling');
        else if (player !== streamer && deps.now() >= retryAt.signalling) failed('signalling', '信令端口仅有一个被占用；保留已有服务，不抢占端口');
      }
      if (!allowed()) return;
      const exporting = await deps.exportActive();
      if (!allowed()) return;
      if (exporting) pauseRenderer();
      if (owned.has('renderer') && !exporting && !children.has('renderer') && deps.now() >= retryAt.renderer) {
        const running = await deps.rendererRunning();
        if (!allowed()) return;
        if (!running) await launch('renderer');
      }
    } catch (error) {
      if (deps.now() >= retryAt.renderer) failed('renderer', `运行时探测失败：${String(error)}`);
    } finally {
      if (allowed()) timer = deps.later(() => { void tick(); }, 2000);
    }
  }
  return {
    async start() {
      if (started || !allowed()) return;
      started = true;
      await tick();
    },
    stop() {
      stopped = true;
      if (timer) deps.cancel(timer);
      for (const child of children.values()) deps.kill(child);
      children.clear();
      for (const release of releases.splice(0)) release();
      owned.clear();
    }
  };
}

const exec = promisify(execFile);
export function previewRendererMatches(command: string, project: string, streamerPort: number) {
  const normalized = command.replaceAll('\\', '/').toLowerCase();
  const projectPath = project.replaceAll('\\', '/').toLowerCase();
  const escapedProject = projectPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s"'])${escapedProject}(?=["'\\s]|$)`).test(normalized) && /(?:^|\s)-game(?:\s|$)/.test(normalized)
    && new RegExp(`-pixelstreamingurl=["']?ws://127\\.0\\.0\\.1:${streamerPort}(?:["'\\s/]|$)`).test(normalized);
}

export function startPreviewRuntime(root: string, rendererOnly = false) {
  const player = Number(process.env.UE_SIGNALLING_PORT || 8888);
  const streamer = Number(process.env.UE_STREAMER_PORT || 8889);
  const pidFile = join(root, 'workspace/ue-preview.pid');
  const logDir = join(root, 'workspace/ue-logs');
  const runtimeFile = process.env.GEO_UE_RUNTIME || join(root, 'workspace/ue-runtime.json');
  let runtime: { engineRoot: string; project: string };
  async function loadRuntime() {
    try {
      runtime = JSON.parse((await readFile(runtimeFile, 'utf8')).replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new Error(`无法读取 UE 运行时配置 ${runtimeFile}，请运行 pnpm ue:build：${String(error)}`);
    }
    if (!runtime.engineRoot || !runtime.project) throw new Error('UE 运行时配置不完整，请运行 pnpm ue:build');
    return runtime;
  }
  const controller = createPreviewRuntime({
    enabled: () => process.env.STUDIO_PREVIEW !== 'off',
    acquire: kind => new Promise((resolve, reject) => {
      const lock = createServer(socket => socket.end());
      lock.once('error', error => (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? resolve(null) : reject(error));
      // 内核持有的本机锁随进程退出释放，不会留下过期文件锁。
      const guardPort = Number(process.env.UE_RUNTIME_GUARD_PORT || (streamer + 10000));
      lock.listen(guardPort + (kind === 'renderer' ? 1 : 0), '127.0.0.1', () => {
        resolve(() => { lock.close(); });
      });
    }),
    portOpen: port => new Promise(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(400);
      const finish = (open: boolean) => { socket.destroy(); resolve(open); };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('timeout', () => finish(false));
    }),
    exportActive: () => exportRecordingActive(root),
    rendererRunning: async () => {
      const config = await loadRuntime();
      const { stdout } = process.platform === 'win32'
        ? await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Get-CimInstance Win32_Process -Filter \"Name='UnrealEditor.exe'\" | Select-Object -ExpandProperty CommandLine"], { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 })
        : await exec('ps', ['-eo', 'args'], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
      return stdout.split(/\r?\n/).some(line => previewRendererMatches(line, config.project, streamer));
    },
    launch: async (kind, allowed) => {
      await mkdir(logDir, { recursive: true });
      const config = kind === 'renderer' ? await loadRuntime() : null;
      const release = kind === 'renderer' ? await tryAcquireExportGuard() : null;
      if (kind === 'renderer' && !release) throw new Error('导出正在占用渲染资源');
      try {
        // 已持有内核锁，此处只探测旧文件锁，避免把自己的启动锁当作导出。
        if (kind === 'renderer' && await legacyExportLockActive(root)) throw new Error('旧版导出正在占用渲染资源');
        if (!allowed()) throw new Error('预览运行时已停止');
        const child = kind === 'signalling'
          ? spawn(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'apps/ue-player/signalling.ts')], { cwd: root, windowsHide: true, stdio: 'inherit' })
          : spawn(join(config!.engineRoot, 'Engine/Binaries/Win64/UnrealEditor.exe'), [
            config!.project, '/Engine/Maps/Entry', '-game', '-RenderOffscreen', '-Unattended', '-NoSplash', '-AudioMixer', '-mimalloc',
            `-PixelStreamingURL=ws://127.0.0.1:${streamer}`, '-ResX=720', '-ResY=1280', '-ForceRes',
            `-abslog=${join(logDir, 'preview-renderer.log')}`,
            ...(process.env.UE_CAPTURE_ROOT ? [`-GeoCaptureRoot=${process.env.UE_CAPTURE_ROOT}`] : [])
          ], { cwd: root, windowsHide: true, stdio: 'inherit' });
        // 等待 spawn 成功；ENOENT 等错误先在本层处理，避免 await 交接时丢失事件。
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('spawn', () => { child.removeListener('error', reject); resolve(); });
        });
        if (kind === 'renderer' && child.pid) {
          await writeFile(pidFile, String(child.pid), 'utf8').catch(error => console.warn(`UE_RUNTIME_PID_FAILED ${String(error)}`));
          child.once('exit', () => {
            void (async () => {
              if ((await readFile(pidFile, 'utf8')).trim() === String(child.pid)) await unlink(pidFile);
            })().catch(() => {});
          });
        }
        return child;
      } finally { await release?.(); }
    },
    kill: child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32' && child.pid) {
        // Windows 的 kill() 不向 node 子进程投递 SIGTERM；只清理本守护器拥有的进程树。
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', error => console.warn(`UE_RUNTIME_STOP_FAILED ${String(error)}`));
      } else child.kill();
    },
    log: message => console.log(message),
    now: Date.now,
    later: setTimeout,
    cancel: clearTimeout
  }, { player, streamer }, rendererOnly);
  void controller.start();
  return controller;
}
