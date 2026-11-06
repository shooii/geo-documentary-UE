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
  assert.equal(actual.height, 8800);
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
  assert.equal(returned.labels.c!.scale, .9 * .68);
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
