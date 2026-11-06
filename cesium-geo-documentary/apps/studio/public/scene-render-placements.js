/**
 * Which bound pictures the finished film shows for a scene — and which one is on
 * screen at a given moment.
 *
 * The export owns this answer in `packages/render-spec` (`selectSceneAssetsForRender`),
 * and the right-hand 素材 list owns its counterpart (`sceneAssetIncluded`). The
 * playback preview ignored both: it painted `selectedPlacement()`, i.e. whatever
 * card the operator had clicked, so a village with five pictures marked 用于成片
 * sat on one of them for the whole paragraph and the other four looked like they
 * were not in the film at all.
 *
 * The preview therefore has to answer the same question the export answers, and
 * the only way to keep two implementations honest is to test them against each
 * other (`tests/studio-playback-photos.test.ts` compares this module with
 * `selectSceneAssetsForRender()`). A plain ES module under `public/` because
 * `studio.js` is served raw, with no build step.
 */

/**
 * The scene's pictures in film order.
 *
 * Only the pictures explicitly marked 用于成片 (`includeInRender === true`) are
 * in the film — an unmarked picture is not "implicitly first", it is simply not
 * selected. This mirrors `selectSceneAssetsForRender()` exactly; the old
 * "no flags means the first `assetDisplayCount ?? 1`" fallback is gone, because
 * it made the film show a picture for a scene the editor showed as image-less.
 */
export function selectSceneRenderPlacements(scene) {
  const placements = Array.isArray(scene?.placements) ? scene.placements : [];
  return placements.filter((placement) => placement?.includeInRender === true);
}

/**
 * Index into `selectSceneRenderPlacements()` of the picture the film has on
 * screen at `progress` (0 → 1).
 *
 * `render-engine` splits a scene's measured narration window equally between the
 * selected pictures, in saved order, so equal slices is the whole rule.
 */
export function sceneRenderPlacementIndex(count, progress) {
  if (!(Number(count) > 0)) return -1;
  const value = Number(progress);
  const clamped = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  return Math.min(Number(count) - 1, Math.floor(clamped * Number(count)));
}
