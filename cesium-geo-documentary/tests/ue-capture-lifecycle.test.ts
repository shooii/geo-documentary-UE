import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { CaptureScope, CaptureRetryError, waitForCapture, retryCaptureChunk, assertCaptureFrames, stopCaptureProcess, isTransientCaptureFailure, captureBatchTimeoutMs } from '../apps/ue-player/capture-lifecycle.js';

const child = () => Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null }) as ChildProcess;
const pending = () => new Promise<never>(() => {});

test('启动、就绪、帧失败都完整等待所有清理，close可重复调用', async () => {
  for (const phase of ['startup', 'ready', 'capture']) {
    const events: string[] = [];
    let release!: () => void;
    const scope = new CaptureScope(new AbortController().signal, async () => {
      events.push('stop'); await new Promise<void>(resolve => { release = resolve; }); events.push('stopped');
    });
    scope.track(child(), phase);
    scope.defer(async () => { events.push('page'); });
    const work = (async () => { try { throw new Error(phase); } finally { await scope.close(); } })();
    const rejected = assert.rejects(work, new RegExp(phase));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.deepEqual(events, ['page', 'stop']);
    release(); await rejected; await scope.close();
    assert.deepEqual(events, ['page', 'stop', 'stopped']);
  }
});

test('spawn error及signal退出立刻打断正在等待的录制', async () => {
  for (const event of ['error', 'exit']) {
    const scope = new CaptureScope(new AbortController().signal, async () => {});
    const process = scope.track(child(), 'renderer');
    const work = scope.wait(pending());
    if (event === 'error') process.emit('error', new Error('pipe failed'));
    else process.emit('exit', null, 'SIGTERM');
    await assert.rejects(work, CaptureRetryError);
    await scope.close();
  }
});

test('页面崩溃立即打断帧等待，清理关闭页面不会再标记失败', async () => {
  const scope = new CaptureScope(new AbortController().signal, async () => {});
  const work = scope.wait(pending());
  scope.fail(new CaptureRetryError('页面崩溃'));
  await assert.rejects(work, /页面崩溃/);
  await scope.close();
  const clean = new CaptureScope(new AbortController().signal, async () => {});
  clean.defer(async () => { clean.fail(new CaptureRetryError('页面关闭')); });
  await clean.close();
  assert.equal(clean.signal.aborted, false);
});

test('缺失可执行文件属于永久错误，不能自动重试', async () => {
  const scope = new CaptureScope(new AbortController().signal, async () => {});
  const process = scope.track(child(), 'renderer');
  const work = scope.wait(pending());
  process.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
  await assert.rejects(work, error => error instanceof Error && !(error instanceof CaptureRetryError));
  await scope.close();
});

test('挂起操作有界超时，取消即时打断并且不重试', async () => {
  await assert.rejects(waitForCapture(pending(), new AbortController().signal, 5), CaptureRetryError);
  const cancellation = new AbortController();
  let attempts = 0;
  const work = retryCaptureChunk(async () => {
    attempts++;
    const scope = new CaptureScope(cancellation.signal, async () => {});
    try { await scope.wait(pending()); } finally { await scope.close(); }
  }, cancellation.signal, 2);
  cancellation.abort(new Error('已取消'));
  await assert.rejects(work, /已取消/);
  assert.equal(attempts, 1);
});

test('重启整块复用索引覆盖部分成功帧，最终不丢不重', async () => {
  const files = new Map<number, number>();
  let attempts = 0;
  await retryCaptureChunk(async () => {
    attempts++;
    for (let i = 4; i < 8; i++) {
      files.set(i, i / 30);
      if (attempts === 1 && i === 5) throw new CaptureRetryError('renderer crashed');
    }
  }, new AbortController().signal, 2);
  assert.equal(attempts, 2);
  assert.deepEqual([...files], [4, 5, 6, 7].map(i => [i, i / 30]));
  let failures = 0;
  await assert.rejects(retryCaptureChunk(async () => { failures++; throw new CaptureRetryError('crash'); }, new AbortController().signal, 2), /crash/);
  assert.equal(failures, 3);
});

test('清理失败不再重启，且一处清理失败不阻止其他资源释放', async () => {
  let attempts = 0, stopped = 0;
  await assert.rejects(retryCaptureChunk(async () => {
    attempts++;
    const scope = new CaptureScope(new AbortController().signal, async () => { stopped++; });
    scope.track(child(), 'renderer');
    scope.defer(async () => { throw new Error('context close failed'); });
    try { throw new CaptureRetryError('crash'); } finally { await scope.close(); }
  }, new AbortController().signal, 2), /UE_CAPTURE_CLEANUP_FATAL/);
  assert.equal(attempts, 1); assert.equal(stopped, 1);
});

test('原生影像瓦片拒帧按暂态错误重启整块，不放宽影像门槛', async () => {
  const native = await readFile(new URL('../unreal/GeoDocumentary/Source/GeoDocumentary/GeoMap.cpp', import.meta.url), 'utf8');
  assert.match(native, /Imagery tile errors \(%d of %d\); frame capture refused/);
  assert.equal(isTransientCaptureFailure(new Error('page.evaluate: Imagery tile errors (2 of 14); frame capture refused')), true);
  assert.equal(isTransientCaptureFailure(new Error('Invalid imagery provider')), false);
  let attempts = 0;
  await retryCaptureChunk(async () => {
    attempts++;
    if (attempts === 1) {
      const error = new Error('Imagery tile errors (2 of 14); frame capture refused');
      if (isTransientCaptureFailure(error)) throw new CaptureRetryError(error.message, { cause: error });
      throw error;
    }
  }, new AbortController().signal, 1);
  assert.equal(attempts, 2);
});

test('批次外层预算覆盖每帧拆包的连续client超时', async () => {
  const client = await readFile(new URL('../apps/ue-player/client.ts', import.meta.url), 'utf8');
  assert.match(client, /action === 'capture-batch' \? 300000/);
  assert.equal(captureBatchTimeoutMs(1), 330_000);
  assert.equal(captureBatchTimeoutMs(16), 4_830_000);
  const source = await readFile(new URL('../apps/ue-player/capture.ts', import.meta.url), 'utf8');
  assert.match(source, /scope\.wait\(page\.evaluate[^\n]+captureBatchTimeoutMs\(times\.length\)/);
});

test('帧数量相同但索引缺口或多余帧都拒绝编码', () => {
  assert.equal(assertCaptureFrames(['frame-000000.png', 'frame-000001.png', 'unreal.log'], 2), 2);
  assert.throws(() => assertCaptureFrames(['frame-000000.png', 'frame-000002.png'], 2), /缺少帧/);
  assert.throws(() => assertCaptureFrames(['frame-000000.png', 'frame-000001.png', 'frame-000002.png'], 2), /3\/2/);
});

test('真实子进程清理等待close事件，不遗留进程', async () => {
  const process = spawn(globalThis.process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  process.on('error', () => {});
  await once(process, 'spawn');
  let closed = false;
  process.once('close', () => { closed = true; });
  await stopCaptureProcess(process);
  assert.equal(closed, true);
  assert.ok(process.exitCode !== null || process.signalCode !== null);
});

test('编码探测具有硬超时，探测被终止后即使打印过时长也不能发布', async () => {
  const source = await readFile(new URL('../apps/ue-player/capture.ts', import.meta.url), 'utf8');
  const probe = source.slice(source.indexOf('const probeSeconds='), source.indexOf('const tsx='))
    .replace('const probeSeconds=async(file:string)=>', 'globalThis.probeSeconds=async(file)=>');
  let options: Record<string, unknown> | undefined;
  let result: { stdout: string; stderr: string; signal?: string; error?: Error } = { stdout: '', stderr: 'Duration: 00:00:12.00' };
  const context = createContext({ ffmpeg: 'ffmpeg', spawnSync: (_exe: string, _args: string[], value: Record<string, unknown>) => { options = value; return result; } });
  runInContext(probe, context);
  assert.equal(await context.probeSeconds('map.mp4'), 12);
  assert.equal(options?.timeout, 15_000);
  result = { ...result, signal: 'SIGTERM' };
  assert.equal(await context.probeSeconds('map.mp4'), null);
  result = { stdout: '', stderr: 'Duration: 00:00:12.00', error: new Error('ETIMEDOUT') };
  assert.equal(await context.probeSeconds('map.mp4'), null);
  assert.match(source, /'-pix_fmt','yuv420p',pendingOutput/);
  assert.ok(source.indexOf('await rename(pendingOutput,output)') > source.indexOf('if(encodedSeconds===null'));
  assert.match(source, /await rm\(join\(frames,'encoded-map.mp4'\),\{force:true\}\)/);
});

test('录制入口保持整块try/finally、启动fetch超时和固定索引偏移契约', async () => {
  const source = await readFile(new URL('../apps/ue-player/capture.ts', import.meta.url), 'utf8');
  assert.match(source, /finally\s*\{\s*await scope\.close\(\)/);
  assert.match(source, /AbortSignal\.timeout/);
  assert.match(source, /GeoCaptureIndexOffset=\$\{chunkStart\}/);
  assert.doesNotMatch(source, /usablePort\([^\n]+\+ chunkStart/);
  assert.doesNotMatch(source, /UE_BATCH_RETRY|UE_FRAME_RETRY/);
});

test('UE 原生分块捕获使用绝对帧索引，偏移只应用一次且加载场景不归零', async () => {
  const source = await readFile(new URL('../unreal/GeoDocumentary/Source/GeoDocumentary/GeoMap.cpp', import.meta.url), 'utf8');
  assert.match(source, /FParse::Value\(FCommandLine::Get\(\), TEXT\("GeoCaptureIndexOffset="\), CaptureIndexOffset\);\s*CaptureIndex = CaptureIndexOffset;/);
  assert.match(source, /CaptureBatchStart = CaptureIndex;/);
  assert.match(source, /const int32 Done = CaptureIndex - CaptureBatchStart;/);
  assert.match(source, /TEXT\("frame-%06d\.png"\), CaptureIndex\+\+/);
  assert.doesNotMatch(source, /CaptureIndexOffset\s*\+\s*CaptureIndex/);
  const loadScene = source.slice(source.indexOf('void AGeoMap::LoadScene('), source.indexOf('void AGeoMap::SetImagery('));
  assert.doesNotMatch(loadScene, /CaptureIndex\s*=\s*0\s*;/);
});

test('非零 offset 的首批、后批与重启只覆盖本块，且批内索引从零推进', async () => {
  const source = await readFile(new URL('../unreal/GeoDocumentary/Source/GeoDocumentary/GeoMap.cpp', import.meta.url), 'utf8');
  const initialize = source.match(/\bCaptureIndex = CaptureIndexOffset;/)?.[0];
  const startBatch = source.match(/\bCaptureBatchStart = [^;]+;/)?.[0];
  const done = source.match(/const int32 Done = ([^;]+);/)?.[1];
  const nextFileIndex = source.match(/TEXT\("frame-%06d\.png"\), ([^\)]+)\)/)?.[1];
  assert.ok(initialize && startBatch && done && nextFileIndex);
  const launch = (offset: number) => {
    const state = createContext({ CaptureIndexOffset: offset, CaptureIndex: 0, CaptureBatchStart: 0 });
    runInContext(initialize, state);
    return state;
  };
  const capture = (state: ReturnType<typeof launch>, count: number) => {
    runInContext(startBatch, state);
    const indices: number[] = [];
    for (let i = 0; i < count; i++) {
      assert.equal(runInContext(done, state), i);
      indices.push(runInContext(nextFileIndex, state));
    }
    assert.equal(runInContext(done, state), count);
    return indices;
  };
  const state = launch(600);
  assert.deepEqual(capture(state, 3), [600, 601, 602]);
  assert.deepEqual(capture(state, 2), [603, 604]);
  const files = new Map([[599, '前块'], [600, '部分成功'], [601, '部分成功']]);
  const restart = launch(600);
  for (const index of capture(restart, 3)) files.set(index, '重试成功');
  for (const index of capture(restart, 2)) files.set(index, '重试成功');
  assert.deepEqual([...files], [[599, '前块'], ...[600, 601, 602, 603, 604].map(index => [index, '重试成功'])]);
});
