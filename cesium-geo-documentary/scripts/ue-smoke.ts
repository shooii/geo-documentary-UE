import { chromium } from 'playwright';
import { mkdir,writeFile } from 'node:fs/promises';
const browser=await chromium.launch({headless:true,channel:'chrome'});
let monitor:ReturnType<typeof setInterval>|undefined;
try {
 const page=await browser.newPage({viewport:{width:540,height:960}});
 monitor=setInterval(()=>{void page.locator('#status').textContent().then(x=>console.log('UE_STATUS',x)).catch(()=>{});},5000);
 page.on('pageerror',e=>console.log('PAGE_ERROR',e.message));
 page.on('console',e=>{if(e.type()==='error')console.log('BROWSER_ERROR',e.text());});
 const imagery=process.env.UE_SMOKE_IMAGERY || 'esri-world-imagery';
 await page.goto(`http://127.0.0.1:4174/?region=440825102&profile=portrait&imagery=${encodeURIComponent(imagery)}`);
 try { await page.waitForFunction(()=>Boolean((window as any).geoVideo?.getDiagnostics().ready),{},{timeout:60000}); }
 catch(error) { console.log('STATUS',await page.locator('body').innerText()); throw error; }
 await page.evaluate(()=>(window as any).geoVideo.seek(8));
 await page.waitForTimeout(20000);
 await mkdir('workspace/ue-qa',{recursive:true});
 await page.screenshot({path:'workspace/ue-qa/native-stream.png'});
 const result=await page.evaluate(async()=>({diagnostics:(window as any).geoVideo.getDiagnostics(),renderer:await (window as any).geoVideo.getRendererStatus(),video:[...document.querySelectorAll('video')].map(v=>({width:v.videoWidth,height:v.videoHeight,readyState:v.readyState,currentTime:v.currentTime})),status:document.getElementById('status')?.textContent}));
 await writeFile('workspace/ue-qa/smoke.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
}finally{clearInterval(monitor);await browser.close();}
