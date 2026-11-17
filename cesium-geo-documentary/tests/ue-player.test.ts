import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Cartographic, EllipsoidGeodesic } from 'cesium';
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
 assert.equal(overview.height,base.height,'不得在安全拟合后隐式推近总览');
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

test('UE flight follows the Cesium WGS84 path across the antimeridian', () => {
  const from = camera({ lon: 179, lat: 40, height: 7000 });
  const to = camera({ lon: -179, lat: 44, height: 5000 });
  const geodesic = new EllipsoidGeodesic(Cartographic.fromDegrees(from.lon, from.lat), Cartographic.fromDegrees(to.lon, to.lat));
  const expected = geodesic.interpolateUsingFraction(.5);
  const actual = flight(from, to, .5);
  assert.ok(Math.abs(actual.lon - expected.longitude * 180 / Math.PI) < 1e-9);
  assert.ok(Math.abs(actual.lat - expected.latitude * 180 / Math.PI) < 1e-9);
  assert.ok(actual.height > 6000 && actual.height <= 6900, '抬升不得超过较小取景尺度的18%');
});

test('UE keeps the displayed camera and label when jumping to a nonadjacent village', () => {
  const cameraPreset = { longitude: 109.9, latitude: 21.3, height: 25000, pitch: -64 };
  const scene = { region: { cameraPreset } };
  const stops = ['a', 'b', 'c'].map((id, index) => ({
    id, start: 10 + index * 10, end: 20 + index * 10, flightDuration: 4,
    cameraPreset: { ...cameraPreset, longitude: 109.86 + index * .07, height: 6500 }
  }));
  const from = frameAt(scene, stops, 15, 'portrait', 4.4);
  const start = frameAt(scene, stops, 30, 'portrait', 4.4, false, from);
  assert.deepEqual(start.camera, from.camera);
  assert.deepEqual(start.labels.a, from.labels.a);
  assert.equal(start.labels.b?.alpha ?? 0, 0);

  const revealing = frameAt(scene, stops, 33, 'portrait', 4.4, false, from);
  const settled = frameAt(scene, stops, 34, 'portrait', 4.4, false, from);
  assert.ok(revealing.labels.c!.scale < settled.labels.c!.scale);
  assert.ok(revealing.labels.c!.alpha < settled.labels.c!.alpha);
  assert.deepEqual(settled.camera, camera(stops[2]!.cameraPreset));

  const returned = frameAt(scene, stops, 45, 'portrait', 4.4);
  assert.equal(returned.parentLabel, 0);
  assert.ok(returned.labels.c!.alpha > 0, 'ending retains the village name');
  assert.equal(returned.labels.c!.scale, .9 * .68);
  const outro = frameAt(scene, stops, 45, 'portrait', 4.4, false, undefined, 1);
  assert.equal(outro.parentLabel, 0, 'outro overview also hides the town name');
  assert.ok(outro.labels.c!.alpha > 0);
});

test('UE opening hides every label inside the cloud and releases it when the boundary beam is halfway', () => {
  const base = { longitude: 110, latitude: 20, height: 26000, pitch: -64, heading: 0 };
  const scene = {
    region: { cameraPreset: base, openingDescent: { enabled: true, seconds: 3 } },
    context: { cameraPreset: { ...base, height: 120000 } }
  };
  const at = (time: number) => frameAt(scene, [], time, 'portrait', 4.4, true, undefined, undefined, null, true);
  const insideCloud = at(2.5);
  assert.equal(insideCloud.labelsReveal, 0);
  assert.equal(insideCloud.parentLabel, 0);
  assert.equal(insideCloud.contextReveal, 0);
  // 镇域轮廓 0.35–0.95 s 先描完；光束中点（0.65 s）过后名字才开始出现，不再等光束消失。
  const beforeHalf = at(3.5);
  assert.equal(beforeHalf.labelsReveal, 0);
  assert.equal(beforeHalf.parentLabel, 0);
  const beamSweeping = at(4.05);
  assert.ok(beamSweeping.labelsReveal > 0 && beamSweeping.labelsReveal < 1);
  assert.ok(beamSweeping.parentReveal > .5);
  assert.ok(beamSweeping.parentLabel > 0);
  const settled = at(5.6);
  assert.equal(settled.labelsReveal, 1);
  assert.ok(settled.parentLabel > .9);
});

test('village boundary stays continuous through the hand-off to the next village', () => {
 const base={longitude:110,latitude:20,height:20000,pitch:-64,heading:0};
 const scene={region:{cameraPreset:base}};
 const stops=[
  {id:'a',start:0,end:10,flightDuration:4,cameraPreset:{...base,longitude:110.04,height:6000}},
  {id:'b',start:10,end:20,flightDuration:4,cameraPreset:{...base,longitude:110.08,height:6000}}
 ];
 const at=(time:number)=>frameAt(scene,stops,time,'portrait',4.4);
 const before=at(9.9);
 assert.equal(before.current,'a');
 assert.ok((before.accents.a??0)>.9);
 assert.ok(before.trace.alpha>0,'outgoing village keeps its orbiting beam');
 const handoff=at(10);
 assert.equal(handoff.current,'b');
 assert.equal(handoff.accents.b??0,0,'incoming accent begins at zero, independent of base rim');
 assert.equal(handoff.focusId,'a','outgoing focus must remain visible even though current is b');
 assert.deepEqual(handoff.visitedIds,['a','b']);
 assert.equal(handoff.trace.alpha,0,'golden sweep waits for landing');
 const mid=at(12);
 assert.equal(mid.accents.a,.5);
 assert.equal(mid.accents.b,.5);
 assert.equal(mid.trace.alpha,0);
 assert.equal(mid.fills.a,1,'previous green fill survives the hand-off');
 const landed=at(14.2);
 assert.ok(landed.trace.alpha>0,'landing sweep starts independently of base rim');
 assert.equal(landed.fills.a,1);
 const nearBefore=at(10-1/3000),nearAfter=at(10+1/3000);
 assert.ok(Math.abs(nearBefore.accents.a!-nearAfter.accents.a!)<.001);
 assert.ok((nearAfter.accents.b??0)<.001,'no artificial accent floor');
 for (let i=0;i<120;i++) {
  const frame=at(10+i/30);
  assert.ok(frame.visitedIds.includes('a') && frame.visitedIds.includes('b'));
  assert.equal(frame.fills.a,1);
  assert.equal(frame.trace.alpha,0,'no sweep during flight');
 }
 const direct=at(12);
 at(18);at(2);
 assert.deepEqual(at(12),direct,'seeking never accumulates stale future villages');
 // Closing retires only the emphasis and sweep, not the persistent village set.
 const closing=at(20);
 assert.equal(closing.current,'');
 assert.equal(closing.trace.alpha,0);
});

test('town rim completes before the county expands, and the county retracts before the first image', () => {
  const base = { longitude: 110, latitude: 20, height: 26000, pitch: -64, heading: 0 };
  const scene = { region: { cameraPreset: base, openingDescent: { enabled: false } },
    context: { cameraPreset: { ...base, height: 120000 } } };
  const at = (time: number) => frameAt(scene, [], time, 'portrait', 4.4, true, undefined, undefined, null, true);
  // 顺序契约：镇域轮廓 0.35–0.95 s 描完，镇名落在上面并稳定展示到 2.2 s，
  // 县界 2.2 s 才开始 flood（1.5 s），回卷后回到镇域。
  assert.equal(at(0).contextReveal, 0);
  assert.equal(at(.5).contextReveal, 0, 'county must not start while the town rim is still being traced');
  assert.ok(at(.5).parentReveal > 0 && at(.5).parentReveal < 1, 'town rim is the one drawing at .5 s');
  assert.equal(at(1.5).contextReveal, 0, 'the county waits for the settled town, not just the finished rim');
  assert.ok(at(1.5).parentLabel > .5, 'the town name is up and holding during the settle');
  assert.ok(at(2.8).contextReveal > 0 && at(2.8).contextReveal < 1, 'the 1.5 s flood starts at 2.2 s');
  assert.ok(at(3.5).contextReveal > .9);
  assert.ok(at(4.2).contextReveal < 1 && at(4.2).contextReveal > 0, 'rewind has started but the county lingers');
  assert.equal(at(4.9).contextReveal, 0);
  assert.equal(at(4.9).contextOpacity, 0);
  assert.deepEqual(at(4.9).camera, at(0).camera);
  assert.ok(at(5.2).contextReveal === 0, 'county is gone well before the first image');
});

test('UE tour villages are not held back by the opening label gate', () => {
  const base = { longitude: 110, latitude: 20, height: 20000, pitch: -64, heading: 0 };
  const scene = { region: { cameraPreset: base, openingDescent: { enabled: true, seconds: 3 } } };
  const stops = [{ id: 'v', start: 10, end: 20, flightDuration: 4, cameraPreset: { ...base, height: 5000 } }];
  const settled = frameAt(scene, stops, 18, 'portrait', 4.4);
  assert.equal(settled.labelsReveal, 1);
  assert.ok((settled.labels.v?.alpha ?? 0) > .01);
});

test('UE preview and capture honor scene map views while preserving the displayed flight origin', () => {
  const preset = { longitude: 109.9, latitude: 21.3, height: 20000, heading: 0, pitch: -64 };
  const view = { longitudeOffset: .05, latitudeOffset: -.05, zoom: 2, headingOffset: 20, pitchOffset: 8 };
  const scene = { region: { cameraPreset: preset, mapViewTrack: [{ start: 0, view }, { start: 10, view: null }] } };
  const preview = frameAt(scene, [], 0, 'portrait', 4.4, false, undefined, undefined, view);
  assert.deepEqual(frameAt(scene, [], 0, 'portrait', 4.4).camera, preview.camera);
  assert.equal(preview.camera.height, 10000);
  assert.equal(preview.camera.heading, 20);
  assert.equal(preview.camera.pitch, -56);
  assert.equal(frameAt(scene, [], 11, 'portrait', 4.4).camera.height, 20000);
  const stops = [{ id: 'village', start: 10, end: 20, flightDuration: 4, cameraPreset: preset }];
  assert.deepEqual(frameAt(scene, stops, 10, 'portrait', 4.4, false, preview, undefined, view).camera, preview.camera);
});
