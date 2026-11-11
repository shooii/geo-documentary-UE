import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('closing keeps all visited fills but no more than six representative village names', () => {
  const pose = {longitude: 110, latitude: 22, height: 10000, heading: 0, pitch: -64};
  const scene = {region: {cameraPreset: pose, openingDescent: {enabled: false}}};
  const stops = Array.from({length: 24}, (_, id) => ({id: String(id), start: id * 10, end: (id + 1) * 10,
    flightDuration: 3.2, cameraPreset: {...pose, longitude: 110 + id * .001, height: 1000}}));
  const end = frameAt(scene, stops, 250, 'portrait', 4.4);
  assert.equal(Object.keys(end.fills).length, 24);
  assert.equal(end.visitedIds.length, 24);
  assert.equal(Object.values(end.labels).filter(style => style.alpha > .01).length, 6);
  assert.ok(end.parentLabel > .9);
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
