import { Config, PixelStreaming } from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.7';
import { actions, frameAt, type PreviewFlightOrigin } from './presentation.js';
import { configureOpening } from './opening.js';
import { DEFAULT_IMAGERY_PROVIDER, type MapView } from '../../packages/project-schema/index.js';

const query = new URLSearchParams(location.search);
const parentOrigin = new URL(query.get('parentOrigin') || 'http://127.0.0.1:4180').origin;
const profile = query.get('profile') || 'portrait';
const imagery = query.get('imagery') || DEFAULT_IMAGERY_PROVIDER;
const sceneParams = new URLSearchParams({ region: query.get('region') || '', imagery });
if (imagery === 'cesium-ion-world-imagery') sceneParams.set('session', crypto.randomUUID());
if (query.has('boundary')) sceneParams.set('boundary', query.get('boundary')!);
const sceneUrl = `/api/scene?${sceneParams}`;
async function fetchScene(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { ...(signal ? { signal } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '地图场景加载失败');
  return data;
}
// Start the scene and two local fallback tiles during the WebRTC handshake.
let preloadedScene = query.has('studioPreview') ? fetchScene(`${sceneUrl}&warm=1`).catch(() => undefined) : undefined;
const overlay = document.getElementById('connection')!;
const status = document.getElementById('status')!;
let scene: any, stops: any[] | undefined, duration = 4.4, time = 0, raf = 0, ready = false, openingOnly = false;
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
const configResponse = await fetch('/runtime-config.json');
if (!configResponse.ok) throw new Error('UE configuration unavailable');
const settings = await configResponse.json();
const config = new Config({ useUrlParams: false, initialSettings: { ss: settings.signallingUrl, AutoConnect: false, AutoPlayVideo: true, StartVideoMuted: true, WaitForStreamer: true, MaxReconnectAttempts:600, StreamerAutoJoinInterval:2000, MatchViewportRes: false, KeyboardInput: false, MouseInput: false, TouchInput: false } });
const stream = new PixelStreaming(config, { videoElementParent: document.getElementById('stream')! });
function send(action: string, payload = {}): Promise<any> {
  if (!channelReady) return Promise.reject(new Error('UE data channel unavailable'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`UE command timeout: ${action}`)); }, action==='capture-frame'?90000:30000);
    pending.set(requestId, { resolve, reject, timer });
    if (!stream.emitUIInteraction({ type: 'geo-video-ue', version: 1, requestId, action, ...payload })) {
      clearTimeout(timer); pending.delete(requestId); reject(new Error('UE data channel unavailable'));
    }
  });
}
function draw(force=false) {
  if (!ready || !scene) return;
  const now=performance.now();if(!force && now-lastDrawAt<1000/30)return;lastDrawAt=now;
  const overviewProgress = flightOrigin?.overviewStart === undefined ? undefined : (time - flightOrigin.overviewStart) / duration;
  const frame = frameAt(scene, stops ?? [], time, profile, duration, openingOnly, flightOrigin, overviewProgress, previewView);
  if (stream.emitUIInteraction({ type: 'geo-video-ue', version: 1, action: 'apply-frame', frame })) displayedFrame = frame;
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
        if (connection === sceneLoad && ready) fail(error);
      });
    }
    return;
  }
  if (!ready) { queuedMotion = data; return; }
  const descent = scene.region.openingDescent?.enabled === false ? 0 : Number(scene.region.openingDescent?.seconds || 0);
  const wasPlaying = raf !== 0;
  stop();
  if (data.action === 'stop-scene-playback') return;
  openingOnly = false;
  flightOrigin = undefined;
  if (data.action === 'play-opening') {
    openingOnly = true;
    scene.region=configureOpening(scene.region,data.opening || {});
    const seconds = Number(scene.region.openingDescent.seconds)+3.2;
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
function fail(error: unknown) { status.textContent = String(error); overlay.hidden = false; notify('engine-error',{ message:String(error) }); }
async function load(signal: AbortSignal) {
  ready = false; status.textContent = '正在加载 UE 地图场景…'; overlay.hidden = false;
  if (!scene) {
    const preload = preloadedScene;
    preloadedScene = undefined;
    const loaded = await preload ?? await fetchScene(sceneUrl, signal);
    signal.throwIfAborted();
    scene = loaded;
    stops ??= scene.region.tourStops || [];
  }
  const size=profile==='landscape'?[1280,720]:profile==='square'?[720,720]:[720,1280];
  await send('load-scene',{ url: `${location.origin}${sceneUrl}`, profile, width:query.has('studioPreview')?size[0]:innerWidth,height:query.has('studioPreview')?size[1]:innerHeight,imagery });
  const expected=query.has('studioPreview')?size:[innerWidth,innerHeight];
  const until=performance.now()+8000;
  while (!signal.aborted && performance.now() < until) {
    const video = document.querySelector('video');
    if (video?.videoWidth && Math.abs(video.videoWidth / video.videoHeight - expected[0]! / expected[1]!) < .015) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  signal.throwIfAborted();
  ready = true; overlay.hidden = true; draw(true);
  controls.forEach(handle);
  const motion = queuedMotion;
  queuedMotion = undefined;
  if (motion) handle(motion);
  notify('engine-ready');
}
stream.addResponseEventListener('geo-documentary', raw => {
  try {
    const response = JSON.parse(raw);
    if (response.type !== 'geo-video-ue') return;
    const request = pending.get(response.requestId);
    if (request) { clearTimeout(request.timer); pending.delete(response.requestId); response.error ? request.reject(new Error(response.error)) : request.resolve(response); }
  } catch (error) { fail(error); }
});
function maybeLoad() {
  if (!channelReady || sceneLoad || !document.querySelector('video')?.readyState) return;
  const loadController = new AbortController();
  sceneLoad = loadController;
  void load(loadController.signal).catch(error => {
    if (loadController.signal.aborted) return;
    sceneLoad = undefined;
    fail(error);
  });
}
function resetConnection() {
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
  status.textContent = 'UE 视频流已断开，正在重新连接…';
  overlay.hidden = false;
}
document.addEventListener('loadedmetadata',maybeLoad,true);
stream.addEventListener('dataChannelOpen',() => { channelReady=true; maybeLoad(); });
stream.addEventListener('dataChannelClose', resetConnection);
stream.addEventListener('webRtcDisconnected', resetConnection);
stream.addEventListener('playStreamRejected',() => { status.textContent = '点击播放 UE 地图视频流'; overlay.hidden = false; });
document.getElementById('retry')!.onclick = () => {
  if (channelReady) { stream.play(); maybeLoad(); }
  else stream.reconnect();
};
window.addEventListener('message',event => { if (event.source === parent && event.origin === parentOrigin && event.data?.type === 'geo-video-studio') handle(event.data); });
window.addEventListener('pagehide', () => { resetConnection(); stream.disconnect(); });
Object.assign(window,{ geoVideo: {
  getDiagnostics: () => ({ engine:'unreal', ready, time, imagery:scene?.imagery?.provider }),
  getRendererStatus: () => send('get-status'),
  playOpeningPreview: (opening={}) => handle({action:'play-opening',opening}),
  prepareStudioTour: (preview:any) => handle({action:'prepare-tour',preview}),
  renderFrame: async (t: number) => { stop(); time=t; openingOnly=false; if (!ready) throw new Error('UE renderer not ready'); return send('capture-frame',{ frame:frameAt(scene,stops ?? [],t,profile,duration,false) }); },
  seek: async (t: number) => { stop(); flightOrigin=undefined; time=t; draw(true); },
  getFrameStatus: () => ({ initialized:ready, renderStable:ready, time, engine:'unreal' })
} });
stream.connect();
