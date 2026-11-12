import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeCompositionText, extractCaptionText } from "../.agents/skills/cesium-geo-documentary/scripts/delivery-subtitle-text.js";

const root = process.cwd();

test("从真实双层 compose 字幕DOM只提取一次 ink", async () => {
  const source = await readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts"), "utf8");
  assert.match(source, /class="subtitle-wash" aria-hidden="true">\$\{html\}<\/span><span class="subtitle-ink">\$\{html\}<\/span>/);

  const text = "它不靠海，<澳门> 368 & 5";
  const escaped = "它不靠海，&lt;澳门&gt; 368 &amp; 5";
  const actualTemplate = source.match(/return `<div id="caption-\$\{index\}"[^\n]+`;/)?.[0];
  assert.ok(actualTemplate, "必须执行生产字幕DOM模板，不能用简化纯文本代替");
  const composeCaption = new Function("index", "html", "activeEnd", "timeline", "COMPOSITION_TRACKS", actualTemplate);
  const actualComposeCaption = composeCaption(0, escaped, 2, { start: 0, duration: 2 }, { subtitle: 4 }) as string;
  assert.equal(extractCaptionText(actualComposeCaption), text);
  assert.deepEqual(extractCaptionText(composeCaption(1, "第一行<br/>第二行", 2, { start: 0, duration: 2 }, { subtitle: 4 })).split("\n"), ["第一行", "第二行"]);
});

test("保留 br 换行、转义文本并兼容旧版纯字幕", () => {
  assert.equal(decodeCompositionText("甲<br>乙<br/>丙<br />&amp;&lt;&gt;&quot;&#39;&apos;"), "甲\n乙\n丙\n&<>" + '"' + "''");
  assert.equal(extractCaptionText("旧版纯文本 &amp; 内容<br>第二行"), "旧版纯文本 & 内容\n第二行");
  assert.equal(extractCaptionText("<span class='accent subtitle-ink visible'>甲<br/>乙</span>"), "甲\n乙");
  assert.equal(decodeCompositionText("&amp;lt;br&amp;gt; &amp;quot;"), "&lt;br&gt; &quot;");
});

test("提取 ink 后仍然严格保留18字单行限制", () => {
  const caption = '<div><span class="subtitle-wash" aria-hidden="true">1234567890123456789</span><span class="subtitle-ink">1234567890123456789</span></div>';
  const visibleLines = extractCaptionText(caption).split("\n");
  assert.equal(visibleLines.length, 1);
  assert.equal([...visibleLines[0]!].length, 19);
  assert.ok([...visibleLines[0]!].length > 18);
});
