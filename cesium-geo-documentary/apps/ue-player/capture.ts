import { readFile, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
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
// Three consecutive ports, all bindable here. Windows reserves whole ranges for
// Hyper-V/WinNAT, and binding one of them fails with EACCES rather than EADDRINUSE —
// the player then starts fine while the signalling server dies, and the capture page
// waits forever for a streamer that can never connect. Probe before committing.
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
const port = await usablePort(Number(option('port', '4674')));
const signallingPort = port + 1, streamerPort = port + 2;
if (port !== Number(option('port', '4674'))) console.log(`UE_CAPTURE_PORTS ${port}-${streamerPort} (requested ${option('port','4674')})`);
const preview=process.argv.includes('--preview') && process.argv.includes('--qa'),scale=preview?2/3:1;
const width=(profile==='landscape'?1920:1080)*scale,height=(profile==='landscape'?1080:profile==='square'?1080:1920)*scale;
const qa=process.argv.includes('--qa');
// QA runs are one-frame probes of a timeline, and they used to be written into
// the same `renders/ue-frames` and `renders/intermediate` paths as a real
// capture. A `--qa --frames 1` run therefore replaced a finished 50 s map clip
// with a single frame, and every later composition played a blank white board
// with only the subtitles left on it. Keep the probe output in its own lane.
const slot=qa?`${region}-${profile}-qa`:`${region}-${profile}`;
const frames=join(root,'renders','ue-frames',slot);
const unrealLog=join(frames,`unreal-${Date.now()}.log`);
const timeline=JSON.parse(await readFile(join(root,'data/regions',`${region}.timeline.json`),'utf8'));
const regionData=JSON.parse(await readFile(join(root,'data/regions',`${region}.json`),'utf8'));
const seconds=Number(timeline.duration)+(regionData.openingDescent?.enabled===false?0:Number(regionData.openingDescent?.seconds || 0));
const fps=30,total=Number(option('frames',String(Math.ceil(seconds*fps)))),startTime=Number(option('start-time','0'));
if (!Number.isSafeInteger(total) || total<1 || !Number.isFinite(startTime) || startTime<0) throw new Error('Invalid capture frame range');
await mkdir(frames,{recursive:true});
// A job reuses its sandbox and UE restarts its frame counter at zero, so frames left by
// an earlier attempt sit at exactly the numbers this run is about to write. ffmpeg
// globs `frame-%06d.png` from 0, which means a stale tail silently padded a short take
// (or a partial PNG from a killed run broke the encode). Clear the lane first.
for (const name of await readdir(frames).catch(() => [] as string[])) {
  if (/^frame-\d{6}\.png$/.test(name)) await rm(join(frames, name), { force: true });
}
const ffmpeg=join(root,'node_modules/ffmpeg-static',process.platform==='win32'?'ffmpeg.exe':'ffmpeg');
const probeSeconds=async(file:string)=>{
  const result=spawnSync(ffmpeg,['-hide_banner','-i',file],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  const text=`${result.stdout??''}\n${result.stderr??''}`;
  const match=text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if(!match) return null;
  return Number(match[1])*3600+Number(match[2])*60+Number(match[3]);
};
const children:ChildProcess[]=[];
const start=(exe:string,args:string[],env={})=>{const p=spawn(exe,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...env}});children.push(p);p.stdout?.on('data',x=>process.stdout.write(x));p.stderr?.on('data',x=>process.stderr.write(x));return p;};
const tsx=join(root,'node_modules/tsx/dist/cli.mjs');
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try{
 // 独立录制同样先生成本轮字幕；QA无旁白时明确不预留字幕空间。
 if (!qa && !option('subtitle-composition')) {
   const composition = start(process.execPath, [tsx, join(root, '.agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts'), '--region', region, '--profile', profile, '--map-fallback']);
   await new Promise<void>((ok, no) => { composition.once('error', no); composition.once('exit', code => code === 0 ? ok() : no(new Error(`字幕预合成失败：${code}`))); });
 }
 start(process.execPath,[tsx,join(root,'apps/ue-player/signalling.ts')],{UE_SIGNALLING_PORT:String(signallingPort),UE_STREAMER_PORT:String(streamerPort)});
 start(process.execPath,[tsx,join(root,'apps/ue-player/server.ts'),`--port=${port}`],{UE_SIGNALLING_URL:`ws://127.0.0.1:${signallingPort}`, ...(token ? { CESIUM_ION_TOKEN: token } : {})});
 const deadline=Date.now()+30000;
 while(true){try{const r=await fetch(`http://127.0.0.1:${port}/runtime-config.json`);if(r.ok)break;}catch{}if(Date.now()>deadline)throw new Error('UE player startup timeout');await new Promise(r=>setTimeout(r,200));}
 const unreal=start(join(runtime.engineRoot,'Engine/Binaries/Win64/UnrealEditor.exe'),[runtime.project,'/Engine/Maps/Entry','-game','-RenderOffscreen','-Unattended','-NoSplash','-AudioMixer',`-PixelStreamingURL=ws://127.0.0.1:${streamerPort}`,`-GeoCaptureRoot=${frames}`,`-ResX=${width}`,`-ResY=${height}`,'-ForceRes',`-abslog=${unrealLog}`]);
 // Without this the grabber kept asking a dead renderer for frames and only found out
 // minutes later, as a generic command timeout — with no hint that UE had crashed.
 let unrealExit:string|undefined;
 unreal.once('exit',(code,signal)=>{unrealExit=`UE renderer exited (code ${code ?? '?'}${signal?`, ${signal}`:''})`;});
 const unrealDeadline=Date.now()+180000;
 while(true){
   if(unrealExit)throw new Error(`${unrealExit} before the stream was ready`);
   const log=await readFile(unrealLog,'utf8').catch(()=>'');
   if(log.includes(`Websocket connection made to: ws://127.0.0.1:${streamerPort}`))break;
   if(Date.now()>unrealDeadline)throw new Error('UE streamer startup timeout');
   await new Promise(r=>setTimeout(r,500));
 }
 browser=await chromium.launch({headless:true, args: ['--allow-file-access-from-files']});
 let subtitleWindows: Awaited<ReturnType<typeof measureSubtitleWindows>> = [];
 if (!qa || option('subtitle-composition')) {
   const layoutPage = await browser.newPage({ viewport: { width: profile === 'landscape' ? 1920 : 1080, height: profile === 'landscape' ? 1080 : profile === 'square' ? 1080 : 1920 } });
   // index.html与media同级；直接使用composition子目录会导致字体相对路径错误。
   await layoutPage.goto(pathToFileURL(resolve(root, option('subtitle-composition', 'apps/video-compositor/index.html'))).href);
   const compositionId = await layoutPage.locator('main').getAttribute('data-composition-id');
   if (compositionId !== `${region}-${profile}`) throw new Error(`字幕合成页不属于本次录制：${compositionId}`);
   subtitleWindows = await measureSubtitleWindows(layoutPage);
   await layoutPage.close();
   console.log(`UE_SUBTITLE_LAYOUT ${subtitleWindows.length} windows (map clock)`);
 }
 const page=await browser.newPage({viewport:{width,height}});
 // The player only exposes its state through the overlay; when it never becomes ready
 // the useful information is the HTTP failure or the exception, so surface both.
 page.on('console',m=>{ if(m.type()==='error') console.log('UE_PAGE_CONSOLE',m.text()); });
 page.on('pageerror',e=>console.log('UE_PAGE_ERROR',e.message));
 page.on('response',r=>{ if(r.status()>=400) console.log('UE_PAGE_HTTP',r.status(),r.url()); });
 // `capture=1` puts the page in headless mode: no viewer lease, and a dropped stream
 // reconnects by itself instead of waiting for a click that will never come.
 await page.goto(`http://127.0.0.1:${port}/?region=${region}&profile=${profile}&imagery=${encodeURIComponent(imagery)}&capture=1`);
 try {
   await page.waitForFunction(()=>Boolean((window as any).geoVideo?.getDiagnostics().ready),{},{timeout:180000});
 } catch (error) {
   const status=await page.evaluate(()=>document.getElementById('status')?.textContent||'').catch(()=>'');
   console.log('UE_PAGE_OVERLAY',JSON.stringify(status));
   throw error;
 }
 await page.evaluate(windows => (window as any).geoVideo.setSubtitleWindows(windows), subtitleWindows);
 const health=await page.evaluate(()=>(window as any).geoVideo?.getStreamHealth?.()).catch(()=>null);
 // If `captureMode` is not true here the page will wait for a click after a dropped
 // stream and the whole recovery path is dead code — worth one line in the log.
 console.log('UE_STREAM_HEALTH',JSON.stringify(health));
 const requestedTimes=process.env.GEO_QA_TIMES?process.env.GEO_QA_TIMES.split(',').map(Number):undefined;
const sampleTimes=requestedTimes ?? (qa?[0,2.1,8]:undefined);
 if(qa){await page.evaluate(()=>(window as any).geoVideo.playOpeningPreview({descentSeconds:0}));}
 // One frame, with the stream allowed to come back. A WebRTC hiccup mid-take used to
 // abort the whole export; in capture mode the page reconnects and re-applies the scene,
 // so the only thing the grabber has to do is wait and ask again.
 const renderFrame=async(t:number)=>{
   for(let attempt=1;;attempt++){
     if(unrealExit)throw new Error(unrealExit);
     try{
       await page.evaluate(t=>(window as any).geoVideo.renderFrame(t),t);
       if(attempt>1)console.log(`UE_FRAME_RECOVERED t=${t.toFixed(2)} after ${attempt-1} retries`);
       return;
     }catch(error){
       const message=error instanceof Error?error.message:String(error);
       if(attempt>=8)throw error;
       console.log(`UE_FRAME_RETRY ${attempt} t=${t.toFixed(2)}: ${message}`);
       await page.evaluate(()=>(window as any).geoVideo?.waitForStream?.(60000)).catch(()=>undefined);
       await new Promise(r=>setTimeout(r,1000));
     }
   }
 };
 for(let i=0;i<total;i++){
   await renderFrame(sampleTimes?.[i] ?? startTime+i/fps);
   if(i%30===0)console.log(`UE_CAPTURE ${i}/${total}`);
 }
 let qualityReport:unknown;
 if(qa){
   const settled=await page.evaluate(()=>(window as any).geoVideo.getRendererStatus());
   const bounds=settled.parentScreenBounds;
   if(!bounds || bounds.left<0 || bounds.top<0 || bounds.right>1 || bounds.bottom>1)throw new Error(`UE viewport clips region: ${JSON.stringify(bounds)}`);
   await page.waitForTimeout(5000);
   const motion=await page.evaluate(async()=>{
     (window as any).geoVideo.playOpeningPreview({descentSeconds:0});
     const video=document.querySelector('video')!;const before=video.getVideoPlaybackQuality();const at=performance.now();
     await new Promise(r=>setTimeout(r,3000));
     const after=video.getVideoPlaybackQuality();
     return {renderer:await (window as any).geoVideo.getRendererStatus(),video:{width:video.videoWidth,height:video.videoHeight,decodedFps:(after.totalVideoFrames-before.totalVideoFrames)/((performance.now()-at)/1000),droppedFrames:after.droppedVideoFrames-before.droppedVideoFrames}};
   });
   qualityReport={settled,motion};
 }
 const output=join(root,'renders/intermediate',`${region}-map-${profile}${qa?'-qa':''}.mp4`);await mkdir(resolve(output,'..'),{recursive:true});
 // Count what actually landed on disk before encoding. The old report claimed
 // `capturedDurationSeconds = total / fps` no matter what happened, so a take that died
 // at frame 900 of 4000 looked exactly like a complete one and was cached as such.
 const written=(await readdir(frames).catch(()=>[] as string[])).filter(name=>/^frame-\d{6}\.png$/.test(name)).length;
 if(unrealExit)throw new Error(`${unrealExit} after ${written}/${total} frames`);
 if(written!==total)throw new Error(`Captured ${written}/${total} frames; the UE stream stopped early`);
 const encoder=start(ffmpeg,['-y','-framerate',String(fps),'-start_number','0','-i',join(frames,'frame-%06d.png'),'-frames:v',String(total),'-c:v','libx264','-crf','16','-pix_fmt','yuv420p',output]);
 await new Promise<void>((ok,no)=>{encoder.once('error',no);encoder.once('exit',code=>code===0?ok():no(new Error(`FFmpeg exited ${code}`)));});
 const encodedSeconds=await probeSeconds(output);
 const expectedSeconds=total/fps;
 if(encodedSeconds===null||encodedSeconds<expectedSeconds-0.1)throw new Error(`Encoded ${encodedSeconds ?? 0}s, expected ${expectedSeconds.toFixed(2)}s`);
 await writeFile(join(frames,'capture-report.json'),JSON.stringify({engine:'unreal',region,profile,imagery,fps,total,framesWritten:written,expectedDurationSeconds:expectedSeconds,encodedDurationSeconds:encodedSeconds,sourceDurationSeconds:seconds,capturedDurationSeconds:encodedSeconds,startTime,sampleTimes,subtitleLayout:{clock:'map',windows:subtitleWindows},qualityReport,output},null,2));
}finally{
 await browser?.close();
 // `child.kill()` on Windows terminates the node wrapper only: the UE renderer, the
 // signalling server and chromium survive it, hold the GPU and the ports, and make the
 // next take flakier than the one that just failed. Kill the whole tree.
 for(const child of children){
   if(child.exitCode!==null)continue;
   child.kill();
   if(process.platform==='win32'&&child.pid)spawn('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});
 }
}
