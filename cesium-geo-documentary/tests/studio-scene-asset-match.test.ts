import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const REGION = "440825";

interface MatchCandidate { asset: Record<string, unknown>; keyword: string }
interface MatchFields { field: string; text: string }
interface MatchOptions {
  assets: unknown[];
  narration: string;
  regionId?: string;
  regionNames?: Array<string | undefined>;
  limit?: number;
  childNameOf?: (asset: Record<string, unknown>) => string | undefined;
}
interface SceneAssetMatch {
  MATCH_STOP_CHARS: Set<string>;
  MATCH_EDGE_STOP_CHARS: Set<string>;
  compactMatchText(value: unknown): string;
  isEvidenceWindow(window: string): boolean;
  narrationLexeme(sourceText: string, narration: string): string;
  assetMatchFields(asset: unknown): MatchFields[];
  isDiscriminatingLexeme(lexeme: string, administrativeNames?: string | Array<string | undefined>): boolean;
  selectSceneAssetsForNarration(options: MatchOptions): MatchCandidate[];
}

// `apps/studio/public/*.js` is served to the browser exactly as written — there
// is no build step — and it sits outside the TypeScript program (`tsconfig.json`
// has no `allowJs`). Loading it by URL is what lets the test and the browser run
// one copy of the rules; the interface above keeps the test typed.
const loaded = await import(pathToFileURL(resolve(root, "apps/studio/public/scene-asset-match.js")).href);
const match = loaded as unknown as SceneAssetMatch;

/**
 * An Amap photo, named the way `amap-materials.ts:341` names them:
 * `${childName} · ${poiName} · ${photoTitle}`. The shared village prefix is the
 * whole reason auto-binding used to look random.
 */
function amapPhoto(id: string, childName: string, poiName: string, photoTitle = "", photoIndex = 1) {
  return {
    id,
    name: `${childName} · ${poiName}${photoTitle ? ` · ${photoTitle}` : ""}`,
    path: `/workspace-assets/${id}.jpg`, type: "image", sourceType: "amap-poi", verifiedReal: true,
    alt: `${childName}的${poiName}`,
    scope: { regionId: REGION, childId: `child-${childName}` },
    poi: {
      provider: "amap", poiId: `poi-${id}`, poiName, poiType: "风景名胜;景点", poiTypeCode: "110000",
      childId: `child-${childName}`, childName, photoIndex, photoTitle, retrievedAt: "2026-09-18T00:00:00.000Z"
    }
  } as Record<string, unknown>;
}

/**
 * A web-evidence photo (`project-service.ts`): sourced from a manifest, so it
 * carries a descriptive label instead of Amap POI metadata.
 */
function evidencePhoto(id: string, label: string) {
  return {
    id, name: label, alt: label, path: `/workspace-assets/${id}.jpg`,
    type: "image", sourceType: "verified-real", verifiedReal: true
  } as Record<string, unknown>;
}

const select = (options: Partial<MatchOptions> & { narration: string }) =>
  match.selectSceneAssetsForNarration({ assets: [], ...options } as MatchOptions);
const ids = (candidates: MatchCandidate[]) => candidates.map((item) => (item.asset as { id: string }).id);

test("a sentence that only names the village binds no photo", () => {
  // Every photo of 江洪镇 carries that village in its generated name, so the old
  // matcher scored all of them identically and let `localeCompare` pick two.
  // Naming the village says nothing about which photo belongs to the sentence.
  const photos = [
    amapPhoto("a", "江洪镇", "江洪渔港", "渔船归港", 1),
    amapPhoto("b", "江洪镇", "江洪码头", "码头全景", 2),
    amapPhoto("c", "江洪镇", "仙群岛", "海岛远景", 3)
  ];
  assert.deepEqual(select({ assets: photos, narration: "江洪镇地处雷州半岛西海岸。" }), []);
});

test("a sentence that names the POI binds that POI's photos, in Amap's photo order", () => {
  const photos = [
    amapPhoto("tide", "江洪镇", "江洪码头", "码头全景", 1),
    amapPhoto("boat-late", "江洪镇", "江洪渔港", "灯塔", 9),
    amapPhoto("boat-first", "江洪镇", "江洪渔港", "渔船归港", 2)
  ];
  const picked = select({ assets: photos, narration: "江洪渔港停满归港的渔船。" });
  assert.deepEqual(ids(picked), ["boat-first", "boat-late"]);
  assert.deepEqual(picked.map((item) => item.keyword), ["江洪渔港", "江洪渔港"]);
  // Ties used to fall through to Chinese alphabetical order. Guard that this
  // case genuinely separates the two rules, so the assertion above means
  // something: by name, 灯塔 sorts before 渔船 — the reverse of photo order.
  const byName = [...picked].sort((a, b) =>
    String((a.asset as { name: string }).name).localeCompare(String((b.asset as { name: string }).name), "zh"));
  assert.deepEqual(ids(byName), ["boat-late", "boat-first"]);
  // The photo of a different POI in the same village must not be borrowed just
  // because the sentence mentions the village too.
  assert.equal(ids(picked).includes("tide"), false);
});

test("a window held together by a function word is not evidence", () => {
  // Real regression: 「东港村 · 海边福德堂」 and 「一个镇的海岸线，足足46公里。」
  // share "的海" — the 的 from the village's possessive and the 海 from two
  // different words. The old rule put a temple photo on a sentence about how
  // long the coastline is.
  const temple = amapPhoto("temple", "东港村", "海边福德堂", "", 1);
  assert.deepEqual(select({ assets: [temple], narration: "一个镇的海岸线，足足46公里。" }), []);
  assert.equal(match.narrationLexeme("东港村的海边福德堂", "一个镇的海岸线，足足46公里。"), "");
  // The window is only rejected because of its edges, not because it is short:
  // the same bigram in the middle of real words still counts.
  assert.equal(match.isEvidenceWindow("的海"), false);
  assert.equal(match.isEvidenceWindow("渔港"), true);
  // 中/上/下/里/外/前/后 are function words *and* everyday name characters, so
  // they must not disqualify a window.
  for (const name of ["下巷古井", "上洋村", "中和堂", "外罗港", "前山村"]) {
    assert.equal(match.isEvidenceWindow(name), true, `${name} should stay usable`);
  }
});

test("a word shared with other scenes is still used", () => {
  // Deliberate non-rule. `findVisualAnchorIssues` reports a keyword as misplaced
  // only when it is missing from *its own* scene, and a keyword taken from the
  // sentence it anchors to never is — so suppressing a shared word would only
  // ever cost a correct photo. `amap-materials.ts:207` has always bound child
  // scenes with the village name, which several scenes share.
  // Real case: 「渔港直供，鲜到咬舌头。」 belongs to 乌石渔港, a word the overview
  // scene naturally also says.
  const harbour = {
    id: "wushi-harbour", name: "乌石渔港", path: "/workspace-assets/wushi.jpg",
    type: "image", sourceType: "verified-real", verifiedReal: true
  } as Record<string, unknown>;
  const picked = select({ assets: [harbour], narration: "渔港直供，鲜到咬舌头。" });
  assert.deepEqual(ids(picked), ["wushi-harbour"]);
  assert.deepEqual(picked.map((item) => item.keyword), ["渔港"]);
});

test("a match has to live inside one field, not straddle two", () => {
  // The old matcher joined `name + poiName + poiType + alt`, stripped the
  // separator and slid a window across the result — so "港船", which exists only
  // where "归港" meets "船埠头", counted as evidence about a real photo.
  const asset = amapPhoto("straddle", "北和镇", "船埠头");
  (asset as { name: string }).name = "北和镇 · 归港";
  (asset as { alt: string }).alt = "北和镇";
  assert.deepEqual(select({ assets: [asset], narration: "港船往来。" }), []);
  // Proof the window really was reachable when the fields were one string.
  assert.equal("北和镇归港船埠头".includes("港船"), true);
});

test("the POI name is stronger evidence than the generated name", () => {
  // `viaName` only matches through the generated name, `viaPoi` through the POI
  // name. Both share the same two-character word, so only the field priority can
  // separate them — and it has to beat the photo order, which favours `viaName`.
  const viaName = amapPhoto("via-name", "南兴镇", "旧码头", "", 1);
  (viaName as { name: string }).name = "南兴镇 · 渔港";
  (viaName as { alt: string }).alt = "南兴镇";
  const viaPoi = amapPhoto("via-poi", "南兴镇", "渔港", "", 7);
  (viaPoi as { name: string }).name = "南兴镇 · 旧码头";
  (viaPoi as { alt: string }).alt = "南兴镇";
  assert.deepEqual(ids(select({ assets: [viaName, viaPoi], narration: "渔港" })), ["via-poi", "via-name"]);
});

test("stop characters alone are never evidence", () => {
  assert.equal(match.narrationLexeme("的一是", "有和是"), "");
  assert.equal(match.narrationLexeme("在上面的", "这里的都是"), "");
  // Two characters of real text still count.
  assert.equal(match.narrationLexeme("海湾", "湛江海湾"), "海湾");
});

test("isDiscriminatingLexeme rejects the village name and its fragments", () => {
  assert.equal(match.isDiscriminatingLexeme("江洪镇", "江洪镇"), false);
  assert.equal(match.isDiscriminatingLexeme("江洪", "江洪镇"), false);
  assert.equal(match.isDiscriminatingLexeme("洪镇", "江洪镇"), false);
  assert.equal(match.isDiscriminatingLexeme("江洪渔港", "江洪镇"), true);
  // With no village to compare against, the lexeme stands on its own.
  assert.equal(match.isDiscriminatingLexeme("江洪镇", undefined), true);
  assert.equal(match.isDiscriminatingLexeme("", "江洪镇"), false);
});

test("isDiscriminatingLexeme rejects every unit in the administrative chain", () => {
  // The village is not the only name that identifies nothing: a POI named after
  // its town or county matches every sentence in a video about that place.
  const chain = ["广东省", "湛江市", "雷州市", "乌石镇", undefined];
  assert.equal(match.isDiscriminatingLexeme("乌石", chain), false);
  assert.equal(match.isDiscriminatingLexeme("雷州", chain), false);
  assert.equal(match.isDiscriminatingLexeme("湛江", chain), false);
  assert.equal(match.isDiscriminatingLexeme("广东", chain), false);
  // Anything narrower than the unit itself stays usable.
  assert.equal(match.isDiscriminatingLexeme("乌石甜", chain), true);
  assert.equal(match.isDiscriminatingLexeme("乌石渔港", chain), true);
  // Blank entries must not disqualify anything.
  assert.equal(match.isDiscriminatingLexeme("渔港", [undefined, "", "  "]), true);
});

test("assets scoped elsewhere and prohibited photos are never bound", () => {
  const here = amapPhoto("here", "江洪镇", "江洪渔港", "", 1);
  const elsewhere = amapPhoto("elsewhere", "江洪镇", "江洪渔港", "", 1);
  (elsewhere as { scope: Record<string, unknown> }).scope = { regionId: "440802" };
  const prohibited = amapPhoto("banned", "江洪镇", "江洪渔港", "", 1);
  (prohibited as { prohibitedContent: boolean }).prohibitedContent = true;
  const picked = select({ assets: [elsewhere, prohibited, here], narration: "江洪渔港", regionId: REGION });
  assert.deepEqual(ids(picked), ["here"]);
});

test("photos without POI metadata fall back to the scene's child name", () => {
  // Web-evidence photos (`project-service.ts`) carry only a descriptive label.
  const evidence = {
    id: "harbour-fleet", name: "江洪渔港开渔船队航拍", path: "/workspace-assets/harbour.jpg",
    type: "image", sourceType: "verified-real", verifiedReal: true
  } as Record<string, unknown>;
  const picked = select({
    assets: [evidence], narration: "江洪渔港的开渔船队出海。", childNameOf: () => "江洪镇"
  });
  assert.deepEqual(ids(picked), ["harbour-fleet"]);
  assert.deepEqual(picked.map((item) => item.keyword), ["江洪渔港"]);
});

test("a label that only names the region is not evidence", () => {
  // Real regression, 乌石镇 (440882115). These are web-evidence photos, so their
  // label is the only text there is: 乌石甜糟 / 乌石二 / 乌石中心渔港. The sentence
  // says 乌石甜酒, so "乌石" — the town's own name — is shared by all three, and
  // the old matcher bound the sentence to two of them.
  const photos = [
    evidencePhoto("wine", "乌石甜糟"),
    evidencePhoto("two", "乌石二"),
    evidencePhoto("harbour", "乌石中心渔港")
  ];
  const narration = "雷州老话讲「乌石甜酒甜第一」。";
  // Without the hierarchy, sharing the town name is enough for an incidental photo.
  assert.deepEqual(ids(select({ assets: photos, narration })), ["wine", "two"]);
  const picked = select({ assets: photos, narration, regionNames: ["广东省", "湛江市", "雷州市", "乌石镇"] });
  assert.deepEqual(ids(picked), ["wine"]);
  // And the photo is pinned to the part of the sentence that actually mentions it.
  assert.deepEqual(picked.map((item) => item.keyword), ["乌石甜"]);
});

test("nothing to match and nothing to say both return no binding", () => {
  assert.deepEqual(select({ assets: [amapPhoto("a", "江洪镇", "江洪渔港")], narration: "" }), []);
  assert.deepEqual(select({ assets: [amapPhoto("a", "江洪镇", "江洪渔港")], narration: "湛江位于雷州半岛。" }), []);
  assert.deepEqual(select({ assets: [], narration: "江洪渔港" }), []);
  // A video asset is never a photo to bind.
  const clip = amapPhoto("clip", "江洪镇", "江洪渔港");
  (clip as { type: string }).type = "video";
  assert.deepEqual(select({ assets: [clip], narration: "江洪渔港" }), []);
});

test("limit caps how many photos one sentence can carry", () => {
  const photos = [1, 2, 3, 4].map((index) => amapPhoto(`p${index}`, "江洪镇", "江洪渔港", "", index));
  assert.equal(select({ assets: photos, narration: "江洪渔港", limit: 2 }).length, 2);
  assert.equal(select({ assets: photos, narration: "江洪渔港", limit: 0 }).length, 0);
});

test("the studio wires the chosen word into the placement and stays honest when nothing matches", async () => {
  const client = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");
  // The rules only matter if the splitter actually uses them and writes the
  // keyword that proves the binding.
  assert.match(client, /import \{ selectSceneAssetsForNarration \} from "\.\/scene-asset-match\.js\?v=/);
  assert.match(client, /requiredKeywords: keyword \? \[keyword\] : \[\]/);
  assert.match(client, /matches\.map\(\(match\) => defaultPlacementForAsset\(match\.asset, scene, duration, match\.keyword\)\)/);
  // No photo tied to the sentence means a map scene, not an empty image card.
  assert.match(client, /type: isOriginal \? keepType : \(matches\.length \? "image-card" : "map-overview"\)/);
  // The administrative chain comes from the project's own cover metadata.
  assert.match(client, /regionNames: \[cover\.province, cover\.city, cover\.county, cover\.town\]/);
  assert.doesNotMatch(client, /localeCompare\(String\(b\.asset\.name/, "the alphabetical tie-break must stay gone");
  // Cross-scene keyword suppression stays out: it can only ever cost a correct
  // photo, because a keyword taken from its own sentence cannot be misplaced.
  assert.doesNotMatch(client, /otherNarrations/);
});
