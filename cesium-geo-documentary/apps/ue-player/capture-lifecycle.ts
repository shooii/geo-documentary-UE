import { spawn, type ChildProcess } from 'node:child_process';

export const CAPTURE_CLEANUP_FATAL = 'UE_CAPTURE_CLEANUP_FATAL';
// A full UE chunk can hold tens of GB of committed memory. Windows tree
// termination must finish reclaiming it before the next renderer is launched.
export const CAPTURE_PROCESS_CLEANUP_TIMEOUT_MS = 90_000;
export class CaptureCleanupError extends AggregateError {
  constructor(errors: unknown[]) { super(errors, `${CAPTURE_CLEANUP_FATAL}: 录制资源未完全清理，禁止重试`); }
}
export class CaptureRetryError extends Error {}

export function isTransientCaptureFailure(error: unknown): error is Error {
  return error instanceof Error && (error.name === 'TimeoutError' || /Target .*closed|crash|UE renderer not ready|stream|data.?channel|WebRTC|command timeout|response.*timeout|Timed out waiting for imagery|Imagery tile errors \(\d+ of \d+\); frame capture refused|超时/i.test(error.message));
}

export function captureBatchTimeoutMs(frameCount: number): number {
  // client.ts 每条 capture-batch 消息限时 300s，最坏每帧独立拆包。
  return 30_000 + 300_000 * Math.max(1, frameCount);
}

export async function waitForCapture<T>(operation: Promise<T>, signal: AbortSignal, timeoutMs = 180_000): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    signal.throwIfAborted();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => reject(new CaptureRetryError(`录制操作超时（${timeoutMs}ms）`)), timeoutMs);
  });
  try { return await Promise.race([operation, interrupted]); }
  finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export async function stopCaptureProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
    child.stdout?.destroy(); child.stderr?.destroy();
    return;
  }
  const controller = new AbortController();
  let onClose!: () => void;
  const closed = new Promise<void>(resolve => { onClose = resolve; child.once('close', onClose); });
  try {
    if (process.platform === 'win32') {
      // 必须先等待整棵树被终止；先杀父进程会使 taskkill 无法定位其子进程。
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      const killed = new Promise<void>((resolve, reject) => {
        killer.once('error', reject);
        killer.once('close', code => code === 0 || child.exitCode !== null || child.signalCode !== null
          ? resolve() : reject(new Error(`taskkill 失败：${code}`)));
      });
      await waitForCapture(killed, controller.signal, CAPTURE_PROCESS_CLEANUP_TIMEOUT_MS);
    } else {
      child.kill('SIGTERM');
      try { await waitForCapture(closed, controller.signal, 5_000); }
      catch { child.kill('SIGKILL'); }
    }
    await waitForCapture(closed, controller.signal, CAPTURE_PROCESS_CLEANUP_TIMEOUT_MS);
  } catch (error) {
    throw new Error(`录制子进程 ${child.pid} 清理失败`, { cause: error });
  } finally {
    child.removeListener('close', onClose);
  }
}

export class CaptureScope {
  private controller = new AbortController();
  private children: ChildProcess[] = [];
  private finalizers: Array<() => Promise<unknown>> = [];
  private stopping = false;
  private closePromise?: Promise<void>;
  private onAbort = () => this.controller.abort(this.parent.reason);
  readonly signal = this.controller.signal;

  constructor(private parent: AbortSignal, private stop = stopCaptureProcess) {
    if (parent.aborted) this.onAbort();
    else parent.addEventListener('abort', this.onAbort, { once: true });
  }

  track(child: ChildProcess, name: string, expectedExit = false) {
    this.children.push(child);
    child.on('error', error => {
      if (this.stopping) return;
      const permanent = ['ENOENT', 'EACCES', 'ENOEXEC'].includes((error as NodeJS.ErrnoException).code ?? '');
      const Failure = permanent ? Error : CaptureRetryError;
      this.controller.abort(new Failure(`${name} 启动失败：${error.message}`, { cause: error }));
    });
    child.once('exit', (code, signal) => {
      if (!this.stopping && !(expectedExit && code === 0)) {
        this.controller.abort(new CaptureRetryError(`${name} 已退出（code=${code}, signal=${signal ?? '-'}）`));
      }
    });
    return child;
  }

  fail(error: Error) { if (!this.stopping) this.controller.abort(error); }
  defer(finalizer: () => Promise<unknown>) { this.finalizers.push(finalizer); }
  wait<T>(operation: Promise<T>, timeoutMs?: number) { return waitForCapture(operation, this.signal, timeoutMs); }

  close(): Promise<void> {
    return this.closePromise ??= this.cleanup();
  }

  private async cleanup() {
    this.stopping = true;
    this.parent.removeEventListener('abort', this.onAbort);
    const failures: unknown[] = [];
    for (const finalizer of this.finalizers.reverse()) {
      try { await waitForCapture(finalizer(), new AbortController().signal, 15_000); } catch (error) { failures.push(error); }
    }
    const stopped = await Promise.allSettled(this.children.reverse().map(child => this.stop(child)));
    for (const result of stopped) if (result.status === 'rejected') failures.push(result.reason);
    if (failures.length) throw new CaptureCleanupError(failures);
  }
}

export async function retryCaptureChunk(
  capture: () => Promise<void>, signal: AbortSignal, retries: number,
  onRetry: (attempt: number, error: Error) => void = () => {}
) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { await capture(); return; }
    catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof CaptureRetryError) || attempt >= retries) throw error;
      onRetry(attempt + 1, error);
    }
  }
}

export function assertCaptureFrames(names: string[], total: number) {
  const captured = new Set(names.filter(name => /^frame-\d+\.png$/.test(name)));
  if (captured.size !== total) throw new Error(`Captured ${captured.size}/${total} frames; the UE stream stopped early`);
  for (let i = 0; i < total; i++) {
    if (!captured.has(`frame-${String(i).padStart(6, '0')}.png`)) throw new Error(`录制缺少帧 ${i}`);
  }
  return captured.size;
}
