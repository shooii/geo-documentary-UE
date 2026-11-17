import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automaticChildCamera, boundaryCameraPoints, cameraFrustumTangents, DEFAULT_CAMERA_SAFE_FRAME, fitBoundaryCamera, isAutomaticCamera } from '../packages/geo-camera/index.js';
import { buildTourPlan } from '../packages/render-spec/tour-plan.js';
import { camera, flight } from '../apps/ue-player/presentation.js';
import { buildRenderSpec } from '../packages/render-spec/index.js';
import type { VideoProject } from '../packages/project-schema/index.js';
import { materializeProject } from '../apps/studio/render-engine.js';
import { fitRegionProfiles } from '../apps/ue-player/viewport.js';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
const preset={longitude:110,latitude:20,height:6000,heading:37,pitch:-64};
const bounds=[109.96,19.99,110.04,20.01] as const;
const points=[[109.96,19.99],[110.035,20.008],[110.04,20.01],[109.965,19.992]] as const;
test('细长斜向多块边界在三种真实画幅和非对称字幕安全区内',()=>{
 const geometry={type:'MultiPolygon',coordinates:[[[...points,points[0]]],[[[110.02,20],[110.025,20],[110.025,20.005],[110.02,20]]]]};
 const vertices=boundaryCameraPoints(geometry);
 assert.equal(vertices.length,9);
 for(const aspect of [9/16,16/9,1])for(const heading of [0,37,128]) {
  const result=fitBoundaryCamera({...preset,heading},bounds,aspect,vertices),t=cameraFrustumTangents(aspect),h=heading*Math.PI/180,p=Math.abs(result.pitch)*Math.PI/180;
  for(const [lon,lat] of vertices) {
   const east=(lon-result.longitude)*111320*Math.cos(20*Math.PI/180),north=(lat-result.latitude)*110570;
   const x=east*Math.cos(h)-north*Math.sin(h),y=north*Math.cos(h)+east*Math.sin(h),depth=result.height+y*Math.cos(p);
   const screenX=(1+x/(depth*t.horizontal))/2,screenY=(1-y*Math.sin(p)/(depth*t.vertical))/2;
   assert.ok(screenX>=DEFAULT_CAMERA_SAFE_FRAME.left-1e-6 && screenX<=DEFAULT_CAMERA_SAFE_FRAME.right+1e-6);
   assert.ok(screenY>=DEFAULT_CAMERA_SAFE_FRAME.top-1e-6 && screenY<=DEFAULT_CAMERA_SAFE_FRAME.bottom+1e-6);
  }
 }
});
test('仅自动来源相机生成三画幅，旧镜头和修改过的自动镜头保留',()=>{
 const auto=automaticChildCamera(preset,bounds,points);
 const plan=(value:typeof preset)=>buildTourPlan({scenes:[{id:'v',section:'child',childId:'v',duration:15,camera:value}]}).tourStops[0]!;
 assert.ok(isAutomaticCamera(auto));
 assert.ok(plan(auto).cameraProfiles.landscape);
 assert.ok(plan(auto).cameraProfiles.square);
 assert.equal(plan(preset).cameraProfiles.landscape,undefined);
 const custom={...auto,height:auto.height+100};
 assert.equal(isAutomaticCamera(custom),false);
 assert.equal(plan(custom).cameraProfiles.portrait.height,custom.height);
 assert.equal(plan(custom).cameraProfiles.landscape,undefined);
});
test('近距离与同点转场无固定500米抬升，端点和最短航向保持',()=>{
 const from=camera({...preset,heading:350}),same=flight(from,from,.5);
 assert.ok(Math.abs(same.height-from.height)<1e-6);
 const to=camera({...preset,longitude:110.0001,heading:10});
 const mid=flight(from,to,.5);
 assert.ok(mid.height-from.height<2);
 assert.equal(mid.heading,360);
 assert.equal(flight(from,to,0),from);assert.equal(flight(from,to,1),to);
 const small=flight(camera({...preset,height:500}),camera({...preset,height:500,longitude:110.5}),.5);
 assert.ok(small.height<=590);
});
test('非法数值与roll不传播到自动镜头；用户编辑过的来源不被区域fit覆盖',()=>{
 for(const value of [{...preset,heading:NaN},{...preset,pitch:0},{...preset,roll:12}]) {
  assert.throws(()=>fitBoundaryCamera(value,bounds));
 }
 assert.throws(()=>fitBoundaryCamera(preset,bounds,Infinity));
 assert.throws(()=>fitBoundaryCamera(preset,bounds,1,[[NaN,20]]));
 assert.throws(()=>fitBoundaryCamera(preset,[109,-90,110,20]));
 const auto=automaticChildCamera(preset,bounds,points);
 const invalid=buildTourPlan({scenes:[{id:'v',section:'child',childId:'v',duration:10,camera:{...auto,framing:{...auto.framing!,points:[[NaN,20]]}}}]});
 assert.equal(invalid.diagnostics[0]?.code,'invalid-camera');
 assert.equal(invalid.tourStops.length,0);
 const changed={...auto,height:auto.height+200};
 const geometry={type:'Polygon',coordinates:[[...points,points[0]]]};
 assert.deepEqual(fitRegionProfiles({bbox:bounds,cameraPreset:changed,cameraProfiles:{portrait:changed}},geometry).cameraProfiles.portrait,changed);
});
test('shared端点真实bundle包含浏览器可解析的相机依赖',async()=>{
 const source=await readFile(resolve('apps/studio/server.ts'),'utf8');
 const branch=source.slice(source.indexOf('if (pathname === "/shared/tour-plan.js")'),source.indexOf('const relativePath = pathname'));
 assert.match(branch,/bundle: true/);
 const bundled=await build({entryPoints:[resolve('packages/render-spec/tour-plan.ts')],bundle:true,write:false,platform:'browser',format:'esm',target:'es2022'});
 const text=bundled.outputFiles[0]!.text;
 assert.doesNotMatch(text,/from\s+["']\.\./);
 const module=await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
 const value=automaticChildCamera(preset,bounds,points);
 assert.deepEqual(module.buildTourPlan({scenes:[{id:'v',section:'child',childId:'v',duration:10,camera:value}]}),buildTourPlan({scenes:[{id:'v',section:'child',childId:'v',duration:10,camera:value}]}));
});
test('真实RenderSpec→materialize→builder保留自动来源且三画幅实际尺寸一致',async()=>{
 const root=resolve(process.cwd()),scratch=await mkdtemp(join(tmpdir(),'camera-fit-p1-')),regionId='990000002';
 try {
  await mkdir(join(scratch,'content'),{recursive:true});
  await mkdir(join(scratch,'data/regions'),{recursive:true});
  await mkdir(join(scratch,'assets/audio',regionId),{recursive:true});
  const auto=automaticChildCamera(preset,bounds,points);
  const project={id:'camera-p1',revision:1,regionId,scenes:[{id:'intro',section:'overview',type:'map-overview',narration:'总览',subtitle:'总览',duration:7},{id:'v',section:'child',type:'region-focus',childId:'v',childName:'甲村',title:'甲村',narration:'甲村',subtitle:'甲村',duration:10,camera:auto}],assets:[],template:{id:'test',openingDescentSeconds:0,tourReturnSeconds:4.4},voice:{speed:1},cover:{town:'测试镇',province:'',city:'',county:'',administrativeLabel:'测试镇',introSeconds:0},output:{profile:'landscape',width:1500,height:1000,quality:'draft'},imagery:{provider:'tianditu-imagery'}} as unknown as VideoProject;
  const cues=[{index:0,start:0,end:7,text:'总览'},{index:1,start:7,end:17,text:'甲村'}];
  const spec=buildRenderSpec({project,cues,geometrySignature:'test',parentCamera:preset});
  assert.deepEqual(spec.tourPlan.tourStops[0]!.cameraProfiles.landscape!.height,fitBoundaryCamera(auto,bounds,1.5,points).height);
  await writeFile(join(scratch,'content/regions.zh-CN.json'),JSON.stringify({[regionId]:{tourChildCueRanges:[{childId:'v',cueStartIndex:1,cueEndIndex:1}]}}));
  await writeFile(join(scratch,'data/regions',`${regionId}.json`),JSON.stringify({cameraPreset:preset,childIds:['v'],childRegions:[{id:'v',name:'甲村',bbox:bounds,cameraPreset:preset}]}));
  await materializeProject(scratch,project,spec);
  const record=JSON.parse(await readFile(join(scratch,'data/regions',`${regionId}.json`),'utf8'));
  assert.deepEqual(record.childRegions[0].cameraPreset.framing,auto.framing);
  await writeFile(join(scratch,'assets/audio',regionId,'narration-edge.srt'),'1\n00:00:00,000 --> 00:00:07,000\n总览\n\n2\n00:00:07,000 --> 00:00:17,000\n甲村\n');
  await writeFile(join(scratch,'assets/audio',regionId,'duration.json'),JSON.stringify({durationSeconds:21.4,outroPause:{applied:true,mode:'parent-child-tour',hasClosingNarration:false,insertedSeconds:4.4,returnWindowSeconds:4.4}}));
  execFileSync(process.execPath,[join(root,'node_modules/tsx/dist/cli.mjs'),join(root,'.agents/skills/cesium-geo-documentary/scripts/build-child-tour.ts'),'--region',regionId],{cwd:scratch,stdio:'pipe'});
  const exported=JSON.parse(await readFile(join(scratch,'data/regions',`${regionId}.json`),'utf8')).tourStops[0];
  const expected=spec.tourPlan.tourStops[0]!;
  for(const key of ['start','end','flightDuration','visualReadySeconds','groundDistanceMeters','cameraPreset','cameraProfiles'] as const)assert.deepEqual(exported[key],expected[key]);
  for(const profile of ['portrait','landscape','square'] as const)assert.ok(isAutomaticCamera(exported.cameraProfiles[profile]));
 } finally {await rm(scratch,{recursive:true,force:true});}
});
