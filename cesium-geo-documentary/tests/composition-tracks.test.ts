import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { COMPOSITION_TRACKS, musicTrack, visualTrack } from "../packages/content-engine/tracks.js";

test("composition track bands never overlap, however many visuals a project has", () => {
  // 城月镇 selected 61 visuals and its export died in the preflight with
  // "Track 80: clip ending at 511.6s overlaps with clip starting at 489.548s".
  // Nothing was wrong with the timing: visuals were `20 + index` and music beds
  // `70 + index`, so the 51st visual landed on the first music bed's track.
  const fixed = [
    COMPOSITION_TRACKS.map,
    COMPOSITION_TRACKS.shade,
    COMPOSITION_TRACKS.subtitle,
    COMPOSITION_TRACKS.narration,
    COMPOSITION_TRACKS.boundaryPen,
    COMPOSITION_TRACKS.imageryCredit
  ];
  assert.equal(new Set(fixed).size, fixed.length, "the fixed tracks must be distinct");
  for (const track of fixed) {
    assert.ok(track < COMPOSITION_TRACKS.visualBase, `fixed track ${track} must sit below the visual band`);
  }

  // Ten thousand visuals is far beyond any township, and it must still fit
  // below the music band so the two families can never meet.
  const lastVisual = visualTrack(10_000);
  assert.ok(lastVisual < COMPOSITION_TRACKS.musicBase, `visual track ${lastVisual} collides with the music band`);
  assert.ok(musicTrack(1_000) < COMPOSITION_TRACKS.cover, "music beds must sit below the cover track");

  // The concrete shapes the export actually produces.
  const combined = [
    ...fixed,
    ...Array.from({ length: 61 }, (_, index) => visualTrack(index)),
    ...Array.from({ length: 20 }, (_, index) => musicTrack(index)),
    COMPOSITION_TRACKS.cover
  ];
  assert.equal(new Set(combined).size, combined.length, "every clip family needs its own track numbers");
});

test("the compositor takes its track numbers from the shared bands", async () => {
  const source = await readFile(
    resolve(import.meta.dirname, "../.agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts"),
    "utf8"
  );
  assert.match(source, /from "\.\.\/\.\.\/\.\.\/\.\.\/packages\/content-engine\/tracks\.js"/);
  assert.match(source, /data-track-index="\$\{visualTrack\(index\)\}"/);
  assert.match(source, /data-track-index="\$\{musicTrack\(index\)\}"/);
  // The literal arithmetic is what collided; it must not come back.
  assert.doesNotMatch(source, /data-track-index="\$\{20 \+ index\}"/);
  assert.doesNotMatch(source, /data-track-index="\$\{70 \+ index\}"/);
  assert.doesNotMatch(source, /data-track-index="100"/);
});
