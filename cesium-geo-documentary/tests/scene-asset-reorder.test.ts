import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { selectSceneAssetsForRender } from "../packages/render-spec/index.js";

/**
 * Reordering bound assets is only meaningful if the export follows the same
 * order. `scene.placements` is that order: the renderer projects the *included*
 * placements onto the asset pool, so the film's cards come out in the sequence
 * the editor shows — not in library order, and not "included first".
 */
test("the film follows the placement order, not the asset pool order", () => {
  const pool = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" }
  ];
  const scene = {
    placements: [
      { assetId: "c", includeInRender: true },
      { assetId: "a", includeInRender: true },
      { assetId: "b", includeInRender: false }
    ]
  };
  assert.deepEqual(selectSceneAssetsForRender(scene as never, pool).map((x) => x.id), ["c", "a"]);
});

test("an unselected asset keeps its slot, so reordering it is not undone", () => {
  // The editor's ↑/↓ and drag move any card, including one that is not used in
  // the film. If the renderer re-sorted "included first", that move would look
  // applied and then silently revert — so excluded placements must simply be
  // skipped in place rather than gathered at the end.
  const pool = ["a", "b", "c", "d"].map((id) => ({ id }));
  const scene = {
    placements: [
      { assetId: "a", includeInRender: true },
      { assetId: "c", includeInRender: false },
      { assetId: "b", includeInRender: true },
      { assetId: "d", includeInRender: true }
    ]
  };
  assert.deepEqual(selectSceneAssetsForRender(scene as never, pool).map((x) => x.id), ["a", "b", "d"]);
});

test("the Studio moves placements without re-sorting included assets to the front", async () => {
  const studio = await readFile(resolve(import.meta.dirname, "../apps/studio/public/studio.js"), "utf8");
  // The reorder path must not call the "included first" helper: that helper
  // belongs to the export toggle and would fight the user's drag.
  const start = studio.indexOf("function moveSceneAsset(");
  assert.ok(start > 0, "moveSceneAsset must exist");
  const end = studio.indexOf("function nudgeSceneAsset(", start);
  const body = studio.slice(start, end);
  assert.doesNotMatch(body, /prioritizeIncludedSceneAssets/);
  // …and assetIds — the second record of the same order — has to move with it.
  assert.match(body, /scene\.assetIds = \[\.\.\.orderedIds/);
  // Both controls funnel through the same function.
  assert.match(studio, /function nudgeSceneAsset\(assetId, delta\)[\s\S]{0,400}moveSceneAsset\(assetId, index \+ delta\)/);
  assert.match(studio, /function bindSceneAssetReordering\(scene\)/);
  assert.match(studio, /event\.altKey && \(event\.key === "ArrowUp" \|\| event\.key === "ArrowDown"\)/);
});
