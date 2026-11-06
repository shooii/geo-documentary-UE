import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// 一次真实事故：给场景绑了视频素材后导出，预检报
//   `<video> with data-start is nested inside <figure id="visual-15"> …`
// 但预检只在地图录完之后才能跑（composition 依赖录好的 map mp4），
// 所以一个 lint 错误先烧掉约 40 分钟的录制才被拦下（2026-10-10）。
//
// 现在录制之前多一道「预演合成 + 预检」：地图槽位用黑色占位视频，其余输入
// （旁白、时长、时间轴、字幕、素材、封面）在录制前就绪，所以整段检查可以提前跑。
// 录制之后那道预检保留，它才是拿真地图做权威判断的那一次。
const root = process.cwd();

test("the composition is linted before the map is recorded, and again after it", async () => {
  const [engine, compositor] = await Promise.all([
    readFile(resolve(root, "apps/studio/render-engine.ts"), "utf8"),
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts"), "utf8")
  ]);

  // 1. 录制前的预检：合成（带 --map-fallback）紧接着一次预检，且都在录制之前。
  assert.match(engine, /"--map-fallback"/);
  assert.match(engine, /stage: "录制前预检成片"/);
  assert.match(engine, /stopMessage: "已在地图录制前中止，省下了整段录制时间。"/);
  const earlyCompose = engine.indexOf('"--map-fallback"');
  const cacheLookup = engine.indexOf("await cacheMap(root, sandbox, project, spec)");
  const capture = engine.indexOf('await runTsx("apps/ue-player/capture.ts"');
  assert.ok(earlyCompose > 0 && cacheLookup > 0 && capture > 0, "the three pipeline anchors must exist");
  assert.ok(earlyCompose < cacheLookup, "预演合成必须在取地图缓存之前");
  assert.ok(cacheLookup < capture, "录制前的预检必须在录制之前");
  // 预检失败时要在录制前抛错，而不是继续往下走。
  const earlyPreflight = engine.indexOf("await preflightComposition(sandbox, callbacks", earlyCompose);
  assert.ok(earlyPreflight > earlyCompose && earlyPreflight < capture, "录制前必须真的跑一次 preflightComposition");

  // 2. 录制之后仍保留权威预检（这次用的是真地图）。
  assert.match(engine, /stopMessage: "已在编码前中止，未浪费编码时间。"/);
  const latePreflight = engine.lastIndexOf("await preflightComposition(sandbox, callbacks");
  assert.ok(latePreflight > capture, "编码前那道预检不能因为有了提前版就删掉");

  // 3. 合成脚本只在显式要求时容忍缺地图，并且占位视频写在 media 槽位里
  //    （绝不能落进 renders/intermediate，那是地图缓存与录制的产物路径）。
  assert.match(compositor, /const mapFallbackAllowed = args\.includes\("--map-fallback"\);/);
  assert.match(compositor, /if \(!mapRecorded && !mapFallbackAllowed\) throw new Error\(`Missing map video \$\{mapSource\}; run capture first`\);/);
  assert.match(compositor, /async function writeMapFallbackStub\(target: string, profile: RenderProfile, durationSeconds: number\)/);
  assert.match(compositor, /await writeMapFallbackStub\(mapTarget, profile, timelineData\.duration\);/);
  assert.match(compositor, /process\.stdout\.write\(`MAP_STUB_USED \$\{mapTarget\}\\n`\);/);
  assert.match(compositor, /const mapTarget = resolve\(mediaDir, `maps\/\$\{id\}-map-\$\{profileName\}\.mp4`\);/);
});
