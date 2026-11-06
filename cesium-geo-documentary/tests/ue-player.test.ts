import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { within, loadScene } from '../apps/ue-player/scene.js';
import { camera, flight, frameAt } from '../apps/ue-player/presentation.js';
test('UE file resolver rejects traversal and sibling-prefix escapes',()=>{
 assert.throws(()=>within('/project','../project-other/file'));assert.throws(()=>within('/project','../secret'));assert.equal(within('/project','data/a'),resolve('/project','data/a'));
});
test('UE scene reads frozen project geometry before live geometry',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ue-scene-'));
 try{
  for(const base of ['data/regions','data/normalized','workspace/projects/p.boundary/data/normalized'])await mkdir(join(root,base),{recursive:true});
  await writeFile(join(root,'data/regions/a.json'),JSON.stringify({id:'a',geometryPath:'data/normalized/a.geojson'}));
  await writeFile(join(root,'data/regions/a.timeline.json'),'{}');
  await writeFile(join(root,'data/normalized/a.geojson'),JSON.stringify({features:[{properties:{name:'live'}}]}));
  await writeFile(join(root,'workspace/projects/p.boundary/data/normalized/a.geojson'),JSON.stringify({features:[{properties:{name:'frozen'}}]}));
  assert.equal((await loadScene(root,'a','p')).layers[0].properties.name,'frozen');
  await assert.rejects(loadScene(root,'../a',null));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('UE tour starts at settled opening camera and returns to the same camera',()=>{
 const base={longitude:110,latitude:20,height:20000,pitch:-64,heading:0};
 const scene={region:{cameraPreset:base}};
 const stops=[{id:'one',start:10,end:20,flightDuration:4,cameraPreset:{...base,longitude:110.1,height:5000}}];
 const overview=frameAt(scene,stops,0,'portrait',4.4).camera;
 assert.deepEqual(frameAt(scene,stops,10,'portrait',4.4).camera,overview);
 const returned=frameAt(scene,stops,30,'portrait',4.4).camera;
 assert.ok(Math.abs(returned.height-overview.height)<1e-8);
 assert.equal(returned.lon,overview.lon);
 assert.equal(frameAt(scene,stops,30,'portrait',4.4).parentLabel,0);
 assert.deepEqual(frameAt(scene,stops,30,'portrait',4.4).visited,['one']);
});
test('UE camera heading takes the short path across north',()=>{
 const a=camera({lon:110,lat:20,height:5000,heading:350}),b=camera({lon:111,lat:21,height:5000,heading:10});
 assert.equal(flight(a,b,.5).heading,360);
});
