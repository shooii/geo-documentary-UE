import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

/**
 * The editor's ▶ is a **still preview**: the map parks on the scene's
 * establishing frame, the narration and subtitles advance, and the editor steps
 * to the next scene when the audio reaches the end of that scene's measured cue
 * range.
 *
 * Continuous camera motion was built (the player grew `play-scene-range`) and
 * then reverted on the operator's request: it is the right thing for a final
 * look, but it makes the loop this editor is used for — play a scene, hear the
 * paragraph, fix the text, play again — several times slower and keeps the
 * laptop's fans on the whole time. The capability stays in runtime.js so an
 * opt-in toggle could restore it without touching the player.
 */
test("the editor previews scenes as stills, not as continuous camera motion", async () => {
  const studio = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");
  // No call site may drive the range player: one stray call would silently make
  // every preview slow again.
  assert.doesNotMatch(studio, /playSelectedSceneRange\(/);
  assert.doesNotMatch(studio, /stopSelectedSceneRange\(/);
  assert.doesNotMatch(studio, /"play-scene-range"/);
  assert.doesNotMatch(studio, /"stop-scene-playback"/);

  // What playback must still do: park the frame, then advance on the audio clock.
  const playStart = studio.indexOf("function startPlaybackFromSelected(");
  assert.ok(playStart > 0, "startPlaybackFromSelected must exist");
  const play = studio.slice(playStart);
  const body = play.slice(0, play.indexOf("function togglePlayback()"));
  assert.match(body, /previewSelectedScene\(\);/);
  assert.match(body, /playPreviewNarration\(scene, false, openingNarrationDelaySeconds\(scene\)\)/);
  assert.match(body, /schedulePlaybackAdvance\(\);/);

  // Scene transitions are driven by the narration's own clock, so a paragraph
  // that runs longer than the estimated duration is never cut off.
  assert.match(studio, /const pollAudioClock = \(\) => \{[\s\S]{0,320}audio\.currentTime \|\| 0\) \+ 0\.02 >= Number\(range\.end \|\| 0\)/);
});

test("the player still owns the range capability, unused by default", async () => {
  // Kept deliberately: removing it would mean re-deriving the presentation-time
  // offset and the flight-complete signal if the toggle ever comes back.
  const runtime = await readFile(resolve(root, "apps/cesium-player/public/runtime.js"), "utf8");
  assert.match(runtime, /function playTimelineRange\(range = \{\}\)/);
  // Presentation time plus the region's own opening descent, like the tour player.
  assert.match(runtime, /const start = Math\.max\(0, openingSeconds \+ \(Number\(range\.start\) \|\| 0\)\)/);
  // Frame-clock driven, never a timer — the runtime contract forbids setTimeout.
  assert.match(runtime, /const startedAt = performance\.now\(\);[\s\S]{0,320}previewAnimationFrame = requestAnimationFrame\(tick\)/);
  assert.doesNotMatch(runtime, /setTimeout\s*\(/);
});

/**
 * ▶ previews exactly one scene and stops; ↺ 从头 plays the whole film.
 *
 * Both used to roll on into the next scene, so auditioning a single paragraph
 * meant stop-and-reselect after every take. These two transports now mean two
 * different things, and the difference is one flag — worth pinning down.
 */
test("▶ previews one scene, ↺ 从头 plays the film", async () => {
  const [studio, html] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/public/index.html"), "utf8")
  ]);
  // Off by default: a plain ▶ must never roll into the next scene.
  assert.match(studio, /playbackContinuous: false/);
  assert.match(studio, /function startPlaybackFromSelected\(\{ continuous = false \} = \{\}\)/);
  assert.match(studio, /function togglePlayback\(\) \{ if \(state\.playTimer\) return stopPlayback\(\); startPlaybackFromSelected\(\); \}/);
  // The advance step honours the flag before touching the selection.
  assert.match(studio, /if \(!state\.playbackContinuous\) return stopPlayback\(\{ completed: true \}\);/);
  // Only ↺ 从头 asks for the whole film.
  assert.match(studio, /function playFromBeginning\(\)[\s\S]{0,300}startPlaybackFromSelected\(\{ continuous: true \}\)/);
  // Skipping to another scene mid-film keeps the film rolling.
  assert.match(studio, /if \(continuePlaying\) startPlaybackFromSelected\(\{ continuous \}\)/);
  // The transport has to say which one ▶ is.
  assert.match(studio, /只播「\$\{selectedScene\(\)\.title\}」/);
  assert.match(html, /title="播放当前场景（画面 \+ 旁白 \+ 字幕），播完停在这一场"/);
});

test("a finished preview keeps its last subtitle instead of rewinding to the first", async () => {
  const studio = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");
  // Playing to the end is not the same as pausing: pausing rewinds the caption
  // so the frame reads as "not playing yet", finishing keeps the line it ended
  // on — otherwise a completed preview looks like it never advanced.
  assert.match(studio, /function stopPlayback\(\{ completed = false \} = \{\}\)/);
  assert.match(studio, /if \(!completed\) showPreviewSubtitle\(selectedScene\(\)\);/);
});

/**
 * A mute preview must still end.
 *
 * `narration-audio` answers 404 as soon as the narration text or the voice speed
 * changes — that is the normal state between editing a paragraph and regenerating
 * the mp3. The advance step polls `audio.currentTime`, which stays 0 forever in
 * that state, so ▶ used to leave the button on Ⅱ with the preview never finishing
 * and no way forward except clicking ▶ again.
 */
test("a preview with no usable narration still ends on its estimated duration", async () => {
  const studio = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");
  const start = studio.indexOf("function schedulePlaybackAdvance()");
  assert.ok(start > 0, "schedulePlaybackAdvance must exist");
  // Slice to the next top-level function rather than a fixed character count:
  // 1800 chars truncated the tail of this function and made the assertion look
  // like a missing feature.
  const body = studio.slice(start, studio.indexOf("function startPlaybackFromSelected(", start));
  assert.match(body, /const stalled = !audio\s*\n?\s*\|\| Boolean\(audio\.error\)/);
  // Arm the fallback at the call site too — asserting only that the predicate
  // exists lets a `if (false)` disable it without the test noticing.
  assert.match(body, /if \(stalled && !muteFallbackArmed\) \{/);
  assert.match(body, /Number\(audio\.currentTime \|\| 0\) === 0 && Date\.now\(\) - startedAt >= 2500/);
  // Once armed it waits out the *remaining* estimate rather than starting a
  // fresh full-length timer, so a mute preview is not longer than a sounded one.
  assert.match(body, /const remaining = Math\.max\(800, estimatedMs - \(Date\.now\(\) - startedAt\)\);\s*\n\s*state\.playTimer = setTimeout\(advance, remaining\);/);
});
