import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { applyPortraitZoomToLayer, portraitOverviewExtent, portraitOverviewFrustumTangents, portraitOverviewScreenFractions } from '../apps/ue-player/framing.js';
import { fitRegionProfiles, outputSizes, simplifyRing } from '../apps/ue-player/viewport.js';
import { configureOpening, cloudStateAt } from '../apps/ue-player/opening.js';
import { frameAt } from '../apps/ue-player/presentation.js';
const read=async(path:string)=>JSON.parse(await readFile(path,'utf8'));

test('UE portrait framing reproduces the Cesium reference camera exactly',async()=>{
 const source=await readFile('apps/cesium-player/public/runtime.js','utf8');
 const block=source.split('// ---- portrait overview framing (pure, test-extractable) -------------------')[1]!.split('// ---- end portrait overview framing ----------------------------------------')[0]!;
 const reference=runInNewContext(`const CAMERA_PITCH=-64;${block};applyPortraitZoomToLayer`);
 const region=await read('data/regions/440825102.json'),geometry=await read('data/normalized/440825102.geojson');
 const expected=reference(region,geometry).cameraProfiles.portrait;
 assert.equal(JSON.stringify(applyPortraitZoomToLayer(region,geometry).cameraProfiles.portrait),JSON.stringify(expected));
 assert.equal(JSON.stringify(fitRegionProfiles(region,geometry).cameraProfiles.portrait),JSON.stringify(expected));
});
test('real region vertices stay inside every frame including the tighter tour overview',async()=>{
 for(const id of ['440825102','440882110','440823113']){
  const original=await read(`data/regions/${id}.json`),geometry=await read(`data/normalized/${id}.geojson`);
  const region=fitRegionProfiles(original,geometry),extent=portraitOverviewExtent(original.bbox,geometry)!;
  for(const [profile,[width,height]] of Object.entries(outputSizes)){
   const camera=frameAt({region},[{id:'child',start:100,end:110,cameraPreset:original.cameraPreset}],10,profile,4.4).camera;
   const east=(camera.lon-extent.longitude)*111320*Math.cos(extent.latitude*Math.PI/180),north=(camera.lat-extent.latitude)*110570;
   const tangent=portraitOverviewFrustumTangents(width/height);
   for(const point of extent.points){
    const projected=portraitOverviewScreenFractions(point.east-east,point.north-north,camera.height,camera.pitch,tangent);
    assert.ok(Math.abs(projected.x)<.94 && Math.abs(projected.y)<.94,`${id} ${profile} clipped`);
   }
  }
 }
});
test('sub-pixel simplification preserves closure and the maximum geometric error',()=>{
 const ring=Array.from({length:1001},(_,i)=>{const a=i*Math.PI/500;return [110+Math.cos(a)*.01,20+Math.sin(a)*.01];});
 ring[1000]=ring[0]!;
 const result=simplifyRing(ring,1);
 assert.ok(result.length<ring.length/3);
 assert.deepEqual(result[0],result.at(-1));
 const sx=111320*Math.cos(20*Math.PI/180),sy=110570;
 for(const p of ring){
  let distance=Infinity;
  for(let i=1;i<result.length;i++){
   const a=result[i-1]!,b=result[i]!,dx=(b[0]!-a[0]!)*sx,dy=(b[1]!-a[1]!)*sy,px=(p[0]!-a[0]!)*sx,py=(p[1]!-a[1]!)*sy;
   const t=Math.max(0,Math.min(1,(px*dx+py*dy)/(dx*dx+dy*dy)));
   distance=Math.min(distance,Math.hypot(px-t*dx,py-t*dy));
  }
  assert.ok(distance<1.01);
 }
 assert.equal(ring.length,1001);
});
test('overview replay supplies the missing descent and clouds, then clears them before the map hold',()=>{
 const region=configureOpening({cameraPreset:{longitude:110,latitude:20,height:30000,pitch:-64}}, {descentSeconds:3,startHeightMeters:900000});
 const scene={region};
 const start=frameAt(scene,[],0,'portrait',4.4,true),middle=frameAt(scene,[],2.1,'portrait',4.4,true),end=frameAt(scene,[],3.1,'portrait',4.4,true);
 assert.equal(start.camera.height,900000);
 assert.ok(middle.camera.height<start.camera.height);
 assert.ok(middle.clouds.deck>.2 && middle.clouds.veil>.4);
 assert.equal(end.clouds.deck,0);assert.equal(end.clouds.veil,0);
 assert.equal(frameAt({region:configureOpening(region,{clouds:false})},[],2.1,'portrait',4.4).clouds.volume,0);
});
test('cloud envelope timing matches the reference renderer at every opening beat',async()=>{
 const source=await readFile('apps/cesium-player/public/runtime.js','utf8');
 const block=source.slice(source.indexOf('  function openingCloudAlpha('),source.indexOf('  function buildOpeningClouds('));
 const opening={seconds:3,cloudsEnabled:true,clouds:true,cloudAlphaPeak:.95,cloudDeckHeightMeters:45000};
 const reference=runInNewContext(`const openingDescent=${JSON.stringify(opening)};const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));const lerp=(a,b,t)=>a+(b-a)*t;const smootherStep=t=>{t=clamp(t,0,1);return t*t*t*(t*(t*6-15)+10);};${block};({openingCloudAlpha,openingCloudDeckAlpha,openingCloudVeilAlpha})`);
 for(const time of [0,.8,1.2,1.8,2.1,2.5,2.9]){
  const actual=cloudStateAt(time,opening,100000);
  assert.ok(Math.abs(actual.deck-reference.openingCloudDeckAlpha(time))<1e-12);
  assert.ok(Math.abs(actual.veil-reference.openingCloudVeilAlpha(time))<1e-12);
  assert.ok(Math.abs(actual.volume-reference.openingCloudAlpha(time,100000))<1e-12);
 }
});
