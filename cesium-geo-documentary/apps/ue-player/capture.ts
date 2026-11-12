import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { pathToFileURL } from 'node:url';
import { measureSubtitleWindows } from './subtitle-layout.js';
import { DEFAULT_IMAGERY_PROVIDER } from '../../packages/project-schema/index.js';
import { ionToken } from './imagery.js';
import { CaptureScope, CaptureRetryError, CaptureCleanupError, CAPTURE_CLEANUP_FATAL, retryCaptureChunk, assertCaptureFrames, isTransientCaptureFailure, captureBatchTimeoutMs } from './capture-lifecycle.js';
const cancellation = new AbortController();
const cancel = () => cancellation.abort(new Error('录制已取消'));
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const root = resolve(process.cwd());
const option = (name:string, fallback='') => { const i=process.argv.indexOf(`--${name}`); return i>=0?process.argv[i+1] || fallback:fallback; };
const region = option('region'), profile=option('profile','portrait');
if (!/^[\w-]+$/.test(region)) throw new Error('A valid --region is required');
const runtimePath = process.env.GEO_UE_RUNTIME || join(root,'workspace/ue-runtime.json');
const runtime=JSON.parse((await readFile(runtimePath,'utf8')).replace(/^\uFEFF/,''));
const imagery = option('imagery', DEFAULT_IMAGERY_PROVIDER);
const token = imagery === 'cesium-ion-world-imagery' ? await ionToken(resolve(dirname(runtimePath), '..'), process.env) : '';
const probe = (candidate: number) => new Promise<boolean>(resolve => {
  const server = createServer();
  server.once('error', () => resolve(false));
  server.once('listening', () => server.close(() => resolve(true)));
  server.listen(candidate, '127.0.0.1');
});
async function usablePort(start: number) {
  if (!Number.isSafeInteger(start) || start < 1024 || start > 65533) throw new Error('录制端口必须在 1024–65533 之间');
  for (let candidate = start; candidate <= Math.min(start + 297, 65533); candidate += 3) {
    cancellation.signal.throwIfAborted();
    const ok = await Promise.all([0, 1, 2].map((offset) => probe(candidate + offset)));
    if (ok.every(Boolean)) return candidate;
  }
  throw new Error('没有可用的本机端口可以启动录制');
}
const preview=process.argv.includes('--preview') && process.argv.includes('--qa'),scale=preview?2/3:1;
const width=(profile==='landscape'?1920:1080)*scale,height=(profile==='landscape'?1080:profile==='square'?1080:1920)*scale;
const qa=process.argv.includes('--qa');
const slot=qa?`${region}-${profile}-qa`:`${region}-${profile}`;
// Timestamped frame directory: the capture previously wiped stale frame-*.png before
// starting, which trips the session's bulk-delete guard on a re-export. A fresh
// directory needs no deletes at all; old directories can be dropped wholesale later.
const frames=join(root,'renders','ue-frames',`${slot}-${Date.now()}`);
const timeline=JSON.parse(await readFile(join(root,'data/regions',`${region}.timeline.json`),'utf8'));
const regionData=JSON.parse(await readFile(join(root,'data/regions',`${region}.json`),'utf8'));
const seconds=Number(timeline.duration)+(regionData.openingDescent?.enabled===false?0:Number(regionData.openingDescent?.seconds || 0));
const fps=30,total=Number(option('frames',String(Math.ceil(seconds*fps)))),startTime=Number(option('start-time','0'));
if (!Number.isSafeInteger(total) || total<1 || !Number.isFinite(startTime) || startTime<0) throw new Error('Invalid capture frame range');
await mkdir(frames,{recursive:true});
// The UE renderer historically grew ~15-25 MiB of committed memory per deterministic
// frame (screenshot buffers and rim/boundary triangle churn never gave pages back), so
// a single process died with "page file too small" around frame ~2000. Two fixes land
// on the UE side (async PNG saves + warm HUD scratch buffers) and the chunked session
// restart below stays as a fallback switch: set GEO_CAPTURE_CHUNK=0 to disable it and
// record the whole film in one session.
// The UE renderer grew ~15-25 MiB of committed memory per deterministic frame on the
// binned allocator — not a leaked object (uobject count and physical memory stay flat)
// but allocator fragmentation: freed page blocks never return to the OS, so commit only
// climbs. mimalloc cuts that roughly tenfold; the chunked session restart is the hard
// ceiling that keeps a single chunk well under the commit limit. Set GEO_CAPTURE_CHUNK=0
// to record in one session (short takes only) or lower it for very long films.
const CHUNK_ENV = Number(process.env.GEO_CAPTURE_CHUNK ?? 1500) | 0;
const CHUNK = CHUNK_ENV > 0 ? Math.max(240, CHUNK_ENV) : 0;
// Batch capture: one round trip per batch instead of per frame. The UE side still
// walks each frame through the identical single-frame pipeline (apply, wait for
// imagery, screenshot), so pixels are unchanged; only the transport is batched.
const BATCH = Math.max(4, Number(process.env.GEO_CAPTURE_BATCH ?? 16) | 0);
const ffmpeg=join(root,'node_modules/ffmpeg-static',process.platform==='win32'?'ffmpeg.exe':'ffmpeg');
const probeSeconds=async(file:string)=>{
  const result=spawnSync(ffmpeg,['-hide_banner','-i',file],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  const text=`${result.stdout??''}\n${result.stderr??''}`;
  const match=text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if(!match) return null;
  return Number(match[1])*3600+Number(match[2])*60+Number(match[3]);
};
const tsx=join(root,'node_modules/tsx/dist/cli.mjs');
const chunkRetries = Number(process.env.GEO_CAPTURE_RETRIES ?? 2);
if (!Number.isSafeInteger(chunkRetries) || chunkRetries < 0 || chunkRetries > 5) throw new Error('GEO_CAPTURE_RETRIES 必须在 0–5 之间');

// The subtitle windows are a pure function of the region/profile, so they are measured
// once up front against a static composition page, then reused by every chunk.
async function measureSubtitleWindowsOnce(browser: Browser) {
  if (qa && !option('subtitle-composition')) return [];
  const layoutPage = await browser.newPage({ viewport: { width: profile === 'landscape' ? 1920 : 1080, height: profile === 'landscape' ? 1080 : profile === 'square' ? 1080 : 1920 } });
  try {
  await layoutPage.goto(pathToFileURL(resolve(root, option('subtitle-composition', 'apps/video-compositor/index.html'))).href);
  const compositionId = await layoutPage.locator('main').getAttribute('data-composition-id');
  if (compositionId !== `${region}-${profile}`) throw new Error(`字幕合成页不属于本次录制：${compositionId}`);
  const windows = await measureSubtitleWindows(layoutPage);
  console.log(`UE_SUBTITLE_LAYOUT ${windows.length} windows (map clock)`);
  return windows;
  } finally { await layoutPage.close(); }
}

// 分块重启始终覆盖同一帧区间；批次部分完成后不能在原进程中盲重发。
async function captureChunk(chunkStart: number, chunkEnd: number, subtitleWindows: Awaited<ReturnType<typeof measureSubtitleWindows>>, browser: Browser): Promise<void> {
  const port = await usablePort(Number(option('port', '4674')));
  const signallingPort = port + 1, streamerPort = port + 2;
  const scope = new CaptureScope(cancellation.signal);
  const start=(exe:string,args:string[],env={})=>{
    scope.signal.throwIfAborted();
    const p=scope.track(spawn(exe,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...env}}), exe);
    p.stdout?.on('data',x=>process.stdout.write(x));p.stderr?.on('data',x=>process.stderr.write(x));return p;
  };
  try {
  const unrealLog=join(frames,`unreal-${Date.now()}.log`);
  start(process.execPath,[tsx,join(root,'apps/ue-player/signalling.ts')],{UE_SIGNALLING_PORT:String(signallingPort),UE_STREAMER_PORT:String(streamerPort)});
  start(process.execPath,[tsx,join(root,'apps/ue-player/server.ts'),`--port=${port}`],{UE_SIGNALLING_URL:`ws://127.0.0.1:${signallingPort}`, ...(token ? { CESIUM_ION_TOKEN: token } : {})});
  const deadline=Date.now()+30000;
  while(true){
    scope.signal.throwIfAborted();
    try {
      const r=await fetch(`http://127.0.0.1:${port}/runtime-config.json`, { signal: AbortSignal.any([scope.signal, AbortSignal.timeout(Math.max(1, Math.min(2000, deadline-Date.now())))]) });
      await r.body?.cancel();
      if(r.ok)break;
    } catch { scope.signal.throwIfAborted(); }
    if(Date.now()>=deadline)throw new CaptureRetryError('UE player startup timeout');
    await scope.wait(delay(200));
  }
  start(join(runtime.engineRoot,'Engine/Binaries/Win64/UnrealEditor.exe'),[runtime.project,'/Engine/Maps/Entry','-game','-RenderOffscreen','-Unattended','-NoSplash','-AudioMixer','-mimalloc',`-PixelStreamingURL=ws://127.0.0.1:${streamerPort}`,`-GeoCaptureRoot=${frames}`,`-GeoCaptureIndexOffset=${chunkStart}`,`-ResX=${width}`,`-ResY=${height}`,'-ForceRes',`-abslog=${unrealLog}`]);
  const unrealDeadline=Date.now()+180000;
  while(true){
    scope.signal.throwIfAborted();
    const logText=await readFile(unrealLog,'utf8').catch(()=>'');
    if(logText.includes(`Websocket connection made to: ws://127.0.0.1:${streamerPort}`))break;
    if(Date.now()>unrealDeadline)throw new CaptureRetryError('UE streamer startup timeout');
    await scope.wait(delay(500));
  }
  const context=await browser.newContext({viewport:{width,height}});
  scope.defer(() => context.close());
  scope.signal.throwIfAborted();
  const page=await scope.wait(context.newPage());
  page.on('console',m=>{ console.log('UE_PAGE_CONSOLE',m.type(),m.text().slice(0,160)); });
  page.on('pageerror',e=>console.log('UE_PAGE_ERROR',e.message));
  page.on('response',r=>{ if(r.status()>=400) console.log('UE_PAGE_HTTP',r.status(),r.url()); });
  page.once('crash', () => scope.fail(new CaptureRetryError('UE 录制页面崩溃')));
  page.once('close', () => scope.fail(new CaptureRetryError('UE 录制页面关闭')));
  await scope.wait(page.goto(`http://127.0.0.1:${port}/?region=${region}&profile=${profile}&imagery=${encodeURIComponent(imagery)}&capture=1`));
  try {
    await scope.wait(page.waitForFunction(()=>Boolean((window as any).geoVideo?.getDiagnostics().ready),{},{timeout:180000}));
  } catch (error) {
    const status=await scope.wait(page.evaluate(()=>document.getElementById('status')?.textContent||''), 2000).catch(()=>'');
    console.log('UE_PAGE_OVERLAY',JSON.stringify(status));
    throw error;
  }
  await scope.wait(page.evaluate(windows => (window as any).geoVideo.setSubtitleWindows(windows), subtitleWindows));
  if (chunkStart === 0) {
    const health=await scope.wait(page.evaluate(()=>(window as any).geoVideo?.getStreamHealth?.()), 2000).catch(()=>null);
    console.log('UE_STREAM_HEALTH',JSON.stringify(health));
  }
  const renderBatch=async(times:number[])=>{
    scope.signal.throwIfAborted();
    const response=await scope.wait(page.evaluate(times=>(window as any).geoVideo.renderBatch(times),times), captureBatchTimeoutMs(times.length));
    const captured=Number(response?.captured);
    if(captured!==times.length) throw new CaptureRetryError(`批次丢帧：UE 汇总 captured=${captured}，期望 ${times.length}`);
  };
  for(let i=chunkStart;i<chunkEnd;i+=BATCH){
    const count=Math.min(BATCH,chunkEnd-i);
    const times:number[]=[]; for(let k=0;k<count;k++) times.push(startTime+(i+k)/fps);
    await renderBatch(times);
    console.log(`UE_CAPTURE ${i+count-1}/${total}`);
  }
  } catch (error) {
    if (scope.signal.aborted) throw scope.signal.reason;
    if (isTransientCaptureFailure(error)) {
      throw new CaptureRetryError(error.message, { cause: error });
    }
    throw error;
  } finally {
    await scope.close();
  }
}

let browser: Browser | undefined;
const scope = new CaptureScope(cancellation.signal);
try{
 if (!qa && !option('subtitle-composition')) {
   scope.signal.throwIfAborted();
   const composition = scope.track(spawn(process.execPath, [tsx, join(root, '.agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts'), '--region', region, '--profile', profile, '--map-fallback'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), '字幕预合成', true);
   composition.stdout?.on('data', x => process.stdout.write(x)); composition.stderr?.on('data', x => process.stderr.write(x));
   await scope.wait(new Promise<void>((ok, no) => { composition.once('error', no); composition.once('exit', code => code === 0 ? ok() : no(new Error(`字幕预合成失败：${code}`))); }), 600_000);
 }
 browser=await chromium.launch({headless:true, args: ['--allow-file-access-from-files']});
 scope.signal.throwIfAborted();
 const subtitleWindows=await scope.wait(measureSubtitleWindowsOnce(browser));
 for(let chunkStart=0;chunkStart<total;chunkStart+=CHUNK===0?total:CHUNK){
   const chunkEnd=Math.min(chunkStart+(CHUNK===0?total:CHUNK),total);
   if(chunkStart>0)console.log(`UE_CAPTURE_RESTART ${chunkStart}/${total} (session reset)`);
   await retryCaptureChunk(() => captureChunk(chunkStart,chunkEnd,subtitleWindows,browser!), cancellation.signal, chunkRetries,
     (attempt, error) => console.log(`UE_CAPTURE_CHUNK_RETRY ${attempt}/${chunkRetries} frames=${chunkStart}-${chunkEnd-1}: ${error.message}`));
 }
 let qualityReport:unknown;
 const output=join(root,'renders/intermediate',`${region}-map-${profile}${qa?'-qa':''}.mp4`);await mkdir(resolve(output,'..'),{recursive:true});
 cancellation.signal.throwIfAborted();
 const written=assertCaptureFrames(await readdir(frames),total);
 const encoder=scope.track(spawn(ffmpeg,['-y','-framerate',String(fps),'-start_number','0','-i',join(frames,'frame-%06d.png'),'-frames:v',String(total),'-c:v','libx264','-crf','16','-pix_fmt','yuv420p',output],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']}), 'FFmpeg', true);
 encoder.stdout?.on('data',x=>process.stdout.write(x)); encoder.stderr?.on('data',x=>process.stderr.write(x));
 await scope.wait(new Promise<void>((ok,no)=>{encoder.once('error',no);encoder.once('exit',code=>code===0?ok():no(new Error(`FFmpeg exited ${code}`)));}), 3_600_000);
 cancellation.signal.throwIfAborted();
 const encodedSeconds=await probeSeconds(output);
 const expectedSeconds=total/fps;
 if(encodedSeconds===null||encodedSeconds<expectedSeconds-0.1)throw new Error(`Encoded ${encodedSeconds ?? 0}s, expected ${expectedSeconds.toFixed(2)}s`);
 await writeFile(join(frames,'capture-report.json'),JSON.stringify({engine:'unreal',region,profile,imagery,fps,total,framesWritten:written,expectedDurationSeconds:expectedSeconds,encodedDurationSeconds:encodedSeconds,sourceDurationSeconds:seconds,capturedDurationSeconds:encodedSeconds,startTime,chunkFrames:CHUNK||total,batchFrames:BATCH,subtitleLayout:{clock:'map',windows:subtitleWindows},qualityReport,output},null,2));
}catch(error){
 if(error instanceof CaptureCleanupError) console.error(CAPTURE_CLEANUP_FATAL, error.message);
 throw error;
}finally{
 try { await scope.close(); }
 finally {
   try { await browser?.close(); }
   finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
 }
}
