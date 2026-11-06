import { Config, PixelStreaming } from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.7';
import { actions, frameAt } from './presentation.js';
import { configureOpening } from './opening.js';

const query = new URLSearchParams(location.search);
const parentOrigin = new URL(query.get('parentOrigin') || 'http://127.0.0.1:4180').origin;
const profile = query.get('profile') || 'portrait';
const overlay = document.getElementById('connection')!;
const status = document.getElementById('status')!;
let scene: any, stops: any[] = [], duration = 4.4, time = 0, raf = 0, ready = false, openingOnly = false;
let channelReady=false,loading=false;
let lastDrawAt=-Infinity;
const latest = new Map<string, any>();
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const notify = (event: string, details = {}) => parent.postMessage({ type: 'geo-video-player', event, ...details }, parentOrigin);
const configResponse = await fetch('/runtime-config.json');
if (!configResponse.ok) throw new Error('UE configuration unavailable');
const settings = await configResponse.json();
const config = new Config({ useUrlParams: false, initialSettings: { ss: settings.signallingUrl, AutoConnect: false, AutoPlayVideo: true, StartVideoMuted: true, WaitForStreamer: true, MaxReconnectAttempts:120, StreamerAutoJoinInterval:1000, MatchViewportRes: false, KeyboardInput: false, MouseInput: false, TouchInput: false } });
const stream = new PixelStreaming(config, { videoElementParent: document.getElementById('stream')! });
function send(action: string, payload = {}): Promise<any> {
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
  const frame = frameAt(scene, stops, time, profile, duration, openingOnly);
  stream.emitUIInteraction({ type: 'geo-video-ue', version: 1, action: 'apply-frame', frame });
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
  if (!ready) { latest.set(data.action, data); return; }
  const p = data.preview || {};
  if (p.tourStops) stops = p.tourStops;
  if (p.returnDuration) duration = Number(p.returnDuration);
  const descent = scene.region.openingDescent?.enabled === false ? 0 : Number(scene.region.openingDescent?.seconds || 0);
  if (data.action === 'prepare-tour') { draw(); return; }
  if (data.action === 'set-annotations' || data.action === 'update-tour-labels') {
    latest.set(data.action, data);
    void send(data.action,data.action === 'set-annotations' ? { annotationWindows: data.annotationWindows } : { labels: data.labels }).catch(fail); return;
  }
  stop(); openingOnly = false;
  if (data.action === 'stop-scene-playback') return;
  if (data.action === 'play-opening') {
    openingOnly = true;
    scene.region=configureOpening(scene.region,data.opening || {});
    const seconds = Number(scene.region.openingDescent.seconds)+3.2;
    play(0,seconds,'opening-label-visible'); return;
  }
  if (data.action === 'play-scene-range') {
    const r = data.range || {}; play(descent+Number(r.start || 0),descent+Number(r.end || 0),'scene-range-complete',{ sceneId:r.sceneId, childId:r.childId },Number(r.flightSeconds || 0)); return;
  }
  if (data.action === 'play-tour-outro') { play(descent+Number(stops.at(-1)?.end || 0),descent+Number(stops.at(-1)?.end || 0)+duration,'tour-outro-complete'); return; }
  time = descent+Number(p.time || 0);
  if (data.action === 'play-tour-segment') {
    const target = stops.find(s => String(s.id) === String(p.targetId));
    play(time,time+Number(p.segmentDuration || 5),'scene-range-complete',{ childId:p.targetId },Number(target?.flightDuration || 3.2));
  } else draw();
}
function fail(error: unknown) { status.textContent = String(error); overlay.hidden = false; notify('engine-error',{ message:String(error) }); }
async function load() {
  ready = false; status.textContent = '正在加载 UE 地图场景…'; overlay.hidden = false;
  const params = new URLSearchParams({ region:query.get('region') || '' });
  params.set('imagery',query.get('imagery') || 'esri-world-imagery');
  if (query.has('boundary')) params.set('boundary',query.get('boundary')!);
  const response = await fetch(`/api/scene?${params}`);
  if (!response.ok) { const error=await response.json(); throw new Error(error.error || '地图场景加载失败'); }
  scene = await response.json(); stops = scene.region.tourStops || [];
  const size=profile==='landscape'?[1280,720]:profile==='square'?[720,720]:[720,1280];
  await send('load-scene',{ url: `${location.origin}/api/scene?${params}`, profile, width:query.has('studioPreview')?size[0]:innerWidth,height:query.has('studioPreview')?size[1]:innerHeight,imagery: query.get('imagery') || 'esri-world-imagery' });
  const expected=query.has('studioPreview')?size:[innerWidth,innerHeight];
  const until=performance.now()+8000;
  while(performance.now()<until){const video=document.querySelector('video');if(video?.videoWidth && Math.abs(video.videoWidth/video.videoHeight-expected[0]!/expected[1]!)<.015)break;await new Promise(r=>setTimeout(r,100));}
  ready = true; overlay.hidden = true; draw();
  const queued = [...latest.values()]; latest.clear(); queued.forEach(handle); notify('engine-ready');
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
  if (!channelReady || loading || ready || !document.querySelector('video')?.readyState) return;
  loading=true; void load().catch(fail).finally(()=>{loading=false;});
}
document.addEventListener('loadedmetadata',maybeLoad,true);
stream.addEventListener('dataChannelOpen',() => { channelReady=true; maybeLoad(); });
stream.addEventListener('webRtcDisconnected',() => { channelReady=false; ready = false; stop(); status.textContent = 'UE 视频流已断开，等待重新连接'; overlay.hidden = false; });
stream.addEventListener('playStreamRejected',() => { status.textContent = '点击播放 UE 地图视频流'; overlay.hidden = false; });
document.getElementById('retry')!.onclick = () => { stream.reconnect(); };
window.addEventListener('message',event => { if (event.source === parent && event.origin === parentOrigin && event.data?.type === 'geo-video-studio') handle(event.data); });
window.addEventListener('pagehide',() => { stop(); stream.disconnect(); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Player disposed')); } pending.clear(); });
Object.assign(window,{ geoVideo: {
  getDiagnostics: () => ({ engine:'unreal', ready, time, imagery:scene?.imagery?.provider }),
  getRendererStatus: () => send('get-status'),
  playOpeningPreview: (opening={}) => handle({action:'play-opening',opening}),
  prepareStudioTour: (preview:any) => handle({action:'prepare-tour',preview}),
  renderFrame: async (t: number) => { stop(); time=t; openingOnly=false; if (!ready) throw new Error('UE renderer not ready'); return send('capture-frame',{ frame:frameAt(scene,stops,t,profile,duration,false) }); },
  seek: async (t: number) => { stop(); time=t; draw(true); },
  getFrameStatus: () => ({ initialized:ready, renderStable:ready, time, engine:'unreal' })
} });
stream.connect();
