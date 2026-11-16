import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createFramePlayback } from '../apps/ue-player/playback.js';
// @ts-ignore 浏览器共用的原生 JS 模块
import { createPlaybackClock } from '../apps/studio/public/playback-clock.js';

function scheduler() {
  let now = 0, serial = 0;
  const jobs = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    schedule(callback: () => void, delay = 0) { const id = ++serial; jobs.set(id, { at: now + delay, callback }); return id; },
    cancel(id: number) { jobs.delete(id); },
    advance(ms: number) {
      const end = now + ms;
      while (true) {
        const next = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; jobs.delete(next[0]); next[1].callback();
      }
      now = end;
    },
    first() { return [...jobs.values()][0]?.callback; },
  };
}

test('暂停保留字幕、素材显隐、音频延迟和结束任务的剩余时间，清空拒绝迟到回调', () => {
  const timer = scheduler();
  const clock = createPlaybackClock({ now: timer.now, schedule: timer.schedule, cancel: timer.cancel });
  const fired: string[] = [];
  for (const [name, delay] of [['字幕', 30], ['旁白', 1200], ['素材隐藏', 5500], ['结束', 8000]] as const) clock.setTimeout(() => fired.push(name), delay);
  timer.advance(500);
  const stale = timer.first()!;
  clock.pause(); timer.advance(10000);
  assert.equal(clock.now(), 500); assert.deepEqual(fired, ['字幕']);
  clock.resume(); stale(); assert.deepEqual(fired, ['字幕']);
  timer.advance(699); assert.deepEqual(fired, ['字幕']);
  timer.advance(1); assert.deepEqual(fired, ['字幕', '旁白']);
  timer.advance(4300); assert.deepEqual(fired, ['字幕', '旁白', '素材隐藏']);
  const cancelled = timer.first()!; clock.clear(); cancelled(); timer.advance(10000);
  assert.deepEqual(fired, ['字幕', '旁白', '素材隐藏']);
});

test('地图暂停继续保留当前帧、原始飞行门槛与完成事件且取消旧RAF', () => {
  const timer = scheduler(), frames: number[] = [], events: string[] = [];
  const player = createFramePlayback({ now: timer.now, request: (cb) => timer.schedule(cb, 100), cancel: timer.cancel, draw: (time) => frames.push(time), notify: (event) => events.push(event) });
  player.play(10, 12, 'done', {}, 1);
  timer.advance(500); const stale = timer.first()!;
  player.pause(); const frozen = frames.at(-1);
  timer.advance(10000); assert.equal(frames.at(-1), frozen); assert.deepEqual(events, []);
  player.resume(); stale(); assert.equal(frames.at(-1), frozen);
  timer.advance(500); assert.deepEqual(events, ['tour-flight-complete']);
  timer.advance(1100); assert.deepEqual(events, ['tour-flight-complete', 'done']);
  assert.equal(frames.at(-1), 12);
  player.play(0, 10, 'old'); const cancelled = timer.first()!; player.stop(); cancelled();
  assert.deepEqual(events, ['tour-flight-complete', 'done']);
});

async function studioHarness() {
  const source = await readFile(new URL('../apps/studio/public/studio.js', import.meta.url), 'utf8');
  const timer = scheduler(), calls: string[] = [];
  const audio = { currentTime: 2, muted: false, pause() { calls.push('audio-pause'); } };
  const video = { paused: false, currentTime: 3, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } };
  const state: any = { playbackStatus: 'playing', playbackEpoch: 1, previewAudioSeekToken: 0, deferredPlaybackCallbacks: [], playbackStageActive: true, playbackStagePlacement: { id: '照片二' }, previewAudio: audio, playTimer: 1, subtitleTimers: [] };
  const nodes: any = { previewAssetVideo: video, playButton: {}, cesiumPreview: { contentWindow: { postMessage(data: any) { calls.push(data.action); } } }, previewAssetFrame: { getAnimations() { return []; } } };
  const clock = createPlaybackClock({ now: timer.now, schedule: timer.schedule, cancel: timer.cancel });
  const context = vm.createContext({ state, playbackClock: clock, $: (id: string) => nodes[id], CESIUM_PREVIEW_ORIGIN: 'local', clearPreviewSubtitleTimers() {}, selectedScene: () => ({ id: 'scene' }), selectedPlacement: () => null, applyPreviewStagePlacement() {}, showPreviewSubtitle() { calls.push('subtitle-reset'); }, playAudioElement() { calls.push('audio-play'); }, startPlaybackFromSelected() { calls.push('restart'); } });
  vm.runInContext(source.slice(source.indexOf('function sendPlaybackControl('), source.indexOf('/* The export splits', source.indexOf('function sendPlaybackControl('))), context);
  const toggleStart = source.indexOf('function togglePlayback()');
  vm.runInContext(source.slice(toggleStart, source.indexOf('async function boot()', toggleStart)), context);
  return { state, timer, clock, calls, video, run: (code: string) => vm.runInContext(code, context) };
}

test('真实studio暂停继续不重飞、不重置字幕素材或视频位置，完成与停止不同', async () => {
  const h = await studioHarness();
  let advanced = 0; h.clock.setTimeout(() => advanced++, 1000);
  h.timer.advance(200); h.run('togglePlayback()');
  assert.equal(h.state.playbackStatus, 'paused'); assert.equal(h.video.currentTime, 3);
  const placement = h.state.playbackStagePlacement;
  h.timer.advance(5000); assert.equal(advanced, 0);
  h.run('togglePlayback()'); assert.equal(h.state.playbackStagePlacement, placement);
  assert.equal(h.video.currentTime, 3); assert.equal(h.video.paused, false);
  assert.ok(!h.calls.includes('restart')); assert.ok(!h.calls.includes('subtitle-reset'));
  h.timer.advance(800); assert.equal(advanced, 1);
  h.run('stopPlayback({completed:true})'); assert.equal(h.state.playbackStatus, 'completed');
  assert.equal(h.state.playbackStagePlacement, placement);
  h.run('stopPlayback()'); assert.equal(h.state.playbackStatus, 'idle'); assert.equal(h.state.playbackStagePlacement, null);
});

test('无音频与无renderSpec预览仍轮播素材，暂停期间不消耗完成预算', async () => {
  const source = await readFile(new URL('../apps/studio/public/studio.js', import.meta.url), 'utf8');
  for (const range of [null, { start: 4, end: 6 }]) {
    const timer = scheduler();
    const clock = createPlaybackClock({ now: timer.now, schedule: timer.schedule, cancel: timer.cancel });
    const scene = { id: 'one', section: 'child' };
    const state: any = { playTimer: true, playbackEpoch: 1, playbackContinuous: false, project: { scenes: [scene] } };
    let completed = false, progress = 0;
    const context = vm.createContext({ state, playbackClock: clock, selectedScene: () => scene, openingNarrationDelaySeconds: () => 0, sceneNarrationRange: () => range, sceneDuration: () => 2, sceneStartSeconds: () => 0, totalDuration: () => 2, formatTime: String, $: () => null, syncPlaybackStage: (_scene: unknown, position: number) => { progress = position; }, stopPlayback: () => { completed = true; } });
    const start = source.indexOf('function playbackProgress(');
    vm.runInContext(source.slice(start, source.indexOf('function syncPlaybackStage(', start)), context);
    const scheduleStart = source.indexOf('function schedulePlaybackAdvance()');
    vm.runInContext(source.slice(scheduleStart, source.indexOf('/* Playback is a *still preview*', scheduleStart)), context);
    vm.runInContext('schedulePlaybackAdvance()', context);
    timer.advance(900); assert.ok(progress > 0.4 && progress < 0.5);
    clock.pause(); timer.advance(10000); assert.equal(completed, false);
    clock.resume(); timer.advance(1000); assert.equal(completed, false);
    timer.advance(130); assert.equal(completed, true);
  }
});

test('旧metadata在同epoch切场或替换audio后迟到不得seek', async () => {
  const source = await readFile(new URL('../apps/studio/public/studio.js', import.meta.url), 'utf8');
  for (const changeAudio of [false, true]) {
    const timer = scheduler(), listeners: Record<string, () => void> = {};
    const clock = createPlaybackClock({ now: timer.now, schedule: timer.schedule, cancel: timer.cancel });
    const audio = { readyState: 0, currentTime: 0, muted: true, addEventListener(name: string, cb: () => void) { listeners[name] = cb; } };
    const scene = { id: 'old', section: 'child' }, state: any = { playbackEpoch: 1, playbackStatus: 'playing', deferredPlaybackCallbacks: [], previewAudio: audio, playTimer: 1 };
    let current = scene, seeks = 0;
    const context = vm.createContext({ state, playbackClock: clock, selectedScene: () => current, ensurePreviewAudio: () => audio, sceneNarrationRange: () => ({ start: 4, end: 8 }), syncPreviewSubtitlesToAudio() {}, seekPreviewAudio() { seeks++; } });
    const callbackStart = source.indexOf('function playbackCallback(');
    vm.runInContext(source.slice(callbackStart, source.indexOf('/* The export splits', callbackStart)), context);
    const narrationStart = source.indexOf('function playPreviewNarration(');
    vm.runInContext(source.slice(narrationStart, source.indexOf('function assetById', narrationStart)), context);
    (context as any).scene = scene; vm.runInContext('playPreviewNarration(scene)', context); timer.advance(0);
    if (changeAudio) state.previewAudio = {}; else current = { ...scene, id: 'new' };
    listeners.loadedmetadata!(); assert.equal(seeks, 0);
  }
});

test('真实Chrome点击暂停继续冻结素材动画与延迟任务（模拟UE和媒体）', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="playButton">Ⅱ</button><div id="previewAssetFrame">素材</div><div id="previewSubtitle">当前字幕</div>');
    const source = await readFile(new URL('../apps/studio/public/studio.js', import.meta.url), 'utf8');
    const clockSource = await readFile(new URL('../apps/studio/public/playback-clock.js', import.meta.url), 'utf8');
    const controls = source.slice(source.indexOf('function sendPlaybackControl('), source.indexOf('/* The export splits', source.indexOf('function sendPlaybackControl(')));
    const toggleStart = source.indexOf('function togglePlayback()');
    const toggle = source.slice(toggleStart, source.indexOf('async function boot()', toggleStart));
    await page.evaluate(({ controls, toggle, clockSource }) => {
      const setup = `${clockSource.replace('export function', 'function')}\nconst playbackClock = createPlaybackClock();
      const calls = []; const video = {paused:false,currentTime:3,pause(){this.paused=true},play(){this.paused=false;return Promise.resolve()}};
      const state = {playbackStatus:'playing',playbackEpoch:1,deferredPlaybackCallbacks:[],previewAudio:{paused:false,pause(){this.paused=true}},playTimer:1};
      const $ = id => id === 'cesiumPreview' ? {contentWindow:{postMessage(data){calls.push(data.action)}}} : id === 'previewAssetVideo' ? video : document.getElementById(id);
      const CESIUM_PREVIEW_ORIGIN = 'mock'; const playAudioElement = audio => {audio.paused=false};
      ${controls}\n${toggle}\n
      const animation = $('previewAssetFrame').animate([{transform:'translateX(0px)'},{transform:'translateX(100px)'}],{duration:10000,fill:'both'});
      let fired=false; globalThis.armPausedTimer=()=>playbackClock.setTimeout(()=>{fired=true},200);
      $('playButton').onclick=togglePlayback;
      globalThis.probe=()=>({calls:[...calls],fired,time:animation.currentTime,status:state.playbackStatus,videoTime:video.currentTime,subtitle:document.getElementById('previewSubtitle').textContent});`;
      (0, eval)(setup);
    }, { controls, toggle, clockSource });
    await page.click('#playButton');
    await page.evaluate(() => (globalThis as any).armPausedTimer());
    const before = await page.evaluate(() => (globalThis as any).probe());
    await page.waitForTimeout(300);
    const paused = await page.evaluate(() => (globalThis as any).probe());
    assert.equal(paused.status, 'paused'); assert.equal(paused.fired, false); assert.equal(paused.time, before.time);
    assert.equal(paused.subtitle, '当前字幕'); assert.equal(paused.videoTime, 3);
    await page.click('#playButton'); await page.waitForTimeout(250);
    const resumed = await page.evaluate(() => (globalThis as any).probe());
    assert.equal(resumed.status, 'playing'); assert.equal(resumed.fired, true);
    assert.deepEqual(resumed.calls, ['pause-scene-playback', 'resume-scene-playback']);
    assert.ok(resumed.time > paused.time);
  } finally { await browser.close(); }
});

test('真实地图完成回调等待共享填色落稳预算，暂停不消耗素材入场延迟', async () => {
  const source = await readFile(new URL('../apps/studio/public/studio.js', import.meta.url), 'utf8');
  const timer = scheduler();
  const clock = createPlaybackClock({ now: timer.now, schedule: timer.schedule, cancel: timer.cancel });
  const parent = {}, scene = { id: 'scene', section: 'child', childId: 'a' };
  const state = { playbackEpoch: 1, playbackStatus: 'playing', deferredPlaybackCallbacks: [], previewAssetReadySceneId: null };
  let reveals = 0;
  const context = vm.createContext({ state, playbackClock: clock, $: () => ({ contentWindow: parent }), CESIUM_PREVIEW_ORIGIN: 'local', selectedScene: () => scene, isOpeningScene: () => false, tourPreviewPayload: () => ({ tourStops: [{ id: 'a', flightDuration: 3.2, visualReadySeconds: 4.75 }] }), revealSelectedSceneAsset: () => { reveals++; } });
  const callbackStart = source.indexOf('function playbackCallback(');
  vm.runInContext(source.slice(callbackStart, source.indexOf('/* The export splits', callbackStart)), context);
  const handlerStart = source.indexOf('function handleCesiumPreviewMessage(');
  vm.runInContext(source.slice(handlerStart, source.indexOf('function ensurePreviewAudio()', handlerStart)), context);
  (context as any).event = { source: parent, origin: 'local', data: { type: 'geo-video-player', event: 'tour-flight-complete', childId: 'a', playbackEpoch: 1 } };
  vm.runInContext('handleCesiumPreviewMessage(event)', context);
  timer.advance(1000); assert.equal(reveals, 0);
  clock.pause(); timer.advance(10000); assert.equal(reveals, 0);
  clock.resume(); timer.advance(549); assert.equal(reveals, 0);
  timer.advance(2); assert.equal(reveals, 1); assert.equal(state.previewAssetReadySceneId, 'scene');
});

test('暂停中迟到音频metadata/地图完成回调延后，停止或换场后丢弃', async () => {
  const h = await studioHarness();
  h.run('globalThis.count = 0; globalThis.delayed = playbackCallback(() => count++); pausePlayback(); delayed()');
  assert.equal(h.run('count'), 0); h.run('resumePlayback()'); assert.equal(h.run('count'), 1);
  h.run('pausePlayback(); delayed(); stopPlayback(); resumePlayback(); delayed()');
  assert.equal(h.run('count'), 1);
});
