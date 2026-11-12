import { Config, PixelStreaming } from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.7';
import { actions, contextIntroSeconds, frameAt, type PreviewFlightOrigin } from './presentation.js';
import { configureOpening } from './opening.js';
import { activeSubtitleBounds, subtitleBounds, type SubtitleBounds, type SubtitleWindow } from './subtitle-layout.js';

let previewSubtitleBounds: SubtitleBounds | undefined;
let subtitleWindows: SubtitleWindow[] = [];
import { DEFAULT_IMAGERY_PROVIDER, type MapView } from '../../packages/project-schema/index.js';

const query = new URLSearchParams(location.search);
const parentOrigin = new URL(query.get('parentOrigin') || 'http://127.0.0.1:4180').origin;
const profile = query.get('profile') || 'portrait';
const imagery = query.get('imagery') || DEFAULT_IMAGERY_PROVIDER;
let imageryProvider = imagery;
const boundary = query.get('boundary');
function sceneQuery(provider = imageryProvider) {
  const params = new URLSearchParams({ region: query.get('region') || '', imagery: provider });
  if (provider === 'cesium-ion-world-imagery') params.set('session', crypto.randomUUID());
  if (boundary) params.set('boundary', boundary);
  return params;
}
const sceneUrl = () => `/api/scene?${sceneQuery()}`;
async function fetchJson(url: string, timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
async function fetchScene(url: string, signal?: AbortSignal) {
  return fetchJson(url, 30000, signal);
}
// Start the scene and two local fallback tiles during the WebRTC handshake.
let preloadedScene = query.has('studioPreview') ? fetchScene(`${sceneUrl()}&warm=1`).catch(() => undefined) : undefined;
const overlay = document.getElementById('connection')!;
const status = document.getElementById('status')!;
let scene: any, stops: any[] | undefined, duration = 4.4, time = 0, raf = 0, ready = false, openingOnly = false, contextIntro = false;
let channelReady = false;
let sceneLoad: AbortController | undefined;
let queuedMotion: any;
let displayedFrame: ReturnType<typeof frameAt> | undefined;
let flightOrigin: (PreviewFlightOrigin & { overviewStart?: number }) | undefined;
let previewView: MapView | null | undefined;
let lastDrawAt=-Infinity;
const controls = new Map<string, any>();
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const notify = (event: string, details = {}) => parent.postMessage({ type: 'geo-video-player', event, ...details }, parentOrigin);
const settings = await fetchJson('/runtime-config.json', 10000);
if (typeof settings.signallingUrl !== 'string' || !/^wss?:\/\//.test(settings.signallingUrl)) {
  throw new Error('UE signalling configuration unavailable');
}
// Camera updates go out at the stream's frame rate, not at a hardcoded 30: at 60 the
// old throttle halved the rate of the very motion it was meant to smooth.
const frameInterval = 1000 / Math.max(15, Math.min(120, Number(settings.streamFps) || 30));
// Only the application owns retry timers. SDK retries cannot be cancelled on lease
// loss and used to race our four-second reconnect loop.
const createConfig = () => new Config({ useUrlParams: false, initialSettings: { ss: settings.signallingUrl, AutoConnect: false, AutoPlayVideo: true, StartVideoMuted: true, WaitForStreamer: true, MaxReconnectAttempts:0, StreamerAutoJoinInterval:2000, MatchViewportRes: false, KeyboardInput: false, MouseInput: false, TouchInput: false } });
let stream: PixelStreaming;
let streamGeneration = 0;
function send(action: string, payload = {}): Promise<any> {
  if (!channelReady) return Promise.reject(new Error('UE data channel unavailable'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    // A batch rides one round trip for N frames; its reply can therefore take far
    // longer than a solo capture-frame, so it gets its own timeout budget.
    const budget = action === 'capture-frame' ? 90000 : action === 'capture-batch' ? 300000 : 30000;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`UE command timeout: ${action}`)); }, budget);
    pending.set(requestId, { resolve, reject, timer });
    if (!stream.emitUIInteraction({ type: 'geo-video-ue', version: 1, requestId, action, ...payload })) {
      clearTimeout(timer); pending.delete(requestId); reject(new Error('UE data channel unavailable'));
    }
  });
}
function draw(force=false) {
  if (!ready || !scene) return;
  const now=performance.now();if(!force && now-lastDrawAt<frameInterval)return;lastDrawAt=now;
  const overviewProgress = flightOrigin?.overviewStart === undefined ? undefined : (time - flightOrigin.overviewStart) / duration;
  const frame = frameAt(scene, stops ?? [], time, profile, duration, openingOnly, flightOrigin, overviewProgress, previewView, contextIntro);
  if (stream.emitUIInteraction({ type: 'geo-video-ue', version: 1, action: 'apply-frame', frame: { ...frame, subtitleBounds: previewSubtitleBounds ?? null } })) displayedFrame = frame;
}
function stop() { cancelAnimationFrame(raf); raf = 0; }
function play(start: number, end: number, done: string, details = {}, flightSeconds = 0) {
  stop(); time = start; draw(true); const started = performance.now(); let flightSent = false;
  const tick = () => {
    time = Math.min(end,start+(performance.now()-started)/1000); draw(time>=end);
    if (flightSeconds && !flightSent && time >= start+flightSeconds) { flightSent = true; notify('tour-flight-complete',details); }
    if (time < end) raf = requestAnimationFrame(tick); else { raf = 0; notify(done,details); }
  }; raf = requestAnimationFrame(tick);
}
function handle(data: any) {
  if (data.action === 'set-subtitle-bounds') {
    previewSubtitleBounds = subtitleBounds(data.bounds);
    draw(true);
    return;
  }
  if (!actions.has(data.action)) return;
  const p = data.preview || {};
  if (p.tourStops) stops = p.tourStops;
  if (p.returnDuration) duration = Number(p.returnDuration);
  if (data.mapView !== undefined) previewView = data.mapView;
  if (data.action === 'set-map-view') {
    if (queuedMotion) queuedMotion = { ...queuedMotion, mapView: previewView };
    draw(true);
    return;
  }
  if (data.action === 'prepare-tour') return;
  if (data.action === 'set-annotations' || data.action === 'update-tour-labels') {
    controls.set(data.action, data);
    if (ready) {
      const connection = sceneLoad;
      void send(data.action,data.action === 'set-annotations' ? { annotationWindows: data.annotationWindows } : { labels: data.labels }).catch(error => {
        if (connection === sceneLoad && ready) loadFailed(error);
      });
    }
    return;
  }
  if (!ready) { queuedMotion = data; return; }
  if (data.action === 'switch-imagery') { void switchImagery(String(data.imagery || '')).catch(error => loadFailed(error)); return; }
  const descent = scene.region.openingDescent?.enabled === false ? 0 : Number(scene.region.openingDescent?.seconds || 0);
  const wasPlaying = raf !== 0;
  stop();
  if (data.action === 'stop-scene-playback') return;
  openingOnly = false;
  contextIntro = false;
  flightOrigin = undefined;
  if (data.action === 'play-opening') {
    openingOnly = true;
    contextIntro = true;
    scene.region=configureOpening(scene.region,data.opening || {});
    // Play the whole county-establishing shot, not just the descent: the town
    // draws its rim, then the parent county is traced in before the camera
    // settles back. Stopping at the descent hid that choreography in preview.
    const seconds = Math.max(Number(scene.region.openingDescent.seconds)+3.2, contextIntroSeconds(scene)+.6);
    play(0,seconds,'opening-label-visible'); return;
  }
  if (data.action === 'play-scene-range') {
    const r = data.range || {}; play(descent+Number(r.start || 0),descent+Number(r.end || 0),'scene-range-complete',{ sceneId:r.sceneId, childId:r.childId },Number(r.flightSeconds || 0)); return;
  }
  if (data.action === 'play-tour-outro') {
    const start = descent + Number(stops?.at(-1)?.end || 0);
    flightOrigin = displayedFrame;
    play(start, start + duration, 'tour-outro-complete');
    return;
  }
  if (data.action === 'play-parent-overview') {
    openingOnly = true;
    const start = descent + 4;
    if (displayedFrame && (displayedFrame.current || wasPlaying)) {
      flightOrigin = { ...displayedFrame, overviewStart: start };
      play(start, start + duration, 'opening-preview-complete');
    } else {
      time = start;
      draw(true);
    }
    return;
  }
  time = descent+Number(p.time || 0);
  if (data.action === 'play-tour-segment') {
    const target = stops?.find(s => String(s.id) === String(p.targetId));
    if (!target) return;
    if (wasPlaying || displayedFrame?.current !== String(target.id) || !displayedFrame.accents[String(target.id)]) flightOrigin = displayedFrame;
    const start = descent + Number(target.start);
    // The next stop can start exactly when this clip ends. Hold this village's
    // last frame so its preview flight origin cannot leak into the next leg.
    const end = Math.max(start + .001, descent + Number(target.end) - .0001);
    play(start, end, 'tour-segment-complete', { childId:target.id }, Number(target.flightDuration));
  } else draw(true);
}
function fail(error: unknown) { status.textContent = String(error); retryButton.hidden = false; overlay.hidden = false; notify('engine-error',{ message:String(error) }); }
// A scene load rides the same data channel as everything else: if UE restarted under
// us the command dies with it, and freezing on the error would leave the preview dead
// until a manual refresh. Treat it as a stream failure and recover instead.
function loadFailed(error: unknown) {
  if (suspended) return;
  notify('engine-error', { message: String(error) });
  standDown(`地图场景加载失败：${error instanceof Error ? error.message : String(error)}`);
}
// The basemap is a tile source, not a scene: swapping it re-resolves the provider and
// hands the new template to UE, which rebuilds only its tile layer. Geometry, labels
// and the camera stay where they are, so the video stream is never torn down.
async function switchImagery(provider: string) {
  if (!provider || provider === imageryProvider) return;
  const response = await fetch(`/api/imagery-descriptor?imagery=${encodeURIComponent(provider)}`);
  const descriptor = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(descriptor.error || '影像源切换失败');
  await send('set-imagery', { imagery: descriptor });
  imageryProvider = provider;
  if (scene) scene.imagery = descriptor;
  draw(true);
  notify('imagery-changed', { provider });
}
async function load(signal: AbortSignal) {
  ready = false; status.textContent = '正在加载 UE 地图场景…'; overlay.hidden = false;
  if (!scene) {
    const preload = preloadedScene;
    preloadedScene = undefined;
    const loaded = await preload ?? await fetchScene(sceneUrl(), signal);
    signal.throwIfAborted();
    scene = loaded;
    stops ??= scene.region.tourStops || [];
  }
  const size=profile==='landscape'?[1280,720]:profile==='square'?[720,720]:[720,1280];
  await send('load-scene',{ url: `${location.origin}${sceneUrl()}`, profile, width:query.has('studioPreview')?size[0]:innerWidth,height:query.has('studioPreview')?size[1]:innerHeight,imagery:imageryProvider });
  signal.throwIfAborted();
  const expected=query.has('studioPreview')?size:[innerWidth,innerHeight];
  const until=performance.now()+8000;
  while (!signal.aborted && performance.now() < until) {
    const video = document.querySelector('video');
    if (video?.videoWidth && Math.abs(video.videoWidth / video.videoHeight - expected[0]! / expected[1]!) < .015) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  signal.throwIfAborted();
  ready = true; joinAttempts = 0; streamDownAt = 0; lastFailure = ''; resetVideoHealth(); overlay.hidden = !playBlocked;
  // The standalone capture publishes no tour stops: it always opens on the town and
  // therefore carries the county establishing shot.
  contextIntro = (stops ?? scene.region?.tourStops ?? []).length === 0;
  draw(true);
  controls.forEach(handle);
  const motion = queuedMotion;
  queuedMotion = undefined;
  if (motion) handle(motion);
  notify('engine-ready');
}
function receiveResponse(raw: string) {
  try {
    const response = JSON.parse(raw);
    if (response.type !== 'geo-video-ue') return;
    const request = pending.get(response.requestId);
    if (request) { clearTimeout(request.timer); pending.delete(response.requestId); response.error ? request.reject(new Error(response.error)) : request.resolve(response); }
  } catch (error) { fail(error); }
}
function maybeLoad() {
  const video = document.querySelector('video');
  if (!channelReady || sceneLoad || !video || video.readyState < 2 || !video.videoWidth || !video.videoHeight || video.ended) return;
  const loadController = new AbortController();
  sceneLoad = loadController;
  void load(loadController.signal).catch(error => {
    if (loadController.signal.aborted) return;
    sceneLoad = undefined;
    loadFailed(error);
  });
}
const retryButton = document.getElementById('retry')!;
function teardown() {
  connectedAt = 0;
  channelReady = false;
  ready = false;
  stop();
  sceneLoad?.abort();
  sceneLoad = undefined;
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error('UE data channel closed'));
  }
  pending.clear();
}
const captureMode = query.has('capture');
// Lease state is declared before any listener that can touch it: a page hidden while
// the module is still awaiting its runtime config must not hit a temporal dead zone.
const viewerId = crypto.randomUUID();
const slotEnabled = query.get('slot') !== 'off' && !captureMode;
let holdsSlot = false;
let leaseGeneration = 0;
let joining = false;
let renewing = false;
let leaseConfirmedAt = 0;
let slotHeartbeat: ReturnType<typeof setTimeout> | undefined;
let slotPoll: ReturnType<typeof setTimeout> | undefined;
let streamDownAt = 0;
let joinAttempts = 0;
let joinTimer: ReturnType<typeof setTimeout> | undefined;
let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
let healthTimer: ReturnType<typeof setInterval> | undefined;
let suspended = false;
let playBlocked = false;
let lastVideoTime = -1;
let lastVideoProgress = performance.now();
let lastHealthCheck = performance.now();
let connectedAt = 0;
let lastFailure = '';
const FIRST_FRAME_TIMEOUT = 20000;
const HANDSHAKE_TIMEOUT = 60000;
const VIDEO_STALL_TIMEOUT = 15000;
function stopJoining() { clearTimeout(joinTimer); joinTimer = undefined; }
function resetVideoHealth() {
  lastVideoTime = -1;
  lastVideoProgress = performance.now();
  lastHealthCheck = lastVideoProgress;
}
function closeStream() {
  // Invalidate before disconnect: close callbacks can fire synchronously or arrive
  // after the replacement has opened. Neither may tear down the new connection.
  streamGeneration++;
  stopJoining();
  teardown();
  // The SDK keeps its old <video> and MediaStream alive after disconnect. Clear the
  // tracks explicitly, otherwise every recovery leaves another decoded stream behind.
  const container = document.getElementById('stream');
  for (const node of container?.querySelectorAll?.('video') ?? []) {
    const old = node as HTMLVideoElement;
    old.pause?.();
    const source = old.srcObject as MediaStream | null;
    source?.getTracks?.().forEach(track => track.stop());
    old.srcObject = null;
  }
  container?.replaceChildren?.();
  try { stream?.disconnect(); } catch { /* already closed */ }
}
/** MediaStream video elements do not reliably advance currentTime in every browser;
 *  decoded frame count is the stronger signal, with currentTime as the fallback. */
function videoProgress(video: HTMLVideoElement) {
  const frames = video.getVideoPlaybackQuality?.().totalVideoFrames;
  return typeof frames === 'number' && frames > 0 ? frames : video.currentTime;
}
function standDown(message: string) {
  if (suspended || recoveryTimer || (slotEnabled && !holdsSlot)) return;
  lastFailure = message;
  closeStream();
  if (!streamDownAt) streamDownAt = performance.now();
  playBlocked = false;
  status.textContent = `${message}，正在自动恢复…`;
  retryButton.hidden = false;
  retryButton.textContent = '立即重试';
  overlay.hidden = captureMode;
  notify('engine-reconnecting', { message });
  const delay = retryDelay(joinAttempts++);
  recoveryTimer = setTimeout(() => {
    recoveryTimer = undefined;
    void joinWithSlot();
  }, delay);
}
function openStream() {
  closeStream();
  const generation = streamGeneration;
  document.getElementById('stream')!.replaceChildren();
  try {
    stream = new PixelStreaming(createConfig(), { videoElementParent: document.getElementById('stream')! });
  } catch (error) {
    standDown(`视频播放器初始化失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const current = () => generation === streamGeneration && !suspended && (!slotEnabled || holdsSlot);
  stream.addResponseEventListener('geo-documentary', raw => { if (current()) receiveResponse(raw); });
  stream.addEventListener('dataChannelOpen', () => {
    if (!current()) return;
    if (channelReady) return;
    channelReady = true;
    connectedAt = performance.now();
    status.textContent = 'UE 控制通道已连接，正在等待视频首帧…';
    stopJoining();
    resetVideoHealth();
    announceLease();
    maybeLoad();
  });
  stream.addEventListener('dataChannelClose', () => { if (current()) standDown('视频流连接中断'); });
  stream.addEventListener('webRtcDisconnected', () => { if (current()) standDown('视频流连接中断'); });
  stream.addEventListener('webRtcFailed', () => { if (current()) standDown('视频流协商失败'); });
  stream.addEventListener('dataChannelError', () => { if (current()) standDown('UE 控制通道错误'); });
  stream.addEventListener('subscribeFailed', () => { if (current()) standDown('UE 视频订阅暂时不可用（实例可能被占用）'); });
  stream.addEventListener('playStreamError', () => { if (current()) standDown('视频解码或播放失败'); });
  stream.addEventListener('videoInitialized', () => { if (current()) maybeLoad(); });
  stream.addEventListener('playStreamRejected', () => {
    if (!current()) return;
    playBlocked = true;
    status.textContent = '点击播放 UE 地图视频流';
    retryButton.textContent = '播放视频';
    retryButton.hidden = false;
    overlay.hidden = false;
  });
  status.textContent = '正在连接 UE 地图视频流…';
  overlay.hidden = captureMode;
  // Slow UE startup/negotiation is not a failure after four seconds. Allow a full
  // handshake, and let exactly one application timer retry if it really stalls.
  joinTimer = setTimeout(() => { if (current() && !channelReady) standDown('视频流连接超时'); }, HANDSHAKE_TIMEOUT);
  try { stream.connect(); } catch { standDown('预览服务暂时不可用'); }
}
function checkVideoHealth() {
  if (suspended) return;
  maybeLoad();
  const now = performance.now();
  const resumed = now - lastHealthCheck > 10000;
  lastHealthCheck = now;
  if (channelReady && !sceneLoad && !ready && !playBlocked) {
    // A data channel alone is not a usable video stream. Previously opening it
    // cancelled the handshake timer while the frame watchdog waited for ready,
    // leaving this in-between state without any timeout at all.
    if (document.hidden || resumed) connectedAt = now;
    else if (now - connectedAt >= FIRST_FRAME_TIMEOUT) {
      standDown('UE 控制通道已连接，但视频首帧超时');
      return;
    }
  }
  if (!channelReady || !ready || document.hidden || resumed || playBlocked) {
    lastVideoProgress = now;
    return;
  }
  const video = document.querySelector('video');
  const tracks = (video?.srcObject as MediaStream | null)?.getVideoTracks?.() ?? [];
  if (tracks.some(track => track.readyState === 'ended')) { standDown('视频轨道已停止'); return; }
  if (!video || video.ended) {
    if (now - lastVideoProgress > VIDEO_STALL_TIMEOUT) standDown('视频轨道不可用');
    return;
  }
  if (video.paused) {
    // A paused element looks identical to a dead one. Ask it to play before blaming
    // the network: a rejected autoplay is handled by the play overlay, not by a
    // reconnect, which would rebuild a stream that was never broken.
    void video.play().catch(() => {
      playBlocked = true;
      status.textContent = '点击播放 UE 地图视频流';
      retryButton.textContent = '播放视频';
      retryButton.hidden = false;
      overlay.hidden = false;
    });
    lastVideoProgress = now;
    return;
  }
  if (videoProgress(video) > lastVideoTime) {
    lastVideoTime = videoProgress(video);
    lastVideoProgress = now;
  } else if (now - lastVideoProgress > VIDEO_STALL_TIMEOUT) {
    standDown('视频画面长时间未更新');
  }
}
function startHealthMonitor() {
  clearInterval(healthTimer);
  resetVideoHealth();
  healthTimer = setInterval(checkVideoHealth, 2000);
}
document.addEventListener('loadedmetadata', maybeLoad, true);
document.addEventListener('loadeddata', maybeLoad, true);
retryButton.onclick = () => {
  if (playBlocked) {
    void document.querySelector('video')?.play().then(() => {
      playBlocked = false; overlay.hidden = ready; resetVideoHealth(); maybeLoad();
    }).catch(() => { status.textContent = '浏览器阻止了播放，请再次点击播放视频'; });
    return;
  }
  clearTimeout(recoveryTimer); recoveryTimer = undefined;
  joinAttempts = 0;
  if (!channelReady) void joinWithSlot();
  else { sceneLoad?.abort(); sceneLoad = undefined; maybeLoad(); }
};
window.addEventListener('message',event => { if (event.source === parent && event.origin === parentOrigin && event.data?.type === 'geo-video-studio') handle(event.data); });
window.addEventListener('pagehide', () => {
  suspended = true;
  leaseGeneration++;
  clearTimeout(recoveryTimer); recoveryTimer = undefined;
  clearInterval(healthTimer); healthTimer = undefined;
  closeStream();
  releaseSlot();
});
window.addEventListener('pageshow', event => {
  if (!event.persisted || !suspended) return;
  suspended = false;
  startHealthMonitor();
  void joinWithSlot();
});
document.addEventListener('visibilitychange', () => {
  resetVideoHealth();
  if (!document.hidden && !suspended) {
    if (holdsSlot) void renewSlot();
    else if (!recoveryTimer) void joinWithSlot();
  }
});
window.addEventListener('online', () => {
  if (!suspended && !channelReady) {
    clearTimeout(recoveryTimer); recoveryTimer = undefined;
    void joinWithSlot();
  }
});
Object.assign(window,{ geoVideo: {
  getDiagnostics: () => ({ engine:'unreal', ready, time, imagery:scene?.imagery?.provider, imageProvider:imageryProvider }),
  getRendererStatus: () => send('get-status'),
  setImagery: (provider: string) => switchImagery(provider),
  playOpeningPreview: (opening={}) => handle({action:'play-opening',opening}),
  prepareStudioTour: (preview:any) => handle({action:'prepare-tour',preview}),
  setSubtitleWindows: (windows: SubtitleWindow[]) => { subtitleWindows = windows; },
  /** 注记时间窗直接下发到 UE；验收脚本用它做「开/关」同帧对照。 */
  setAnnotationWindows: async (windows: { sceneId?: string; start: number; end: number }[]) => send('set-annotations', { annotationWindows: windows }),
  renderFrame: async (t: number) => { stop(); time=t; openingOnly=false; if (!ready) throw new Error('UE renderer not ready'); return send('capture-frame',{ frame:{ ...frameAt(scene,stops ?? [],t,profile,duration,false), subtitleBounds: activeSubtitleBounds(subtitleWindows, t) ?? null } }); },
  /**
   * Batch capture: compose N frames locally (frameAt is a pure function of t) and hand
   * the run to UE in one or more data-channel messages. UE walks them on its own Tick
   * and answers each message once, so the per-frame evaluate/datachannel round trip
   * disappears; each frame is still rendered and screenshotted by the same single-frame
   * pipeline. A message is split to stay under ~120 KB, because the WebRTC data channel
   * silently truncates a larger reliable message and UE then drops the whole JSON.
   */
  renderBatch: async (times: number[]) => {
    stop(); time=times.at(-1) ?? time; openingOnly=false;
    if (!ready) throw new Error('UE renderer not ready');
    if (!times.length) return { captured: 0 };
    const MAX_MESSAGE = 120_000;
    let captured = 0;
    for (let base = 0; base < times.length;) {
      const frames: any[] = [];
      let size = 0;
      let i = base;
      while (i < times.length) {
        const t = times[i]!;
        const frame = { ...frameAt(scene, stops ?? [], t, profile, duration, false), subtitleBounds: activeSubtitleBounds(subtitleWindows, t) ?? null };
        const n = JSON.stringify(frame).length;
        if (frames.length && size + n > MAX_MESSAGE) break;
        frames.push(frame); size += n; i++;
      }
      const response = await send('capture-batch', { frames });
      captured += Number(response?.captured ?? frames.length);
      base = i;
    }
    return { captured };
  },
  seek: async (t: number) => { stop(); flightOrigin=undefined; time=t; draw(true); },
  getStreamHealth: () => ({
    ready,
    channelReady,
    captureMode,
    downSeconds: streamDownAt ? Math.round((performance.now() - streamDownAt) / 100) / 10 : 0,
    sceneLoaded: Boolean(scene),
    stage: suspended ? 'suspended' : ready ? 'ready' : playBlocked ? 'play-blocked' : sceneLoad ? 'scene-loading' : channelReady ? 'waiting-first-frame' : holdsSlot || !slotEnabled ? 'connecting' : 'waiting-slot',
    attempts: joinAttempts,
    lastFailure,
    status: status.textContent
  }),
  // The grabber waits on this instead of polling the DOM: `ready` only turns true once
  // the reconnected stream has re-applied the scene, which is the moment a frame is
  // safe to request again.
  waitForStream: async (timeoutMs = 120000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(channelReady && ready)) {
      if (Date.now() > deadline) throw new Error(`UE stream did not recover (${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s)`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return true;
  },
  getFrameStatus: () => ({ initialized:ready, renderStable:ready, time, engine:'unreal' })
} });
// --- single-viewer lease -------------------------------------------------
// One UE instance drives one stream, and the streamer takes a single subscriber.
// The first window to arrive holds the slot; every later window is told the instance
// is busy and keeps polling, so it joins by itself the moment the holder goes away.
// One lease round trip at a time. Without this, a reply that arrives after the page
// is frozen (or after a newer claim) reopened a stream nobody was watching, and two
// windows ended up fighting over the streamer's single subscriber seat.
async function claimSlot(): Promise<'granted' | 'busy' | 'offline'> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('/api/viewer-slot', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: viewerId }), signal: controller.signal
    });
    if (response.status === 409) return 'busy';
    if (!response.ok) return 'offline';
    const data = await response.json();
    return data.granted === true ? 'granted' : 'offline';
  } catch {
    return 'offline';
  } finally {
    // Keep the timeout active until the body has arrived as well as the headers.
    clearTimeout(timeout);
  }
}
// The HTTP lease cannot tell two windows apart quickly enough: a background tab has
// its timers throttled to one tick a minute, so its lease expires and the other
// window claims a subscriber seat that is still in use. Both then fight, and the
// visible symptom is a preview that drops every time the user switches away. Windows
// of the same origin can just say who holds the stream, so that is the primary
// arbiter; the HTTP lease stays as a fallback when BroadcastChannel is unavailable.
const leaseChannel: BroadcastChannel | undefined = typeof BroadcastChannel === 'function'
  ? new BroadcastChannel('geo-video-viewer') : undefined;
let peerClaimAt = 0;
let probeBarrier: (() => void) | undefined;
/**
 * A peer is considered alive only while it keeps answering probes. A window that was
 * killed (not closed) leaves no release message behind, so trusting a stale flag for
 * minutes would lock the preview out for minutes.
 */
function peerOwnsStream() {
  return Boolean(leaseChannel && peerClaimAt && performance.now() - peerClaimAt < 10000);
}
function announceLease() {
  if (!leaseChannel || (!holdsSlot && !channelReady)) return;
  try { leaseChannel.postMessage({ type: 'claim', id: viewerId, video: channelReady }); } catch { /* channel closed */ }
}
/**
 * Ask the other windows whether one of them is already showing frames. The HTTP lease
 * cannot answer that (a throttled tab's lease expires while its stream is perfectly
 * alive), and subscribing blind is what made two windows evict each other in a loop.
 */
function askPeers(timeoutMs = 700): Promise<void> {
  if (!leaseChannel) return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      probeBarrier = undefined;
      clearTimeout(timer);
      resolve();
    };
    probeBarrier = finish;
    timer = setTimeout(finish, timeoutMs);
    try { leaseChannel.postMessage({ type: 'probe', id: viewerId }); } catch { finish(); }
  });
}
leaseChannel?.addEventListener('message', event => {
  const data = event.data as { type?: string; id?: string; video?: boolean } | null;
  if (!data || data.id === viewerId) return;
  if (data.type === 'probe') { announceLease(); return; }
  if (data.type === 'release') {
    peerClaimAt = 0;
    if (!holdsSlot && !channelReady && !recoveryTimer && !suspended) void joinWithSlot();
    return;
  }
  if (data.type !== 'claim') return;
  peerClaimAt = performance.now();
  // A window that is already showing frames owns the single subscriber seat. Retrying
  // into it only produces rejected subscriptions, so pause and wait for its release.
  if (data.video && !channelReady && !captureMode) { probeBarrier?.(); waitForSlot('busy'); }
});
function sendSlotRelease() {
  if (!slotEnabled) return;
  try { leaseChannel?.postMessage({ type: 'release', id: viewerId }); } catch { /* ignored */ }
  const body = JSON.stringify({ id: viewerId });
  const queued = navigator.sendBeacon?.('/api/viewer-slot/release', new Blob([body], { type: 'application/json' }));
  if (!queued) void fetch('/api/viewer-slot/release', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true
  }).catch(() => {});
}
function releaseSlot() {
  clearTimeout(slotHeartbeat); slotHeartbeat = undefined;
  clearTimeout(slotPoll); slotPoll = undefined;
  holdsSlot = false;
  sendSlotRelease();
}
function waitForSlot(state: 'busy' | 'offline') {
  if (suspended) return;
  clearTimeout(slotPoll);
  retryButton.hidden = state === 'busy';
  overlay.hidden = false;
  status.textContent = state === 'busy'
    ? '地图实例正在被另一个窗口使用。\n切回那个窗口即可继续预览，关闭它后本窗口会自动接入。'
    : '预览服务暂时不可用，正在自动重试…';
  // Poll slowly: a fast loop only re-enters contention and keeps the stream churning.
  const delay = state === 'busy' ? 3000 : retryDelay(joinAttempts++);
  slotPoll = setTimeout(() => { slotPoll = undefined; void joinWithSlot(); }, delay);
}
function scheduleHeartbeat() {
  clearTimeout(slotHeartbeat);
  if (!suspended && holdsSlot) slotHeartbeat = setTimeout(() => { slotHeartbeat = undefined; void renewSlot(); }, 4000);
}
async function renewSlot() {
  if (suspended || !holdsSlot || renewing || joining) return;
  renewing = true;
  const generation = leaseGeneration;
  const state = await claimSlot();
  renewing = false;
  // The page went away (or was replaced) while this reply was in flight. A grant we
  // no longer need must be handed back, or the next window waits on a ghost.
  if (suspended || generation !== leaseGeneration) {
    if (state === 'granted') sendSlotRelease();
    return;
  }
  if (state === 'granted') {
    leaseConfirmedAt = performance.now();
    announceLease();
    scheduleHeartbeat();
    return;
  }
  // Dropping a working stream because one heartbeat lost a race is exactly the
  // "disconnects constantly" behaviour. Trust live video; the video watchdog and the
  // peer announcements are what decide a stream is really gone.
  if (channelReady) { scheduleHeartbeat(); return; }
  holdsSlot = false;
  clearTimeout(slotHeartbeat); slotHeartbeat = undefined;
  clearTimeout(recoveryTimer); recoveryTimer = undefined;
  closeStream();
  notify('engine-reconnecting', { message: state === 'busy' ? '另一个窗口正在使用地图实例' : '预览服务暂时不可用' });
  waitForSlot(state);
}
// Brief handshake failures back off instead of hammering the single subscriber seat.
function retryDelay(attempt: number) {
  return Math.min(20000, 2000 * 2 ** Math.min(attempt, 3));
}
async function joinWithSlot() {
  // A round trip already in flight will open the stream; a second claim would only
  // race it and could hand the lease back out from under the first one.
  if (joining || suspended || channelReady) return;
  clearTimeout(slotPoll); slotPoll = undefined;
  clearTimeout(recoveryTimer); recoveryTimer = undefined;
  if (!slotEnabled) { openStream(); return; }
  if (peerOwnsStream() && !captureMode) { waitForSlot('busy'); return; }
  joining = true;
  const generation = leaseGeneration;
  await askPeers();
  if (suspended || generation !== leaseGeneration) { joining = false; return; }
  if (peerOwnsStream() && !captureMode) { joining = false; waitForSlot('busy'); return; }
  const state = await claimSlot();
  joining = false;
  if (suspended || generation !== leaseGeneration) {
    if (state === 'granted') sendSlotRelease();
    return;
  }
  if (state !== 'granted') { waitForSlot(state); return; }
  holdsSlot = true;
  leaseConfirmedAt = performance.now();
  announceLease();
  scheduleHeartbeat();
  openStream();
}
startHealthMonitor();
void joinWithSlot();
