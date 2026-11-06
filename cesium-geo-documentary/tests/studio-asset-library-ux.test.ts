import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.cwd());

test("scene assets distinguish export selection from primary-image ordering", async () => {
  const [html, source] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/index.html"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8")
  ]);

  assert.match(html, /id="sceneAssetScope"/);
  assert.match(html, /id="sceneAssetSort"/);
  assert.match(html, /id="sceneAssetPickerTitle">选择素材</);
  assert.match(html, /id="toggleSceneAssetPicker" type="button">选择素材</);
  assert.doesNotMatch(html, /id="uploadSceneAsset"/);
  assert.doesNotMatch(html, /id="sceneAssetDropHint"/);
  assert.doesNotMatch(html, /id="openAssetLibraryFromPicker"/);
  assert.doesNotMatch(source, /\$\("openAssetLibraryFromPicker"\)/);
  assert.doesNotMatch(source, /\$\("uploadSceneAsset"\)/);
  assert.match(source, /data-open-asset-library-empty>前往素材库上传/);
  assert.match(source, /\$\("assetLibraryUpload"\)\.onclick = \(\) => \{ state\.uploadTargetSceneId = null;/);
  assert.match(source, /data-toggle-scene-asset-export/);
  assert.match(source, /data-set-primary-scene-asset/);
  assert.match(source, /async function setPrimarySceneAsset\(id\)/);
  assert.match(source, /scene\.placements\.unshift\(placement\)/);
  assert.match(source, /scene\.assetIds = \[id, \.\.\.\(scene\.assetIds \|\| \[\]\)\.filter/);
  assert.doesNotMatch(source, /if \(needsPersist\) await flushPendingSave\(\)/);
  assert.match(source, /已设为首图并加入成片；点击“保存方案”后生效/);
  assert.doesNotMatch(source, /data-replace-scene-asset/);
  assert.match(source, /local\.name = name;[\s\S]*?if \(state\.assetLibraryOpen\) renderAssetLibrary\(\);/);
  assert.match(source, /名称已更新，正在同步全部方案…/);
});

test("asset library groups duplicates and exposes safe batch cleanup controls", async () => {
  const [html, source, styles] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/index.html"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio-refine.css"), "utf8")
  ]);

  for (const id of ["assetLibrarySource", "assetLibraryUsage", "assetLibrarySort", "selectUnusedAssets", "deleteSelectedAssets"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(source, /function assetGroupKey\(asset\)/);
  assert.match(source, /function groupedLibraryHtml\(assets\)/);
  assert.match(source, /async function removeSelectedAssetsFromLibrary\(\)/);
  assert.match(source, /永久删除会移除所有方案中的引用和本机文件，无法撤销/);
  assert.match(styles, /\.lib-group\{/);
  assert.match(styles, /\.lib-asset\.selected\{/);
});

test("bound asset cards contain long names without covering their actions", async () => {
  const [source, styles] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio-refine.css"), "utf8")
  ]);
  assert.match(source, /class="scene-bound-asset-title" title="\$\{escapeHtml\(asset\.name\)\}"/);
  assert.match(styles, /\.scene-bound-asset \.scene-bound-asset-title>b\{[^}]*-webkit-line-clamp:2/);
  assert.match(styles, /\.scene-bound-asset \.scene-bound-asset-title>small\{[^}]*text-overflow:ellipsis/);
});

test("the scene-asset action column sizes to its widest label", async () => {
  const styles = await readFile(resolve(root, "apps/studio/public/studio-refine.css"), "utf8");

  /*
   * The column used to be pinned to 60px while its buttons are
   * `white-space:nowrap`. Grid items never shrink below their min-content
   * width, and a nowrap "✓ 用于成片" needs ~71.5px, so the column overflowed its
   * own box and the buttons slid out through the card border by 13.5px. The
   * width must stay content-derived for the buttons to stay inside the card.
   */
  assert.match(styles, /\.scene-bound-actions\{width:max-content;min-width:60px;justify-items:stretch\}/);
  assert.doesNotMatch(styles, /\.scene-bound-actions\{width:60px/);
  assert.match(styles, /\.scene-bound-actions button\{[^}]*white-space:nowrap/);
});

test("the export badge is never the part of the kind line that gets cut", async () => {
  const [source, styles] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio-refine.css"), "utf8")
  ]);

  /*
   * The kind line mixes a variable-length label with the export badge on one
   * nowrap row. While both shared a bare text node they competed for the same
   * space, and the badge — the only indicator of whether the asset is in the
   * film, with no tooltip to fall back on — was what got pushed out. The label
   * is wrapped so it ellipsises on its own and the badge keeps its room.
   */
  assert.match(source, /<span class="asset-kind-text" title="\$\{escapeHtml\(kindLabel\)\}">\$\{escapeHtml\(kindLabel\)\}<\/span>/);
  assert.match(source, /const kindLabel = `\$\{assetKind\(asset\)\} · \$\{assetSourceLabel\(asset\)\}`;/);
  assert.match(styles, /\.scene-bound-asset \.asset-kind-text\{[^}]*text-overflow:ellipsis/);
  assert.match(styles, /\.scene-bound-asset \.asset-kind \.scene-bound-export-badge\{flex:0 0 auto\}/);
});
