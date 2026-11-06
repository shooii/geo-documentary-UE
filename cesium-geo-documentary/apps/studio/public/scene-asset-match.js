/**
 * Which project photo may illustrate a sentence — and which word proves it.
 *
 * A placement carries `requiredKeywords`: the claim "the sentence that shows
 * this photo contains this text". The compositor re-anchors a clip to the
 * nearest narration cue that mentions its keyword, so a keyword that is simply
 * absent leaves the photo on its declared cue and drifting, while a keyword that
 * is present pins it to the right sentence.
 *
 * Auto-binding used to be "longest shared substring, ties broken by Chinese
 * alphabetical order". Amap material names are built as
 * `${childName} · ${poiName} · ${photoTitle}` (`amap-materials.ts:341`), so
 * every photo of a village shares that village's prefix: a sentence that merely
 * names the village matched all of them at the identical weight, and the
 * tie-break picked which two shipped. That is why the binding read as random.
 *
 * Three rules replace it:
 *
 *  1. Score each text field on its own. The old code concatenated
 *     `name + poiName + poiType + alt`, stripped the separator spaces and slid a
 *     window over the result, so a window could straddle two fields and match
 *     text no single field contains.
 *  2. Refuse a match that is only the administrative unit's own name. It cannot
 *     tell one photo of the village from another, so the honest answer is *no
 *     photo* rather than an arbitrary one — the same "宁缺勿滥" the QA checklist
 *     asks for.
 *  3. Refuse a window that begins or ends with a function word. `东港村的海边
 *     福德堂` shares "的海" with `一个镇的海岸线`; that is a coincidence across a
 *     word boundary, not evidence, and it used to put a temple photo on a
 *     sentence about coastline length.
 *
 * NOT a rule, deliberately: skipping a keyword that also occurs in another
 * scene. `findVisualAnchorIssues` only calls a keyword misplaced when it is
 * missing from *its own* scene, so a keyword taken from the sentence it anchors
 * to cannot be misplaced — and `amap-materials.ts:207` has always bound child
 * scenes with the village name, which appears in several scenes by construction.
 *
 * Kept as a plain ES module under `public/` because `studio.js` is served raw
 * with no build step, so browser and tests importing this file is the only way
 * they can share one implementation.
 */

// Function words and bare numerals. A sliding window made only of these says
// nothing about which photo to use.
export const MATCH_STOP_CHARS = new Set(["的", "和", "与", "是", "在", "了", "着", "于", "有", "这", "那", "也", "都", "对", "从", "被", "把", "为", "又", "很", "并", "但", "而", "让", "到", "向", "往", "中", "内", "点", "面", "处", "之", "其", "所", "等", "后", "前", "一", "二", "两", "三", "四", "五", "六", "七", "八", "九", "十", "上", "下", "里", "外", "随", "将", "已", "正", "还", "再", "另", "各", "每", "某"]);

/**
 * Function words that essentially never begin or end a Chinese place name, so a
 * window touching one is standing on a word boundary rather than on shared
 * subject matter.
 *
 * Deliberately narrower than `MATCH_STOP_CHARS`: 中/上/下/里/外/前/后/内/点/面/处
 * and the numerals are function words *and* everyday name characters
 * (下巷古井, 上洋村, 外罗港), so they must not disqualify a window.
 */
export const MATCH_EDGE_STOP_CHARS = new Set(["的", "和", "与", "是", "在", "了", "着", "于", "有", "这", "那", "也", "都", "对", "从", "被", "把", "为", "又", "很", "并", "但", "而", "让", "到", "向", "往", "之", "其", "所", "等", "随", "将", "已", "正", "还", "再", "另", "各", "每", "某"]);

// Where a match came from. The POI name is the strongest evidence that a
// sentence is about that specific place; the photo title and the free-text alt
// are progressively weaker; the generated `name` is the weakest because it
// repeats the village for every photo.
const FIELD_PRIORITY = { poiName: 6, photoTitle: 4, alt: 2, name: 0 };

// Two characters of shared text is the floor; longer is stronger. Deliberately
// NOT "longest wins outright": `name` is the concatenation
// `${childName} · ${poiName} · ${photoTitle}`, so its long windows are exactly
// the ones most likely to straddle two fields, and rule 1 above exists to stop
// trusting those. Field priority therefore has to be able to outweigh a
// character or two. Measured against the 64 real projects, removing this
// counterweight changes no binding at all — it is kept so the weakest field
// cannot win on length alone.
const LEXEME_LENGTH_WEIGHT = 2;

const MIN_LEXEME_LENGTH = 2;
const MAX_LEXEME_LENGTH = 5;

export function compactMatchText(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

/** True when the window is usable evidence at all: substantive, and not held together by a function word. */
export function isEvidenceWindow(window) {
  if (window.length < MIN_LEXEME_LENGTH) return false;
  if ([...window].every((char) => MATCH_STOP_CHARS.has(char))) return false;
  return !MATCH_EDGE_STOP_CHARS.has(window[0]) && !MATCH_EDGE_STOP_CHARS.has(window[window.length - 1]);
}

/**
 * Longest window of `sourceText` that also occurs in `narration`, or "".
 */
export function narrationLexeme(sourceText, narration) {
  const text = compactMatchText(sourceText);
  const needle = compactMatchText(narration);
  if (text.length < MIN_LEXEME_LENGTH || needle.length < MIN_LEXEME_LENGTH) return "";
  for (let length = Math.min(MAX_LEXEME_LENGTH, text.length); length >= MIN_LEXEME_LENGTH; length -= 1) {
    for (let index = 0; index + length <= text.length; index += 1) {
      const window = text.slice(index, index + length);
      if (!isEvidenceWindow(window)) continue;
      if (needle.includes(window)) return window;
    }
  }
  return "";
}

/** The text of one asset, strongest evidence first. Each field is scored alone. */
export function assetMatchFields(asset) {
  const fields = [
    { field: "poiName", text: asset?.poi?.poiName },
    { field: "photoTitle", text: asset?.poi?.photoTitle },
    { field: "alt", text: asset?.alt },
    { field: "name", text: asset?.name }
  ];
  return fields.filter((entry) => typeof entry.text === "string" && entry.text.trim());
}

/**
 * False when the only shared text is the name of an administrative unit the
 * photo already belongs to.
 *
 * `childName` "江洪镇" against a lexeme of "江洪镇" (or the fragment "江洪")
 * tells us the sentence names the village — it does not tell us *which* of the
 * village's photos belongs here. The same holds one level up: a POI whose name
 * is just "乌石" or "雷州" matches every sentence in a video about 乌石镇.
 * Callers pass the whole hierarchy (province/city/county/town plus the photo's
 * own village), and any name that contains the lexeme disqualifies it.
 */
export function isDiscriminatingLexeme(lexeme, administrativeNames) {
  const needle = compactMatchText(lexeme);
  if (!needle) return false;
  const names = Array.isArray(administrativeNames) ? administrativeNames : [administrativeNames];
  return !names.some((name) => {
    const unit = compactMatchText(name);
    return Boolean(unit) && unit.includes(needle);
  });
}

/**
 * Bind photos to one sentence.
 *
 * @returns `{ asset, keyword }[]`, best evidence first — possibly empty, which
 *   is a real answer: the caller should leave the scene without a photo instead
 *   of padding it with an arbitrary one.
 */
export function selectSceneAssetsForNarration(options) {
  const assets = Array.isArray(options?.assets) ? options.assets : [];
  const narration = options?.narration;
  const regionId = options?.regionId;
  const limit = Number.isFinite(options?.limit) ? Math.max(0, Number(options.limit)) : 2;
  const regionNames = Array.isArray(options?.regionNames) ? options.regionNames : [];
  const childNameOf = typeof options?.childNameOf === "function"
    ? options.childNameOf
    : (asset) => asset?.poi?.childName;

  if (!compactMatchText(narration) || limit === 0) return [];

  const scored = [];
  assets.forEach((asset, index) => {
    if (asset?.type !== "image") return;
    // Compliance guard: conference/meeting photos are prohibited project-wide
    // (`packages/project-schema/index.ts` rejects them), so never bind one.
    if (asset.prohibitedContent) return;
    if (regionId && asset.scope?.regionId && String(asset.scope.regionId) !== String(regionId)) return;
    // Everything that only says "this photo was taken here": the region's own
    // chain (province/city/county/town) plus the photo's village. A POI literally
    // named after its town — 乌石 under 乌石镇, 雷州 under 雷州市 — hits every
    // sentence in the video and identifies no photo in particular.
    const administrativeNames = [...regionNames, childNameOf(asset)];
    let best = null;
    for (const entry of assetMatchFields(asset)) {
      const lexeme = narrationLexeme(entry.text, narration);
      if (!lexeme) continue;
      if (!isDiscriminatingLexeme(lexeme, administrativeNames)) continue;
      const score = lexeme.length * LEXEME_LENGTH_WEIGHT + (FIELD_PRIORITY[entry.field] ?? 0);
      if (!best || score > best.score) best = { lexeme, score };
    }
    if (!best) return;
    const photoIndex = Number(asset?.poi?.photoIndex);
    scored.push({ asset, keyword: best.lexeme, score: best.score, photoIndex: Number.isFinite(photoIndex) ? photoIndex : Number.POSITIVE_INFINITY, index });
  });

  // Ties used to fall through to `localeCompare`, i.e. Chinese alphabetical
  // order, which has nothing to do with fitness. Break them by Amap's own photo
  // order — its first photo of a POI is the one it chose to surface — and then
  // by insertion order, which is at least stable.
  scored.sort((a, b) => b.score - a.score || a.photoIndex - b.photoIndex || a.index - b.index);
  return scored.slice(0, limit).map((entry) => ({ asset: entry.asset, keyword: entry.keyword }));
}
