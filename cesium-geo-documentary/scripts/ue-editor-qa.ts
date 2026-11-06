import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { spawn,type ChildProcess } from 'node:child_process';
import { chromium } from 'playwright';
const root=process.cwd(),runtime=JSON.parse((await readFile('workspace/ue-runtime.json','utf8')).replace(/^\uFEFF/,''));
const children:ChildProcess[]=[];
const launch=(exe:string,args:string[],env={})=>{const p=spawn(exe,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...env}});children.push(p);p.stderr?.on('data',x=>process.stderr.write(x));return p;};
const tsx=join(root,'node_modules/tsx/dist/cli.mjs'),out=resolve('workspace/ue-qa');await mkdir(out,{recursive:true});
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try{
 launch(process.execPath,[tsx,'apps/ue-player/signalling.ts'],{UE_SIGNALLING_PORT:'4775',UE_STREAMER_PORT:'4776'});
 launch(process.execPath,[tsx,'apps/ue-player/server.ts','--port=4774'],{UE_SIGNALLING_URL:'ws://127.0.0.1:4775'});
 const log=join(out,`editor-${Date.now()}.log`);
 launch(join(runtime.engineRoot,'Engine/Binaries/Win64/UnrealEditor.exe'),[runtime.project,'/Engine/Maps/Entry','-game','-RenderOffscreen','-Unattended','-NoSplash','-AudioMixer','-PixelStreamingURL=ws://127.0.0.1:4776','-ResX=720','-ResY=720','-ForceRes',`-abslog=${log}`]);
 const deadline=Date.now()+180000;
 while(!(await readFile(log,'utf8').catch(()=>'')).includes('Websocket connection made to: ws://127.0.0.1:4776')){if(Date.now()>deadline)throw new Error('QA streamer failed');await new Promise(r=>setTimeout(r,500));}
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1196,height:956}});
 await page.route('**/studio-config.js',route=>route.fulfill({contentType:'text/javascript',body:'export const previewOrigin = "http://127.0.0.1:4774";'}));
 await page.goto('http://127.0.0.1:4180/');await page.locator('#timelineScenes .timeline-clip').nth(1).waitFor({timeout:60000});
 await page.locator('#timelineScenes .timeline-clip').nth(1).click();
 const frame=await page.locator('#cesiumPreview').elementHandle().then(el=>el!.contentFrame());
 if(!frame)throw new Error('Preview frame missing');
 await frame.waitForFunction(()=>Boolean((window as any).geoVideo?.getDiagnostics().ready),{},{timeout:180000});
 await page.waitForTimeout(8000);await frame.evaluate(()=>(window as any).geoVideo.seek(8));await page.waitForTimeout(1000);
 const overview=await frame.evaluate(async()=>({native:await (window as any).geoVideo.getRendererStatus(),video:{width:document.querySelector('video')!.videoWidth,height:document.querySelector('video')!.videoHeight},canvas:{width:innerWidth,height:innerHeight}}));
 if(overview.native.width!==720 || overview.native.height!==1280 || Math.abs(overview.video.width/overview.video.height-9/16)>.01)throw new Error(`Preview aspect mismatch: ${JSON.stringify(overview)}`);
 await page.screenshot({path:join(out,'editor-overview.png')});
 const projects:any[]=await fetch('http://127.0.0.1:4180/api/projects').then(r=>r.json());
 const project=projects.find(p=>p.regionId==='440825102');const selected=project?.scenes.find((s:any)=>s.childName==='坑头村' || s.title==='坑头村') || project?.scenes.find((s:any)=>s.section==='child');
 if(!selected)throw new Error('No child scene available');
 await page.locator(`#timelineScenes [data-scene-id="${selected.id}"]`).click();await page.waitForTimeout(4000);
 await page.screenshot({path:join(out,'editor-child-trace.png')});await page.waitForTimeout(2500);
 const time=await frame.evaluate(()=>(window as any).geoVideo.getDiagnostics().time);await frame.evaluate(t=>(window as any).geoVideo.seek(t),time);await page.waitForTimeout(1000);
 await page.screenshot({path:join(out,'editor-child.png')});
 const child=await frame.evaluate(async()=>({diagnostics:(window as any).geoVideo.getDiagnostics(),native:await (window as any).geoVideo.getRendererStatus()}));
 if(!child.native.filledRegions)throw new Error('Region fill geometry missing');
 await writeFile(join(out,'editor-qa.json'),JSON.stringify({overview,child},null,2));console.log(JSON.stringify({overview,child}));
}finally{await browser?.close();for(const p of children)if(p.exitCode===null)p.kill();}
