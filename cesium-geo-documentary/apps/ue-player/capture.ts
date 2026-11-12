import { readFile, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { pathToFileURL } from 'node:url';
import { measureSubtitleWindows } from './subtitle-layout.js';
import { DEFAULT_IMAGERY_PROVIDER } from '../../packages/project-schema/index.js';
import { ionToken } from './imagery.js';
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
  for (let candidate = start; candidate < start + 300; candidate += 3) {
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
const killTree=(child:ChildProcess)=>{ if(child.exitCode!==null)return; child.kill(); if(process.platform==='win32'&&child.pid)spawn('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'}); };

// The subtitle windows are a pure function of the region/profile, so they are measured
// once up front against a static composition page, then reused by every chunk.
async function measureSubtitleWindowsOnce(browser: Browser) {
  if (qa && !option('subtitle-composition')) return [];
  const layoutPage = await browser.newPage({ viewport: { width: profile === 'landscape' ? 1920 : 1080, height: profile === 'landscape' ? 1080 : profile === 'square' ? 1080 : 1920 } });
  await layoutPage.goto(pathToFileURL(resolve(root, option('subtitle-composition', 'apps/video-compositor/index.html'))).href);
  const compositionId = await layoutPage.locator('main').getAttribute('data-composition-id');
  if (compositionId !== `${region}-${profile}`) throw new Error(`字幕合成页不属于本次录制：${compositionId}`);
  const windows = await measureSubtitleWindows(layoutPage);
  await layoutPage.close();
  console.log(`UE_SUBTITLE_LAYOUT ${windows.length} windows (map clock)`);
  return windows;
}

type Session = {
  page: Awaited<ReturnType<Browser['newPage']>>;
  renderFrame: (t:number)=>Promise<void>;
  teardown: ()=>Promise<void>;
};

// Launch signalling + player server + UE + page for one chunk, capturing frames
// [chunkStart, chunkEnd). Returns once the chunk is captured; the caller tears it down.
async function captureChunk(chunkStart: number, chunkEnd: number, subtitleWindows: Awaited<ReturnType<typeof measureSubtitleWindows>>, browser: Browser): Promise<Session> {
  const port = await usablePort(Number(option('port', '4674')) + chunkStart);
  const signallingPort = port + 1, streamerPort = port + 2;
  const children: ChildProcess[] = [];
  const start=(exe:string,args:string[],env={})=>{const p=spawn(exe,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...env}});children.push(p);p.stdout?.on('data',x=>process.stdout.write(x));p.stderr?.on('data',x=>process.stderr.write(x));return p;};
  const unrealLog=join(frames,`unreal-${Date.now()}.log`);
  start(process.execPath,[tsx,join(root,'apps/ue-player/signalling.ts')],{UE_SIGNALLING_PORT:String(signallingPort),UE_STREAMER_PORT:String(streamerPort)});
  start(process.execPath,[tsx,join(root,'apps/ue-player/server.ts'),`--port=${port}`],{UE_SIGNALLING_URL:`ws://127.0.0.1:${signallingPort}`, ...(token ? { CESIUM_ION_TOKEN: token } : {})});
  const deadline=Date.now()+30000;
  while(true){try{const r=await fetch(`http://127.0.0.1:${port}/runtime-config.json`);if(r.ok)break;}catch{}if(Date.now()>deadline)throw new Error('UE player startup timeout');await new Promise(r=>setTimeout(r,200));}
  let unrealExit:string|undefined;
  const unreal=start(join(runtime.engineRoot,'Engine/Binaries/Win64/UnrealEditor.exe'),[runtime.project,'/Engine/Maps/Entry','-game','-RenderOffscreen','-Unattended','-NoSplash','-AudioMixer','-mimalloc',`-PixelStreamingURL=ws://127.0.0.1:${streamerPort}`,`-GeoCaptureRoot=${frames}`,`-GeoCaptureIndexOffset=${chunkStart}`,`-ResX=${width}`,`-ResY=${height}`,'-ForceRes',`-abslog=${unrealLog}`]);
  unreal.once('exit',(code,signal)=>{unrealExit=`UE renderer exited (code ${code ?? '?'}${signal?`, ${signal}`:''})`;});
  const unrealDeadline=Date.now()+180000;
  while(true){
    if(unrealExit)throw new Error(`${unrealExit} before the stream was ready`);
    const logText=await readFile(unrealLog,'utf8').catch(()=>'');
    if(logText.includes(`Websocket connection made to: ws://127.0.0.1:${streamerPort}`))break;
    if(Date.now()>unrealDeadline)throw new Error('UE streamer startup timeout');
    await new Promise(r=>setTimeout(r,500));
  }
  const page=await browser.newPage({viewport:{width,height}});
  page.on('console',m=>{ console.log('UE_PAGE_CONSOLE',m.type(),m.text().slice(0,160)); });
  page.on('pageerror',e=>console.log('UE_PAGE_ERROR',e.message));
  page.on('response',r=>{ if(r.status()>=400) console.log('UE_PAGE_HTTP',r.status(),r.url()); });
  await page.goto(`http://127.0.0.1:${port}/?region=${region}&profile=${profile}&imagery=${encodeURIComponent(imagery)}&capture=1`);
  try {
    await page.waitForFunction(()=>Boolean((window as any).geoVideo?.getDiagnostics().ready),{},{timeout:180000});
  } catch (error) {
    const status=await page.evaluate(()=>document.getElementById('status')?.textContent||'').catch(()=>'');
    console.log('UE_PAGE_OVERLAY',JSON.stringify(status));
    throw error;
  }
  await page.evaluate(windows => (window as any).geoVideo.setSubtitleWindows(windows), subtitleWindows);
  if (chunkStart === 0) {
    const health=await page.evaluate(()=>(window as any).geoVideo?.getStreamHealth?.()).catch(()=>null);
    console.log('UE_STREAM_HEALTH',JSON.stringify(health));
  }
  const renderFrame=async(t:number)=>{ for(let attempt=1;;attempt++){ if(unrealExit)throw new Error(unrealExit); try{ await page.evaluate(t=>(window as any).geoVideo.renderFrame(t),t); if(attempt>1)console.log(`UE_FRAME_RECOVERED t=${t.toFixed(2)} after ${attempt-1} retries`); return; }catch(error){ const message=error instanceof Error?error.message:String(error); if(attempt>=8)throw error; console.log(`UE_FRAME_RETRY ${attempt} t=${t.toFixed(2)}: ${message}`); await page.evaluate(()=>(window as any).geoVideo?.waitForStream?.(60000)).catch(()=>undefined); await new Promise(r=>setTimeout(r,1000)); } } };
  const renderBatch=async(times:number[])=>{
    for(let attempt=1;;attempt++){
      if(unrealExit)throw new Error(unrealExit);
      try{
        const response=await page.evaluate(times=>(window as any).geoVideo.renderBatch(times),times);
        const captured=Number(response?.captured ?? times.length);
        if(captured!==times.length) throw new Error(`批次丢帧：UE 汇总 captured=${captured}，期望 ${times.length}`);
        if(attempt>1)console.log(`UE_BATCH_RECOVERED ${times[0]?.toFixed(2)}s after ${attempt-1} retries`);
        return;
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        if(attempt>=8)throw error;
        console.log(`UE_BATCH_RETRY ${attempt} @${times[0]?.toFixed(2)}s: ${message}`);
        await page.evaluate(()=>(window as any).geoVideo?.waitForStream?.(60000)).catch(()=>undefined);
        await new Promise(r=>setTimeout(r,1000));
      }
    }
  };
  for(let i=chunkStart;i<chunkEnd;i+=BATCH){
    const count=Math.min(BATCH,chunkEnd-i);
    const times:number[]=[]; for(let k=0;k<count;k++) times.push(startTime+(i+k)/fps);
    await renderBatch(times);
    console.log(`UE_CAPTURE ${i+count-1}/${total}`);
  }
  const teardown=async()=>{
    await page.close().catch(()=>undefined);
    for(const child of children){
      if(child.exitCode!==null)continue;
      child.kill();
      if(process.platform==='win32'&&child.pid)spawn('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});
    }
  };
  return { page, renderFrame, teardown };
}

let browser: Browser | undefined;
try{
 if (!qa && !option('subtitle-composition')) {
   const composition = spawn(process.execPath, [tsx, join(root, '.agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts'), '--region', region, '--profile', profile, '--map-fallback'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
   composition.stdout?.on('data', x => process.stdout.write(x)); composition.stderr?.on('data', x => process.stderr.write(x));
   await new Promise<void>((ok, no) => { composition.once('error', no); composition.once('exit', code => code === 0 ? ok() : no(new Error(`字幕预合成失败：${code}`))); });
 }
 browser=await chromium.launch({headless:true, args: ['--allow-file-access-from-files']});
 const subtitleWindows=await measureSubtitleWindowsOnce(browser);
 for(let chunkStart=0;chunkStart<total;chunkStart+=CHUNK===0?total:CHUNK){
   const chunkEnd=Math.min(chunkStart+(CHUNK===0?total:CHUNK),total);
   if(chunkStart>0)console.log(`UE_CAPTURE_RESTART ${chunkStart}/${total} (session reset)`);
   const session=await captureChunk(chunkStart,chunkEnd,subtitleWindows,browser);
   await session.teardown();
 }
 let qualityReport:unknown;
 const output=join(root,'renders/intermediate',`${region}-map-${profile}${qa?'-qa':''}.mp4`);await mkdir(resolve(output,'..'),{recursive:true});
 const written=(await readdir(frames).catch(()=>[] as string[])).filter(name=>/^frame-\d{6}\.png$/.test(name)).length;
 if(written!==total)throw new Error(`Captured ${written}/${total} frames; the UE stream stopped early`);
 const encoder=spawn(ffmpeg,['-y','-framerate',String(fps),'-start_number','0','-i',join(frames,'frame-%06d.png'),'-frames:v',String(total),'-c:v','libx264','-crf','16','-pix_fmt','yuv420p',output],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
 encoder.stdout?.on('data',x=>process.stdout.write(x)); encoder.stderr?.on('data',x=>process.stderr.write(x));
 await new Promise<void>((ok,no)=>{encoder.once('error',no);encoder.once('exit',code=>code===0?ok():no(new Error(`FFmpeg exited ${code}`)));});
 const encodedSeconds=await probeSeconds(output);
 const expectedSeconds=total/fps;
 if(encodedSeconds===null||encodedSeconds<expectedSeconds-0.1)throw new Error(`Encoded ${encodedSeconds ?? 0}s, expected ${expectedSeconds.toFixed(2)}s`);
 await writeFile(join(frames,'capture-report.json'),JSON.stringify({engine:'unreal',region,profile,imagery,fps,total,framesWritten:written,expectedDurationSeconds:expectedSeconds,encodedDurationSeconds:encodedSeconds,sourceDurationSeconds:seconds,capturedDurationSeconds:encodedSeconds,startTime,chunkFrames:CHUNK||total,batchFrames:BATCH,subtitleLayout:{clock:'map',windows:subtitleWindows},qualityReport,output},null,2));
}finally{
 await browser?.close();
}
