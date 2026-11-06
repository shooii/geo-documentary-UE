/**
 * Export a Studio scheme to a spreadsheet, let a human edit it, then import it
 * back — with a full pre-validation pass before anything is written.
 *
 * The scheme is a `VideoProject`: only a handful of fields are safe to hand to
 * a human (`title`, the narration, the film-image binding, and whole new
 * overview scenes). Everything else — camera framing, timing, imagery, voice,
 * section wiring — is either machine-owned or validated into existence by the
 * boundaries it was authored against, so the workbook never exposes it and the
 * import never touches it.
 *
 * 旁白 and 字幕 share one column. Both fields survive in the scheme, but a human
 * writes one text and the import writes it to both, so the subtitle can never
 * drift away from the narration it subtitles and no semantic comparison is
 * needed to keep them together. 时长 is not exported at all: it is recomputed
 * from the narration audio at render time, so a column for it would only offer
 * a number nobody can meaningfully edit.
 *
 * The rules that matter are enforced the same way the saved-project path
 * enforces them:
 *   - `findVisualAnchorIssues` reports photo keywords that no longer occur in
 *     their scene, which is how a rewritten narration silently re-anchors a
 *     photo to a different village.
 *   - `validateVideoProject` runs on the merged result as the final backstop.
 *
 * The import is deliberately all-or-nothing: any error and the whole file is
 * rejected, so a partially-edited scheme can never be saved.
 *
 * Export also embeds a thumbnail of every film image inside the scene sheet, so
 * a human can see which picture each row describes. Every thumbnail is fitted
 * into one shared box and drawn at that size, so a row of them can be given a
 * single column width and row height and the sheet stays a readable contact
 * sheet — full-size photos spilled across their neighbours and made the file
 * enormous. It is pure decoration: nothing reads it back, and a missing or
 * unreadable file costs only that one picture, never the export.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join, normalize } from "node:path";
import sharp from "sharp";
import {
  validateVideoProject,
  type AssetPlacement,
  type SceneType,
  type StudioAsset,
  type StudioScene,
  type VideoProject
} from "../../packages/project-schema/index.js";
import { findVisualAnchorIssues } from "../../packages/content-engine/visual-anchoring.js";
import { selectSceneAssetsForRender } from "../../packages/render-spec/index.js";
import {
  isWrittenPreview,
  pictureHash,
  readXlsx,
  readXlsxImages,
  writeXlsx,
  type SheetCell,
  type SheetEmbeddedImage,
  type SheetImage,
  type SheetSpec,
  type SheetTable
} from "../../packages/workbook-sheet/index.js";
import { writeJsonVersionResilient } from "./fs-resilience.js";

export const SCENE_SHEET = "场景";
export const LIBRARY_SHEET = "素材库";
export const NOTES_SHEET = "说明";
export const WORKBOOK_VERSION = 5;
/**
 * Marker written into the 说明 sheet stating that this export stamps its
 * thumbnails (see `isWrittenPreview`).
 *
 * The import needs to know before it interprets a single drawing: on a sheet
 * without the marker it cannot tell a stale thumbnail from a freshly pasted
 * photo, and guessing "pasted" would register a hundred previews as new assets.
 * So a sheet that predates the marker keeps the old behaviour -- pictures are
 * ignored -- and says so.
 */
const IMAGE_MARKER_VERSION = "wrk-preview-1";

/** Blank, pre-unlocked rows appended so a human can type new scenes below the data. */
const TRAILING_ROWS = 30;
/** Spare 成片素材 columns so an editor can add film images a scene does not have yet. */
const FILM_ASSET_SPARE_COLUMNS = 2;

/**
 * Fixed columns on either side of the variable film-asset column family.
 *
 * 旁白 and 字幕 are one column: the scheme still keeps both fields, but a human
 * edits one text and the import writes it to both, so a subtitle can never drift
 * away from the narration it is meant to follow. 时长 is deliberately absent —
 * it is recomputed from the narration audio at render time, so exporting it only
 * invited someone to edit a number that does nothing.
 */
/*
 * Two columns that used to sit here are gone, and the reason matters:
 *
 * - 原始id was an anchor the script wrote so that rewriting 场景id counted as a
 *   rename of the *same* scene. That made an id column that was not the key,
 *   which is exactly the confusion worth removing: there is now one id, it is
 *   the key, and rows are matched to scenes by it.
 * - 操作 held a hand-maintained copy of something the rows already say. The sheet
 *   is read as the scene list itself: a row means the scene is there, no row
 *   means it is gone, an extra row means a new scene. Nothing to keep in sync.
 *
 * Both are still *read* when present, so a workbook exported before this change
 * keeps working.
 */
const SCENE_LEFT_HEADERS = ["顺序", "场景id", "章节", "场景类型", "场景名称", "旁白字幕"] as const;
const SCENE_RIGHT_HEADERS = ["校验提示"] as const;

const LIBRARY_HEADERS = ["素材id", "素材名称", "类型", "来源", "路径"] as const;

/** A1-style column letter of a scene-sheet column, taken from the header itself. */
function sceneColumnLetter(name: string): string {
  const position = (SCENE_LEFT_HEADERS as readonly string[]).indexOf(name);
  if (position < 0) throw new Error(`未知的场景表列：${name}`);
  return String.fromCharCode(65 + position);
}

/*
 * Column widths, keyed by header name instead of listed by position.
 *
 * Two separate bugs came out of positional lookups into a width array: a column
 * whose width landed in the XML as `width="NaN"`, and row heights that silently
 * became NaN so the rows carrying preview pictures lost their height. Keyed like
 * this, adding or removing a column cannot shift anybody else's width, and a
 * missing entry is a compile error rather than `undefined` at runtime.
 */
const SCENE_LEFT_WIDTHS: Record<(typeof SCENE_LEFT_HEADERS)[number], number> = {
  顺序: 6,
  场景id: 30,
  章节: 11,
  场景类型: 14,
  场景名称: 26,
  旁白字幕: 72
};
/** Column widths of one film-image slot, named so nothing has to index by position. */
const FILM_ID_WIDTH = 38;
const FILM_NAME_WIDTH = 30;
const FILM_PREVIEW_WIDTH = 14;
/**
 * One column of a film-image slot.
 *
 * The id column is the only way to choose or reorder a scene's pictures from the
 * sheet, so it is always written; 素材名称N and the 成片预览N thumbnail follow it
 * for a human to read. (A picture-less variant existed for a while and was dropped:
 * more than one person edited pictures in it and concluded the import was broken,
 * because that sheet cannot carry a picture at all.)
 *
 * 素材关键词 used to be another column here. It is gone on purpose: the keywords
 * are an internal anchoring contract (they cross-check the narration against the
 * picture), not something to hand-edit in a spreadsheet, and inviting an edit
 * meant inviting a silent 图文锚定错位. The column is still *read* when present.
 */
interface FilmSlotColumn {
  header: (position: number) => string;
  width: number;
  cell: (assetId: string, asset: StudioAsset | undefined) => SheetCell;
}

/** 成片素材 / 素材名称 / 成片预览, repeated once per film image. */
function filmSlotColumns(): FilmSlotColumn[] {
  const name: FilmSlotColumn = {
    header: (position) => `素材名称${position + 1}`,
    width: FILM_NAME_WIDTH,
    cell: (_assetId, asset) => ({ value: asset?.name ?? "", style: "lockedText" })
  };
  // The preview column always sits last in the slot; it holds the picture, so its
  // cells stay empty on purpose (see the anchored images below).
  const preview: FilmSlotColumn = {
    header: (position) => `成片预览${position + 1}`,
    width: FILM_PREVIEW_WIDTH,
    cell: () => ({ value: "", style: "lockedText" })
  };
  const id: FilmSlotColumn = {
    header: (position) => (position === 0 ? "成片素材1(首图)" : `成片素材${position + 1}`),
    width: FILM_ID_WIDTH,
    cell: (assetId) => ({ value: assetId, style: "text" })
  };
  return [id, name, preview];
}

const SCENE_RIGHT_WIDTHS: Record<(typeof SCENE_RIGHT_HEADERS)[number], number> = { 校验提示: 30 };
const LIBRARY_WIDTHS = [28, 34, 8, 16, 54];

/** The narration column, as it was called before the merge. */
const LEGACY_NARRATION_HEADER = "旁白";

/**
 * Child scenes carry their sub-district in the id itself, `child-<childId>`. The
 * renderer parses the prefix back out to schedule the tour, so the convention is
 * a contract, not a naming preference.
 */
const CHILD_ID_PREFIX = "child-";

/**
 * The 操作 column, kept only for sheets exported before it was dropped.
 *
 * Current exports do not write it: the rows themselves say which scenes exist.
 * When an older sheet still carries it its value is still honoured, so whoever
 * has one open in Excel gets exactly what its own 说明 promised.
 */
const ACTIONS = ["保留", "新增", "删除"] as const;
type RowAction = (typeof ACTIONS)[number];

const SECTION_TYPES: Record<string, readonly SceneType[]> = {
  cover: ["cover"],
  overview: ["map-overview", "image-card", "fact-card"],
  child: ["region-focus"],
  // 结尾补充 plays after the pull-back, so it speaks the overview vocabulary.
  "outro-lead": ["map-overview", "image-card", "fact-card"],
  outro: ["outro"]
};

const SECTION_RANK = { cover: 0, overview: 1, child: 2, outro: 3, "outro-lead": 4 } as const;

/** Sections whose rows may be added from the sheet, with their id prefix. */
const ADDABLE_SECTIONS = ["overview", "outro-lead"] as const;
type AddableSection = (typeof ADDABLE_SECTIONS)[number];

const WORKBOOK_NOTES = [
  "地理图说 · 方案表格往返说明",
  "",
  "1. 表格＝方案：「场景」页有几行，方案里就有几个场景。行没了＝那个场景被删除，多出来的行＝新增场景，导入按「场景id」把每一行挂到对应场景上。",
  "2. 场景id 是主键（和 素材id 一样），不要改它：改了这行就挂不上任何场景，而原来那个场景因为没了行会被当成删除，导入会直接拒绝并告诉你哪里对不上。要改显示名请改「场景名称」。",
  "3. 新增：在目标位置插入一行（也可以用表格末尾预留的空行），「场景id」留空（脚本会自动分配；也可以自己填一个不重名、只含字母、数字、点、下划线和短横线的 id），「章节」填 overview 或 outro-lead，「场景类型」填 map-overview / image-card / fact-card，再填好「场景名称」与「旁白字幕」。新增只允许落在「总体介绍」与「结尾补充」两个区块。",
  "4. 删除：把整行删掉即可。⚠️ 导入前请确认没有筛选、隐藏或误删造成的行缺失 —— 表格里没有的行就会被当作删除。封面与拉回结尾不能删（见第 5 条）。",
  "5. 封面(cover)与拉回结尾(outro)：全片必须且只能各有一个，不能新增也不能删除；封面标题锁定为行政区标签，两者的场景id 也不可修改。",
  "6. 结尾补充(outro-lead)：可增删改，位置固定在拉回上级区域结尾之后，是影片最后的镜头，用来在画面拉回上级区域之后再补充内容。它的场景类型与总体介绍一致（map-overview / image-card / fact-card），也可以绑定成片素材，写法与 overview 行完全相同。全文顺序必须保持：封面 → 总体介绍 → 行政区巡游 → 拉回上级区域结尾 → 结尾补充。",
  "7. 行政区巡游(child)：id 必须保持 child-<childId> 形式且对应真实下级行政区划，不能凭空新增，也不能改 id（巡游靠它定位下级区划）。",
  "8. 旁白字幕：一列同时充当旁白与字幕，改它就是改配音稿，字幕会一并跟随，因此不存在“字幕与旁白不一致”的问题。留空表示沿用原旁白。",
  "9. 成片素材1(首图)、成片素材2…：只列出会进入成片的图片，一格填一张图（也可以把名称填在旁边的 素材名称N 里，见第 12 条）；第 1 格是首图（成片的第一张），其余按成片顺序排列。每格可以填三种东西：① 素材id（形如 3f2a…，脚本本来就会写）；② 素材名称（只要与素材库里某一个完全相同就行，末尾的「 · 」可省略）；③ 图片路径（先在 Studio 上传，或把文件放进 workspace/assets 或仓库内目录）。填路径时如果这张图还不在素材库，导入会自动把它登记成新素材，名称取你在旁边 素材名称N 里填的那个，并在结果里告诉你分配到的 id。用不到的格子留空。",
  "10. 只导出进入成片的图片；方案里其余的图片绑定仍然保留，导入不会删除它们，只是不进成片。",
  "11. ⚠️ 如果这份表格里整列都没有「成片素材N」（有些旧版本导出的表格就是这样），导入不会改动任何图片，也不会动素材库；成片预览N 里的缩略图更是从不被读取 —— 在这种表格里换图、删图都不会生效。重新导出一次即可（新表格一律带 成片素材N），或者直接在 Studio 里点素材的「设为首图」。反过来，格子在但留空＝这张不进成片。",
  "12. 素材名称N：正常情况下由脚本按 成片素材N 自动填写，不用管它。但如果对应的 成片素材N 是空的、而你在这里写了一个名字，导入就按这个名字找图并用上它（这时它和 成片素材N 一样，可以填 素材id / 素材名称 / 图片路径）。想「把这张图从成片里去掉」请清空 成片素材N 并且不要改这一格。",
  "13. 素材关键词 不再导出到表格：它是脚本与渲染器之间的“图文锚定”契约（用来校验旁白里有没有真的提到这张图），在 Excel 里手改很容易造成锚定错位，所以从表格里撤掉了。表格里看不到 ≠ 被删掉 —— 导入会原样保留方案里已有的锚定关键词。（用旧版本导出、仍带 素材关键词N 列的表格照旧可以编辑。）",
  "14. 顺序 仅供阅读。时长不导出：它会在导出成片时按旁白音频重新计算，改表格里的任何内容都不会直接改时长。",
  "15. 导入前会先做完整预校验，全部通过才会保存；任一失败都会逐行报错并中止，绝不写入任何内容。",
  "16. 表格会记录导出时的方案指纹。只要方案内容没变（例如 Studio 只是自动保存过、或改了相机/时长这类表格不涉及的字段），你手上的表格照旧可以导入；只有内容真的变了（场景增删改、旁白、素材库等）才会被拦下，那样请重新导出后再编辑。",
  "17. 导入成功后会自动写回本方案（生成新的 revision），Studio 里的画面与场景列表随即刷新，无需手工替换方案文件。",
  "18. 成片预览N：脚本把对应成片素材的缩略图内嵌在这里，统一 240×180、等比缩放，只为人工核对画面用对没用对。它不是原图，请勿据此校色或裁切。⚠️ 但你可以把自己要用的图片**直接粘贴/插入到这一格**（覆盖或放在旁边都行）：导入会把它读出来、登记成新素材并放进本场景的成片，等同于在 Studio 上传这张图。脚本自己内嵌的缩略图带识别标记，永远不会被误当成你贴的图。",
  "19. 「场景」「素材库」两页已加内外边框，仅覆盖有内容的区域；本说明页不加边框。边框只是阅读辅助，不影响任何数据，导入时完全不读取。",
  "20. 「素材库」页可增删改，导入同样生效：新增一行即注册一张新图片 —— 素材id 留空就行，脚本会自动分配一个 id（和「场景id 留空＝新增」是同一套规则），你只要填 素材名称 / 类型 / 路径；删除一行即从方案中移除该素材，并自动解除所有场景对它的绑定（若该素材仍被场景引用，请同时在「场景」页把对应 成片素材N 格子清空）；改 素材名称 或 路径 会同步更新方案里的素材信息。",
  "21. 「素材库」页新增行时的 路径 必须指向磁盘上已存在的图片文件（形如 /workspace-assets/xxx.jpg 或 assets/source/<区域码>/xxx.jpg）：这一列的路径是指向已有文件的，不会凭空造图。文件不存在会报错并拒绝导入 —— 这种情况下更省事的做法是不要在这一页新增，而是按第 27 条把图片直接贴到「场景」页；或者先用 Studio 上传图片，再回来填这里。",
  "22. 留空 素材id 新增之后，导入结果里会告诉你分配到的 id。这个 id 就是 成片素材N 要填的值：如果这张新图同时要进成片，可以导入一次（先把素材注册进方案），重新导出表格后把 id 填进 成片素材N，再导入第二次。想一次填好也行：自己指定一个不重名的 素材id（字母、数字、点、下划线、短横线，以字母或数字开头）。",
  "23. 素材id 是主键，导入后不可修改：要改显示名请改 素材名称，不要改 素材id —— 改了 素材id 会被当成「少了一个素材 + 新增一个素材」，等于换图。",
  "24. 新增素材的 类型 只能是 image / video / audio；来源 可填 verified-real / user-provided / generated-illustrative / amap-poi，留空亦可。",
  "25. 既有素材（素材id 已在方案里）的 类型 与 来源 是锁定的，改了会被拒绝导入（不是静默忽略）。要更换类型请把该行删掉后重新新增；路径可以改，但新路径同样必须指向磁盘上真实存在的文件。",
  "26. 既有场景的顺序不可通过表格调整：拖动整行会被判为「顺序被调整」并拒绝导入。调整顺序请在 Studio 里拖动场景卡片。",
  "27. 换图有三条路，任选其一：① 改 成片素材N 里的内容（素材id / 素材名称 / 图片路径，见第 9 条）；② 直接把图片**粘贴/插入到 成片预览N 格子里** —— 导入会读出这张图，自动登记为新素材（文件存为 /workspace-assets/sheet-<哈希>.png）并放进该场景成片，等同于在 Studio 上传，不需要先有素材id；③ 在 Studio 里选中场景后点素材的「设为首图」。同一行里如果既有文字又有你贴的图，**以你贴的图为准**。贴进来的图请用 PNG / JPEG / WebP，单张不超过 15 MB；贴在其它列上的图片不会生效（导入会提示你）。",
  "28. 旧版表格仍然可用：早先导出、带「操作」和「原始id」列的表格照旧能导入 —— 「操作＝删除」照样生效，只是现在「整行删掉」和它是一个意思。但「原始id」已不参与识别，那版表格如果改过「场景id」，导入会拒绝并提示对不上，重新导出一次即可。"
].join("\n");

export interface WorkbookIssue {
  /** 1-based spreadsheet row, or null for a whole-file problem. */
  row: number | null;
  message: string;
}

export interface MergeResult {
  ok: boolean;
  project: VideoProject;
  revision: number;
  addedScenes: string[];
  deletedScenes: string[];
  changedScenes: string[];
  /**
   * 素材库 rows this import changed (added / removed / renamed / repathed).
   *
   * Counted separately from the scenes because the panel sums them to decide
   * whether to say "nothing changed" -- and asset-only edits used to fall through
   * that sum, so an operator who renamed an asset was told the sheet was identical.
   */
  changedAssets: number;
  /**
   * Picture files this import created from pictures embedded in the sheet.
   *
   * The bytes are here rather than on the disk because a pre-check must not
   * write anything: only the caller knows whether this run commits. Whoever
   * writes the scheme writes these first, or the scheme would point at files
   * that do not exist yet.
   */
  pendingAssets: PendingSheetAsset[];
  warnings: string[];
  errors: WorkbookIssue[];
  needsNarrationRegen: boolean;
}

interface ParsedRow {
  rowNumber: number;
  /** Only ever non-default on an older sheet that still carries 操作. */
  action: RowAction;
  /**
   * The id this row carries, and therefore the scene it stands for: blank for a
   * row that adds a scene, otherwise the id of the scene it updates.
   */
  sceneId: string;
  section: string;
  sceneType: string;
  title: string;
  /** The one 旁白字幕 cell, already resolved to the text the scene should carry. */
  narration: string;
  subtitle: string;
  assetIds: string[];
  keywordGroups: string[][];
}

interface KeywordRemoval {
  row: number;
  title: string;
  keyword: string;
  count: number;
}

function defaultPlacement(asset: StudioAsset | undefined): AssetPlacement {
  return {
    assetId: asset?.id ?? "",
    fit: "cover",
    crop: { x: 0, y: 0, width: 1, height: 1 },
    focalPoint: { x: 0.5, y: 0.5 },
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    animation: "push-in",
    leadSeconds: 0.2,
    tailSeconds: 0.15,
    minimumDisplaySeconds: 2,
    requiredKeywords: [],
    alt: asset?.alt || asset?.name || ""
  };
}

/** Human-readable section names, shared by the row-level error messages. */
const SECTION_LABELS: Record<string, string> = {
  cover: "封面",
  overview: "总体介绍",
  child: "行政区巡游",
  outro: "拉回结尾",
  "outro-lead": "结尾补充"
};

/** Mirror of `studio.js addScene()` so a new row matches the editor's own default. */
export function newOverviewScene(id: string, title: string, narration: string, type: SceneType, section: AddableSection = "overview"): StudioScene {
  const duration = 4;
  return {
    id,
    type,
    section,
    title,
    narration,
    subtitle: narration,
    duration,
    assetIds: [],
    placements: [],
    timing: { actualNarrationSeconds: duration, preHoldSeconds: 0, postHoldSeconds: 0, minimumVisualSeconds: duration, mapHoldSeconds: 0 }
  };
}

/** A fresh unused id for an added row, shaped after the block it joins. */
function uniqueAddedSceneId(taken: Set<string>, section: AddableSection): string {
  const prefix = section === "outro-lead" ? "outro-lead" : "overview-content";
  let stamp = Date.now();
  let id = `${prefix}-${stamp.toString(36)}`;
  while (taken.has(id)) {
    stamp += 1;
    id = `${prefix}-${stamp.toString(36)}`;
  }
  return id;
}

/** A scene id a human typed in the sheet: no whitespace, no path-ish characters. */
const SCENE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A fresh unused id for an added library row whose 素材id was left blank.
 *
 * Same convention as `uniqueAddedSceneId`: the operator should never have to
 * invent a primary key just to add a picture, and a blank key is what "this row
 * is new" looks like on the scene sheet too. The generated id satisfies
 * `ASSET_ID_PATTERN` and is reported back in the import result, because it is
 * what a later 成片素材N cell has to reference.
 */
function uniqueAddedAssetId(taken: Set<string>): string {
  let stamp = Date.now();
  let id = `asset-${stamp.toString(36)}`;
  while (taken.has(id)) {
    stamp += 1;
    id = `asset-${stamp.toString(36)}`;
  }
  return id;
}

/**
 * Whether a renamed id is structurally safe for its section.
 *
 * A child scene's id is load-bearing: the renderer recovers the sub-district from
 * the `child-<childId>` prefix (render-engine `writeChildCueRanges`), so an
 * arbitrary rename would silently break the tour schedule. Any other section
 * uses the id purely as a key, so a new unique id is harmless.
 */
function sceneIdProblem(section: string, id: string): string | null {
  if (!id) return "场景id 不能为空";
  if (!SCENE_ID_PATTERN.test(id)) return "场景id 只能包含字母、数字、点、下划线和短横线，且必须以字母或数字开头";
  if (section === "child") {
    if (!id.startsWith(CHILD_ID_PREFIX)) return `行政区巡游(child)的场景id 必须以「${CHILD_ID_PREFIX}」开头（形如 child-<childId>），否则无法定位该下级行政区`;
    if (id.length === CHILD_ID_PREFIX.length) return "行政区巡游(child)的场景id 缺少 childId 部分";
  } else if (id.startsWith(CHILD_ID_PREFIX)) {
    return `只有行政区巡游(child)的场景id 能以「${CHILD_ID_PREFIX}」开头`;
  }
  return null;
}

/** An asset id a human typed in the library sheet. Looser than a scene id:
 * market/library ids come from the importer as bare uuids and POI slugs, and
 * both only ever use these characters. */
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const ASSET_TYPES = ["image", "video", "audio"] as const;
type AssetType = (typeof ASSET_TYPES)[number];

const ASSET_SOURCE_TYPES = ["verified-real", "user-provided", "generated-illustrative", "amap-poi"] as const;

/** One row of the 素材库 sheet, already validated. */
interface ParsedAssetRow {
  rowNumber: number;
  id: string;
  name: string;
  path: string;
  type: AssetType;
  sourceType?: StudioAsset["sourceType"];
}

/**
 * Where a path points, in the two shapes the scheme speaks.
 *
 * The workbook can only carry a path, never the picture itself, so an added
 * asset is a *reference* to a file that must already be on disk. `kind` decides
 * how that reference is resolved (workspace library vs. inside the project) and
 * therefore what "the file exists" has to check.
 */
type AssetPathTarget =
  | { kind: "workspace"; file: string }
  | { kind: "project"; file: string }
  | { kind: "missing" }
  | { kind: "invalid"; reason: string };

function classifyAssetPath(root: string, rawPath: string): AssetPathTarget {
  const path = String(rawPath ?? "").trim();
  if (!path) return { kind: "invalid", reason: "路径不能为空" };
  if (path.includes("..")) return { kind: "invalid", reason: "路径不允许包含 “..”" };
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return { kind: "invalid", reason: "路径必须是仓库内相对路径或以 /workspace-assets/ 开头，不接受 URL" };
  if (path.startsWith("/workspace-assets/")) {
    const relative = path.slice("/workspace-assets/".length);
    if (!relative) return { kind: "invalid", reason: "/workspace-assets/ 后面缺少文件名" };
    const file = join(root, "workspace", "assets", relative);
    return existsSync(file) ? { kind: "workspace", file } : { kind: "missing" };
  }
  if (path.startsWith("/project-assets/")) {
    const relative = path.slice("/project-assets/".length);
    if (!relative) return { kind: "invalid", reason: "/project-assets/ 后面缺少文件名" };
    const file = normalize(join(root, relative));
    return existsSync(file) ? { kind: "project", file } : { kind: "missing" };
  }
  if (path.startsWith("/")) return { kind: "invalid", reason: "只支持以 /workspace-assets/ 或 /project-assets/ 开头的绝对路径，或仓库内相对路径" };
  const file = normalize(join(root, path));
  return existsSync(file) ? { kind: "project", file } : { kind: "missing" };
}

/** Names are compared loosely: the library's own names end in a separator. */
function normalizeAssetName(name: string): string {
  return String(name ?? "").replace(/\s+/g, " ").trim().replace(/[·\s]+$/u, "");
}

/**
 * What one 成片素材N cell may contain, tried in this order:
 *
 *   1. a 素材id from the library -- the precise form, and what the export writes;
 *   2. a 素材名称 that matches exactly one asset -- what a human actually
 *      remembers, compared loosely so the library's trailing " · " is optional;
 *   3. a path to a picture that is already on disk inside the workspace or the
 *      repository: it is registered as an asset and used.
 *
 * Order matters only for the ambiguous middle case, which is refused rather than
 * guessed at. The whole cell is tried before any splitting, because a name
 * legitimately contains spaces and separators ("六格村 · 有隆古井 · ") and a path
 * may contain spaces too -- splitting first would tear them into pieces and
 * report the unhelpful "one id per cell" error.
 *
 * Registering rather than refusing is the point: an operator with eleven photos
 * of one village should not have to look up a UUID, nor open a second sheet.
 */
function resolveFilmReference(
  reference: string,
  context: { root: string; assets: Map<string, StudioAsset>; taken: Set<string>; nameHint: string }
): { asset: StudioAsset; registered: boolean; how: string } | { problem: string } {
  const value = String(reference ?? "").trim();
  if (!value) return { problem: "空引用" };
  const known = context.assets.get(value);
  if (known) return { asset: known, registered: false, how: "素材id" };

  const wanted = normalizeAssetName(value);
  const byName = [...context.assets.values()].filter((asset) => normalizeAssetName(asset.name) === wanted);
  if (byName.length === 1) return { asset: byName[0]!, registered: false, how: `素材名称「${byName[0]!.name}」` };
  if (byName.length > 1) {
    return { problem: `成片素材「${value}」匹配到 ${byName.length} 张同名素材，无法确定是哪一张。请改填素材id：${byName.slice(0, 3).map((asset) => asset.id).join("、")}${byName.length > 3 ? " …" : ""}` };
  }

  const target = classifyAssetPath(context.root, value);
  const samePath = [...context.assets.values()].find((asset) => asset.path === value);
  if (samePath) return { asset: samePath, registered: false, how: "已有素材的路径" };
  if (target.kind === "workspace" || target.kind === "project") {
    const id = uniqueAddedAssetId(context.taken);
    context.taken.add(id);
    const asset: StudioAsset = {
      id,
      // The neighbouring 素材名称N cell is the operator's own name for the
      // picture; without it, the file name. Never blank.
      name: context.nameHint.trim() || basename(value).replace(/\.[^.]+$/, ""),
      path: value,
      type: "image",
      sourceType: "user-provided"
    };
    context.assets.set(id, asset);
    return { asset, registered: true, how: `路径 ${value}` };
  }
  /* Lead with the case at hand: "this id is not in the library" is the diagnosis an
     operator who mistyped an id needs, "this is not any of the three forms" is the
     one for a cell that was never a reference at all. */
  const looksLikeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
  const head = looksLikeId
    ? `成片素材「${value}」在素材库中不存在，也不是磁盘上存在这个文件名的图片路径`
    : `成片素材「${value}」不是素材库里的素材id、也不对应唯一的素材名称（${target.kind === "missing" ? "磁盘上也没有这个文件" : target.reason}）`;
  return { problem: `${head}。一个格子可以填：① 素材id（形如 3f2a…）；② 素材名称（必须与素材库里某一个完全相同）；③ 图片路径（先在 Studio 上传，或把文件放进 workspace/assets 或仓库内目录，再照原样填进来）。` };
}

/**
 * Read and validate the 素材库 sheet against the scheme it was exported from.
 *
 * The library is the one place a human can grow the picture set: a new row
 * registers a texture the scene sheet may then reference, a removed row takes
 * the asset (and every scene reference to it) with it, and an edited name/path
 * patches the scheme's metadata. The id is the key, so it may not change —
 * renaming an asset means editing 素材名称, not 素材id.
 *
 * A file the sheet points at has to really exist: a workbook carries paths, not
 * bytes, so a typo would otherwise register an asset the renderer can never
 * load. Missing sheets are tolerated (older exports), in which case the library
 * is left exactly as it was.
 */
function parseAssetLibrary(
  root: string,
  table: SheetTable | undefined,
  existing: ReadonlyMap<string, StudioAsset>,
  fail: (row: number | null, message: string) => void,
  warn: (message: string) => void
): Map<string, ParsedAssetRow> | null {
  if (!table) return null;
  const header = table.rows[0] ?? [];
  const { index, missing } = columnIndexes(header, LIBRARY_HEADERS);
  if (missing.length) {
    fail(null, `「${LIBRARY_SHEET}」缺少必需列：${missing.join("、")}`);
    return null;
  }
  const rows = new Map<string, ParsedAssetRow>();
  const seenIds = new Set<string>();
  /** Every id an added row may not take: the scheme's ids plus the ones minted here. */
  const taken = new Set<string>(existing.keys());
  for (let cursor = 1; cursor < table.rows.length; cursor += 1) {
    const row = table.rows[cursor] ?? [];
    // Identifiers, paths and enums are trimmed so stray whitespace cannot make
    // them mismatch. 素材名称 is free text and must NOT be: an asset name
    // legitimately ends in a separator ("… · "), and trimming it here silently
    // rewrote the name of every such asset on each import.
    const rawValue = (name: string): string => cellAt(row, index, name);
    const value = (name: string): string => rawValue(name).trim();
    const nameCell = rawValue("素材名称");
    const typedId = value("素材id");
    // A trailing blank row (Excel pads to its used range) is not a deletion.
    if (!typedId && !nameCell.trim() && !value("路径") && !value("类型")) continue;
    const rowNumber = cursor + 1;
    /* A blank 素材id means "this row registers a new picture" -- the same rule the
       scene sheet already uses for 场景id. Making the operator invent a primary
       key was the single most awkward part of adding an image; the id is minted
       here and reported back so it can be referenced from 成片素材N afterwards. */
    const id = typedId || uniqueAddedAssetId(taken);
    if (!ASSET_ID_PATTERN.test(id)) {
      fail(rowNumber, `第${rowNumber}行：素材id「${id}」只能包含字母、数字、点、下划线和短横线，且必须以字母或数字开头`);
      continue;
    }
    if (seenIds.has(id)) {
      fail(rowNumber, `第${rowNumber}行：素材id「${id}」与上一行重复`);
      continue;
    }
    // An existing id is a reference to an asset already in the scheme, so its
    // identity fields are locked; only the display name and path may be revised.
    // Locked fields are REFUSED rather than quietly ignored: an ignored edit lets
    // the operator believe a successful import carried their change, which is the
    // one outcome a round-trip must never produce.
    if (existing.has(id)) {
      seenIds.add(id);
      const current = existing.get(id)!;
      const typedType = value("类型");
      if (typedType && typedType !== current.type) {
        fail(rowNumber, `第${rowNumber}行：素材「${id}」的 类型 不可修改（原为 ${current.type}）。类型决定渲染器怎么加载它，如需换成别的类型请删除该行后重新新增。`);
        continue;
      }
      const typedSource = value("来源");
      if (typedSource && typedSource !== (current.sourceType ?? "")) {
        fail(rowNumber, `第${rowNumber}行：素材「${id}」的 来源 不可修改（原为 ${current.sourceType ?? "（空）"}）`);
        continue;
      }
      // The path MAY be revised, but only to something that really resolves. A
      // dangling path imports cleanly and then fails at render time, so it has to
      // be caught here. Untouched paths skip the check entirely, which keeps an
      // unmodified sheet byte-for-byte idempotent even when the project was moved
      // and its stored paths no longer resolve on this machine.
      const typedPath = value("路径");
      if (typedPath && typedPath !== current.path) {
        const target = classifyAssetPath(root, typedPath);
        if (target.kind === "invalid") {
          fail(rowNumber, `第${rowNumber}行：素材「${id}」的新 路径 ${target.reason}`);
          continue;
        }
        if (target.kind === "missing") {
          fail(rowNumber, `第${rowNumber}行：素材「${id}」的新 路径「${typedPath}」在磁盘上找不到文件。表格不携带图片本身，请先把图片放进素材库（Studio 上传或拷进 workspace/assets）再填这里。`);
          continue;
        }
      }
      rows.set(id, {
        rowNumber,
        id,
        name: nameCell.trim() ? nameCell : current.name,
        path: typedPath || current.path,
        type: current.type,
        sourceType: current.sourceType
      });
      continue;
    }
    const name = nameCell;
    if (!name.trim()) {
      fail(rowNumber, `第${rowNumber}行：新增素材「${id}」缺少 素材名称`);
      continue;
    }
    const type = value("类型") as AssetType;
    if (!(ASSET_TYPES as readonly string[]).includes(type)) {
      fail(rowNumber, `第${rowNumber}行：新增素材「${id}」的 类型 必须是 image / video / audio（当前为「${value("类型") || "空"}」）`);
      continue;
    }
    const path = value("路径");
    const target = classifyAssetPath(root, path);
    if (target.kind === "invalid") {
      fail(rowNumber, `第${rowNumber}行：新增素材「${id}」的 路径 ${target.reason}`);
      continue;
    }
    if (target.kind === "missing") {
      fail(rowNumber, `第${rowNumber}行：新增素材「${id}」的 路径「${path}」在磁盘上找不到文件。表格不能携带图片本身，请先把图片放进素材库（Studio 上传或拷进 workspace/assets）再填这里的路径。`);
      continue;
    }
    const sourceText = value("来源");
    const sourceType = (ASSET_SOURCE_TYPES as readonly string[]).includes(sourceText)
      ? (sourceText as StudioAsset["sourceType"])
      : undefined;
    if (sourceText && !sourceType) {
      fail(rowNumber, `第${rowNumber}行：新增素材「${id}」的 来源 只能是 ${ASSET_SOURCE_TYPES.join(" / ")}（当前为「${sourceText}」）`);
      continue;
    }
    seenIds.add(id);
    taken.add(id);
    rows.set(id, { rowNumber, id, name, path, type, sourceType });
    /* Say the generated id out loud: it is the key a 成片素材N cell has to use, and
       the operator cannot see it in the sheet they are editing. */
    if (!typedId) {
      warn(`第${rowNumber}行：新增素材「${name}」的 素材id 留空，已自动分配为 ${id}。下次导出表格即可看到该 id；若要让它进入成片，请在「场景」页的 成片素材N 填 ${id}。`);
    }
  }
  return rows;
}

function placementsByAsset(scene: StudioScene | null | undefined): Map<string, AssetPlacement> {
  const byAsset = new Map<string, AssetPlacement>();
  for (const placement of scene?.placements ?? []) if (!byAsset.has(placement.assetId)) byAsset.set(placement.assetId, placement);
  return byAsset;
}

/**
 * The images a scene actually contributes to the film, in film order. Reuses the
 * renderer's own selection rule (an explicit includeInRender flag wins, else the
 * legacy first-N rule) instead of re-deriving it, so the workbook can never
 * disagree with what the film shows.
 */
function filmAssetIds(scene: StudioScene): string[] {
  const candidates = (scene.placements ?? []).map((placement) => ({ id: placement.assetId }));
  return selectSceneAssetsForRender(scene, candidates).map((asset) => asset.id);
}

function splitAssetIds(value: string): string[] {
  return value.split(/[\s,，、;；]+/).map((item) => item.trim()).filter(Boolean);
}

function splitKeywords(value: string): string[] {
  const text = value.trim();
  return text ? text.split(/[,，、;；]+/).map((keyword) => keyword.trim()).filter(Boolean) : [];
}

interface FilmAssetSlot {
  /** Column holding this slot's asset id. */
  id: number;
  /** Column holding its 素材名称, or -1 when the sheet omitted it. */
  name: number;
  /**
   * Column holding its keywords, or -1 when the sheet omitted it.
   */
  keywords: number;
  /**
   * Column this slot's picture is drawn in (成片预览N), or -1 when the sheet has
   * no preview column. A picture pasted here -- or over the slot's id or name
   * cell -- is read as the operator supplying the photo itself.
   */
  preview: number;
}

/** Discover the variable 成片素材N / 素材关键词N column family, ordered by N. */
function filmAssetSlots(header: readonly string[]): FilmAssetSlot[] {
  const ids = new Map<number, number>();
  const names = new Map<number, number>();
  const previews = new Map<number, number>();
  const keywords = new Map<number, number>();
  header.forEach((name, position) => {
    const key = String(name ?? "").trim();
    const idMatch = /^成片素材(\d+)/.exec(key);
    if (idMatch) {
      const number = Number(idMatch[1]);
      if (!ids.has(number)) ids.set(number, position);
      return;
    }
    const nameMatch = /^素材名称(\d+)$/.exec(key);
    if (nameMatch) {
      const number = Number(nameMatch[1]);
      if (!names.has(number)) names.set(number, position);
      return;
    }
    const previewMatch = /^成片预览(\d+)$/.exec(key);
    if (previewMatch) {
      const number = Number(previewMatch[1]);
      if (!previews.has(number)) previews.set(number, position);
      return;
    }
    const keywordMatch = /^素材关键词(\d+)$/.exec(key);
    if (keywordMatch) {
      const number = Number(keywordMatch[1]);
      if (!keywords.has(number)) keywords.set(number, position);
    }
  });
  return [...ids.keys()].sort((a, b) => a - b).map((number) => ({
    id: ids.get(number)!,
    name: names.get(number) ?? -1,
    keywords: keywords.get(number) ?? -1,
    preview: previews.get(number) ?? -1,
  }));
}

function columnIndexes(header: readonly string[], required: readonly string[]): { index: Map<string, number>; missing: string[] } {
  const index = new Map<string, number>();
  header.forEach((name, position) => {
    const key = String(name ?? "").trim();
    if (key && !index.has(key)) index.set(key, position);
  });
  const missing = required.filter((name) => !index.has(name));
  return { index, missing };
}

/** Formats a 素材 can be registered from: the ones the Studio can serve back. */
type EmbeddedImageExtension = "png" | "jpeg" | "webp";

const IMAGE_CONTENT_TYPES: Record<EmbeddedImageExtension, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp"
};

/**
 * The picture's real format, read from its leading bytes rather than from the
 * part name: a mislabelled media part would otherwise register an asset whose
 * file the browser refuses to render.
 */
function embeddedImageExtension(data: Buffer): EmbeddedImageExtension | null {
  if (data.length > 8 && data.readUInt32BE(0) === 0x89504e47) return "png";
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpeg";
  if (data.length > 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

/**
 * Where a picture that arrived inside the sheet lands on disk.
 *
 * Content-addressed, for two reasons: importing the same sheet twice cannot
 * register the same photo twice, and a glance at the file name says this asset
 * came out of a sheet rather than out of an upload.
 */
function embeddedPicturePath(data: Buffer, extension: EmbeddedImageExtension): string {
  return `/workspace-assets/sheet-${createHash("sha1").update(data).digest("hex").slice(0, 16)}.${extension}`;
}

/** A picture file the import created but could not write; see `pendingAssets`. */
export interface PendingSheetAsset {
  asset: StudioAsset;
  data: Buffer;
}

interface EmbeddedRegistration {
  root: string;
  assets: Map<string, StudioAsset>;
  taken: Set<string>;
  pending: PendingSheetAsset[];
}

/**
 * Turn one picture from the sheet into an asset.
 *
 * This is the same move an upload makes -- bytes in, file out, asset registered
 * for the library -- except the bytes came from the workbook instead of a
 * multipart request. Impossible to express with a path, which is why the sheet
 * carries the picture at all.
 */
function registerEmbeddedPicture(
  image: SheetEmbeddedImage,
  name: string,
  context: EmbeddedRegistration
): { asset: StudioAsset; reused: boolean } | { problem: string } {
  if (image.data.length > 15_000_000) return { problem: `贴进来的图片有 ${Math.round(image.data.length / 1_048_576)} MB，超过 15 MB 上限。` };
  const extension = embeddedImageExtension(image.data);
  if (!extension) {
    return { problem: `贴进来的图片不是 PNG / JPEG / WebP（读到的是「${image.extension || "未知格式"}」），无法登记成素材。请贴这三种格式之一。` };
  }
  const path = embeddedPicturePath(image.data, extension);
  /* The same picture pasted in twice -- or a sheet re-imported after a fix --
     must reuse the asset it registered last time, not grow a twin. */
  const existing = [...context.assets.values()].find((asset) => asset.path === path);
  if (existing) return { asset: existing, reused: true };
  const id = uniqueAddedAssetId(context.taken);
  context.taken.add(id);
  const asset: StudioAsset = {
    id,
    name: name.trim() || "表格贴图",
    path,
    type: "image",
    sourceType: "user-provided"
  };
  context.assets.set(id, asset);
  context.pending.push({ asset, data: image.data });
  return { asset, reused: false };
}

/** The pictures pasted into one film slot: any of the slot's own cells counts. */
function picturesInSlot(pictures: readonly SheetEmbeddedImage[] | undefined, slot: FilmAssetSlot): SheetEmbeddedImage[] {
  if (!pictures?.length) return [];
  const columns = new Set([slot.id, slot.name, slot.preview].filter((column) => column >= 0));
  return pictures.filter((image) => columns.has(image.column));
}

function cellAt(row: readonly string[], index: Map<string, number>, name: string): string {
  const position = index.get(name);
  return position === undefined ? "" : String(row[position] ?? "");
}

/**
 * The hash of every thumbnail the export embedded, keyed by its anchor cell.
 *
 * This is the signal the import classifies pictures against, and it lives in a
 * cell on purpose: cell text is the one thing every editor round-trips intact --
 * verified on this operator's own sheets, which still carry 导出指纹 after a save
 * in WPS. A shape's name or description would be more elegant and less provable.
 */
function parseThumbnailFingerprints(value: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of value.split(";")) {
    const match = /^(\d+):(\d+)=([0-9a-f]+)$/.exec(entry.trim());
    if (match) map.set(`${match[1]}:${match[2]}`, match[3]!);
  }
  return map;
}

function parseNotesMeta(table: SheetTable | undefined): {
  projectId: string;
  revision: number | null;
  signature: string | null;
  imageMarker: boolean;
  thumbnailHashes: Map<string, string>;
} {
  let projectId = "";
  let revision: number | null = null;
  let signature: string | null = null;
  let imageMarker = false;
  let thumbnailHashes = new Map<string, string>();
  for (const row of table?.rows ?? []) {
    const key = String(row[0] ?? "").trim();
    const value = String(row[1] ?? "").trim();
    if (key === "方案id") projectId = value;
    else if (key === "图片标记") imageMarker = value === IMAGE_MARKER_VERSION;
    else if (key === "预览指纹") thumbnailHashes = parseThumbnailFingerprints(value);
    else if (key === "导出指纹") signature = value || null;
    else if (key === "导出revision") {
      const parsed = Number(value);
      revision = Number.isFinite(parsed) ? parsed : null;
    }
  }
  return { projectId, revision, signature, imageMarker, thumbnailHashes };
}

/**
 * A short, actionable account of why a sheet no longer matches its scheme.
 *
 * "请重新导出" on its own leaves the operator guessing what went wrong -- and the
 * usual causes are things they did on purpose elsewhere in the Studio (deleting a
 * scene, editing a narration). Naming the first few differences turns a dead end
 * into a to-do list.
 */
function describeContentDrift(sceneTable: SheetTable, project: VideoProject): string[] {
  const header = sceneTable.rows[0] ?? [];
  /* 原始id wins when the sheet still has it: on an older sheet that column is the
     id the scene had at export time, which is what names the row there. Current
     sheets have only 场景id. */
  const anchorAt = header.findIndex((name) => ["原始id", "场景id"].includes(String(name ?? "").trim()));
  const anchored = new Set<string>();
  const missing: string[] = [];
  if (anchorAt >= 0) {
    sceneTable.rows.slice(1).forEach((row, index) => {
      const id = String(row[anchorAt] ?? "").trim();
      if (!id) return;
      anchored.add(id);
      if (!project.scenes.some((scene) => scene.id === id)) missing.push(`表格第${index + 2}行的「${id}」在方案里已不存在`);
    });
  }
  const notes: string[] = [];
  if (missing.length) notes.push(`${missing.slice(0, 3).join("、")}${missing.length > 3 ? ` 等 ${missing.length} 处` : ""}`);
  if (anchored.size) {
    const added = project.scenes.filter((scene) => !anchored.has(scene.id));
    if (added.length) {
      notes.push(`方案里新增或改名了 ${added.length} 个场景（${added.slice(0, 3).map((scene) => scene.title || scene.id).join("、")}），表格里没有它们的行`);
    }
    const narrationAt = header.findIndex((name) => String(name ?? "").trim() === "旁白字幕");
    if (narrationAt >= 0) {
      const edited = project.scenes.filter((scene) => {
        if (!anchored.has(scene.id)) return false;
        const row = sceneTable.rows.find((candidate) => String(candidate[anchorAt] ?? "").trim() === scene.id);
        if (!row) return false;
        const sheetNarration = String(row[narrationAt] ?? "");
        // A blank cell means "keep the narration that is already there", so only a
        // differing non-blank value counts as drift.
        return sheetNarration.trim() !== "" && sheetNarration !== (scene.narration ?? "");
      });
      if (edited.length) {
        notes.push(`${edited.length} 个场景的旁白字幕已在 Studio 里改过（${edited.slice(0, 3).map((scene) => scene.title || scene.id).join("、")}）`);
      }
    }
  }
  return notes;
}

/**
 * What this workbook is a picture of.
 *
 * A digest over exactly the fields the sheet carries and the merge can write:
 * the scenes' identity, order and editable text; each scene's film selection and
 * its placements (including the anchoring keywords the sheet cannot show); and
 * the asset library. Anything outside that set -- camera, timings, cover text,
 * output profile, voice -- is deliberately excluded, because an import can never
 * clobber those, so a change to them must not expire an in-flight edit.
 *
 * This is what makes the staleness check about *content* rather than about a
 * revision counter: an identical save used to mint a new revision and refuse a
 * perfectly consistent sheet.
 */
export function workbookContentSignature(project: VideoProject): string {
  const signature = {
    scenes: project.scenes.map((scene) => ({
      id: scene.id,
      section: scene.section ?? null,
      type: scene.type,
      title: scene.title ?? "",
      narration: scene.narration ?? "",
      subtitle: scene.subtitle ?? "",
      film: filmAssetIds(scene),
      placements: (scene.placements ?? []).map((placement) => ({
        assetId: placement.assetId,
        keywords: placement.requiredKeywords ?? [],
        includeInRender: placement.includeInRender ?? null
      }))
    })),
    assets: project.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      type: asset.type,
      sourceType: asset.sourceType ?? null,
      path: asset.path
    }))
  };
  return createHash("sha256").update(JSON.stringify(signature)).digest("hex").slice(0, 20);
}

/** Read only the identity/revision/signature stamp a workbook carries in its 说明 sheet. */
export function readWorkbookMeta(buffer: Buffer): { projectId: string; revision: number | null; signature: string | null } {
  const tables = readXlsx(buffer);
  return parseNotesMeta(tables.find((table) => table.name === NOTES_SHEET));
}

function sameOrderedIds(before: readonly string[], after: readonly string[]): boolean {
  return before.length === after.length && before.every((id, position) => id === after[position]);
}

/**
 * Rebuild a scene's placements from the workbook's film-image list while keeping
 * every hidden library binding the workbook does not show. The per-image
 * `includeInRender` flag is only materialised when the film selection actually
 * changed (or was already explicit), so an untouched legacy scene still
 * round-trips byte for byte while an edited one really drives the film.
 */
function rebuildPlacements(
  original: StudioScene | null,
  filmIds: readonly string[],
  groups: readonly string[][],
  assets: Map<string, StudioAsset>,
  keywordsEditable: boolean
): AssetPlacement[] {
  const existing = placementsByAsset(original);
  const filmSet = new Set(filmIds);
  const alreadyExplicit = (original?.placements ?? []).some((placement) => placement.includeInRender !== undefined);
  const materialize = alreadyExplicit || !sameOrderedIds(original ? filmAssetIds(original) : [], [...filmIds]);
  const placements: AssetPlacement[] = [];
  filmIds.forEach((assetId, position) => {
    const base = existing.get(assetId) ?? defaultPlacement(assets.get(assetId));
    /* A column the workbook does not carry is read-only, not empty. New exports
       have no 素材关键词N column at all, so treating "no column" as "no keywords"
       would quietly strip every anchoring keyword in the scheme on the next
       import -- the one failure mode this round-trip must never have. When the
       column is absent the placement keeps what it already had. */
    const keywords = keywordsEditable ? [...(groups[position] ?? [])] : [...(base.requiredKeywords ?? [])];
    const placement = { ...structuredClone(base), assetId, requiredKeywords: keywords };
    if (materialize) placement.includeInRender = true;
    placements.push(placement);
  });
  for (const placement of original?.placements ?? []) {
    if (filmSet.has(placement.assetId)) continue;
    const kept = structuredClone(placement);
    if (materialize) kept.includeInRender = false;
    placements.push(kept);
  }
  return placements;
}

function sceneFieldsChanged(original: StudioScene, edited: StudioScene): boolean {
  if (original.id !== edited.id) return true;
  if (original.title !== edited.title) return true;
  if (original.narration !== edited.narration) return true;
  if (original.subtitle !== edited.subtitle) return true;
  if (original.assetIds.join("\u0000") !== edited.assetIds.join("\u0000")) return true;
  const before = (original.placements ?? []).map((placement) => placement.assetId + "\u0000" + placement.requiredKeywords.join("\u0001")).join("\u0002");
  const after = (edited.placements ?? []).map((placement) => placement.assetId + "\u0000" + placement.requiredKeywords.join("\u0001")).join("\u0002");
  return before !== after;
}

function collectKeywordRemovals(original: StudioScene, edited: StudioScene, rowNumber: number, into: KeywordRemoval[]): void {
  const before = new Map<string, number>();
  for (const placement of original.placements ?? []) {
    for (const keyword of placement.requiredKeywords ?? []) before.set(keyword, (before.get(keyword) ?? 0) + 1);
  }
  const after = new Set<string>();
  for (const placement of edited.placements ?? []) {
    for (const keyword of placement.requiredKeywords ?? []) after.add(keyword);
  }
  for (const [keyword, count] of before) {
    if (!after.has(keyword)) into.push({ row: rowNumber, title: original.title, keyword, count });
  }
}

/**
 * The box every preview picture is fitted into, in pixels.
 *
 * All previews are the same size on purpose: a row of cells that all hold the
 * same shape can be given one column width and one row height, so the sheet
 * reads as a contact sheet instead of a ragged stack of full-size photos
 * spilling over their neighbours. A picture is scaled to fit *inside* this box
 * — aspect ratio preserved, never stretched, never enlarged past its own
 * resolution — and the sheet draws it at this size.
 */
export const PREVIEW_BOX_WIDTH = 240;
export const PREVIEW_BOX_HEIGHT = 180;

/** One preview picture, keyed by assetId when the workbook is built. */
export interface WorkbookPreview {
  /** Encoded thumbnail bytes, already fitted into the preview box. */
  data: Buffer;
  extension: "png" | "jpeg" | "gif" | "bmp" | "tiff" | "webp";
  /** Always within PREVIEW_BOX_*, and the size the sheet draws the picture at. */
  widthPx: number;
  heightPx: number;
}

export interface WorkbookOptions {
  /** Preview picture per assetId; an asset without one simply shows an empty cell. */
  previews?: ReadonlyMap<string, WorkbookPreview>;
}

/**
 * Picture formats that can go into the package verbatim, keyed by the format
 * sharp reports for the file's actual bytes. Anything outside this set cannot
 * be carried losslessly, so the preview is skipped rather than re-encoded: the
 * cell is decoration, and a missing picture must never corrupt an export.
 */
const EMBEDDABLE_IMAGE_FORMATS: Record<string, WorkbookPreview["extension"]> = {
  jpeg: "jpeg", png: "png", gif: "gif", bmp: "bmp", tiff: "tiff", webp: "webp"
};

/**
 * Re-encode a thumbnail into the same format it came from.
 *
 * The extension the sheet declares and the bytes in the media part have to
 * agree, otherwise the picture is refused by the viewer. Keeps the lossy/small
 * choice per format: PNG stays lossless, everything else stays lossy at a
 * quality that keeps a 240x180 cell small.
 */
async function encodePreview(pipeline: sharp.Sharp, extension: WorkbookPreview["extension"]): Promise<Buffer> {
  switch (extension) {
    case "png": return pipeline.png({ compressionLevel: 9 }).toBuffer();
    case "webp": return pipeline.webp({ quality: 82 }).toBuffer();
    case "tiff": return pipeline.tiff({ quality: 82 }).toBuffer();
    case "bmp": return pipeline.png({ compressionLevel: 9 }).toBuffer();
    // GIF's encoder ignores the resize geometry in some sharp setups and would
    // hand back the full-size frame; a static thumbnail as PNG is both smaller
    // and closer to what a spreadsheet cell can actually show.
    case "gif": return pipeline.png({ compressionLevel: 9 }).toBuffer();
    default: return pipeline.jpeg({ quality: 82, chromaSubsampling: "4:4:4" }).toBuffer();
  }
}

/** Where a scheme asset lives on disk, or null when nothing is there to read. */
export function resolveAssetFile(root: string, assetPath: string): string | null {
  const path = String(assetPath ?? "").trim();
  if (!path) return null;
  if (path.startsWith("/workspace-assets/")) {
    const file = join(root, "workspace", "assets", path.slice("/workspace-assets/".length));
    return existsSync(file) ? file : null;
  }
  if (path.startsWith("/project-assets/")) {
    const file = normalize(join(root, path.slice("/project-assets/".length)));
    return existsSync(file) ? file : null;
  }
  const file = normalize(join(root, path.replace(/^\/+/, "")));
  return existsSync(file) ? file : null;
}

/**
 * Fit one picture inside the preview box, preserving aspect ratio. Never
 * enlarges: a photo smaller than the box keeps its own pixels rather than being
 * blown up into a blurry thumbnail.
 */
function drawSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, PREVIEW_BOX_WIDTH / width, PREVIEW_BOX_HEIGHT / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Read one asset as a thumbnail for its cell. The picture is fitted into the
 * shared preview box and re-encoded, which is what keeps every cell the same
 * size and the workbook small — embedding the originals made a 28-scene scheme
 * a 20 MB sheet whose photos spilled across their neighbours.
 *
 * Re-encoding is only ever applied when the file actually has to change:
 * a JPEG that already fits the box is re-encoded as JPEG so it stays lossy-
 * small, not ballooned into a PNG. Orientation is normalised here too, so a
 * rotated photo arrives upright rather than depending on the viewer's EXIF.
 *
 * The format is taken from the file's actual content, so a mis-named file still
 * lands in a media part whose extension and content type match its bytes.
 *
 * Exported for tests: the geometry rules above are worth pinning directly.
 */
export async function readPreview(file: string): Promise<WorkbookPreview | null> {
  try {
    const meta = await sharp(file).metadata();
    const width = Number(meta.width ?? 0);
    const height = Number(meta.height ?? 0);
    if (!width || !height) return null;
    const source = String(meta.format ?? "");
    const extension = EMBEDDABLE_IMAGE_FORMATS[source];
    if (!extension) return null;
    // `.rotate()` with no argument applies EXIF orientation and then drops it,
    // so the thumbnail is upright no matter what the original carried. That can
    // swap the axes, which is why the box is sized from the *rotated* extent —
    // measuring the raw file would squeeze a portrait shot into a landscape box.
    const upright = (meta.orientation ?? 1) >= 5 ? { width: height, height: width } : { width, height };
    const drawn = drawSize(upright.width, upright.height);
    const pipeline = sharp(file).rotate().resize(drawn.width, drawn.height, { fit: "fill" });
    // Encode back into the format the file actually is. This used to be a
    // two-way branch (`png` else `jpeg`), which meant a WebP/GIF/BMP/TIFF
    // thumbnail was encoded as JPEG while the returned extension still claimed
    // the original format -- the media part's bytes and its declared content
    // type disagreed, and the sheet showed a broken picture. WebP keeps its
    // format here; only genuinely unsupported sources are dropped earlier.
    const data = await encodePreview(pipeline, extension);
    return { data, extension, widthPx: drawn.width, heightPx: drawn.height };
  } catch {
    return null;
  }
}

/**
 * Read one preview picture per film image, keyed by assetId, so the workbook
 * builder can stay synchronous. Missing, unreadable or non-image files are
 * skipped rather than failing the export: a workbook without art is still a
 * perfectly usable workbook.
 */
export async function collectAssetPreviews(root: string, project: VideoProject): Promise<Map<string, WorkbookPreview>> {
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const wanted = new Set<string>();
  for (const scene of project.scenes) for (const assetId of filmAssetIds(scene)) wanted.add(assetId);
  const previews = new Map<string, WorkbookPreview>();
  await Promise.all([...wanted].map(async (assetId) => {
    const asset = assetsById.get(assetId);
    if (!asset || asset.type !== "image") return;
    const file = resolveAssetFile(root, asset.path);
    if (!file) return;
    const preview = await readPreview(file);
    if (preview) previews.set(assetId, preview);
  }));
  return previews;
}

/**
 * Width in pixels of one preview column. Excel's character unit is about 7 px
 * at the default font; the extra pixel absorbs the cell padding so the box
 * width fits without clipping.
 */
function previewColumnPixels(): number {
  return PREVIEW_BOX_WIDTH + 12;
}

/**
 * Column width (Excel character units) for a preview column. Fixed, because
 * every preview shares one box: a width derived from the pictures would vary
 * per slot for no reason and make the sheet ragged.
 */
function previewColumnWidth(): number {
  return Math.max(FILM_PREVIEW_WIDTH, Math.ceil(previewColumnPixels() / 7));
}

/** Display width in Excel's character units, counting CJK glyphs as double. */
function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) width += (character.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
  return width;
}

/**
 * Row height for a scene row that carries a preview picture. Every preview is
 * the same box, so the picture contribution is the same for every row — the
 * only variation left is how much wrapped text the row has to show. Rows
 * without a picture stay auto-sized.
 */
function sceneRowPoints(scene: StudioScene, assetNames: readonly string[], hasPicture: boolean): number {
  const wrapped: { text: string; width: number }[] = [
    { text: scene.title, width: SCENE_LEFT_WIDTHS.场景名称 },
    { text: scene.narration, width: SCENE_LEFT_WIDTHS.旁白字幕 },
    ...assetNames.map((text) => ({ text, width: FILM_NAME_WIDTH }))
  ];
  let lines = 1;
  for (const { text, width } of wrapped) {
    const perLine = Math.max(4, Math.floor(width * 0.9));
    const count = String(text ?? "")
      .split("\n")
      .reduce((total, part) => total + Math.max(1, Math.ceil(displayWidth(part) / perLine)), 0);
    lines = Math.max(lines, count);
  }
  // Points are 1/72 inch and the box is measured in 96 dpi pixels.
  const picturePoints = hasPicture ? Math.ceil(PREVIEW_BOX_HEIGHT * 0.75) + 6 : 0;
  // Excel refuses a row taller than 409.5 points; clamp rather than emit a
  // height the spreadsheet app would silently drop.
  return Math.min(409, Math.max(picturePoints, lines * 15 + 4));
}

/**
 * Build the workbook for a scheme: the round-trip sheet, and the only one.
 *
 * It carries the asset ids (the way to choose a scene's pictures from Excel), the
 * 素材库 sheet (the way to grow the picture set from Excel) and a thumbnail per
 * film image (so a human can eyeball which picture landed where).
 */
export function buildProjectWorkbook(project: VideoProject, options: WorkbookOptions = {}): Buffer {
  const slotColumns = filmSlotColumns();
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const films = project.scenes.map((scene) => filmAssetIds(scene));
  const filmColumns = Math.max(1, ...films.map((ids) => ids.length)) + FILM_ASSET_SPARE_COLUMNS;
  const assetHeaders = Array.from({ length: filmColumns }, (_, position) => slotColumns.map((column) => column.header(position))).flat();
  const headers: string[] = [...SCENE_LEFT_HEADERS, ...assetHeaders, ...SCENE_RIGHT_HEADERS];

  const rows: SheetCell[][] = [headers.map((name) => ({ value: name, style: "header" as const }))];
  const rowHeights: (number | null)[] = [null];
  const images: SheetImage[] = [];
  project.scenes.forEach((scene, index) => {
    const hint = scene.section === "cover" ? "封面（标题锁定）" : "";
    const ids = films[index] ?? [];
    const assetCells: SheetCell[] = [];
    const assetNames: string[] = [];
    let hasPicture = false;
    for (let position = 0; position < filmColumns; position += 1) {
      const assetId = ids[position] ?? "";
      const asset = assetId ? assetsById.get(assetId) : undefined;
      assetNames.push(asset?.name ?? "");
      // Cells follow the slot's own column order, so a shape cannot drift from
      // its headers (the two used to be written independently and one stale index
      // produced width="NaN").
      for (const column of slotColumns) assetCells.push(column.cell(assetId, asset));
      const preview = assetId ? options.previews?.get(assetId) : undefined;
      if (preview) {
        hasPicture = true;
        images.push({
          row: index + 1,
          column: SCENE_LEFT_HEADERS.length + position * slotColumns.length + slotColumns.length - 1,
          data: preview.data,
          extension: preview.extension,
          /* Mark it as ours. Without this the import cannot tell a thumbnail
             from a photo the operator pasted in, and would register every
             preview as a brand new asset on the next import. */
          preview: true,
          widthPx: preview.widthPx,
          heightPx: preview.heightPx,
          // Centre the picture in its cell. The cell is sized for the box, but a
          // portrait only fills part of it, and oneCellAnchor would otherwise
          // pin every picture to the cell's top-left corner.
          offsetXPx: Math.max(0, Math.round((previewColumnPixels() - preview.widthPx) / 2)),
          offsetYPx: Math.max(0, Math.round((PREVIEW_BOX_HEIGHT - preview.heightPx) / 2))
        });
      }
    }
    rows.push([
      { value: index + 1, style: "lockedNumber" },
      // The key. A new row leaves it blank and the import mints one; an existing
      // row must keep the id its scene already has, because the id *is* how the
      // row is matched to that scene (see the merge for why a changed one is
      // refused rather than guessed at).
      { value: scene.id, style: "text" },
      { value: scene.section ?? "", style: "lockedText" },
      { value: scene.type, style: "lockedText" },
      { value: scene.title, style: scene.section === "cover" ? "lockedText" : "text" },
      { value: scene.narration, style: "text" },
      ...assetCells,
      { value: hint, style: "note" }
    ]);
    rowHeights.push(hasPicture ? sceneRowPoints(scene, assetNames, true) : null);
  });
  for (let pad = 0; pad < TRAILING_ROWS; pad += 1) {
    rowHeights.push(null);
    rows.push([
      { value: null, style: "lockedNumber" },
      { value: "", style: "text" },
      { value: "", style: "text" },
      { value: "", style: "text" },
      { value: "", style: "text" },
      { value: "", style: "text" },
      ...Array.from({ length: filmColumns * slotColumns.length }, () => ({ value: "", style: "text" as const })),
      { value: "", style: "note" }
    ]);
  }

  /* The 素材库 sheet is the door to the picture set: 301 rows of ids and paths. */
  const libraryRows: SheetCell[][] = [LIBRARY_HEADERS.map((name) => ({ value: name, style: "header" as const }))];
  for (const asset of project.assets) {
    libraryRows.push([
      { value: asset.id, style: "lockedText" },
      { value: asset.name, style: "lockedText" },
      { value: asset.type, style: "lockedText" },
      { value: asset.sourceType ?? "", style: "lockedText" },
      { value: asset.path, style: "lockedText" }
    ]);
  }

  const noteRows: SheetCell[][] = [
    [{ value: "方案id", style: "lockedText" }, { value: project.id, style: "text" }],
    [{ value: "方案名称", style: "lockedText" }, { value: project.name, style: "text" }],
    [{ value: "导出revision", style: "lockedText" }, { value: Number(project.revision ?? 0), style: "lockedNumber" }],
    // The revision only says *when* the sheet was exported; the signature says
    // *what* it was exported from. The import trusts the signature, so a save
    // that changed nothing (or only fields this sheet cannot write) no longer
    // expires the operator's in-flight edit.
    [{ value: "导出指纹", style: "lockedText" }, { value: workbookContentSignature(project), style: "lockedText" }],
    [{ value: "导出时间", style: "lockedText" }, { value: new Date().toISOString(), style: "text" }],
    [{ value: "表格版本", style: "lockedText" }, { value: WORKBOOK_VERSION, style: "lockedNumber" }],
    // Stated explicitly, because the two shapes support different edits and the
    // operator needs to know which one they are holding.
    [{ value: "内嵌缩略图", style: "lockedText" }, { value: images.length, style: "lockedNumber" }],
    // Says that this export's thumbnails are recognisable, so the import may
    // read the drawings: a picture that is not one of them is the operator's own.
    [{ value: "图片标记", style: "lockedText" }, { value: IMAGE_MARKER_VERSION, style: "lockedText" }],
    /* Which thumbnail sits where, by content. The import compares every picture
       it finds against this: an anchor with no entry, or an entry that no longer
       matches, means the operator put a picture there themselves. */
    [{ value: "预览指纹", style: "lockedText" }, {
      value: images.map((image) => `${image.row}:${image.column}=${pictureHash(image.data)}`).join(";"),
      style: "lockedText"
    }],
    [],
    [{ value: WORKBOOK_NOTES, style: "note" }]
  ];

  // Every preview column is the same width, since every preview is the same
  // box; the column count varies, the geometry never does. The widths are built
  // from the same named constants the header and the cell writer use, and the
  // three are asserted to agree below -- a slot that gains or loses a column
  // must not be able to leave a column behind with no width.
  const previewWidth = previewColumnWidth();
  /* The header, the cells and the widths all come from `slotColumns`, so they
     cannot disagree -- a stale literal index here is what once emitted
     width="NaN". This assertion guards the other direction: a hand-written column
     added to the header (or removed from it) without touching the table. */
  const filmColumnCount = headers.length - SCENE_LEFT_HEADERS.length - SCENE_RIGHT_HEADERS.length;
  if (slotColumns.length * filmColumns !== filmColumnCount) {
    throw new Error(`成片素材列定义不一致：表头 ${filmColumnCount} 列，列宽表 ${slotColumns.length} × ${filmColumns} 个槽位`);
  }
  const widths = [
    ...SCENE_LEFT_HEADERS.map((name) => SCENE_LEFT_WIDTHS[name]),
    // The preview sits last in every slot and takes the computed width.
    ...Array.from({ length: filmColumns }, () => slotColumns.map((column, index) => (index === slotColumns.length - 1 ? previewWidth : column.width))).flat(),
    ...SCENE_RIGHT_HEADERS.map((name) => SCENE_RIGHT_WIDTHS[name])
  ];
  const sheets: SheetSpec[] = [
    {
      name: SCENE_SHEET,
      columns: widths.map((width) => ({ width })),
      rows,
      rowHeights,
      images,
      // The scene sheet is the one people scan down; a thin grid keeps a tall
      // wrapped narration in its own row. The prose 说明 sheet is left bare.
      border: true,
      // Both dropdowns are placed from the header, never from a literal letter:
      // the literals here had drifted one column right, so 章节 and 场景类型 were
      // offering their lists on 原始id and 章节 instead.
      validations: [
        { range: `${sceneColumnLetter("章节")}2:${sceneColumnLetter("章节")}${rows.length}`, options: ["cover", "overview", "child", "outro-lead", "outro"] },
        { range: `${sceneColumnLetter("场景类型")}2:${sceneColumnLetter("场景类型")}${rows.length}`, options: ["map-overview", "image-card", "fact-card", "region-focus", "cover", "outro"] }
      ]
    },
    { name: LIBRARY_SHEET, columns: LIBRARY_WIDTHS.map((width) => ({ width })), rows: libraryRows, border: true },
    { name: NOTES_SHEET, columns: [{ width: 16 }, { width: 90 }], rows: noteRows }
  ];
  return writeXlsx(sheets);
}

function emptyResult(project: VideoProject, errors: WorkbookIssue[], warnings: string[]): MergeResult {
  return {
    ok: false,
    project,
    revision: Number(project.revision ?? 0),
    addedScenes: [],
    deletedScenes: [],
    changedScenes: [],
    changedAssets: 0,
    pendingAssets: [],
    warnings,
    errors,
    needsNarrationRegen: false
  };
}

/**
 * Validate an edited workbook against the scheme it came from and, when every
 * check passes, produce the merged scheme. Never throws for row-level problems:
 * they are returned so the caller can show line numbers and refuse the write.
 *
 * `root` is needed to resolve an added library row's path to a real file — a
 * workbook carries paths, not pictures. When omitted (as in pure parser tests)
 * a path is taken at face value, so the checks that do not touch disk still run.
 */
export function mergeProjectWorkbook(project: VideoProject, buffer: Buffer, root = process.cwd()): MergeResult {
  const errors: WorkbookIssue[] = [];
  const warnings: string[] = [];
  const fail = (row: number | null, message: string): void => { errors.push({ row, message }); };

  let tables: SheetTable[];
  try {
    tables = readXlsx(buffer);
  } catch (error) {
    fail(null, error instanceof Error ? error.message : String(error));
    return emptyResult(project, errors, warnings);
  }

  const sceneTable = tables.find((table) => table.name === SCENE_SHEET);
  if (!sceneTable) {
    fail(null, `表格缺少「${SCENE_SHEET}」工作表，无法导入`);
    return emptyResult(project, errors, warnings);
  }
  const meta = parseNotesMeta(tables.find((table) => table.name === NOTES_SHEET));
  if (meta.projectId && meta.projectId !== project.id) {
    fail(null, `表格属于方案 ${meta.projectId}，与当前方案 ${project.id} 不一致`);
  }
  /* Staleness is about *content*, not about the revision counter. A save that
     changed nothing -- or that only touched fields this sheet cannot write --
     used to mint a new revision and refuse a perfectly consistent sheet, leaving
     the operator to redo their edit for nothing. Observed live: revision 28 and
     29 were byte-identical files. The signature the sheet carries covers exactly
     what the merge can write, so while it still matches, the sheet is consistent
     with the scheme no matter what the revision says.
     Sheets exported before the signature existed fall back to the revision. */
  if (meta.signature) {
    if (meta.signature !== workbookContentSignature(project)) {
      const drift = describeContentDrift(sceneTable, project);
      fail(null, `方案内容在表格导出后被改动过（导出时为 revision ${meta.revision ?? "?"}，当前 revision ${project.revision}），表格与当前方案已不一致。`
        + (drift.length ? `具体差异：${drift.join("；")}。` : "")
        + "请重新导出表格后再编辑导入。");
    }
  } else if (meta.revision !== null && meta.revision !== Number(project.revision ?? 0)) {
    fail(null, `表格导出时的版本为 revision ${meta.revision}，当前方案已是 revision ${project.revision}（期间可能已在 Studio 保存过）。请重新导出表格后再编辑导入。`);
  }

  /* Pictures floating over the sheet, keyed by the 0-based row they are anchored
     to. A thumbnail this module wrote is skipped: it is a rendering of a picture
     the scheme already has. Everything else is a picture the operator put there,
     which is the same thing as uploading it -- the sheet cannot carry a path for
     a file that does not exist yet, so it carries the picture.
     Without the marker row, however, "everything else" includes every stale
     thumbnail of an older export, so on such a sheet the drawings are ignored and
     the operator is told why. */
  let embeddedImages: SheetEmbeddedImage[] = [];
  try {
    embeddedImages = readXlsxImages(buffer);
  } catch {
    // A package whose drawings cannot be read still has readable cells; the
    // pictures are simply unavailable, which the count below reports as zero.
    embeddedImages = [];
  }
  const pastedPictures = new Map<number, SheetEmbeddedImage[]>();
  const sceneImages = embeddedImages.filter((image) => image.sheet === SCENE_SHEET);
  if (meta.imageMarker) {
    for (const image of sceneImages) {
      /* Three ways to be *ours*, and only one of them is the common case:
         the shape still carries its own hash, or the anchor's recorded hash
         still matches the bytes. Either one proves this is the thumbnail the
         export put here. An anchor with no record at all was empty when the
         sheet was exported, so a picture there is new by definition. */
      const recorded = meta.thumbnailHashes.get(`${image.row}:${image.column}`);
      const ours = isWrittenPreview(image) || (recorded !== undefined && recorded === pictureHash(image.data));
      if (ours) continue;
      const list = pastedPictures.get(image.row) ?? [];
      list.push(image);
      pastedPictures.set(image.row, list);
    }
  } else if (sceneImages.length) {
    warnings.push(`这份表格里有 ${sceneImages.length} 张图片，但它是旧版本导出的（说明页没有「图片标记」行），导入无法分辨哪张是你贴的、哪张只是脚本内嵌的缩略图，所以一律没有使用。请重新导出一次表格（新表格的缩略图带识别标记），再把图片贴进 成片预览N 格子里。`);
  }

  const header = sceneTable.rows[0] ?? [];
  /* 旁白字幕 is required, but a sheet exported before the merge carries 旁白
     instead. Either header satisfies the requirement — read both through the
     merged column so an in-flight edit is not thrown away by an upgrade. */
  const required = [...SCENE_LEFT_HEADERS.filter((name) => name !== "旁白字幕"), ...SCENE_RIGHT_HEADERS];
  const { index, missing } = columnIndexes(header, required);
  const mergedNarrationColumn = index.has("旁白字幕") ? "旁白字幕" : LEGACY_NARRATION_HEADER;
  const legacySubtitleColumn = index.has("旁白字幕") ? null : "字幕";
  if (!index.has(mergedNarrationColumn)) missing.push("旁白字幕");
  if (missing.length) fail(null, `「${SCENE_SHEET}」缺少必需列：${missing.join("、")}`);
  const slots = filmAssetSlots(header);
  /* No 成片素材N family at all: the sheet shows 素材名称N + 成片预览N and cannot
     name a picture. The export no longer produces such a sheet, but an operator may
     still be holding one from before, so it is tolerated rather than refused. The
     film is read-only then, exactly like an absent 素材关键词 column is; treating
     "no id columns" as "no pictures" would delete the film on the next import. A
     sheet with no image columns whatsoever is still refused. */
  const filmEditable = slots.length > 0;
  const reviewShape = !filmEditable && header.some((name) => /^(素材名称|成片预览)\d+$/.test(String(name ?? "").trim()));
  if (!filmEditable && !reviewShape) fail(null, `「${SCENE_SHEET}」缺少成片素材列（形如“成片素材1(首图)”“成片素材2”）`);
  /* An operator who edits pictures in this sheet is doing something the format
     cannot carry, and silence is the worst possible answer: everything else on
     the sheet (文案、增删场景) does apply, so the import looks like it worked. Say
     it out loud, unprompted, on every import of a picture-less sheet. */
  if (reviewShape) {
    warnings.push("这份表格里没有 成片素材N 列（只有 素材名称N / 成片预览N，通常是旧版本导出的），所以导入不会改动任何图片与素材库，成片预览N 里的缩略图也从不被读取 —— 换图不会生效。请重新导出一次（新表格一律带 成片素材N），在那一格里填 素材id / 素材名称 / 图片路径；或直接在 Studio 里选中场景后点素材的「设为首图」。");
  }
  /* Whether the sheet carries 素材关键词N columns at all. New exports do not, so
     absent means "read-only": the import then leaves every placement's keywords
     exactly as they were. Reading an absent column as empty would strip every
     anchoring keyword in the scheme. */
  const keywordsEditable = slots.some((slot) => slot.keywords >= 0);
  /* 场景id is the key, and the only anchor. There is no second, script-owned id
     column any more: a row is matched to the scene whose id it carries, which is
     what makes "the sheet is the scene list" true rather than aspirational. 操作
     is only consulted when an older sheet still has it (see ACTIONS). */
  const actionColumn = index.has("操作");
  if (errors.length) return emptyResult(project, errors, warnings);

  const next = structuredClone(project);
  const originalById = new Map(next.scenes.map((scene) => [scene.id, scene]));
  let assets = new Map(next.assets.map((asset) => [asset.id, asset]));
  /** Asset-library rows this import changes; part of the reported effect. */
  let changedAssets = 0;

  /* The 素材库 sheet is the door to the picture set. Reconcile it before any
     scene row is read, so a scene that references a freshly added asset finds
     it, and a scene that references a removed one is refused rather than
     silently keeping a dangling binding. */
  const library = parseAssetLibrary(root, tables.find((table) => table.name === LIBRARY_SHEET), assets, fail, (message) => warnings.push(message));
  if (errors.length) return emptyResult(project, errors, warnings);
  if (library) {
    const addedAssets: StudioAsset[] = [];
    const removedAssetIds = new Set<string>();
    const renamedAssets: string[] = [];
    let repathedAssets = 0;
    for (const [id, row] of library) {
      const current = assets.get(id);
      if (!current) {
        // A new row is a reference to a file that must really be there; the
        // path was already checked by parseAssetLibrary.
        addedAssets.push({ id, name: row.name, path: row.path, type: row.type, ...(row.sourceType ? { sourceType: row.sourceType } : {}) });
        continue;
      }
      // An edited name or path patches the scheme's copy in place, keeping every
      // field the workbook does not show (scope, poi, alt, verified flags…).
      if (current.name !== row.name) {
        renamedAssets.push(`「${current.name}」→「${row.name}」`);
        current.name = row.name;
      }
      if (current.path !== row.path) {
        repathedAssets += 1;
        current.path = row.path;
      }
    }
    /* Library edits are changes like any other, and they have to be reported:
       renaming an asset used to apply silently while the panel announced that
       nothing had changed. */
    changedAssets = addedAssets.length + removedAssetIds.size + renamedAssets.length + repathedAssets;
    if (changedAssets) {
      const parts = [
        addedAssets.length ? `新增 ${addedAssets.length} 个` : "",
        removedAssetIds.size ? `删除 ${removedAssetIds.size} 个` : "",
        renamedAssets.length ? `改名 ${renamedAssets.length} 个（${renamedAssets.slice(0, 3).join("、")}${renamedAssets.length > 3 ? " …" : ""}）` : "",
        repathedAssets ? `改路径 ${repathedAssets} 个` : ""
      ].filter(Boolean);
      warnings.push(`素材库有改动：${parts.join("，")}。`);
    }
    for (const id of assets.keys()) if (!library.has(id)) removedAssetIds.add(id);
    if (addedAssets.length || removedAssetIds.size) {
      assets = new Map([...assets].filter(([id]) => !removedAssetIds.has(id)).concat(addedAssets.map((asset) => [asset.id, asset] as const)));
      next.assets = [...assets.values()];
    }
    if (removedAssetIds.size) {
      // A deleted asset must not survive as a dangling scene reference. Drop it
      // from every scene's assetIds and placements, reporting each scene it
      // touched so the operator sees the reach of the deletion.
      for (const scene of next.scenes) {
        if (!scene.assetIds?.some((id) => removedAssetIds.has(id)) && !scene.placements?.some((placement) => removedAssetIds.has(placement.assetId))) continue;
        scene.assetIds = (scene.assetIds ?? []).filter((id) => !removedAssetIds.has(id));
        if (scene.placements) scene.placements = scene.placements.filter((placement) => !removedAssetIds.has(placement.assetId));
        warnings.push(`素材库删除了 ${scene.title}(${scene.id}) 正在使用的素材，已同时解除该场景对这些素材的绑定。`);
      }
    }
  }

  /* The sheet is read as the scene list itself, so the first thing to work out is
     who is missing from it. A scene with no row is a deletion -- see the account
     taken after the rows are parsed. */
  const claimedSceneIds = new Set<string>();
  for (let cursor = 1; cursor < sceneTable.rows.length; cursor += 1) {
    const id = cellAt(sceneTable.rows[cursor] ?? [], index, "场景id").trim();
    if (id) claimedSceneIds.add(id);
  }
  const rowlessScenes = next.scenes.filter((scene) => !claimedSceneIds.has(scene.id));
  /* The cover and the outro are the two the film cannot do without, so their rows
     may not simply vanish: a missing one is refused, not deleted. */
  for (const scene of rowlessScenes) {
    if (scene.section === "cover" || scene.section === "outro") {
      fail(null, `${scene.section === "cover" ? "封面" : "拉回结尾"}「${scene.title}」(${scene.id}) 的场景行在表格里不存在。封面与拉回结尾全片必须且只能各有一个，不能删除；请把它那一行补回来再导入。`);
    }
  }
  const removableScenes = rowlessScenes.filter((scene) => scene.section !== "cover" && scene.section !== "outro");

  /* A row naming an id no scene has, on a sheet where some other scene has no
     row, is almost certainly a renamed 场景id. This format cannot express a
     rename any more (the id *is* the key), and guessing would turn the edit into
     "deleted that scene, added this one" -- dropping the scene's pictures, camera
     and every other machine field without saying so. Refuse instead, naming both
     ends so the fix is obvious. */
  const orphanRows: { rowNumber: number; id: string }[] = [];
  for (let cursor = 1; cursor < sceneTable.rows.length; cursor += 1) {
    const rowNumber = cursor + 1;
    const id = cellAt(sceneTable.rows[cursor] ?? [], index, "场景id").trim();
    if (id && !originalById.has(id)) orphanRows.push({ rowNumber, id });
  }
  if (orphanRows.length && removableScenes.length) {
    const gone = removableScenes.slice(0, 2).map((scene) => `「${scene.title}」(${scene.id})`).join("、");
    for (const orphan of orphanRows) {
      fail(orphan.rowNumber, `第${orphan.rowNumber}行：场景id「${orphan.id}」在方案里没有对应场景，而 ${gone}${removableScenes.length > 2 ? ` 等 ${removableScenes.length} 个` : ""} 的场景行又不存在 —— 这看起来是把 场景id 改了名。场景id 是主键（和 素材id 一样），导入不会替你配对改名：要改显示名请改「场景名称」；如果这行确实是新增场景，把它的 场景id 留空即可（脚本会自动分配）。`);
    }
  }

  const parsed: ParsedRow[] = [];
  const seenIds = new Set<string>();
  /* The scheme's assets as the sheet was exported from them. Kept apart from the
     live map because the library reconciliation runs first and may delete or rename
     things: "what did the export write in this cell" has to be answered against the
     old copy, or a deleted asset's leftover name reads as a fresh edit. */
  const originalAssets = new Map(project.assets.map((asset) => [asset.id, asset]));
  /* 素材名称N as the export wrote it, per scene and slot. Snapshot taken from the
     pristine project because the library reconciliation below mutates `next.scenes`
     (a deleted asset is stripped from every placement), and then a leftover name
     would look like a fresh edit. */
  const exportedSlotNames = new Map<string, string[]>();
  for (const scene of project.scenes) {
    exportedSlotNames.set(scene.id, filmAssetIds(scene).map((assetId) => originalAssets.get(assetId)?.name ?? ""));
  }
  /* Assets registered on the fly from a path in a 成片素材N cell, plus the ids
     they may not collide with. */
  const registeredAssets: StudioAsset[] = [];
  const takenAssetIds = new Set<string>(assets.keys());
  /* Pictures the sheet supplied as bytes. They become assets exactly like an
     upload does, except their files cannot be written from here -- a pre-check
     must leave the disk alone -- so the bytes travel out in `pendingAssets`. */
  const pendingAssets: PendingSheetAsset[] = [];
  const pictureRegistrations: { rowNumber: number; scene: string; asset: StudioAsset; reused: boolean }[] = [];
  const consumedPictures = new Set<SheetEmbeddedImage>();
  /* Every id a row intends to occupy, collected up front so two rows claiming the
     same id are caught no matter which one the loop reaches first. */
  const finalIds = new Map<string, number>();
  for (let cursor = 1; cursor < sceneTable.rows.length; cursor += 1) {
    const row = sceneTable.rows[cursor] ?? [];
    const claim = cellAt(row, index, "场景id").trim();
    if (!claim) continue;
    const where = finalIds.get(claim);
    if (where !== undefined) {
      fail(cursor + 1, `第${cursor + 1}行：场景id「${claim}」与第${where}行重复`);
      continue;
    }
    finalIds.set(claim, cursor + 1);
  }
  for (let cursor = 1; cursor < sceneTable.rows.length; cursor += 1) {
    const row = sceneTable.rows[cursor] ?? [];
    const leftBlank = SCENE_LEFT_HEADERS.every((name) => !cellAt(row, index, name).trim());
    const assetsBlank = slots.every((slot) => !String(row[slot.id] ?? "").trim());
    if (leftBlank && assetsBlank) continue;
    const rowNumber = cursor + 1;
    const value = (name: string): string => cellAt(row, index, name);

    // Read only from a sheet that still has the column; a current export does not
    // write one, and the rows themselves carry the same information.
    const actionText = actionColumn ? (value("操作").trim() || "保留") : "保留";
    if (!(ACTIONS as readonly string[]).includes(actionText)) {
      fail(rowNumber, `第${rowNumber}行：「操作」只能是 保留 / 新增 / 删除（当前为「${actionText}」）`);
      continue;
    }
    const action = actionText as RowAction;

    const sceneId = value("场景id").trim();
    const section = value("章节").trim();
    const sceneType = value("场景类型").trim();
    const title = value("场景名称");
    const narration = value(mergedNarrationColumn);
    const subtitle = legacySubtitleColumn ? value(legacySubtitleColumn) : narration;

    const original = sceneId ? originalById.get(sceneId) : undefined;
    if (original) {
      if (seenIds.has(sceneId)) {
        fail(rowNumber, `第${rowNumber}行：场景id「${sceneId}」重复出现`);
        continue;
      }
      seenIds.add(sceneId);
      if (section !== original.section) {
        fail(rowNumber, `第${rowNumber}行：章节不可修改（原为 ${original.section ?? "?"}），如需调整请重新导出`);
        continue;
      }
      if (sceneType !== original.type) {
        fail(rowNumber, `第${rowNumber}行：场景类型不可修改（原为 ${original.type}）`);
        continue;
      }
    } else {
      /* No scene carries this id, so this row is an addition. Leaving 场景id blank
         is the plain way (the import mints an id); naming your own is allowed as
         long as it is legal and unused. */
      if (actionColumn && action !== "新增") {
        fail(rowNumber, `第${rowNumber}行：场景id「${sceneId || "空"}」在方案里没有对应场景，这一行会被当成新增；旧版表格需要把「操作」填成“新增”（当前为「${action}」）`);
        continue;
      }
      if (!(ADDABLE_SECTIONS as readonly string[]).includes(section)) {
        if (section === "cover") fail(rowNumber, `第${rowNumber}行：不能新增封面——全片必须且只能有一个封面，且标题锁定为行政区标签`);
        else if (section === "child") fail(rowNumber, `第${rowNumber}行：不能新增行政区巡游——child 场景的 id 必须对应真实下级行政区划（形如 child-<childId>），凭空新增无效`);
        else if (section === "outro") fail(rowNumber, `第${rowNumber}行：不能新增结尾——全片必须且只能有一个拉回上级区域的结尾`);
        else fail(rowNumber, `第${rowNumber}行：新增行只能在“总体介绍(overview)”或“结尾补充(outro-lead)”区块，「章节」需填 overview 或 outro-lead（当前为「${section || "空"}」）`);
        continue;
      }
      if (!(SECTION_TYPES[section] ?? []).includes(sceneType as SceneType)) {
        fail(rowNumber, `第${rowNumber}行：新增行的「场景类型」必须是 map-overview / image-card / fact-card（当前为「${sceneType || "空"}」）`);
        continue;
      }
      // Uniqueness is already handled by the finalIds pass above.
      if (sceneId) {
        const problem = sceneIdProblem(section, sceneId);
        if (problem) {
          fail(rowNumber, `第${rowNumber}行：${problem}`);
          continue;
        }
        if (originalById.has(sceneId)) {
          fail(rowNumber, `第${rowNumber}行：新增场景id「${sceneId}」与已有场景重名`);
          continue;
        }
      }
    }

    if (action === "删除" && original && (original.section === "cover" || original.section === "outro")) {
      fail(rowNumber, `第${rowNumber}行：封面与结尾不能删除`);
      continue;
    }

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      fail(rowNumber, `第${rowNumber}行：场景名称不能为空`);
      continue;
    }
    if (original?.section === "cover" && trimmedTitle !== original.title.trim()) {
      fail(rowNumber, `第${rowNumber}行：封面标题锁定为行政标签「${original.title}」，不能修改`);
      continue;
    }
    if (!original && !narration.trim()) {
      fail(rowNumber, `第${rowNumber}行：新增场景的旁白不能为空`);
      continue;
    }

    const sectionForChecks = original?.section ?? section;
    /* One column feeds both fields, so the two can never disagree: whatever the
       operator types becomes the narration and the subtitle alike. A blank cell
       keeps the scene's existing narration (a new scene was already refused
       above), and a cover's subtitle stays exactly as typed because the cover
       carries no spoken narration to follow. */
    const effectiveNarration = narration.trim() ? narration : (original?.narration ?? "");
    const effectiveSubtitle = sectionForChecks === "cover" && !narration.trim()
      ? (original?.subtitle ?? "")
      : effectiveNarration;

    const assetIds: string[] = [];
    const keywordGroups: string[][] = [];
    let assetCellError = false;
    /* What the export wrote in each 素材名称N cell: needed to tell "the operator
       typed something here" from "this is still the name the script wrote", because
       clearing 成片素材N (to drop a picture) leaves the name cell untouched. */
    const exportedNames = exportedSlotNames.get(sceneId) ?? [];
    const rowPictures = pastedPictures.get(cursor);
    for (const [position, slot] of slots.entries()) {
      const idCell = String(row[slot.id] ?? "").trim();
      // The sibling 素材名称N cell: either the operator's own name for a picture
      // they are adding, or -- when the id cell is blank and the name differs from
      // what the script wrote -- the only thing naming the picture at all.
      const nameHint = slot.name >= 0 ? String(row[slot.name] ?? "") : "";
      const originalName = exportedNames[position] ?? "";
      const typedName = nameHint.trim() && nameHint !== originalName ? nameHint.trim() : "";
      const cell = idCell || typedName;

      /* A picture pasted here outranks the text. It is the more deliberate act,
         and the thumbnail it covers is what the operator was looking at when they
         pasted it; the alternative would be to refuse the import and make them
         also find the asset id of a picture that is not in the library yet. */
      const slotPictures = picturesInSlot(rowPictures, slot);
      const pasted = slotPictures.at(-1);
      if (pasted) {
        for (const picture of slotPictures) consumedPictures.add(picture);
        const registered = registerEmbeddedPicture(
          pasted,
          typedName || `${title.trim()} · 表格贴图`,
          { root, assets, taken: takenAssetIds, pending: pendingAssets }
        );
        if ("problem" in registered) {
          fail(rowNumber, `第${rowNumber}行：${registered.problem}`);
          assetCellError = true;
          break;
        }
        if (!registered.reused && !registeredAssets.some((asset) => asset.id === registered.asset.id)) {
          pictureRegistrations.push({ rowNumber, scene: title.trim(), asset: registered.asset, reused: false });
        }
        assetIds.push(registered.asset.id);
        keywordGroups.push(splitKeywords(slot.keywords >= 0 ? String(row[slot.keywords] ?? "") : ""));
        continue;
      }

      if (!cell) continue;
      const resolved = resolveFilmReference(cell, { root, assets, taken: takenAssetIds, nameHint });
      if ("problem" in resolved) {
        /* "One id per cell" is the right diagnosis only when the cell really is a
           list of ids. A name contains spaces and "·" separators, so the split runs
           on those too -- and reporting the list error for "六格村 · 陈强小卖部"
           would bury the useful message (that name matches three assets). */
        const parts = splitAssetIds(cell);
        const looksLikeAList = parts.length > 1 && parts.some((part) => assets.has(part));
        fail(rowNumber, looksLikeAList
          ? `第${rowNumber}行：一个成片素材格子只能填一个素材id（当前为「${cell}」），请把多张图片分别填到 成片素材1 / 成片素材2 …`
          : `第${rowNumber}行：${resolved.problem}`);
        assetCellError = true;
        break;
      }
      if (resolved.registered) registeredAssets.push(resolved.asset);
      assetIds.push(resolved.asset.id);
      keywordGroups.push(splitKeywords(slot.keywords >= 0 ? String(row[slot.keywords] ?? "") : ""));
    }
    if (assetCellError) continue;
    const duplicateAsset = assetIds.find((id, position) => assetIds.indexOf(id) !== position);
    if (duplicateAsset) {
      fail(rowNumber, `第${rowNumber}行：成片素材「${duplicateAsset}」重复`);
      continue;
    }

    parsed.push({
      rowNumber,
      action,
      sceneId,
      section,
      sceneType,
      title,
      narration: effectiveNarration,
      subtitle: effectiveSubtitle,
      assetIds,
      keywordGroups
    });
  }

  /* The cover/outro case was already refused above, so what is left here is a
     plain deletion: the sheet has no row for the scene, so the film no longer has
     it. Nothing else in the format could express it -- and that is the point, the
     sheet *is* the scene list. */
  const deletedScenes: string[] = removableScenes.map((scene) => scene.id);
  let narrationChanged = deletedScenes.length > 0;
  if (deletedScenes.length) {
    // Loud on purpose: losing a row to a careless copy or a delete-every-other-row
    // is the one spreadsheet accident that silently changes the film.
    warnings.push(`表格里没有这些场景的行，已按删除处理（表格＝方案：行没了就是场景没了）：${removableScenes.map((scene) => `${scene.title}(${scene.id})`).join("、")}。这不是你的本意的话，请重新导出后再编辑。`);
  }

  const orderIndex = new Map(next.scenes.map((scene, position) => [scene.id, position]));
  let lastOrder = -1;
  for (const row of parsed) {
    if (!row.sceneId) continue;
    const position = orderIndex.get(row.sceneId);
    if (position === undefined) continue;
    if (position <= lastOrder) {
      // Reordering is refused on purpose: it rewrites the narration order, and a
      // casual Excel sort would silently invalidate the recorded voice-over. Say
      // where the operation DOES belong so the dead end is actionable.
      fail(row.rowNumber, `第${row.rowNumber}行：既有场景顺序被调整。表格不重排已有场景（重排会改变旁白顺序，Excel 的排序/筛选很容易误触发）；如需调整顺序，请回到 Studio 拖动场景卡片，或先在这里删掉再新增。`);
      break;
    }
    lastOrder = position;
  }

  const finalScenes: StudioScene[] = [];
  const addedScenes: string[] = [];
  const changedScenes: string[] = [];
  const keywordRemovals: KeywordRemoval[] = [];
  const rowOfScene = new Map<string, number>();
  const takenIds = new Set(next.scenes.map((scene) => scene.id));
  let lastExistingSection: string | null = null;
  // Whether the sheet has already walked past the outro, tracked separately from
  // `lastExistingSection` because deletions make it impossible to infer from the
  // previous row alone whether the closing block has been reached.
  let sawOutro = false;

  for (const row of parsed) {
    // A row is an update only when its id names a scene that exists. A row that
    // names a fresh id is an addition, exactly like one that left the cell blank
    // -- testing `row.sceneId` for truthiness here once swallowed those.
    const original = row.sceneId ? originalById.get(row.sceneId) : undefined;
    if (original) {
      lastExistingSection = original.section ?? null;
      if (original.section === "outro") sawOutro = true;
      if (row.action === "删除") {
        // Only reachable from an older sheet that still carries 操作.
        if (!deletedScenes.includes(original.id)) deletedScenes.push(original.id);
        narrationChanged = true;
        continue;
      }
      const edited: StudioScene = structuredClone(original);
      edited.title = row.title;
      edited.narration = row.narration;
      edited.subtitle = row.subtitle === undefined ? row.narration : row.subtitle;
      // A review sheet has no film columns, so its (empty) asset list must not be
      // read as "this scene has no pictures".
      const rebuilt = filmEditable
        ? rebuildPlacements(original, row.assetIds, row.keywordGroups, assets, keywordsEditable)
        : structuredClone(original.placements ?? []);
      // A review sheet cannot speak about pictures, so it must not rewrite the
      // scene's asset list either -- that list is what the renderer walks.
      if (filmEditable) {
        edited.assetIds = rebuilt.map((placement) => placement.assetId);
        for (const assetId of original.assetIds) if (!edited.assetIds.includes(assetId)) edited.assetIds.push(assetId);
      }
      // Materialise placements only when the scene actually carries assets (or
      // already carried a placement list); a scene that never had one must stay
      // without one so the untouched round-trip is byte-for-byte identical.
      if (rebuilt.length || original.placements) edited.placements = rebuilt;
      collectKeywordRemovals(original, edited, row.rowNumber, keywordRemovals);
      if (edited.narration !== original.narration) narrationChanged = true;
      if (sceneFieldsChanged(original, edited)) changedScenes.push(original.id);
      finalScenes.push(edited);
      rowOfScene.set(edited.id, row.rowNumber);
      continue;
    }

    /* No scene carries this row's id (a blank id included), so it is an addition.
       Current sheets need nothing else to say so; the per-row checks above already
       refused an older sheet that marked such a row 保留. */
    if (lastExistingSection === null) {
      fail(row.rowNumber, `第${row.rowNumber}行：新增行必须位于封面之后`);
      continue;
    }
    // A new row inherits the section of the block it is physically inside, which
    // is what makes the sheet read top-to-bottom. `overview` rows belong to the
    // opening block; an `outro-lead` row belongs to the closing block, which now
    // plays AFTER the pull-back — so it is only legal once the outro has been
    // emitted, and it is the last thing on the tape.
    if (row.section === "outro-lead") {
      if (!sawOutro) {
        fail(row.rowNumber, `第${row.rowNumber}行：结尾补充(outro-lead)只能插在拉回上级区域结尾之后（当前还没走到结尾）`);
        continue;
      }
    } else if (lastExistingSection === "child" || lastExistingSection === "outro" || lastExistingSection === "outro-lead") {
      fail(row.rowNumber, `第${row.rowNumber}行：总体介绍(overview)新增行只能插在封面之后、第一个行政区巡游之前，不能插在${SECTION_LABELS[lastExistingSection] ?? lastExistingSection}之后`);
      continue;
    }
    // An added row may name its own id; only mint a fresh one when it left
    // 场景id blank. The addable-section check above already ran, so the cast is
    // safe and narrows `row.section` to the union the constructor accepts.
    const addableSection = row.section as AddableSection;
    const id = row.sceneId || uniqueAddedSceneId(takenIds, addableSection);
    takenIds.add(id);
    const scene = newOverviewScene(id, row.title, row.narration, row.sceneType as SceneType, addableSection);
    scene.subtitle = row.subtitle;
    if (row.assetIds.length) {
      scene.assetIds = [...row.assetIds];
      scene.placements = rebuildPlacements(null, row.assetIds, row.keywordGroups, assets, keywordsEditable);
    }
    finalScenes.push(scene);
    addedScenes.push(id);
    rowOfScene.set(id, row.rowNumber);
    narrationChanged = true;
  }

  if (registeredAssets.length || pictureRegistrations.length) {
    /* Either route grew the picture set, so the library changes too -- and the
       operator has to be told, because an asset appearing out of a cell is not
       something the sheet looks like it should do. */
    next.assets = [...assets.values()];
    for (const asset of registeredAssets) {
      warnings.push(`表格里写的路径不在素材库里，已自动登记为新素材：「${asset.name}」(${asset.id}) → ${asset.path}。下次导出即可在「素材库」页看到它。`);
    }
    for (const entry of pictureRegistrations) {
      warnings.push(`第${entry.rowNumber}行（${entry.scene}）：表格里贴进来的图片已登记为新素材「${entry.asset.name}」(${entry.asset.id})，并放进了该场景的成片 —— 等同于在 Studio 里上传这张图。文件会保存为 ${entry.asset.path}，下次导出即可在「素材库」页与 Studio 素材列表里看到它。`);
    }
    // Registered pictures are library changes as well as scene changes.
    changedAssets += pictureRegistrations.length;
  }

  /* A picture floating somewhere the sheet cannot use is worth saying out loud:
     it looks like a finished edit, and silently doing nothing with it is how this
     feature got its reputation for being broken. */
  for (const [rowIndex, pictures] of pastedPictures) {
    for (const picture of pictures) {
      if (consumedPictures.has(picture)) continue;
      const columnName = String(header[picture.column] ?? "").trim() || `第 ${picture.column + 1} 列`;
      warnings.push(`第${rowIndex + 1}行的「${columnName}」格贴了一张图片，但这一列不参与成片，导入没有使用它。要换图请把图片贴进 成片预览N 格子里（和它同一行的 成片素材N 可以留空或填素材id），或直接在该行改 成片素材N。`);
    }
  }

  if (!finalScenes.length) fail(null, "导入后方案没有任何场景");
  const coverCount = finalScenes.filter((scene) => scene.section === "cover").length;
  const outroCount = finalScenes.filter((scene) => scene.section === "outro").length;
  if (coverCount !== 1) fail(null, `方案必须且只能包含一个封面（当前 ${coverCount} 个）`);
  if (outroCount !== 1) fail(null, `方案必须且只能包含一个拉回结尾（当前 ${outroCount} 个）`);
  if (finalScenes[0]?.section !== "cover" || (finalScenes.at(-1)?.section !== "outro" && finalScenes.at(-1)?.section !== "outro-lead")) {
    fail(null, "场景顺序必须为：封面 → 总体介绍 → 行政区巡游 → 拉回结尾 → 结尾补充");
  }
  for (let position = 1; position < finalScenes.length; position += 1) {
    const current = finalScenes[position]!;
    const previous = finalScenes[position - 1]!;
    if (SECTION_RANK[current.section!] < SECTION_RANK[previous.section!]) {
      fail(null, "场景顺序必须保持：封面、总体介绍、行政区巡游、拉回结尾、结尾补充");
      break;
    }
  }

  next.scenes = finalScenes;
  if (!errors.length) {
    try {
      validateVideoProject(next);
    } catch (error) {
      fail(null, `最终校验未通过：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!errors.length) {
    for (const issue of findVisualAnchorIssues(next.scenes)) {
      const rowNumber = rowOfScene.get(issue.sceneId);
      const where = rowNumber ? `第${rowNumber}行 ` : "";
      const detail = issue.reason === "absent-from-scene"
        ? "未出现在该场景旁白中"
        : `只出现在其它场景（${issue.otherSceneIds.join("、")}）的旁白中`;
      warnings.push(`${where}场景「${issue.sceneTitle}」：素材关键词「${issue.keyword}」${detail}，会导致图文锚定错位，请检查旁白或关键词。`);
    }
    for (const removal of keywordRemovals) {
      warnings.push(`第${removal.row}行 场景「${removal.title}」：锚定关键词「${removal.keyword}」已从素材绑定中移除（原用于 ${removal.count} 个素材），请确认旁白中不再需要该图文锚定。`);
    }
  }

  return {
    ok: errors.length === 0,
    project: next,
    revision: Number(project.revision ?? 0),
    addedScenes,
    deletedScenes,
    changedScenes,
    changedAssets,
    pendingAssets,
    warnings,
    errors,
    needsNarrationRegen: narrationChanged
  };
}

function isNewer(candidate: VideoProject, current: VideoProject): boolean {
  const candidateUpdated = candidate.updatedAt ?? "";
  const currentUpdated = current.updatedAt ?? "";
  if (candidateUpdated !== currentUpdated) return candidateUpdated > currentUpdated;
  return Number(candidate.revision ?? 0) > Number(current.revision ?? 0);
}

/** Read the latest on-disk snapshot for a scheme without needing the Studio. */
export async function readLatestProjectSnapshot(root: string, projectId: string): Promise<VideoProject> {
  const projectsRoot = join(root, "workspace", "projects");
  const names = (await readdir(projectsRoot)).filter((name) => name === `${projectId}.json` || (name.startsWith(`${projectId}.v`) && name.endsWith(".json")));
  if (!names.length) throw new Error(`找不到方案 ${projectId} 的方案文件（workspace/projects）`);
  let best: VideoProject | null = null;
  for (const name of names) {
    try {
      const project = JSON.parse(await readFile(join(projectsRoot, name), "utf8")) as VideoProject;
      if (!best || isNewer(project, best)) best = project;
    } catch {
      // A damaged historical revision must not make the scheme unreadable.
    }
  }
  if (!best) throw new Error(`方案 ${projectId} 没有可读的方案快照`);
  return best;
}

async function latestStoredRevision(projectsRoot: string, projectId: string): Promise<number> {
  const prefix = `${projectId}.v`;
  const revisions = (await readdir(projectsRoot))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => Number(name.slice(prefix.length, -".json".length)))
    .filter(Number.isFinite);
  return revisions.length ? Math.max(...revisions) : 0;
}

/** Write a merged scheme as a new immutable revision snapshot, exactly like a save. */
export async function writeProjectSnapshot(root: string, project: VideoProject): Promise<VideoProject> {
  const projectsRoot = join(root, "workspace", "projects");
  await mkdir(projectsRoot, { recursive: true });
  const next = structuredClone(project);
  const diskRevision = await latestStoredRevision(projectsRoot, next.id);
  next.revision = Math.max(diskRevision, Number(next.revision || 0)) + 1;
  next.updatedAt = new Date().toISOString();
  validateVideoProject(next);
  await writeJsonVersionResilient(join(projectsRoot, `${next.id}.v${String(next.revision).padStart(6, "0")}.json`), next);
  return next;
}

export function workbookFileName(project: VideoProject, stamp = new Date()): string {
  const iso = stamp.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return `${project.id}-workbook-${iso}.xlsx`;
}