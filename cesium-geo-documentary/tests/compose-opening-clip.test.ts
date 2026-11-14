import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { transformSync } from "esbuild";
import { chromium } from "playwright";
import { measureSubtitleWindows, subtitleBounds } from "../apps/ue-player/subtitle-layout.js";

const root = resolve(import.meta.dirname, "..");
const source = await readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts"), "utf8");
function extract(name: string, next: string): string {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(next, start);
  assert.ok(start >= 0 && end > start);
  return transformSync(source.slice(start, end), { loader: "ts" }).code;
}
const clip = new Function(`${extract("openingClipHtml", "function captionStamp(")}; return openingClipHtml;`)() as (html: string, seconds: number) => string;
const parse = new Function(`${extract("parseOpeningClipSeconds", "const openingClipSeconds =")}; return parseOpeningClipSeconds;`)() as (args: string[]) => number | undefined;

const fixture = `<style>.subtitle{position:absolute;top:100px;left:20px}.subtitle-inner{display:inline-block;font-size:18px}</style><main id="root" data-map-clock-offset="1.600" style="width:320px;height:240px;position:relative" data-composition-id="test" data-start="0" data-duration="80.000" data-width="320" data-height="240">
<video id="map" class="clip map" src="map.mp4" data-start="1.600" data-duration="78.400" data-track-index="0"></video>
<div id="shade" class="clip shade" data-start="1.600" data-duration="78.400"></div>
<figure id="visual-0" class="clip visual" data-start="8.000" data-duration="12.000"><img id="visual-main-0"></figure>
<div id="caption-0" class="clip subtitle" data-active-end="12.000" data-start="9.000" data-duration="3.000"><span id="caption-inner-0" class="subtitle-inner">字幕</span></div>
<div id="caption-1" class="clip subtitle" data-start="10.000" data-duration="3.000"><span id="caption-inner-1" class="subtitle-inner">未来字幕</span></div>
<audio id="narration-audio" class="clip" src="narration.wav" data-start="4.000" data-duration="70.000"></audio>
<audio id="music-bed-1" class="clip" src="music.wav" data-start="47.600" data-duration="32.400"></audio>
<figure id="visual-1" class="clip visual"><video id="visual-main-1" class="clip visual-main" src="future.mp4" data-start="35.000" data-duration="10.000"></video><figcaption id="visual-caption-1">未来视频</figcaption></figure>
<figure id="visual-2" class="clip visual" data-start="30.000" data-duration="10.000"><img id="visual-main-2"></figure>
<img id="cover" class="clip cover" data-start="0" data-duration="1.600">
</main>
<script>
const tl=gsap.timeline({paused:true});
gsap.set([".visual", ".subtitle"],{opacity:0});
tl.fromTo("#cover",{opacity:1},{opacity:0,duration:.35},1.25);
tl.fromTo("#visual-0",{opacity:0,scale:.94},{opacity:1,scale:1,duration:.85},8).to("#visual-0",{opacity:0,duration:.35},19.65);
tl.fromTo("#visual-main-0",{scale:1},{scale:1.07,duration:12,ease:"none"},8);
tl.fromTo("#caption-inner-0",{opacity:0},{opacity:1,duration:.08},9).to("#caption-inner-0",{opacity:0,duration:.08},11.9);
tl.fromTo("#caption-inner-1",{opacity:0},{opacity:1,duration:.08},10);
tl.to("#visual-main-1",{scale:1.07,duration:10},35);
tl.to("#visual-main-2",{scale:1.07,duration:10},30);
window.__timelines={test:tl};
</script></body>`;

function tag(html: string, id: string): string {
  const match = html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`));
  assert.ok(match, `${id} 必须保留，GSAP 仍可找到目标`);
  return match[0];
}

test("开头片段参数只接受 1-60 秒，默认不启用", () => {
  assert.equal(parse([]), undefined);
  for (const value of ["1", "10", "60", "8.4"]) assert.equal(parse(["--opening-clip-seconds", value]), Number(value));
  for (const value of [undefined, "0", "61", "NaN", "Infinity", "--profile", ""]) {
    assert.throws(() => parse(value === undefined ? ["--opening-clip-seconds"] : ["--opening-clip-seconds", value]), /1-60/);
  }
});

test("正常无参数仍直接输出完整 HTML，片段报告不宣称完成全片验证", () => {
  assert.match(source, /const html = openingClipSeconds === undefined \? fullHtml : openingClipHtml\(fullHtml, compositionDuration\)/);
  assert.match(source, /const fullCompositionDuration = timelineData\.duration \+ cover\.introSeconds/);
  assert.match(source, /fullCompositionDuration, openingClipSeconds, exportScope: "opening-clip"/);
  assert.match(source, /validationScope: "opening-clip-timing-only"/);
  assert.match(source, /fullFilmValidated: false/);
  assert.match(source, /clipDisplaySeconds > 0 \? staysInsideScene : null/);
  assert.match(source, /filter\(\(cue\) => openingClipSeconds === undefined \|\| cue\.start < openingClipSeconds\)/);
});

test("10 秒元数据精确裁剪，地图仅占封面后的 8.4 秒，未来媒体不进入轨道", () => {
  const html = clip(fixture, 10);
  assert.match(tag(html, "root"), /data-duration="10.000"/);
  for (const id of ["map", "shade"]) assert.match(tag(html, id), /data-duration="8.400"/);
  assert.match(tag(html, "narration-audio"), /data-duration="6.000"/);
  assert.match(tag(html, "visual-0"), /data-duration="2.000"/);
  assert.match(tag(html, "caption-0"), /data-duration="1.000"/);
  assert.match(tag(html, "caption-0"), /data-active-end="10.000"/);
  for (const id of ["caption-1", "visual-1", "visual-2", "visual-main-1", "music-bed-1"]) {
    assert.doesNotMatch(tag(html, id), /data-(?:start|duration|track-index)=|class="clip(?: |")|<(?:audio|video)\b/);
  }
  const originalScript = fixture.slice(fixture.indexOf("<script>"), fixture.indexOf("</script>") + "</script>".length);
  assert.ok(html.includes(originalScript), "原动画脚本必须逐字保留");
  assert.match(html, /openingTimeline\.fromTo\(fullTimeline,\{time:0\},\{time:10\.000,duration:10\.000,ease:"none"/);
  assert.doesNotMatch(html.slice(html.lastIndexOf("<script>")), /opacity|fade|timeScale/);
});

test("短于封面的片段保留原封面退场时刻，地图和旁白不进入轨道", () => {
  const html = clip(fixture, 1);
  assert.match(tag(html, "cover"), /data-duration="1.000"/);
  assert.doesNotMatch(tag(html, "map"), /data-start|<video/);
  assert.doesNotMatch(tag(html, "narration-audio"), /data-start|<audio/);
  assert.match(html, /duration:.35\},1.25/);
});

test("实测片段时钟保持 GSAP 前段样式，HyperFrames 总时长不再被完整动画延长", async (t) => {
  const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", chromium.executablePath()].find((path) => path && existsSync(path));
  if (!executablePath) return t.skip("未安装可用浏览器");
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const gsap = await readFile(resolve(root, "node_modules/gsap/dist/gsap.min.js"), "utf8");
    const warnings: string[] = [];
    const samples: unknown[][] = [];
    for (const html of [fixture, clip(fixture, 10)]) {
      const page = await browser.newPage();
      page.on("console", (message) => { if (/target.*not found/i.test(message.text())) warnings.push(message.text()); });
      await page.route("**/*", (route) => route.abort());
      await page.setContent(`<script>${gsap}</script>${html}`);
      const values = [];
      for (const time of [0, 1.25, 1.5, 8, 8.4, 9, 9.5, 9.9666667]) {
        values.push(await page.evaluate((seconds) => {
          (window as any).__timelines.test.seek(seconds, false);
          return ["cover", "visual-0", "visual-main-0", "caption-inner-0"].map((id) => {
            const style = getComputedStyle(document.getElementById(id)!);
            return { id, opacity: style.opacity, transform: style.transform };
          });
        }, time));
      }
      samples.push(values);
      const windows = await measureSubtitleWindows(page);
      assert.equal(windows.length, html === fixture ? 2 : 1, "未来 untimed 字幕不得进入真实布局测量");
      assert.equal(windows[0]!.start, 9 - 1.6, "保留原合成时钟到地图时钟偏移");
      assert.equal(windows[0]!.end, (html === fixture ? 12 : 10) - 1.6);
      assert.ok(windows.every((window) => subtitleBounds(window.bounds)), "字幕真实矩形必须有限且非空");
      await page.close();
    }
    assert.deepEqual(samples[1], samples[0]);
    assert.deepEqual(warnings, []);

    const require = createRequire(import.meta.url);
    const runtime = resolve(dirname(require.resolve("hyperframes/package.json")), "dist/hyperframe.runtime.iife.js");
    const page = await browser.newPage();
    await page.setContent(`<script>${gsap}</script>${clip(fixture, 10)}`);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.evaluate(() => { (window as any).__name = (fn: unknown) => fn; });
    await page.addScriptTag({ path: runtime });
    await page.waitForFunction(() => (window as any).__renderReady && (window as any).__player?.getDuration() > 0, undefined, { timeout: 10000 }).catch(async (error) => {
      throw new Error(`${error.message}; runtime=${JSON.stringify(await page.evaluate(() => ({ hf: Object.keys((window as any).__hf ?? {}), duration: (window as any).__hf?.duration, ready: (window as any).__renderReady })))}; errors=${errors.join(" | ")}`);
    });
    assert.equal(await page.evaluate(() => (window as any).__timelines.test.duration()), 10);
    assert.equal(await page.evaluate(() => (window as any).__player.getDuration()), 10);
  } finally {
    await browser.close();
  }
});
