import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium } from 'playwright';
const root = resolve(process.cwd());
const option = (name:string, fallback='') => { const i=process.argv.indexOf(`--${name}`); return i>=0?process.argv[i+1] || fallback:fallback; };
const region = option('region'), profile=option('profile','portrait');
if (!/^[\w-]+$/.test(region)) throw new Error('A valid --region is required');
const runtimePath = process.env.GEO_UE_RUNTIME || join(root,'workspace/ue-runtime.json');
const runtime=JSON.parse((await readFile(runtimePath,'utf8')).replace(/^\uFEFF/,''));
const port=Number(option('port','4674')),signallingPort=port+1,streamerPort=port+2;
const preview=process.argv.includes('--preview') && process.argv.includes('--qa'),scale=preview?2/3:1;
const width=(profile==='landscape'?1920:1080)*scale,height=(profile==='landscape'?1080:profile==='square'?1080:1920)*scale;
const frames=join(root,'renders','ue-frames',`${region}-${profile}`);
const unrealLog=join(frames,`unreal-${Date.now()}.log`);
const timeline=JSON.parse(await readFile(join(root,'data/regions',`${region}.timeline.json`),'utf8'));
const regionData=JSON.parse(await readFile(join(root,'data/regions',`${region}.json`),'utf8'));
const seconds=Number(timeline.duration)+(regionData.openingDescent?.enabled===false?0:Number(regionData.openingDescent?.seconds || 0));
const fps=30,total=Number(option('frames',String(Math.ceil(seconds*fps)))),startTime=Number(option('start-time','0'));
if (!Number.isSafeInteger(total) || total<1 || !Number.isFinite(startTime) || startTime<0) throw new Error('Invalid capture frame range');
await mkdir(frames,{recursive:true});
const children:ChildProcess[]=[];
const start=(exe:string,args:string[],env={})=>{const p=spawn(exe,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...env}});children.push(p);p.stdout?.on('data',x=>process.stdout.write(x));p.stderr?.on('data',x=>process.stderr.write(x));return p;};
const tsx=join(root,'node_modules/tsx/dist/cli.mjs');
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try{
 start(process.execPath,[tsx,join(root,'apps/ue-player/signalling.ts')],{UE_SIGNALLING_PORT:String(signallingPort),UE_STREAMER_PORT:String(streamerPort)});
 start(process.execPath,[tsx,join(root,'apps/ue-player/server.ts'),`--port=${port}`],{UE_SIGNALLING_URL:`ws://127.0.0.1:${signallingPort}`});
 const deadline=Date.now()+30000;
 while(true){try{const r=await fetch(`http://127.0.0.1:${port}/runtime-config.json`);if(r.ok)break;}catch{}if(Date.now()>deadline)throw new Error('UE player startup timeout');await new Promise(r=>setTimeout(r,200));}
 start(join(runtime.engineRoot,'Engine/Binaries/Win64/UnrealEditor.exe'),[runtime.project,'/Engine/Maps/Entry','-game','-RenderOffscreen','-Unattended','-NoSplash','-AudioMixer',`-PixelStreamingURL=ws://127.0.0.1:${streamerPort}`,`-GeoCaptureRoot=${frames}`,`-ResX=${width}`,`-ResY=${height}`,'-ForceRes',`-abslog=${unrealLog}`]);
 const unrealDeadline=Date.now()+180000;
 while(true){
   const log=await readFile(unrealLog,'utf8').catch(()=>'');
   if(log.includes(`Websocket connection made to: ws://127.0.0.1:${streamerPort}`))break;
   if(Date.now()>unrealDeadline)throw new Error('UE streamer startup timeout');
   await new Promise(r=>setTimeout(r,500));
 }
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width,height}});
 await page.goto(`http://127.0.0.1:${port}/?region=${region}&profile=${profile}&imagery=${encodeURIComponent(option('imagery','esri-world-imagery'))}`);
 await page.waitForFunction(()=>Boolean((window as any).geoVideo?.getDiagnostics().ready),{},{timeout:180000});
 const qa=process.argv.includes('--qa');
 const sampleTimes=qa?[0,2.1,8]:undefined;
 if(qa){await page.evaluate(()=>(window as any).geoVideo.playOpeningPreview({descentSeconds:3}));}
 for(let i=0;i<total;i++){
   await page.evaluate(t=>(window as any).geoVideo.renderFrame(t),sampleTimes?.[i] ?? startTime+i/fps);
   if(i%30===0)console.log(`UE_CAPTURE ${i}/${total}`);
 }
 let qualityReport:unknown;
 if(qa){
   const settled=await page.evaluate(()=>(window as any).geoVideo.getRendererStatus());
   const bounds=settled.parentScreenBounds;
   if(!bounds || bounds.left<0 || bounds.top<0 || bounds.right>1 || bounds.bottom>1)throw new Error(`UE viewport clips region: ${JSON.stringify(bounds)}`);
   await page.waitForTimeout(5000);
   const motion=await page.evaluate(async()=>{
     (window as any).geoVideo.playOpeningPreview({descentSeconds:3});
     const video=document.querySelector('video')!;const before=video.getVideoPlaybackQuality();const at=performance.now();
     await new Promise(r=>setTimeout(r,3000));
     const after=video.getVideoPlaybackQuality();
     return {renderer:await (window as any).geoVideo.getRendererStatus(),video:{width:video.videoWidth,height:video.videoHeight,decodedFps:(after.totalVideoFrames-before.totalVideoFrames)/((performance.now()-at)/1000),droppedFrames:after.droppedVideoFrames-before.droppedVideoFrames}};
   });
   qualityReport={settled,motion};
 }
 const output=join(root,'renders/intermediate',`${region}-map-${profile}.mp4`);await mkdir(resolve(output,'..'),{recursive:true});
 const ffmpeg=join(root,'node_modules/ffmpeg-static',process.platform==='win32'?'ffmpeg.exe':'ffmpeg');
 const encoder=start(ffmpeg,['-y','-framerate',String(fps),'-start_number','0','-i',join(frames,'frame-%06d.png'),'-frames:v',String(total),'-c:v','libx264','-crf','16','-pix_fmt','yuv420p',output]);
 await new Promise<void>((ok,no)=>{encoder.once('error',no);encoder.once('exit',code=>code===0?ok():no(new Error(`FFmpeg exited ${code}`)));});
 await writeFile(join(frames,'capture-report.json'),JSON.stringify({engine:'unreal',region,profile,imagery:option('imagery','esri-world-imagery'),fps,total,sourceDurationSeconds:seconds,capturedDurationSeconds:total/fps,startTime,sampleTimes,qualityReport,output},null,2));
}finally{await browser?.close();for(const child of children)if(child.exitCode===null)child.kill();}
