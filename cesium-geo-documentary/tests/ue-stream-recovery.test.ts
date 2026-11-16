import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';
import { createFramePlayback } from '../apps/ue-player/playback.js';

const clientSource = await readFile(new URL('../apps/ue-player/client.ts', import.meta.url), 'utf8');
const executable = (await transform(`(async () => {\n${clientSource.replace(/^import .*;\s*$/gm, '')}\n})()`, {
  loader: 'ts', format: 'cjs', target: 'es2022'
})).code;

class Events {
  listeners = new Map<string, Set<(event: any) => void>>();
  addEventListener(name: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener); this.listeners.set(name, listeners);
  }
  removeEventListener(name: string, listener: (event: any) => void) { this.listeners.get(name)?.delete(listener); }
  dispatch(name: string, event: any = {}) {
    for (const listener of [...this.listeners.get(name) ?? []]) listener({ type: name, ...event });
  }
}

/** Every window of one origin shares this bus; a message is delivered to the other
 *  windows only, exactly like BroadcastChannel. Letting a test drive it is how the
 *  two-window contention cases become reproducible. */
class Bus {
  listeners = new Set<(event: any) => void>();
  send(message: any, from?: (event: any) => void) {
    for (const listener of this.listeners) if (listener !== from) listener({ data: structuredClone(message) });
  }
}

let globalViewerId = 1;
async function harness(search = '', sharedBus?: Bus) {
  let now = 1000, nextTimer = 1, nextId = 1;
  const bus = sharedBus ?? new Bus();
  const timers = new Map<number, { at: number; callback: () => void; interval: number }>();
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const schedule = (callback: () => void, delay = 0, interval = 0) => {
    const id = nextTimer++; timers.set(id, { at: now + delay, callback, interval }); return id;
  };
  const advance = async (milliseconds: number) => {
    const target = now + milliseconds;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = Math.max(now, next[1].at); timers.delete(next[0]);
      if (next[1].interval) timers.set(next[0], { ...next[1], at: now + next[1].interval });
      next[1].callback(); await flush();
    }
    now = target; await flush();
  };
  class Element extends Events {
    textContent = ''; hidden = false; onclick: (() => void) | null = null;
    style = {}; children: unknown[] = [];
    appendChild(child: unknown) { this.children.push(child); }
    replaceChildren(...children: unknown[]) { this.children = children; }
    click() { this.onclick?.(); this.dispatch('click'); }
  }
  const video = Object.assign(new Element(), {
    readyState: 4, videoWidth: 720, videoHeight: 1280, currentTime: 0, paused: false, ended: false,
    playCalls: 0, async play() { this.playCalls++; this.paused = false; },
    getVideoPlaybackQuality() { return { totalVideoFrames: Math.floor(this.currentTime * 30) }; }
  });
  const elements = Object.fromEntries(['connection', 'status', 'stream', 'retry'].map(id => [id, new Element()]));
  const document = Object.assign(new Events(), {
    hidden: false, visibilityState: 'visible',
    getElementById: (id: string) => elements[id], querySelector: (selector: string) => selector === 'video' ? video : null
  });
  const window = new Events() as Events & { geoVideo: any };
  const messages: any[] = [], beacons: any[] = [], claims: any[] = [];
  let lease: (signal?: AbortSignal) => Promise<any> = async () => ({ granted: true });
  const configs: any[] = [];
  class Config { constructor(options: any) { configs.push(options); } }
  class PixelStreaming extends Events {
    static instances: PixelStreaming[] = [];
    connectCalls = 0; disconnectCalls = 0; reconnectCalls = 0; sent: any[] = [];
    response?: (raw: string) => void;
    constructor(..._args: any[]) { super(); PixelStreaming.instances.push(this); }
    connect() { this.connectCalls++; }
    disconnect() { this.disconnectCalls++; }
    reconnect() { this.reconnectCalls++; }
    addResponseEventListener(_name: string, callback: (raw: string) => void) { this.response = callback; }
    removeResponseEventListener() {}
    emitUIInteraction(payload: any) {
      this.sent.push(payload);
      if (payload.requestId) queueMicrotask(() => this.response?.(JSON.stringify({ type: 'geo-video-ue', requestId: payload.requestId })));
      return true;
    }
  }
  const parent = { postMessage: (message: any) => messages.push(message) };
  class Channel {
    private listener?: (event: any) => void;
    postMessage(message: any) { bus.send(message, this.listener); }
    addEventListener(_name: string, listener: (event: any) => void) { this.listener = listener; bus.listeners.add(listener); }
    close() { if (this.listener) bus.listeners.delete(this.listener); }
  }
  // Native animation APIs reject a plain dependency object as their receiver.
  // Keep the same constraint in this harness so extracted references cannot pass.
  function requestFrame(this: unknown, callback: () => void) {
    assert.equal(this, window, 'requestAnimationFrame requires the window receiver');
    return schedule(callback, 16);
  }
  function cancelFrame(this: unknown, id: number) {
    assert.equal(this, window, 'cancelAnimationFrame requires the window receiver');
    timers.delete(id);
  }
  Object.assign(window, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame });
  const sandbox = {
    window, document, parent, location: { search, origin: 'http://player.test' },
    navigator: { sendBeacon: (...args: any[]) => { beacons.push(args); return true; } },
    URL, URLSearchParams, AbortController, Blob, console, queueMicrotask, structuredClone,
    BroadcastChannel: Channel,
    crypto: { randomUUID: () => `request-${nextId++}-viewer-${globalViewerId++}` }, performance: { now: () => now },
    Date: class extends Date { static now() { return now; } }, innerWidth: 720, innerHeight: 1280,
    setTimeout: (callback: () => void, delay: number) => schedule(callback, delay),
    setInterval: (callback: () => void, delay: number) => schedule(callback, delay, delay),
    clearTimeout: (id: number) => timers.delete(id), clearInterval: (id: number) => timers.delete(id),
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame,
    fetch: async (url: string, options: any = {}) => {
      if (url === '/runtime-config.json') return { ok: true, status: 200, json: async () => ({ signallingUrl: 'ws://unused.test', streamFps: 30 }) };
      if (url === '/api/viewer-slot') {
        claims.push({ at: now, options });
        const grant = await lease(options.signal);
        return { ok: grant.granted === true, status: grant.granted === true ? 200 : 409, json: async () => grant };
      }
      if (url === '/api/viewer-slot/release') return { ok: true, status: 204, json: async () => ({}) };
      if (url.startsWith('/api/scene?')) return { ok: true, status: 200, json: async () => ({ region: { tourStops: [] }, imagery: { provider: 'test' } }) };
      throw new Error(`未模拟的请求 ${url}`);
    },
    Config, PixelStreaming, DEFAULT_IMAGERY_PROVIDER: 'test',
    createFramePlayback,
    actions: new Set(['seek', 'prepare-tour', 'set-annotations', 'update-tour-labels', 'play-scene-range', 'stop-scene-playback', 'pause-scene-playback', 'resume-scene-playback']),
    frameAt: (_scene: any, stops: any[], time: number, _profile: string, _duration: number, _opening: boolean, _origin?: any, _overview?: number, _view?: any, contextIntro?: boolean) => ({ time, stops, accents: {}, contextIntro }),
    contextIntroSeconds: () => 0, configureOpening: (region: any) => region,
    subtitleBounds: (bounds: any) => bounds, activeSubtitleBounds: () => null
  };
  await vm.runInNewContext(executable, sandbox); await flush();
  const instances = PixelStreaming.instances;
  // Slot pages first ask their peers, then claim, then connect; let that settle so
  // tests observe the connected state rather than the in-flight probe.
  if (!search.includes('slot=off')) await advance(800);
  const open = async (stream = instances.at(-1)!) => { stream.dispatch('dataChannelOpen'); await flush(); };
  return { instances, configs, claims, timers, document, window, video, elements, messages, beacons, parent, bus,
    advance, flush, open, freeze: (milliseconds: number) => { now += milliseconds; },
    setLease: (handler: typeof lease) => { lease = handler; },
    connections: () => instances.reduce((total, instance) => total + instance.connectCalls + instance.reconnectCalls, 0) };
}

test('应用独占重连，UE 冷启动期间不打断首次握手', async () => {
  const h = await harness('?slot=off');
  assert.equal(h.configs[0].initialSettings.MaxReconnectAttempts, 0);
  assert.equal(h.connections(), 1);
  await h.advance(59000);
  assert.equal(h.connections(), 1);
  await h.advance(3000);
  assert.equal(h.connections(), 2);
  assert.equal(h.instances.length, 2);
  assert.equal(h.instances[0]!.reconnectCalls, 0);
});

test('重复断流事件只安排一次恢复并忽略旧实例迟到事件', async () => {
  const h = await harness('?slot=off'); await h.open();
  const old = h.instances[0]!;
  old.dispatch('dataChannelClose'); old.dispatch('webRtcDisconnected'); old.dispatch('dataChannelClose');
  await h.advance(2000);
  assert.equal(h.connections(), 2);
  await h.open();
  old.dispatch('dataChannelClose'); old.dispatch('dataChannelOpen'); old.response?.('{bad json');
  await h.advance(3000);
  assert.equal(h.connections(), 2);
  assert.equal(h.window.geoVideo.getStreamHealth().ready, true);
});

test('租约心跳返回占用时不拆断仍在出画面的流', async () => {
  const h = await harness(); await h.open(); h.setLease(async () => ({ granted: false }));
  h.video.currentTime = 1;
  await h.advance(12000);
  h.video.currentTime = 5;
  await h.advance(12000);
  // Video is live: losing the HTTP lease race must not open a second subscriber
  // against the same single-controller UE.
  assert.equal(h.instances.length, 1);
  assert.equal(h.instances[0]!.disconnectCalls, 0);
});

test('恢复后的新流握手不受旧续租 busy 或 offline 响应影响', async () => {
  for (const outcome of ['busy', 'offline']) {
    const h = await harness(); await h.open();
    let settleOld!: (value: any) => void;
    h.setLease(() => new Promise(resolve => { settleOld = resolve; }).then(value => {
      if (outcome === 'offline') throw new Error('network unavailable');
      return value;
    }));
    await h.advance(4000);
    assert.equal(h.claims.length, 2);
    h.instances[0]!.dispatch('dataChannelClose');
    h.setLease(async () => ({ granted: true }));
    await h.advance(2800);
    assert.equal(h.connections(), 2);
    const replacement = h.instances.at(-1)!;
    assert.equal(h.window.geoVideo.getStreamHealth().stage, 'connecting');

    settleOld({ granted: false });
    await h.flush();
    assert.equal(replacement.disconnectCalls, 0, outcome);
    assert.equal(h.instances.length, 2);
    assert.equal(h.window.geoVideo.getStreamHealth().stage, 'connecting');
    await h.open(replacement);
    assert.equal(h.window.geoVideo.getStreamHealth().ready, true);
  }
});

test('新流可以独立续租，旧成功回复不释放新租约也不清除新请求标记', async () => {
  const h = await harness(); await h.open();
  let settleOld!: (value: any) => void;
  h.setLease(() => new Promise(resolve => { settleOld = resolve; }));
  await h.advance(4000);
  h.instances[0]!.dispatch('dataChannelClose');
  h.setLease(async () => ({ granted: true }));
  await h.advance(2800); await h.open();
  let settleNew!: (value: any) => void;
  h.setLease(() => new Promise(resolve => { settleNew = resolve; }));
  await h.advance(4000);
  assert.equal(h.claims.length, 4);
  const releases = h.beacons.length;
  settleOld({ granted: true }); await h.flush();
  assert.equal(h.beacons.length, releases);
  h.document.dispatch('visibilitychange'); await h.flush();
  assert.equal(h.claims.length, 4);
  settleNew({ granted: true }); await h.flush();
  h.setLease(async () => ({ granted: true }));
  await h.advance(4000);
  assert.equal(h.claims.length, 5);
});

test('租约续期串行进行，挂起请求不能叠加心跳', async () => {
  const h = await harness(); await h.open();
  let settle!: (value: any) => void;
  h.setLease(() => new Promise(resolve => { settle = resolve; }));
  await h.advance(4000); const count = h.claims.length;
  await h.advance(1000);
  assert.equal(h.claims.length, count);
  settle({ granted: true }); await h.flush();
  await h.advance(4000);
  assert.equal(h.claims.length, count + 1);
  h.window.dispatch('pagehide'); settle({ granted: true }); await h.flush();
});

test('pagehide 取消恢复和心跳，BFCache pageshow 重新申请租约', async () => {
  const h = await harness(); await h.open();
  h.instances[0]!.dispatch('dataChannelClose'); h.window.dispatch('pagehide'); await h.flush();
  const claims = h.claims.length, connects = h.connections();
  await h.advance(60000);
  assert.equal(h.claims.length, claims); assert.equal(h.connections(), connects);
  assert.equal(h.timers.size, 0); assert.ok(h.beacons.length > 0);
  h.window.dispatch('pageshow', { persisted: true });
  await h.advance(800);
  assert.equal(h.claims.length, claims + 1); assert.equal(h.connections(), connects + 1);
});

test('重新申请租约期间进入BFCache，旧请求结束后仍能恢复连接', async () => {
  const h = await harness(); await h.open();
  h.instances[0]!.dispatch('dataChannelClose');
  let settle!: (value: any) => void;
  h.setLease(() => new Promise(resolve => { settle = resolve; }));
  await h.advance(2800);
  h.window.dispatch('pagehide');
  h.window.dispatch('pageshow', { persisted: true });
  h.setLease(async () => ({ granted: true }));
  settle({ granted: true }); await h.flush();
  await h.advance(800);
  assert.equal(h.connections(), 2);
  await h.open();
  assert.equal(h.window.geoVideo.getStreamHealth().ready, true);
});

test('探测其他窗口期间退出页面立即取消探测定时器', async () => {
  const h = await harness(); await h.open();
  h.instances[0]!.dispatch('dataChannelClose');
  await h.advance(2000);
  h.window.dispatch('pagehide'); await h.flush();
  assert.equal(h.timers.size, 0);
  await h.advance(60000);
  assert.equal(h.connections(), 1);
});

test('pagehide 后迟到的续期成功不得重新连接', async () => {
  const h = await harness(); await h.open();
  let settle!: (value: any) => void;
  h.setLease(() => new Promise(resolve => { settle = resolve; }));
  await h.advance(4000); h.window.dispatch('pagehide'); settle({ granted: true }); await h.flush();
  await h.advance(60000);
  assert.equal(h.connections(), 1); assert.equal(h.timers.size, 0);
});

test('BFCache恢复后迟到的旧续租成功不能释放新流租约', async () => {
  const h = await harness(); await h.open();
  let settleOld!: (value: any) => void;
  h.setLease(() => new Promise(resolve => { settleOld = resolve; }));
  await h.advance(4000);
  h.window.dispatch('pagehide');
  h.setLease(async () => ({ granted: true }));
  h.window.dispatch('pageshow', { persisted: true });
  await h.advance(800); await h.open();
  const releases = h.beacons.length;
  settleOld({ granted: true }); await h.flush();
  assert.equal(h.beacons.length, releases);
  assert.equal(h.window.geoVideo.getStreamHealth().ready, true);
});

test('手动重试重新申请租约，不直接调用库重连', async () => {
  const h = await harness(); await h.open();
  const before = h.claims.length;
  h.instances[0]!.dispatch('dataChannelClose'); await h.flush();
  h.elements.retry!.click(); await h.flush(); await h.advance(3000);
  assert.ok(h.claims.length > before);
  assert.equal(h.instances[0]!.reconnectCalls, 0);
});

test('旧视频 play 延迟拒绝不会让恢复流卡在 play-blocked', async () => {
  const h = await harness('?slot=off'); await h.open();
  let rejectOld!: (error: Error) => void;
  h.video.paused = true;
  h.video.play = () => new Promise((_resolve, reject) => { rejectOld = reject; });
  await h.advance(2000);
  h.instances[0]!.dispatch('dataChannelClose');
  await h.advance(2000);
  h.video.readyState = 0; h.video.videoWidth = 0;
  await h.open(h.instances.at(-1)!);
  rejectOld(new Error('old video play rejected'));
  await h.flush();
  assert.equal(h.window.geoVideo.getStreamHealth().stage, 'waiting-first-frame');
  await h.advance(26000);
  assert.equal(h.connections(), 3);
  assert.notEqual(h.window.geoVideo.getStreamHealth().stage, 'play-blocked');
});

test('旧播放按钮请求的成功或失败均不回写新实例的播放提示', async () => {
  for (const outcome of ['resolved', 'rejected']) {
    const h = await harness('?slot=off'); await h.open();
    const old = h.instances[0]!;
    old.dispatch('playStreamRejected');
    let settleOld!: () => void;
    h.video.play = () => new Promise<void>((resolve, reject) => {
      settleOld = () => outcome === 'resolved' ? resolve() : reject(new Error('old play rejected'));
    });
    h.elements.retry!.click();
    old.dispatch('dataChannelClose');
    await h.advance(2000);
    h.video.readyState = 0; h.video.videoWidth = 0;
    const replacement = h.instances.at(-1)!;
    await h.open(replacement);
    replacement.dispatch('playStreamRejected');
    const message = h.elements.status!.textContent;
    settleOld(); await h.flush();
    assert.equal(h.window.geoVideo.getStreamHealth().stage, 'play-blocked', outcome);
    assert.equal(h.elements.status!.textContent, message, outcome);
  }
});

test('自动播放被拒后的点击只播放视频，不创建连接', async () => {
  const h = await harness('?slot=off'); await h.open();
  h.video.paused = true; h.instances[0]!.dispatch('playStreamRejected'); h.elements.retry!.click(); await h.flush();
  assert.equal(h.video.playCalls, 1); assert.equal(h.connections(), 1);
});

test('前台视频帧冻结十五秒触发恢复', async () => {
  const h = await harness('?slot=off'); await h.open();
  await h.advance(20000);
  assert.ok(h.connections() >= 2);
});

test('后台视频停帧不会误重连', async () => {
  const h = await harness('?slot=off'); await h.open();
  h.document.hidden = true; h.document.visibilityState = 'hidden'; h.document.dispatch('visibilitychange');
  await h.advance(60000);
  assert.equal(h.connections(), 1);
});

test('双窗口争用时只有持有画面者接入，另一窗口不制造连接', async () => {
  const bus = new Bus();
  const a = await harness('', bus); await a.open();
  const b = await harness('', bus);
  assert.equal(b.connections(), 0);
  assert.equal(a.connections(), 1);
  assert.match(String(b.elements.status!.textContent), /另一个窗口/);
  // While A still produces frames B stays out, even if the HTTP lease would let it in.
  a.video.currentTime = 3;
  await b.advance(12000);
  assert.equal(b.connections(), 0);
  a.window.dispatch('pagehide'); await b.advance(4000);
  assert.equal(b.connections(), 1);
});

test('页面从后台返回时重新确认租约，不把节流误判为断流', async () => {
  const h = await harness('?slot=off'); await h.open();
  h.video.currentTime = 1;
  h.document.hidden = true; h.document.visibilityState = 'hidden'; h.document.dispatch('visibilitychange');
  await h.advance(60000);
  h.video.currentTime = 9;
  h.document.hidden = false; h.document.visibilityState = 'visible'; h.document.dispatch('visibilitychange');
  await h.advance(10000);
  assert.equal(h.instances.length, 1);
  assert.equal(h.window.geoVideo.getStreamHealth().ready, true);
});

test('无租约握手切回前台不会拆断正在协商的流', async () => {
  for (const search of ['?slot=off', '?capture=1']) {
    const h = await harness(search);
    h.document.hidden = true; h.document.dispatch('visibilitychange');
    h.document.hidden = false; h.document.dispatch('visibilitychange');
    await h.flush();
    assert.equal(h.connections(), 1, search);
    assert.equal(h.instances[0]!.disconnectCalls, 0, search);
    await h.open();
    assert.equal(h.window.geoVideo.getStreamHealth().ready, true, search);
  }
});

test('后台定时器完全冻结后切回前台，首帧等待重新获得完整预算', async () => {
  const h = await harness('?slot=off'); h.video.readyState = 0;
  await h.open();
  h.document.hidden = true; h.document.dispatch('visibilitychange');
  h.freeze(60000);
  h.document.hidden = false; h.document.dispatch('visibilitychange');
  await h.advance(10000);
  assert.equal(h.connections(), 1);
  await h.advance(15000);
  assert.equal(h.connections(), 2);
});

test('重连恢复场景时保留时间、游览点与控制消息', async () => {
  const h = await harness('?slot=off'); await h.open();
  const stops = [{ id: 'a', start: 2, end: 10 }];
  h.window.geoVideo.prepareStudioTour({ tourStops: stops });
  h.window.dispatch('message', { source: h.parent, origin: 'http://127.0.0.1:4180', data: { type: 'geo-video-studio', action: 'set-annotations', annotationWindows: [{ start: 1, end: 8 }] } });
  await h.window.geoVideo.seek(7); await h.flush();
  h.instances[0]!.dispatch('dataChannelClose'); await h.advance(2000); await h.open();
  const recovered = h.instances.at(-1)!;
  assert.equal(h.window.geoVideo.getFrameStatus().time, 7);
  assert.ok(recovered.sent.some(message => message.action === 'load-scene'));
  assert.ok(recovered.sent.some(message => message.action === 'set-annotations'));
  const frame = recovered.sent.find(message => message.action === 'apply-frame')?.frame;
  assert.equal(frame.time, 7); assert.equal(JSON.stringify(frame.stops), JSON.stringify(stops));
});

test('控制通道打开但首帧未到时二十秒后恢复，不永久停在连接界面', async () => {
  const h = await harness('?slot=off');
  h.video.readyState = 0; h.video.videoWidth = 0;
  await h.open();
  assert.equal(h.window.geoVideo.getStreamHealth().stage, 'waiting-first-frame');
  await h.advance(19000);
  assert.equal(h.connections(), 1);
  await h.advance(5000);
  assert.equal(h.connections(), 2);
  assert.match(h.window.geoVideo.getStreamHealth().lastFailure, /首帧超时/);
  h.video.readyState = 4; h.video.videoWidth = 720;
  await h.open();
  assert.equal(h.window.geoVideo.getStreamHealth().ready, true);
});

test('有巡游站点时单帧和批量导出仍启用第二场景县界介绍', async () => {
  const h = await harness('?slot=off'); await h.open();
  h.window.geoVideo.prepareStudioTour({ tourStops: [{ id: 'village', start: 50, end: 70 }] });
  await h.window.geoVideo.renderFrame(9);
  await h.window.geoVideo.renderBatch([9, 9.1]);
  const sent = h.instances.at(-1)!.sent;
  const single = sent.find(message => message.action === 'capture-frame')!.frame;
  const batch = sent.find(message => message.action === 'capture-batch')!.frames;
  assert.equal(single.contextIntro, true);
  assert.equal(single.stops.length, 1);
  assert.ok(batch.every((frame: any) => frame.contextIntro === true && frame.stops.length === 1));
});

test('按场景播放第二场景也启用县界介绍', async () => {
  const h = await harness('?slot=off'); await h.open();
  h.window.geoVideo.prepareStudioTour({ tourStops: [{ id: 'village', start: 50, end: 70 }] });
  h.window.dispatch('message', { source: h.parent, origin: 'http://127.0.0.1:4180', data: {
    type: 'geo-video-studio', action: 'play-scene-range', range: { start: 5, end: 20, sceneId: 'overview' }
  } });
  await h.advance(20);
  const frames = h.instances.at(-1)!.sent.filter(message => message.action === 'apply-frame');
  assert.equal(frames.at(-1)!.frame.contextIntro, true);
});

test('暂停途中断线重连仍保留原地图帧与剩余段，继续不重飞', async () => {
  const h = await harness('?slot=off'); await h.open();
  const control = (action: string, extra: any = {}) => h.window.dispatch('message', { source: h.parent, origin: 'http://127.0.0.1:4180', data: { type: 'geo-video-studio', action, ...extra } });
  control('play-scene-range', { playbackEpoch: 9, range: { start: 5, end: 8, sceneId: 'one', flightSeconds: 1 } });
  await h.advance(1200); control('pause-scene-playback');
  const frozen = h.window.geoVideo.getFrameStatus().time;
  h.instances.at(-1)!.dispatch('dataChannelClose');
  await h.advance(2000); await h.open(); await h.advance(500);
  assert.equal(h.window.geoVideo.getFrameStatus().time, frozen);
  control('resume-scene-playback'); await h.advance(2000);
  assert.equal(h.window.geoVideo.getFrameStatus().time, 8);
  assert.equal(h.messages.filter(message => message.event === 'tour-flight-complete').length, 1);
  assert.equal(h.messages.filter(message => message.event === 'scene-range-complete').length, 1);
});

test('地图加载前暂停保留待播命令，恢复才开始且停止会取消待播', async () => {
  const h = await harness('?slot=off');
  const control = (action: string, extra: any = {}) => h.window.dispatch('message', { source: h.parent, origin: 'http://127.0.0.1:4180', data: { type: 'geo-video-studio', action, ...extra } });
  control('play-scene-range', { playbackEpoch: 7, range: { start: 5, end: 6, sceneId: 'one' } });
  control('pause-scene-playback');
  await h.open(); await h.advance(1500);
  assert.ok(!h.messages.some(message => message.event === 'scene-range-complete'));
  control('resume-scene-playback'); await h.advance(500);
  control('pause-scene-playback');
  const position = h.window.geoVideo.getFrameStatus().time;
  await h.advance(2000); assert.equal(h.window.geoVideo.getFrameStatus().time, position);
  control('resume-scene-playback'); await h.advance(600);
  assert.equal(h.messages.filter(message => message.event === 'scene-range-complete').length, 1);
  assert.equal(h.messages.find(message => message.event === 'scene-range-complete').playbackEpoch, 7);
  control('play-scene-range', { range: { start: 8, end: 10 } });
  control('pause-scene-playback'); control('stop-scene-playback'); control('resume-scene-playback');
  await h.advance(3000);
  assert.equal(h.messages.filter(message => message.event === 'scene-range-complete').length, 1);
});

test('只有元数据不能宣布首帧就绪，loadeddata 到达后才加载场景', async () => {
  const h = await harness('?slot=off');
  h.video.readyState = 1;
  await h.open();
  assert.equal(h.window.geoVideo.getStreamHealth().ready, false);
  assert.equal(h.instances[0]!.sent.length, 0);
  h.video.readyState = 2; h.document.dispatch('loadeddata'); await h.flush();
  assert.equal(h.window.geoVideo.getStreamHealth().ready, true);
});

test('首帧等待在后台暂停计时，回到前台后保留完整恢复时间', async () => {
  const h = await harness('?slot=off'); h.video.readyState = 0;
  await h.open();
  h.document.hidden = true; await h.advance(60000);
  assert.equal(h.connections(), 1);
  h.document.hidden = false; h.document.dispatch('visibilitychange');
  await h.advance(10000);
  assert.equal(h.connections(), 1);
  await h.advance(16000);
  assert.equal(h.connections(), 2);
});

test('申请租约成功不能重置连续握手失败的退避间隔', async () => {
  const h = await harness();
  await h.advance(63000);
  assert.equal(h.connections(), 2);
  await h.advance(61000);
  assert.equal(h.connections(), 2);
  await h.advance(5000);
  assert.equal(h.connections(), 3);
  assert.equal(h.window.geoVideo.getStreamHealth().attempts, 2);
});

test('协商、订阅和控制通道显式失败立即进入统一退避，不等六十秒', async () => {
  for (const event of ['webRtcFailed', 'subscribeFailed', 'dataChannelError', 'playStreamError']) {
    const h = await harness('?slot=off');
    h.instances[0]!.dispatch(event);
    assert.equal(h.window.geoVideo.getStreamHealth().attempts, 1, event);
    await h.advance(2000);
    assert.equal(h.connections(), 2, event);
  }
});

test('租约请求网络异常不会遗留超时器，页面退出后无后台任务', async () => {
  const h = await harness(); await h.open();
  h.setLease(async () => { throw new Error('network unavailable'); });
  await h.advance(4000);
  h.window.dispatch('pagehide'); await h.flush();
  assert.equal(h.timers.size, 0);
});
