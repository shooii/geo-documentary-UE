import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { createPreviewRuntime, previewRendererMatches, type RuntimeDependencies } from '../apps/ue-player/runtime.js';

function fixture(overrides: Partial<RuntimeDependencies> = {}) {
  let now = 0;
  const launched: Array<{ kind: string; child: ChildProcess }> = [];
  const killed: ChildProcess[] = [];
  const logs: string[] = [];
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  let releases = 0;
  const deps: RuntimeDependencies = {
    enabled: () => true,
    acquire: async () => () => { releases++; },
    portOpen: async () => false,
    exportActive: async () => false,
    rendererRunning: async () => false,
    launch: async kind => {
      const child = Object.assign(new EventEmitter(), { pid: launched.length + 1, exitCode: null, signalCode: null }) as ChildProcess;
      launched.push({ kind, child });
      return child;
    },
    kill: child => { killed.push(child); child.emit('exit', 0); },
    log: message => { logs.push(message); },
    now: () => now,
    later: callback => { const id = {} as ReturnType<typeof setTimeout>; timers.set(id, callback); return id; },
    cancel: id => { timers.delete(id); },
    ...overrides
  };
  const runtime = createPreviewRuntime(deps, { player: 8888, streamer: 8889 });
  return { runtime, launched, killed, logs, timers, releases: () => releases,
    async tick(ms = 2000) {
      now += ms;
      const callbacks = [...timers.values()]; timers.clear();
      for (const callback of callbacks) callback();
      // 清空 tick 中探测和启动形成的 Promise 链，不启动真实进程或定时器。
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
  };
}

test('完整运行时启动两种子进程且停止仅清理所拥有进程', async () => {
  const f = fixture();
  await f.runtime.start();
  await f.runtime.start();
  assert.deepEqual(f.launched.map(x => x.kind), ['signalling', 'renderer']);
  f.runtime.stop();
  assert.equal(f.killed.length, 2);
  assert.equal(f.releases(), 2);
  assert.equal(f.timers.size, 0);
  await f.tick(60000);
  assert.equal(f.launched.length, 2);
});

test('已有信令和预览UE只复用，停止不杀复用进程', async () => {
  const f = fixture({ portOpen: async () => true, rendererRunning: async () => true });
  await f.runtime.start();
  assert.equal(f.launched.length, 0);
  f.runtime.stop();
  assert.equal(f.killed.length, 0);
});

test('已有守护器不再探测或启动任何子进程', async () => {
  const f = fixture({ acquire: async () => null });
  await f.runtime.start();
  assert.equal(f.launched.length, 0);
  assert.match(f.logs.join('\n'), /UE_RUNTIME_REUSE/);
  f.runtime.stop();
});

test('原守护器退出后复用入口取得锁并恢复完整运行时', async () => {
  let occupied = true;
  const f = fixture({ acquire: async () => occupied ? null : () => {} });
  await f.runtime.start();
  assert.equal(f.launched.length, 0);
  assert.equal(f.timers.size, 1);
  occupied = false;
  await f.tick();
  assert.deepEqual(f.launched.map(x => x.kind), ['signalling', 'renderer']);
  f.runtime.stop();
  assert.equal(f.killed.length, 2);
});

test('接管锁的异步等待期间停止会释放新取得的锁', async () => {
  let occupied = true;
  let finish!: (release: () => void) => void;
  let released = false;
  const f = fixture({ acquire: async () => {
    if (occupied) return null;
    return new Promise(resolve => { finish = resolve; });
  } });
  await f.runtime.start();
  occupied = false;
  const ticking = f.tick();
  await Promise.resolve();
  f.runtime.stop();
  finish(() => { released = true; });
  await ticking;
  assert.equal(released, true);
  assert.equal(f.launched.length, 0);
  assert.equal(f.timers.size, 0);
});

test('renderer-only已有守护时完整入口仍能补齐信令', async () => {
  const f = fixture({ acquire: async kind => kind === 'renderer' ? null : () => {} });
  await f.runtime.start();
  assert.deepEqual(f.launched.map(x => x.kind), ['signalling']);
  f.runtime.stop();
});

test('关闭预览不获取守护锁或拉起任何子进程', async () => {
  const f = fixture({ enabled: () => false, acquire: async () => { throw new Error('不应探测'); } });
  await f.runtime.start();
  assert.equal(f.launched.length, 0);
  assert.equal(f.logs.length, 0);
});

test('初始导出锁阻止预览UE，锁释放后恢复', async () => {
  let exporting = true;
  const f = fixture({ exportActive: async () => exporting });
  await f.runtime.start();
  assert.deepEqual(f.launched.map(x => x.kind), ['signalling']);
  exporting = false;
  await f.tick();
  assert.deepEqual(f.launched.map(x => x.kind), ['signalling', 'renderer']);
  f.runtime.stop();
});

test('运行中出现导出租约只停自有渲染器，信令保持且释放后恢复', async () => {
  let exporting = false;
  const f = fixture({ exportActive: async () => exporting });
  await f.runtime.start();
  exporting = true;
  await f.tick();
  assert.deepEqual(f.killed, [f.launched[1]!.child]);
  assert.equal(f.logs.filter(line => line.includes('FAILED renderer')).length, 0);
  exporting = false;
  await f.tick();
  assert.deepEqual(f.launched.map(x => x.kind), ['signalling', 'renderer', 'renderer']);
  f.runtime.stop();
});

test('renderer异步探测期间出现导出租约不再启动预览', async () => {
  let exporting = false;
  let finish!: (running: boolean) => void;
  const f = fixture({
    exportActive: async () => exporting,
    rendererRunning: () => new Promise(resolve => { finish = resolve; })
  });
  const starting = f.runtime.start();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  exporting = true;
  finish(false);
  await starting;
  assert.deepEqual(f.launched.map(x => x.kind), ['signalling']);
  f.runtime.stop();
});

test('异步launch期间出现导出租约立即清理刚启动的自有renderer', async () => {
  let exporting = false;
  const renderer = Object.assign(new EventEmitter(), { pid: 99, exitCode: null, signalCode: null }) as ChildProcess;
  const f = fixture({
    exportActive: async () => exporting,
    launch: async kind => {
      if (kind === 'renderer') exporting = true;
      return kind === 'renderer' ? renderer : Object.assign(new EventEmitter(), { pid: 98, exitCode: null, signalCode: null }) as ChildProcess;
    }
  });
  await f.runtime.start();
  assert.deepEqual(f.killed, [renderer]);
  assert.equal(f.logs.filter(line => line.includes('FAILED renderer')).length, 0);
  f.runtime.stop();
});

test('部分信令端口被占用时不抢占并明确报告', async () => {
  const f = fixture({ portOpen: async port => port === 8888 });
  await f.runtime.start();
  assert.equal(f.launched.filter(x => x.kind === 'signalling').length, 0);
  assert.match(f.logs.join('\n'), /信令端口仅有一个被占用/);
  f.runtime.stop();
});

test('退出和spawn错误采用有上限退避，error+exit只处理一次', async () => {
  const f = fixture();
  await f.runtime.start();
  f.launched[1]!.child.emit('error', new Error('ENOENT'));
  f.launched[1]!.child.emit('exit', 1);
  assert.equal(f.logs.filter(x => /FAILED renderer/.test(x)).length, 1);
  await f.tick(1000);
  assert.equal(f.launched.length, 2);
  await f.tick(1000);
  assert.equal(f.launched.length, 3);
  f.launched[2]!.child.emit('exit', 1);
  await f.tick(2000);
  assert.equal(f.launched.length, 3);
  await f.tick(2000);
  assert.equal(f.launched.length, 4);
  f.runtime.stop();
});

test('停止发生在异步端口探测期间时不启动或创建重试', async () => {
  let finish!: (open: boolean) => void;
  const pending = new Promise<boolean>(resolve => { finish = resolve; });
  const f = fixture({ portOpen: () => pending });
  const starting = f.runtime.start();
  await Promise.resolve();
  f.runtime.stop();
  finish(false);
  await starting;
  assert.equal(f.launched.length, 0);
  assert.equal(f.timers.size, 0);
});

test('停止发生在守护锁等待期间也释放锁', async () => {
  let finish!: (release: () => void) => void;
  let released = false;
  const f = fixture({ acquire: () => new Promise(resolve => { finish = resolve; }) });
  const starting = f.runtime.start();
  f.runtime.stop();
  finish(() => { released = true; });
  await starting;
  assert.equal(released, true);
  assert.equal(f.launched.length, 0);
});

test('停止发生在异步启动准备期间时不允许创建进程', async () => {
  let resume!: () => void;
  const pending = new Promise<void>(resolve => { resume = resolve; });
  const f = fixture({ launch: async (_kind, allowed) => {
    await pending;
    assert.equal(allowed(), false);
    throw new Error('已取消');
  } });
  const starting = f.runtime.start();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  f.runtime.stop();
  resume();
  await starting;
  assert.equal(f.timers.size, 0);
  assert.equal(f.logs.filter(x => x.includes('FAILED')).length, 0);
});

test('renderer-only不启动信令且只取得renderer锁', async () => {
  const acquired: string[] = [];
  const launched: string[] = [];
  const runtime = createPreviewRuntime({
    enabled: () => true,
    acquire: async kind => { acquired.push(kind); return () => {}; },
    portOpen: async () => true,
    exportActive: async () => false,
    rendererRunning: async () => false,
    launch: async kind => {
      launched.push(kind);
      return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as ChildProcess;
    },
    kill: () => {}, log: () => {}, now: () => 0,
    later: () => ({} as ReturnType<typeof setTimeout>), cancel: () => {}
  }, { player: 8888, streamer: 8889 }, true);
  await runtime.start();
  assert.deepEqual(acquired, ['renderer']);
  assert.deepEqual(launched, ['renderer']);
  runtime.stop();
});

test('识别相同项目与streamer端口，忽略录制实例与其他项目', () => {
  const command = 'UnrealEditor.exe "E:\\项目\\demo.uproject" -game -PixelStreamingURL=ws://127.0.0.1:8889 -ResX=720';
  assert.equal(previewRendererMatches(command, 'E:/项目/demo.uproject', 8889), true);
  assert.equal(previewRendererMatches(command, 'E:/项目/demo.uproject', 889), false);
  assert.equal(previewRendererMatches(command.replace(':8889', ':88890'), 'E:/项目/demo.uproject', 8889), false);
  assert.equal(previewRendererMatches(command, 'E:/项目/other.uproject', 8889), false);
  assert.equal(previewRendererMatches(command.replace(':8889', ':4676'), 'E:/项目/demo.uproject', 8889), false);
  assert.equal(previewRendererMatches(command.replace('demo.uproject', 'demo.uproject-other'), 'E:/项目/demo.uproject', 8889), false);
  assert.equal(previewRendererMatches(command.replace('-game ', '-game-other '), 'E:/项目/demo.uproject', 8889), false);
});
