import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * The bound-asset card is the densest thing in the inspector: 13 assets per
 * village, each one a row. Its action column used to hold three stacked text
 * buttons (72px each, one per line, 80px tall), which made every card 92px and
 * pushed the list to ~1270px — the operator's complaint was literally "太占位置".
 * Icons keep every function and every hint while fitting one 24px row.
 */
test("the bound-asset action column stays one row tall", async () => {
  const [source, styles] = await Promise.all([
    readFile(resolve(import.meta.dirname, "../apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(import.meta.dirname, "../apps/studio/public/studio-refine.css"), "utf8")
  ]);
  // Icon buttons, one row, no wrapping back into a column.
  assert.match(styles, /\.scene-bound-asset \.scene-bound-actions\{[^}]*flex-wrap:nowrap/);
  assert.match(styles, /\.scene-bound-asset \.scene-bound-actions>button\{width:24px;min-width:24px/);
  // The width rule that kept the old labels from overflowing the card border is
  // still in place for any future text button.
  assert.match(styles, /\.scene-bound-actions\{width:max-content;min-width:60px;justify-items:stretch\}/);
  // An icon is only allowed to replace a label if the label survives somewhere
  // a user and a screen reader can reach it.
  for (const label of ["取消用于成片", "选择用于成片", "设为首图", "仅从当前场景移除"]) {
    assert.match(source, new RegExp(label), `the icon button needs a reachable "${label}" hint`);
  }
  assert.match(source, /aria-label="\$\{included \? "取消用于成片" : "选择用于成片"\}/);
});

/**
 * Reordering must not cost any space of its own: the arrows I first added were a
 * fourth stacked button that grew the card again, and a hover overlay over the
 * thumbnail stole the drag start (pointerdown landed on the button, so dragging a
 * picture did nothing). Only the non-interactive number badge is left.
 */
test("reordering adds no controls to the card, only a badge that cannot swallow a drag", async () => {
  const [source, styles] = await Promise.all([
    readFile(resolve(import.meta.dirname, "../apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(import.meta.dirname, "../apps/studio/public/studio-refine.css"), "utf8")
  ]);
  assert.doesNotMatch(source, /data-move-scene-asset/, "no arrow buttons in the card");
  assert.doesNotMatch(source, /scene-bound-move-stack/, "no hover overlay covering the thumbnail");
  assert.match(source, /<span class="scene-bound-order"[^>]*>\$\{index \+ 1\}<\/span>/);
  // pointer-events:none is what lets a drag start on the thumbnail corner the
  // badge sits on; without it the badge becomes a dead zone.
  assert.match(styles, /\.scene-bound-order\{[^}]*pointer-events:none/);
  // The keyboard path stays, since the buttons are gone.
  assert.match(source, /event\.altKey && \(event\.key === "ArrowUp" \|\| event\.key === "ArrowDown"\)/);
});
