import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { activeSubtitleBounds, clearanceAlpha, measureSubtitleWindows, subtitleBounds } from '../apps/ue-player/subtitle-layout.js';

const bounds = { left: .3, top: .72, right: .7, bottom: .78 };
test('字幕仅在实际时间窗内占位，结束边界不残留', () => {
  const windows = [{ start: 2, end: 3, bounds }];
  assert.equal(activeSubtitleBounds(windows, 0), undefined);
  assert.deepEqual(activeSubtitleBounds(windows, 2), bounds);
  assert.equal(activeSubtitleBounds(windows, 3), undefined);
});
test('叠加字幕按当前时间合并实际矩形，无效时间不占位', () => {
  const windows = [{ start: 1, end: 3, bounds }, { start: 2, end: 4, bounds: { left: .2, top: .7, right: .8, bottom: .8 } }];
  assert.deepEqual(activeSubtitleBounds(windows, 2), { left: .2, top: .7, right: .8, bottom: .8 });
  assert.equal(activeSubtitleBounds(windows, NaN), undefined);
});

test('字幕矩形必须是有效的全画面归一化坐标', () => {
  for (const invalid of [null, {}, { ...bounds, left: -.1 }, { ...bounds, right: 2 }, { ...bounds, top: NaN }, { ...bounds, right: .2 }]) assert.equal(subtitleBounds(invalid), undefined);
  assert.deepEqual(subtitleBounds(bounds), bounds);
});
test('碰撞距离平滑淡出，倒放与随机seek不依赖历史帧', () => {
  assert.equal(clearanceAlpha(-1), 0);
  assert.equal(clearanceAlpha(0), 0);
  assert.equal(clearanceAlpha(6), .5);
  assert.equal(clearanceAlpha(12), 1);
  const times = [2, 2.1, 2.8, 3, 0, 2.1];
  const windows = [{ start: 2, end: 3, bounds }];
  const expected = times.map(t => activeSubtitleBounds(windows, t));
  assert.deepEqual([...times].reverse().map(t => activeSubtitleBounds(windows, t)).reverse(), expected);
});
test('离线读取真实DOM宽高并从最终合成时钟减去封面，不重复加入开场', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await page.setContent(`<style>body{margin:0}main{position:relative;width:1080px;height:1920px}.subtitle{position:absolute;top:1400px;left:200px}.subtitle-inner{display:inline-block;font:56px sans-serif}</style><main data-map-clock-offset="3"><div class="subtitle" data-start="10.125" data-duration="2.25"><span class="subtitle-inner">测试字幕</span></div></main>`);
    const windows = await measureSubtitleWindows(page);
    assert.equal(windows.length, 1);
    assert.equal(windows[0]!.start, 7.125);
    assert.equal(windows[0]!.end, 9.375);
    assert.ok(windows[0]!.bounds.left < 200 / 1080);
    assert.ok(windows[0]!.bounds.right > 200 / 1080 && windows[0]!.bounds.right < .9);
    assert.ok(windows[0]!.bounds.bottom > 1400 / 1920);
    assert.equal(activeSubtitleBounds(windows, 7), undefined);
    assert.deepEqual(activeSubtitleBounds(windows, 8), windows[0]!.bounds);
    assert.equal(activeSubtitleBounds(windows, 10), undefined);
  } finally { await browser.close(); }
});

test('UE全Bounds安全区和字幕检测覆盖Pinned及Animated，锚点不改位', () => {
  const source = readFileSync(new URL('../unreal/GeoDocumentary/Source/GeoDocumentary/GeoMap.cpp', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /LabelPlacements\.Contains|LabelPlacements\.Find|const double BandY = \.75/);
  const layout = source.slice(source.indexOf('    // 字幕矩形由实际排版方传入'), source.indexOf('        if (Label.PlateTexture)', source.indexOf('    // 字幕矩形由实际排版方传入')));
  assert.match(layout, /TEXT\("subtitleBounds"\)/);
  assert.match(layout, /Label\.Ink\) \* \(Label\.Animated \? \.55 : \.5\)/);
  assert.match(layout, /Label\.Anchor \+ FVector2D\(0, BaseY\)/);
  assert.match(layout, /Label\.Color\.A \*= LayoutAlpha/);
  assert.doesNotMatch(layout, /!Pinned && !Label\.Animated|CaptionY|LabelPlacements\.Contains/);
  assert.ok(layout.indexOf('if (LayoutAlpha <= 0)') < layout.indexOf('Canvas->DrawItem(Icon)'));
});
