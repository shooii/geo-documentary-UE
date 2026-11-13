import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';

const LOCK_PATH = 'workspace/export-recording.lock';
const LEGACY_TTL_MS = 20 * 60_000;

export interface ExportLease {
  readonly token: string;
  release(): Promise<void>;
}

export function exportGuardPort(): number {
  const streamer = Number(process.env.UE_STREAMER_PORT || 8889);
  return Number(process.env.UE_RUNTIME_GUARD_PORT || (streamer + 10000)) + 2;
}

// 内核锁随拥有者退出释放；文件只用于兼容旧守护器和记录所有者，绝不凭时长释放活跃导出。
export function tryAcquireExportGuard(port = exportGuardPort()): Promise<(() => Promise<void>) | null> {
  return new Promise((resolve, reject) => {
    const server = createServer(socket => socket.end());
    server.once('error', error => (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? resolve(null) : reject(error));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      let closing: Promise<void> | undefined;
      resolve(() => closing ??= new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())));
    });
  });
}

export async function legacyExportLockActive(root: string): Promise<boolean> {
  const path = join(root, LOCK_PATH);
  try {
    const text = await readFile(path, 'utf8');
    try {
      const value = JSON.parse(text) as { version?: number } | null;
      // 新租约没有内核锁就已经失效，PID 被复用也不会延长它的寿命。
      if (value && value.version === 1) return false;
    } catch { /* 旧锁只写时间戳。 */ }
    if (!/^\d+$/.test(text.trim())) return false;
    return Date.now() - (await stat(path)).mtimeMs < LEGACY_TTL_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function exportRecordingActive(root: string, port = exportGuardPort()): Promise<boolean> {
  const occupied = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (active: boolean) => { socket.destroy(); resolve(active); };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(true));
    socket.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') finish(false);
      else { socket.destroy(); reject(error); }
    });
  });
  return occupied || await legacyExportLockActive(root);
}

export async function acquireExportLease(root: string, cancelled: () => boolean, port = exportGuardPort()): Promise<ExportLease> {
  await mkdir(join(root, 'workspace'), { recursive: true });
  while (!cancelled()) {
    const releaseGuard = await tryAcquireExportGuard(port);
    if (releaseGuard) {
      let acquired = false;
      try {
        if (!await legacyExportLockActive(root)) {
          if (cancelled()) throw new Error('Render cancelled');
          const token = randomUUID();
          const path = join(root, LOCK_PATH);
          await writeFile(path, JSON.stringify({ version: 1, ownerPid: process.pid, token, startedAt: new Date().toISOString() }), 'utf8');
          // 旧版运行时仍读 mtime，心跳让它们在长片录制时也保持暂停。
          const heartbeat = setInterval(() => {
            const now = new Date();
            void utimes(path, now, now).catch(() => {});
          }, 30_000);
          heartbeat.unref();
          let releasing: Promise<void> | undefined;
          acquired = true;
          return {
            token,
            release: () => releasing ??= (async () => {
              clearInterval(heartbeat);
              try {
                const owner = JSON.parse(await readFile(path, 'utf8')) as { token?: string; ownerPid?: number };
                if (owner.token === token && owner.ownerPid === process.pid) {
                  // The file is only a compatibility marker for old daemons; the
                  // kernel guard (exclusive TCP port) released in `finally` is the
                  // real mutual exclusion. A host safe-delete guard can refuse this
                  // unlink, and a leftover version:1 file is never treated as an
                  // active lock (legacyExportLockActive returns false for it), so a
                  // failed delete must NEVER turn an otherwise completed export red.
                  await unlink(path).catch(() => undefined);
                }
              } catch { /* Corrupt/missing lock text is harmless; guard is still released below. */ }
              finally { await releaseGuard(); }
            })()
          };
        }
      } finally { if (!acquired) await releaseGuard(); }
    }
    await new Promise<void>(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Render cancelled');
}
