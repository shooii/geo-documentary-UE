import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { selectSceneAssetsForRender } from "../packages/render-spec/index.js";
import type { StudioScene } from "../packages/project-schema/index.js";

const root = resolve(import.meta.dirname, "..");
const playback = await import(pathToFileURL(resolve(root, "apps/studio/public/scene-render-placements.js")).href) as {
  selectSceneRenderPlacements: (scene: unknown) => Array<{ assetId: string }>;
  sceneRenderPlacementIndex: (count: number, progress: number) => number;
};

const assets = Array.from({ length: 6 }, (_, index) => ({ id: `asset-${index + 1}`, path: `p${index + 1}.jpg` }));

function scene(placements: Array<{ assetId: string; includeInRender?: boolean }>, extra: Record<string, unknown> = {}): StudioScene {
  return {
    id: "scene-1", title: "测试场景", section: "child", narration: "旁白", subtitle: "旁白",
    duration: 12, placements: placements.map((placement) => ({
      assetId: placement.assetId, fit: "cover" as const, crop: { x: 0, y: 0, width: 1, height: 1 },
      focalPoint: { x: 0.5, y: 0.5 }, scale: 1, offsetX: 0, offsetY: 0, animation: "still" as const,
      leadSeconds: 0.25, tailSeconds: 0.2, minimumDisplaySeconds: 2, requiredKeywords: [], alt: "",
      ...(placement.includeInRender === undefined ? {} : { includeInRender: placement.includeInRender })
    })),
    ...extra
  } as unknown as StudioScene;
}

function ids(items: Array<{ id?: string; assetId?: string }>) {
  return items.map((item) => item.assetId ?? item.id);
}

/**
 * The preview rotation and the export must agree on which pictures a scene
 * contains. They are two implementations of one rule, so the only useful test is
 * a differential one: feed both the same scenes and compare.
 */
test("playback rotation picks exactly the pictures the export ships", () => {
  const cases: Array<{ name: string; scene: StudioScene }> = [
    { name: "每一张都单独标记了用于成片", scene: scene([{ assetId: "asset-1", includeInRender: true }, { assetId: "asset-2", includeInRender: false }, { assetId: "asset-3", includeInRender: true }]) },
    { name: "标记全开（整村都上片）", scene: scene([{ assetId: "asset-1", includeInRender: true }, { assetId: "asset-2", includeInRender: true }, { assetId: "asset-3", includeInRender: true }, { assetId: "asset-4", includeInRender: true }, { assetId: "asset-5", includeInRender: true }]) },
    { name: "全部关掉（这一场不放图）", scene: scene([{ assetId: "asset-1", includeInRender: false }]) },
    { name: "旧方案：一张都没标记（assetDisplayCount = 2 也不再兜底）", scene: scene([{ assetId: "asset-1" }, { assetId: "asset-2" }, { assetId: "asset-3" }], { assetDisplayCount: 2 }) },
    { name: "旧方案：没有标记也没有 assetDisplayCount", scene: scene([{ assetId: "asset-1" }, { assetId: "asset-2" }]) },
    { name: "只有一张绑定素材", scene: scene([{ assetId: "asset-1", includeInRender: true }]) }
  ];
  for (const item of cases) {
    assert.deepEqual(
      ids(playback.selectSceneRenderPlacements(item.scene)),
      ids(selectSceneAssetsForRender(item.scene, assets)),
      `预览与成片的取图不一致：${item.name}`
    );
  }
});

test("a scene whose pictures were never marked ships nothing at all", () => {
  // 「场景里没有图片」和「成片里没有图片」必须是同一件事：素材卡片上一个 ✓ 都没有
  // 时，成片不能凭空多出一张图。旧数据里的 assetDisplayCount 不再参与判断。
  const unmarked = scene([{ assetId: "asset-1" }, { assetId: "asset-2" }], { assetDisplayCount: 2 });
  assert.deepEqual(ids(playback.selectSceneRenderPlacements(unmarked)), []);
  assert.deepEqual(ids(selectSceneAssetsForRender(unmarked, assets)), []);
});

test("a scene with no bound pictures yields no rotation at all", () => {
  assert.deepEqual(playback.selectSceneRenderPlacements(scene([])), []);
  assert.deepEqual(playback.selectSceneRenderPlacements(undefined), []);
  assert.equal(playback.sceneRenderPlacementIndex(0, 0.5), -1);
});

/**
 * `render-engine` splits the scene's measured narration window equally between
 * the selected pictures, so the preview has to step at those same boundaries —
 * off-by-one here is what makes a five-photo village look like a one-photo
 * village for its last fifth.
 */
test("equal slices of the narration window land on the right picture", () => {
  assert.equal(playback.sceneRenderPlacementIndex(5, 0), 0);
  assert.equal(playback.sceneRenderPlacementIndex(5, 0.199), 0);
  assert.equal(playback.sceneRenderPlacementIndex(5, 0.2), 1);
  assert.equal(playback.sceneRenderPlacementIndex(5, 0.6), 3);
  assert.equal(playback.sceneRenderPlacementIndex(5, 0.999), 4);
  // Progress is clamped: rounding past the end must stay on the last picture
  // instead of reading `placements[5]` and painting nothing.
  assert.equal(playback.sceneRenderPlacementIndex(5, 1), 4);
  assert.equal(playback.sceneRenderPlacementIndex(5, 1.4), 4);
  assert.equal(playback.sceneRenderPlacementIndex(5, -3), 0);
  assert.equal(playback.sceneRenderPlacementIndex(1, 0.7), 0);
});

/**
 * Source-level guards for the wiring itself: the maths above is useless if the
 * playback loop never calls it, or if the rotation outlives the scene it was
 * built for (which would paint the previous village's photo on the next one).
 */
test("playback drives the photo rotation from the audio clock and resets per scene", async () => {
  const studio = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");
  const html = await readFile(resolve(root, "apps/studio/public/index.html"), "utf8");

  // The shared module is the single source of truth in the browser too.
  assert.match(studio, /import \{ sceneRenderPlacementIndex, selectSceneRenderPlacements \} from "\.\/scene-render-placements\.js\?v=/);
  assert.match(studio, /function playbackScenePlacements\(scene\) \{\s*return selectSceneRenderPlacements\(scene\);/);
  // The rotation has to be advanced by the same poll that ends the scene.
  assert.match(studio, /syncPlaybackStage\(scene, playbackProgress\(range, audio, startedAt, estimatedMs\)\)/);
  // First picture is chosen before the camera message goes out, because the
  // flight-complete handler reveals whatever is on stage at that moment.
  assert.match(studio, /beginPlaybackStage\(scene\);\s*previewSelectedScene\(\);/);
  // A new scene must not inherit the previous scene's placement.
  assert.match(studio, /state\.playbackStagePlacement = null;\s*state\.playbackStageActive = false;\s*state\.selectedSceneId = sceneId/);
  // Stopping puts the operator's own selection back on the stage.
  assert.match(studio, /if \(state\.playbackStageActive\) \{[\s\S]{0,200}state\.playbackStageActive = false;[\s\S]{0,200}applyPreviewStagePlacement\(selectedScene\(\), selectedPlacement\(\)\)/);
  // A scene whose pictures are all unmarked stages nothing while it plays: the
  // stage is driven by the flag, not by "is there a placement object".
  assert.match(studio, /state\.playbackStageActive = true;\s*state\.playbackStagePlacement = pool\[0\] \|\| null;\s*applyPreviewStagePlacement\(scene, state\.playbackStagePlacement\);/);
  assert.match(studio, /applyPreviewStagePlacement\(scene, state\.playbackStageActive \? state\.playbackStagePlacement : placement\)/);
  // The stage is painted by one function, which keeps the 素材画面 panel out of it.
  assert.match(studio, /function applyPreviewStagePlacement\(scene, placement\)/);
  // Continuous playback rebuilds the rotation for the scene it just advanced to.
  assert.match(studio, /selectAdjacent\(1, true, true\);[\s\S]{0,120}beginPlaybackStage\(nextScene\);/);
  // The audio-less fallback clock has to move the pictures too, otherwise a
  // missing mp3 freezes the preview on photo one.
  assert.match(studio, /return Math\.min\(1, Math\.max\(0, \(Date\.now\(\) - startedAt\) \/ Math\.max\(1, estimatedMs\)\)\)/);
  assert.match(html, /studio\.js\?v=[0-9A-Za-z-]+/);
});
