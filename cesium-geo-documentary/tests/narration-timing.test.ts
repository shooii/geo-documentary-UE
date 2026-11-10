import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_TOUR_RETURN_SECONDS,
  applyTourOutroPause,
  mapParagraphsToCues,
  parseSrt,
  planTourOutroPause,
  serializeSrt,
  stableNarrationTextHash
} from "../.agents/skills/cesium-geo-documentary/scripts/narration-timing.js";

const sampleCues = [
  { start: 0.1, end: 3.2, text: "intro one" },
  { start: 3.4, end: 6.1, text: "intro two" },
  { start: 6.4, end: 11.2, text: "child one" },
  { start: 11.5, end: 16.8, text: "child two" },
  { start: 17.15, end: 21.1, text: "outro one" },
  { start: 21.3, end: 24.8, text: "outro two" }
];

test("parent-child narration inserts a deterministic return pause before the outro", () => {
  const plan = planTourOutroPause(sampleCues, 2, 2, DEFAULT_TOUR_RETURN_SECONDS);
  assert.equal(plan.outroCueIndex, 4);
  assert.equal(plan.hasClosingNarration, true);
  assert.equal(plan.insertionAtSeconds, 17.15);
  assert.equal(plan.insertedSeconds, 4.4);
  assert.ok(plan.outroNarrationStartSeconds !== null);
  assert.ok(Math.abs(plan.outroNarrationStartSeconds - 21.55) < 1e-9);
  assert.ok(Math.abs(plan.returnWindowSeconds - 4.75) < 1e-9);

  const shifted = applyTourOutroPause(sampleCues, plan);
  assert.deepEqual(shifted.slice(0, 4), sampleCues.slice(0, 4));
  assert.ok(Math.abs(shifted[4]!.start - 21.55) < 1e-9);
  assert.ok(Math.abs(shifted[5]!.end - 29.2) < 1e-9);
});

test("shifted Edge subtitles serialize and parse without losing cue timing or text", () => {
  const plan = planTourOutroPause(sampleCues, 2, 2, 4.4);
  const shifted = applyTourOutroPause(sampleCues, plan);
  const reparsed = parseSrt(serializeSrt(shifted));
  assert.deepEqual(reparsed, shifted);
});

test("parent-child narration may end silently after the exact parent-camera return", () => {
  const plan = planTourOutroPause(sampleCues.slice(0, 4), 2, 2, 4.4);
  assert.equal(plan.hasClosingNarration, false);
  assert.equal(plan.insertionAtSeconds, 16.8);
  assert.equal(plan.outroNarrationStartSeconds, null);
  assert.equal(plan.returnWindowSeconds, 4.4);
  assert.deepEqual(applyTourOutroPause(sampleCues.slice(0, 4), plan), sampleCues.slice(0, 4));
});

test("small provider cue overlaps are normalized at the return boundary", () => {
  const overlapping = sampleCues.map((cue) => ({ ...cue }));
  overlapping[3]!.end = 17.2;
  const plan = planTourOutroPause(overlapping, 2, 2, 4.4);
  const shifted = applyTourOutroPause(overlapping, plan);
  assert.equal(plan.lastChildNarrationEndSeconds, 17.15);
  assert.equal(shifted[3]!.end, 17.15);
  assert.equal(shifted[4]!.start, 21.55);
});

test("paragraph-to-cue mapping keeps multi-sentence villages aligned", () => {
  // Two intro paragraphs, one two-sentence child paragraph (so it spans two
  // cues), then the outro: the outro must start at cue 5, not at cue 3 + 1.
  const cues = sampleCues;
  const paragraphs = [
    "intro one", "intro two",
    "child one child two",
    "outro one outro two"
  ];
  const mapped = mapParagraphsToCues(paragraphs, cues);
  assert.equal(mapped.length, 4);
  assert.deepEqual(mapped.map((m) => [m.startIndex, m.endIndex]), [[0, 0], [1, 1], [2, 3], [4, 5]]);
  const outro = mapped.at(-1)!;
  const plan = planTourOutroPause(cues, 2, 2, DEFAULT_TOUR_RETURN_SECONDS, outro.startIndex);
  assert.equal(plan.outroCueIndex, 4);
  assert.equal(plan.insertionAtSeconds, 17.15);
  const shifted = applyTourOutroPause(cues, plan);
  assert.ok(Math.abs(shifted[4]!.start - 21.55) < 1e-9);
});

test("paragraph-to-cue mapping ignores decorative symbols omitted by Edge TTS", () => {
  const mapped = mapParagraphsToCues(
    ["🥭 “覃斗芒果”：2005年入选国家地理标志保护产品"],
    [{ start: 0, end: 4.2, text: "覃斗芒果”：2005年入选国家地理标志保护产品" }]
  );
  assert.equal(mapped.length, 1);
  assert.deepEqual([mapped[0]!.startIndex, mapped[0]!.endIndex], [0, 0]);
});

test("narration hash is stable and changes whenever the TTS input changes", () => {
  const original = "first paragraph\n\nsecond paragraph\n";
  assert.equal(stableNarrationTextHash(original), stableNarrationTextHash(original));
  assert.notEqual(stableNarrationTextHash(original), stableNarrationTextHash(`${original}changed`));
  assert.match(stableNarrationTextHash(original), /^sha256:[a-f0-9]{64}$/);
});

test("narration and child-tour scripts keep raw TTS assets separate and expose a return action", async () => {
  const root = process.cwd();
  const [narrationSource, tourSource] = await Promise.all([
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/generate-narration.ts"), "utf8"),
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/build-child-tour.ts"), "utf8")
  ]);
  assert.match(narrationSource, /narration-source\.mp3/);
  assert.match(narrationSource, /narration-edge-source\.srt/);
  assert.match(narrationSource, /narrationTextHash/);
  assert.match(narrationSource, /buildFinalNarrationAssets/);
  assert.match(tourSource, /tour-return-parent/);
  assert.match(tourSource, /pullBackToParent/);
  assert.match(tourSource, /tourReturnWindowSeconds/);
  assert.match(tourSource, /tourReturnSilent = true/);
  assert.match(tourSource, /tourClosingNarrationPolicy = "after-exact-opening-camera-lock"/);
  assert.match(tourSource, /cameraLockTarget: "exact-opening-parent-camera"/);
  assert.match(tourSource, /narrationCueIndex/);
  // The lead lives in the shared package because the editor preview has to add the
  // same number to its timecode; the builder may only read it.
  const openingTimingSource = await readFile(resolve(root, "packages/render-spec/opening-timing.ts"), "utf8");
  assert.match(openingTimingSource, /PARENT_BOUNDARY_REVEAL_START_SECONDS = 0\.35/);
  assert.match(tourSource, /import \{ PARENT_BOUNDARY_REVEAL_START_SECONDS \} from/);
  assert.doesNotMatch(tourSource, /PARENT_BOUNDARY_REVEAL_START_SECONDS = 0\.35/);
  assert.match(tourSource, /narrationSyncOffsetSeconds = PARENT_BOUNDARY_REVEAL_START_SECONDS/);
  assert.match(tourSource, /narrationStartSeconds: openingSeconds \+ narrationSyncOffsetSeconds/);
  assert.match(tourSource, /firstCueIndex|start: cueStart \+ narrationSyncOffsetSeconds|start: cue\.start \+ narrationSyncOffsetSeconds/);
  assert.match(tourSource, /tourChildCueRanges/);
  assert.doesNotMatch(tourSource, /tourOrder must contain every direct child exactly once/);
  assert.match(tourSource, /current project's ordered subset/);
  assert.match(tourSource, /content\/storyboards\/\$\{regionId\}\.json/);
  assert.match(tourSource, /content\/visuals\/\$\{regionId\}\.json/);
});
