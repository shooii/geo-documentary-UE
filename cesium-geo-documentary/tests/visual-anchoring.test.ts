import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { findVisualAnchorIssues, normalizeAnchorText } from "../packages/content-engine/visual-anchoring.js";

const root = resolve(process.cwd());

test("anchor comparison ignores punctuation, spacing and width differences", () => {
  assert.equal(normalizeAnchorText("雷州市盐场那沃工区(乌石镇)"), "雷州市盐场那沃工区乌石镇");
  assert.equal(normalizeAnchorText("  那 澳 村  "), "那澳村");
  assert.equal(normalizeAnchorText("ＡＢＣ-12"), "abc12");
  assert.equal(normalizeAnchorText(null), "");
});

test("a keyword that occurs in the scene narration is not reported", () => {
  const issues = findVisualAnchorIssues([
    { id: "child-1", title: "岭峰村", narration: "岭峰村位于乌石镇北部。", placements: [{ requiredKeywords: ["岭峰村"] }] }
  ]);
  assert.deepEqual(issues, []);
});

test("a keyword that the scene narration never mentions is reported once per keyword", () => {
  const issues = findVisualAnchorIssues([
    {
      id: "child-440882115019",
      title: "那澳村",
      narration: "「那澳」，「那」为古壮侗语的田，「澳」是雷州方言的海湾。下辖那澳、澳港两村。",
      placements: [
        { requiredKeywords: ["那澳村"] },
        { requiredKeywords: ["那澳村"] },
        { requiredKeywords: ["那澳村"] }
      ]
    }
  ]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.keyword, "那澳村");
  assert.equal(issues[0]!.placementCount, 3);
  assert.equal(issues[0]!.reason, "absent-from-scene");
  assert.deepEqual(issues[0]!.otherSceneIds, []);
});

test("a keyword that matches another scene is flagged as a mis-anchor, not a soft miss", () => {
  const issues = findVisualAnchorIssues([
    { id: "child-a", title: "甲村", narration: "甲村以养殖为主。", placements: [{ requiredKeywords: ["甲村"] }] },
    { id: "child-b", title: "乙村", narration: "乙村半农半渔，田埂直通大海。", placements: [{ requiredKeywords: ["甲村"] }] }
  ]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.sceneId, "child-b");
  assert.equal(issues[0]!.reason, "matches-another-scene");
  assert.deepEqual(issues[0]!.otherSceneIds, ["child-a"]);
});

test("the compositor and the Studio share one anchor comparison", async () => {
  const [compositor, server] = await Promise.all([
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts"), "utf8"),
    readFile(resolve(root, "apps/studio/server.ts"), "utf8")
  ]);
  assert.match(compositor, /import \{ normalizeAnchorText \} from "\.\.\/\.\.\/\.\.\/\.\.\/packages\/content-engine\/visual-anchoring\.js"/);
  assert.match(compositor, /function normalizeSearchText\(value: string\): string \{[\s\S]*?return normalizeAnchorText\(value\);[\s\S]*?\}/);
  assert.doesNotMatch(compositor, /replace\(\/\[\^\\p\{L\}\\p\{N\}\][\s\S]*?toLowerCase\(\)/);
  assert.match(server, /findVisualAnchorIssues\(project\.scenes\)/);
  assert.match(server, /advise\("visual-keywords"/);
  assert.match(server, /checks\.every\(\(item\) => item\.pass \|\| item\.advisory\)/);
});

test("renaming a child unit carries its placement keywords, not just its narration", async () => {
  const source = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");
  assert.match(source, /function replaceSceneKeywordReference\(placements, previousName, nextName\)/);
  assert.match(source, /scene\.narration = replaceSceneNameReference\(scene\.narration, previousName, nextName\);[\s\S]*?replaceSceneKeywordReference\(scene\.placements, previousName, nextName\);/);
});
