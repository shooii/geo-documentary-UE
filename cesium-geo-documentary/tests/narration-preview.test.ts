import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

/**
 * The Studio can synthesise narration on demand so the preview has sound after
 * an edit — the alternative was "export for 1h50m to hear your new paragraph".
 *
 * The risk this file guards is contamination, not functionality: narration
 * generation also writes captions, and both assets/audio/<region>/ and
 * apps/video-compositor/captions/ are what `makeProject()` reads to measure the
 * CONTENT baseline. An SRT cut from a project's edited narration cannot map onto
 * the content file's paragraphs, so leaving one there makes every later project
 * read fail with "无法按文本稳定映射场景". That is exactly what happened while
 * building this: the project became unreadable until the files were deleted.
 */
test("the narration preview cannot write into the content pipeline directories", async () => {
  const [server, narration, subtitles] = await Promise.all([
    readFile(resolve(root, "apps/studio/server.ts"), "utf8"),
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/generate-narration.ts"), "utf8"),
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/generate-subtitles.py"), "utf8")
  ]);
  // The route must redirect both artefacts: audio via --out-dir, captions via
  // the same directory, and read its narration from a throwaway content file.
  assert.match(server, /"--content", contentPath, "--out-dir", audioOut, "--force"/);
  assert.match(narration, /const audioDir = outDirOverride \?\? resolve\(root, `assets\/audio\/\$\{id\}`\)/);
  assert.match(narration, /outDirOverride \? \["--captions-dir", outDirOverride\] : \[\]/);
  // generate-subtitles defaults must stay exactly where they were.
  assert.match(subtitles, /output_dir = Path\(args\.captions_dir\) if args\.captions_dir else PROJECT_ROOT \/ "apps" \/ "video-compositor" \/ "captions"/);
  assert.match(subtitles, /source = Path\(args\.narration_srt\) if args\.narration_srt else PROJECT_ROOT \/ "assets" \/ "audio" \/ args\.region \/ "narration-edge\.srt"/);
});

test("a stale narration says so, instead of claiming nothing was ever generated", async () => {
  const [server, studio] = await Promise.all([
    readFile(resolve(root, "apps/studio/server.ts"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8")
  ]);
  // Two different situations, two different messages — the second one used to
  // read "尚未生成可预览的旁白" even though the audio existed and was merely
  // describing older text.
  assert.match(server, /旁白文案或语速改过了，现有旁白音频与当前文案对不上，预览暂时没有声音/);
  assert.match(server, /stale: generated/);
  assert.match(server, /hasAnyNarrationAudio/);
  // A 2.4s toast was the whole feedback before; the transport now keeps a
  // standing notice with the one action that fixes it.
  assert.match(studio, /function renderNarrationNotice\(\)/);
  assert.match(studio, /id="generatePreviewNarration"/);
  assert.match(studio, /state\.narrationNotice = \{[\s\S]{0,220}stale: \/改过了\/\.test\(message\)/);
  // The served preview only counts while its signature still matches the film.
  assert.match(server, /const previewUsable = existsSync\(previewAudio\)[\s\S]{0,200}trim\(\) === currentSignature/);
});

/**
 * Subtitles and scene windows have to be built from the cue sheet measured
 * against the audio the preview actually plays.
 *
 * When a region has no canonical SRT, `buildProjectRenderSpec()` falls back to
 * `estimatedProjectCues()` — narration length / 4.1 characters per second. Real
 * Edge TTS runs at 4.96, so on 城月镇 (37 scenes) the estimate totals 629 s
 * against a 523 s soundtrack, and the error accumulates: by the middle of the
 * film the caption shown belonged to a scene the voice had not reached yet. The
 * measurements were already on disk — every export keeps `audio/narration.mp3`
 * plus the `audio/narration-edge.srt` cut from it — so the fix is to pair them
 * instead of guessing.
 */
test("the editor's timings come from the cue sheet measured against the served audio", async () => {
  const server = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");

  // A compatible job only counts when its cue sheet survived next to the audio.
  assert.match(server, /const srtPath = join\(job\.jobRoot, "audio", "narration-edge\.srt"\)/);
  assert.match(server, /if \(entry\.signature !== signature \|\| !entry\.srtPath\) continue;/);
  // The preview mp3 is only usable together with its own SRT and a live signature.
  assert.match(server, /const previewUsable = existsSync\(previewAudio\) && existsSync\(previewSrt\) && existsSync\(previewSignature\)/);
  // The spec route — not just the audio route — has to consume the pairing.
  assert.match(server, /const measuredCues = await resolveMeasuredProjectCues\(project\);/);
  assert.match(server, /buildProjectRenderSpec\(root, project, measuredCues \?\? undefined\)/);
  // A saved scene reorder legitimately breaks the text mapping; the estimator is
  // still the documented fallback and must not turn into a 500.
  assert.match(server, /if \(!measuredCues\) throw error;\s*narrationTimingSource = "estimated";\s*spec = await buildProjectRenderSpec\(root, project\);/);
  assert.match(server, /let narrationTimingSource: "measured" \| "estimated" = measuredCues \? "measured" : "estimated"/);
  assert.match(server, /projectRevision: project\.revision, narrationTimingSource,/);
  // Reading every job snapshot per poll would be far too slow; the scan is
  // memoised per region and expires, so a finished export is still picked up.
  assert.match(server, /const NARRATION_JOB_INDEX_TTL_MS = 60_000/);
  assert.match(server, /\.filter\(\(item\) => item\.regionId === regionId\)/);
  assert.match(server, /const cached = narrationJobIndexes\.get\(regionId\);\s*if \(cached && Date\.now\(\) - cached\.at < NARRATION_JOB_INDEX_TTL_MS\) return cached\.entries;/);
});

test("a freshly synthesised preview keeps the cue sheet that describes it", async () => {
  const server = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");
  // Both artefacts travel together, or the preview is back to the estimator.
  assert.match(server, /const producedSrt = join\(audioOut, "narration-edge\.srt"\);/);
  assert.match(server, /if \(!existsSync\(producedSrt\)\) throw new Error\("旁白生成结束但没有找到 narration-edge\.srt"\);/);
  assert.match(server, /await copyFileResilient\(producedSrt, narrationPreviewSrtPath\(project\.id, project\.regionId\)\);/);
  assert.match(server, /function narrationPreviewSrtPath\(projectId: string, regionId: string\): string \{\s*return join\(root, "workspace", "narration-preview", `\$\{projectId\}-\$\{regionId\}\.srt`\);/);
  // Still outside the content-pipeline directories (see the first test here).
  assert.doesNotMatch(server, /copyFileResilient\(producedSrt, join\(root, "assets", "audio"/);
});
