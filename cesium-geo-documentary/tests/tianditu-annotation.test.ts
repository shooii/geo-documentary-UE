import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildRenderSpec } from "../packages/render-spec/index.js";
import { validateVideoProject } from "../packages/project-schema/index.js";
import { makeProject, readCanonicalCues } from "../apps/studio/project-service.js";

const root = resolve(process.cwd());

test("Tianditu imagery and per-scene annotation survive project validation", async () => {
  const project = await makeProject(root, "440825112");
  project.imagery.provider = "tianditu-imagery";
  const scene = project.scenes.find((item) => item.section === "child");
  assert.ok(scene, "the fixture needs a child scene");
  scene.imageryAnnotation = true;
  validateVideoProject(project);

  const invalid = structuredClone(project);
  (invalid.scenes[0] as { imageryAnnotation?: unknown }).imageryAnnotation = "yes";
  assert.throws(() => validateVideoProject(invalid), /must be a boolean/);
});

test("annotation windows are scene-scoped and invalidate the map cache", async () => {
  const project = await makeProject(root, "440825112");
  const cues = await readCanonicalCues(root, project.regionId);
  const before = buildRenderSpec({ project, cues, geometrySignature: "annotation-test", generatedAt: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(before.annotationWindows, []);

  const scene = project.scenes.find((item) => item.section === "child");
  assert.ok(scene, "the fixture needs a child scene");
  scene.imageryAnnotation = true;
  const after = buildRenderSpec({ project, cues, geometrySignature: "annotation-test", generatedAt: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(after.annotationWindows.map((window) => window.sceneId), [scene.id]);
  assert.notEqual(after.cacheSignature, before.cacheSignature);
  assert.equal(after.scenes.find((item) => item.sceneId === scene.id)?.imageryAnnotation, true);
});

test("Studio and render engine expose the per-scene Tianditu label workflow", async () => {
  const [studioHtml, runtime, engine] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/index.html"), "utf8"),
    readFile(resolve(root, "apps/cesium-player/public/runtime.js"), "utf8"),
    readFile(resolve(root, "apps/studio/render-engine.ts"), "utf8")
  ]);
  assert.match(studioHtml, /value="tianditu-imagery"/);
  assert.match(studioHtml, /id="sceneImageryAnnotation"/);
  assert.match(runtime, /tiandituLayerProvider\("img", runtimeConfig\.tiandituToken\)/);
  assert.match(runtime, /tiandituLayerProvider\("cia", runtimeConfig\.tiandituToken, ANNOTATION_TILE_PX\)/);
  assert.match(runtime, /function updateAnnotationVisibility\(time\)/);
  // Studio preview must not wipe the windows the editor posted before the
  // region fetch finished; export still reads the frozen ones.
  assert.match(runtime, /applyAnnotationWindows\(query\.has\("studioPreview"\) \? annotationWindows : region\.annotationWindows\)/);
  assert.match(engine, /region\.annotationWindows = spec\.annotationWindows/);
});

// The export has to prove it recorded the labels, not just that the toggle was
// on. A window mismatch or a throttled tile stream used to ship a map video with
// silently missing labels.
test("the capture proves it recorded the labels instead of trusting the toggle", async () => {
  const [capture, runtime] = await Promise.all([
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/capture-frames.ts"), "utf8"),
    readFile(resolve(root, "apps/cesium-player/public/runtime.js"), "utf8")
  ]);
  // The capture counts the frames the windows cover and the frames the player
  // actually had the layer on for, and refuses to encode a map video when the
  // two disagree completely. Before this, a project could ship with its label
  // scenes silently unlabelled.
  assert.match(capture, /annotationWindows = Array\.isArray\(regionRecord\.annotationWindows\)/);
  // The tally has to be per anchor: a still stretch re-uses one PNG, so reading
  // `annotationVisible` only where a screenshot is taken reports 0 for every
  // frame of a window that falls inside a still stretch.
  assert.match(capture, /const annotationByKey = new Map<string, boolean>\(\)/);
  assert.match(capture, /annotationByKey\.set\(staticKey \?\? `f\$\{frame\}`, Boolean\(readyState\.annotationVisible\)\)/);
  assert.match(capture, /if \(annotationByKey\.get\(key\) === true\) annotationFrames \+= 1;/);
  assert.match(capture, /if \(annotationFrameBudget > 0 && annotationFrames === 0\)/);
  assert.match(capture, /framesWithLabels: annotationFrames/);
  // A label window changes the picture without moving the camera, so the still
  // anchor has to move to the window's first frame — otherwise the whole window
  // plays the label-free frame captured before it opened.
  assert.match(capture, /const staticAnchorForKey = \(time: number\): number \| null =>/);
  assert.match(capture, /return Math\.max\(anchor, Math\.ceil\(windowStart \* fps - 1e-6\) \/ fps\)/);
  // 天地图 throttles per key: a 30 fps export adds a second tile stream and a
  // measured run had a quarter of the label tiles rejected with 429. Cesium does
  // not re-ask for a failed tile, so the retry has to live in the provider.
  assert.match(runtime, /function withRetry\(provider, label\)/);
  assert.match(runtime, /withRetry\(new Cesium\.UrlTemplateImageryProvider\(\{/);
  // …and the requests have to be paced. 8 subdomains × Cesium's 6 per host was
  // 48 concurrent tiles against a per-second quota; capping it at 4 removed the
  // 429s entirely (measured: 124 rejected → 0).
  assert.match(runtime, /const ANNOTATION_TILE_CONCURRENCY = 4;/);
  assert.match(runtime, /await acquireAnnotationSlot\(\);[\s\S]{0,120}releaseAnnotationSlot\(\);/);
  // A throttled tile must not poison readiness: `ready` requires an empty error
  // list, so one 429 used to make waitReady time out and stall the export.
  assert.match(runtime, /不写进 `errors`/);
});

// The editor parks on one establishing frame, so the film's absolute windows can
// never match it (overview scenes sit at 29–87 s, the preview at ≈0–5 s). Both
// sides have to agree that the editor follows the SELECTED scene's toggle:
// Studio replaces the windows, the player accepts the message.
test("Studio preview drives labels from the selected scene, not the film clock", async () => {
  const [studioJs, runtime] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/cesium-player/public/runtime.js"), "utf8")
  ]);
  assert.match(studioJs, /function previewAnnotationWindows\(scene = selectedScene\(\)\)/);
  assert.match(studioJs, /scene\.imageryAnnotation === true[\s\S]{0,120}start: 0, end: Number\.MAX_SAFE_INTEGER/);
  assert.match(studioJs, /action: "set-annotations"/);
  // The opening replay must carry the same editor windows, otherwise it would
  // re-apply the film windows right after the dedicated message.
  assert.match(studioJs, /settleSeconds: STUDIO_OPENING_PREVIEW_TIMING\.settleSeconds,\s*annotationWindows: previewAnnotationWindows\(\)/);
  assert.match(studioJs, /function previewSelectedScene\(\)[\s\S]{0,320}pushPreviewAnnotationWindows\(\)/);
  assert.match(runtime, /event\.data\.action === "set-annotations"\) applyAnnotationWindows\(event\.data\.annotationWindows\)/);
});
