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

test('结尾总览不再把非代表村压成半亮灰字', () => {
  const source = readFileSync(new URL('../apps/ue-player/presentation.ts', import.meta.url), 'utf8');
  assert.match(source, /const closingShot = returnProgress !== null \|\| overviewProgress !== undefined/);
  assert.match(source, /if \(closingShot\) \{\s*label\.alpha = label\.alpha > \.01 \? \.88 : 0;/);
  assert.match(source, /else if \(id !== current && !representatives\.has\(id\)\)/);
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
