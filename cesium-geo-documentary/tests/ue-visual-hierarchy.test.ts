import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { visualHierarchy, overviewRepresentatives } from '../apps/ue-player/visual-hierarchy.js';
import { frameAt } from '../apps/ue-player/presentation.js';

test('wide views reduce green, internal width and glow without erasing the map', () => {
  const near = visualHierarchy(1000, 10000, 0), far = visualHierarchy(9000, 10000, 1);
  assert.equal(near.fillScale, .8);
  assert.equal(far.fillScale, .65);
  assert.ok(far.interiorAlpha < near.interiorAlpha);
  assert.ok(far.interiorWidth < near.interiorWidth);
  assert.ok(far.interiorGlow < near.interiorGlow);
  assert.ok(far.interiorAlpha > .4);
  assert.equal(far.labelMix, 1);
});

test('representative labels are stable, geographically spread and profile bounded', () => {
  const stops = Array.from({length: 24}, (_, id) => ({id, cameraPreset: {lon: 110 + id * .01, lat: 22}}));
  const chosen = overviewRepresentatives(stops, 'portrait');
  assert.equal(chosen.size, 6);
  assert.ok(chosen.has('0'));
  assert.ok(chosen.has('23'));
  assert.deepEqual([...chosen], [...overviewRepresentatives(stops, 'portrait')]);
  assert.equal(overviewRepresentatives(stops, 'landscape').size, 8);
  assert.equal(overviewRepresentatives(stops.slice(0, 3), 'portrait').size, 3);
});

test('closing keeps every village label and retires the town name', () => {
  const pose = {longitude: 110, latitude: 22, height: 10000, heading: 0, pitch: -64};
  const scene = {region: {cameraPreset: pose, openingDescent: {enabled: false}}};
  const stops = Array.from({length: 24}, (_, id) => ({id: String(id), start: id * 10, end: (id + 1) * 10,
    flightDuration: 3.2, cameraPreset: {...pose, longitude: 110 + id * .001, height: 1000}}));
  const end = frameAt(scene, stops, 250, 'portrait', 4.4);
  assert.equal(Object.keys(end.fills).length, 24);
  assert.equal(end.visitedIds.length, 24);
  assert.equal(Object.values(end.labels).filter(style => style.alpha > .01).length, stops.length);
  // 收尾总览只要行政村名字：乡镇大字在这里会让 24 个村名挤成一团。
  assert.equal(end.parentLabel, 0);
  assert.equal(end.current, '');
  const direct = frameAt(scene, stops, 250, 'portrait', 4.4);
  frameAt(scene, stops, 80, 'portrait', 4.4);
  assert.deepEqual(frameAt(scene, stops, 250, 'portrait', 4.4), direct);
});

test('current village remains named even when absent from the overview representatives', () => {
  const pose = {longitude: 110, latitude: 22, height: 10000, heading: 0, pitch: -64};
  const scene = {region: {cameraPreset: pose, openingDescent: {enabled: false}}};
  const stops = Array.from({length: 24}, (_, id) => ({id: String(id), start: id * 10, end: (id + 1) * 10,
    flightDuration: 3.2, cameraPreset: {...pose, longitude: 110 + id * .001}}));
  const frame = frameAt(scene, stops, 35, 'portrait', 4.4);
  assert.equal(frame.current, '3');
  assert.ok(frame.labels['3']!.alpha > .5);
});

test('村名在飞行、宽景、预览切换和两条返航链路中只会全亮或隐藏', () => {
  const pose = {lon: 110, lat: 22, height: 10000, heading: 0, pitch: -64};
  const scene = {region: {cameraPreset: pose, openingDescent: {enabled: false}}};
  const stops = Array.from({length: 9}, (_, id) => ({id: String(id), start: id * 10,
    end: (id + 1) * 10, flightDuration: 4, cameraPreset: {...pose, lon: 110 + id * .003}}));
  const origin = frameAt(scene, stops, 75, 'portrait', 4.4);
  assert.equal(origin.labels['7']?.alpha, 1);
  for (const profile of ['portrait', 'landscape']) {
    for (let time = 0; time <= 96; time += .125) {
      for (const frame of [frameAt(scene, stops, time, profile, 4.4), frameAt(scene, stops, time, profile, 4.4, false, origin)]) {
        assert.ok(Object.values(frame.labels).every(({alpha}) => alpha === 0 || alpha === 1), `${profile} ${time}`);
      }
    }
    for (const progress of [0, .1, .3, .5, .9, 1]) {
      const frame = frameAt(scene, stops, 90, profile, 4.4, false, origin, progress);
      assert.ok(Object.values(frame.labels).every(({alpha}) => alpha === 0 || alpha === 1));
      assert.equal(frame.current, '');
    }
    assert.deepEqual(frameAt(scene, stops, 15, profile, 4.4, true, origin, .1).labels, {});
  }
});

test('UE 村名字色、名牌和避让不再施加透明度', () => {
  const source = readFileSync(new URL('../unreal/GeoDocumentary/Source/GeoDocumentary/GeoMap.cpp', import.meta.url), 'utf8');
  assert.match(source, /LabelsReveal > \.05 \? 1\.f : 0\.f/);
  assert.match(source, /FLinearColor::White\.CopyWithNewOpacity\(Opacity\)/);
  assert.match(source, /if \(Clearance <= 0\)\s*continue;[^]*?if \(Label\.Animated\)\s*Label\.Color\.A \*= ClearanceAlpha/);
  assert.match(source, /FCanvasTileItem Plate[^]*?FLinearColor\(1, 1, 1, 1\.f\)/);
  assert.doesNotMatch(source, /FadingPlateId|PlateFade/);
});

test('村域色块等镜头落稳后才渐入，飞行途中保持干净', () => {
  const pose = {longitude: 110, latitude: 22, height: 10000, heading: 0, pitch: -64};
  const scene = {region: {cameraPreset: pose, openingDescent: {enabled: false}}};
  const stops = [
    {id: 'a', start: 10, end: 20, flightDuration: 4, cameraPreset: {...pose, longitude: 110.01}},
    {id: 'b', start: 20, end: 30, flightDuration: 4, cameraPreset: {...pose, longitude: 110.02}}
  ];
  // 第一村飞行中(10–14s)：没有色块；名牌/ICON 在 12.2s 起浮出。
  assert.equal(frameAt(scene, stops, 11, 'portrait', 4.4).fills['a'], undefined);
  assert.equal(frameAt(scene, stops, 13, 'portrait', 4.4).fills['a'], undefined);
  const landed = frameAt(scene, stops, 14.3, 'portrait', 4.4);
  assert.ok((landed.fills['a'] ?? 0) > 0 && (landed.fills['a'] ?? 0) < .3);
  const held = frameAt(scene, stops, 16, 'portrait', 4.4);
  assert.equal(held.fills['a'], 1);
  // 第二村飞行中：新村的色块不抢跑，旧村保持已上色。
  const next = frameAt(scene, stops, 22, 'portrait', 4.4);
  assert.equal(next.fills['b'], undefined);
  assert.equal(next.fills['a'], 1);
  assert.equal(frameAt(scene, stops, 26, 'portrait', 4.4).fills['b'], 1);
});
