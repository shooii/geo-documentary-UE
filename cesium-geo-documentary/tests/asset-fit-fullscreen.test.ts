import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// 「适配」原来只有 Cover / Contain / Fill，三者都只描述画面怎么待在**卡片**里；
// 卡片本身是固定的（竖屏 952x780、内缩、描边、圆角、投影）。操作者要的是一个
// 让画面占满整帧的选项，也就是「全屏」。它换的是版式，不是 object-fit。
const root = process.cwd();

test("全屏 is a real fit value on both sides of the export", async () => {
  const [schema, html, client, refine, compositor] = await Promise.all([
    readFile(resolve(root, "packages/project-schema/index.ts"), "utf8"),
    readFile(resolve(root, "apps/studio/public/index.html"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio-refine.css"), "utf8"),
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts"), "utf8")
  ]);

  assert.match(schema, /export type AssetFit = "cover" \| "contain" \| "fill" \| "fullscreen";/);
  assert.match(html, /<option value="fullscreen">Fullscreen 全屏<\/option>/);

  // 全屏不是 object-fit 的关键字：直接把它交给 canvas 是**非法值**，浏览器会保留
  // 上一次的 object-fit（默认 fill = 拉伸）。所以显式落到 cover。
  assert.match(client, /const previewFullscreen = placement\.fit === "fullscreen";/);
  assert.match(client, /placement\.fit === "fill" \? "fill" : previewFullscreen \? "cover" : placement\.fit/);
  assert.match(client, /previewAssetFrame\.classList\.toggle\("is-fullscreen", previewFullscreen\)/);
  assert.match(client, /previewAssetCaption\.classList\.toggle\("is-fullscreen", previewFullscreen\)/);

  // 预览与成片必须是同一件事（见 topics/subtitle-and-overlays.md 的同一条教训）。
  assert.match(refine, /\.preview-asset-frame\.is-fullscreen\{left:0;right:0;top:0;width:100%;height:100%;border:0;border-radius:0;box-shadow:none/);
  assert.match(refine, /\.preview-asset-caption\.is-fullscreen\{left:10px;right:10px;top:auto;bottom:10px/);
  assert.match(compositor, /const layout = visual\.fit === "fullscreen" \? " visual-fullscreen" : "";/);
  assert.match(compositor, /class="clip visual \$\{sourceClass\} visual-\$\{kind\}\$\{layout\}"/);
  assert.match(compositor, /\.visual\.visual-fullscreen\{left:0;top:0;width:\$\{profile\.width\}px;height:\$\{profile\.height\}px;border:0;border-radius:0;box-shadow:none\}/);
  assert.match(compositor, /\.visual-main\.fit-fullscreen\{object-fit:cover\}/);
  // A full-bleed picture covers the whole frame, including the imagery
  // attribution line at the bottom. That text is a licence requirement, so it
  // has to sit above the visual layer (z-index 20, subtitles 40): with the old
  // 15 the layout audit reported `text_occluded` and the export was blocked.
  assert.match(compositor, /\.provider-credit\{z-index:60;/);
  // 全屏素材的标签落在画面底边，和右下角的影像署名是同一片区域。两个文字块叠在
  // 一起会被 layout 审计判成 content_overlap（error，2026-10-12 拦住过一次导出：
  // #provider-credit ↔ #visual-caption-2），所以全屏标签的底边要抬到署名上方
  // （58px = 署名 18 底边 + 行盒 + 内边距 + 12 间隙），没有署名时才用原值。
  assert.match(compositor, /const creditTopPx = 18 \+ Math\.round\(creditFontPx \* 1\.2\) \+ 10;/);
  assert.match(compositor, /const fullscreenCaptionBottomPx = imageryAttribution \? creditTopPx \+ 12 : \(isPortrait \? 16 : 14\);/);
  assert.match(compositor, /\.visual\.visual-fullscreen figcaption\{bottom:\$\{fullscreenCaptionBottomPx\}px\}/);
});
