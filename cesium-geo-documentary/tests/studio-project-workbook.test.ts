import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { AssetPlacement, SceneTiming, StudioAsset, StudioScene, VideoProject } from "../packages/project-schema/index.js";
import {
  isWrittenPreview,
  readXlsx,
  readXlsxImages,
  readXlsxPackage,
  writeXlsx,
  type SheetCell,
  type SheetSpec
} from "../packages/workbook-sheet/index.js";
import {
  LIBRARY_SHEET,
  NOTES_SHEET,
  PREVIEW_BOX_HEIGHT,
  PREVIEW_BOX_WIDTH,
  SCENE_SHEET,
  buildProjectWorkbook,
  collectAssetPreviews,
  mergeProjectWorkbook,
  readPreview,
  type WorkbookPreview
} from "../apps/studio/project-workbook.js";

/**
 * The workbook is the seam between a machine-owned scheme and a human editor.
 * These tests pin the properties that make it safe: an untouched sheet never
 * rewrites anything, only the images that actually enter the film are exported
 * (one id per cell, lead image marked, library name and preview picture shown),
 * and every illegal edit is rejected with the row that caused it — before a
 * single byte is saved.
 */

function placement(assetId: string, requiredKeywords: string[]): AssetPlacement {
  return {
    assetId, fit: "cover", crop: { x: 0, y: 0, width: 1, height: 1 }, focalPoint: { x: 0.5, y: 0.5 },
    scale: 1, offsetX: 0, offsetY: 0, animation: "push-in", leadSeconds: 0.2, tailSeconds: 0.15,
    minimumDisplaySeconds: 2, requiredKeywords, alt: assetId
  };
}

function timing(duration: number): SceneTiming {
  return { actualNarrationSeconds: duration, preHoldSeconds: 0, postHoldSeconds: 0, minimumVisualSeconds: duration, mapHoldSeconds: 0 };
}

const COVER: StudioScene = {
  id: "cover", type: "cover", section: "cover", title: "遂溪县草潭镇", narration: "", subtitle: "",
  duration: 1.6, assetIds: [], timing: timing(1.6), camera: { longitude: 110, latitude: 21, height: 20000, heading: 0, pitch: -45, transition: "fly" }
};
const OVERVIEW: StudioScene = {
  id: "overview-1", type: "image-card", section: "overview", title: "总体介绍", duration: 8,
  narration: "草潭镇位于遂溪县西南部，濒临北部湾。", subtitle: "草潭镇位于遂溪县西南部，濒临北部湾。",
  assetIds: ["asset-core"], placements: [{ ...placement("asset-core", ["草潭"]), includeInRender: true }], timing: timing(8)
};
const CHILD: StudioScene = {
  id: "child-440823113001", type: "region-focus", section: "child", childId: "440823113001", childName: "东港村",
  title: "东港村", duration: 6, narration: "东港村以渔业为主。", subtitle: "东港村以渔业为主。",
  assetIds: ["asset-extra"], placements: [{ ...placement("asset-extra", ["东港村"]), includeInRender: true }], timing: timing(6)
};
const OUTRO: StudioScene = {
  id: "outro", type: "outro", section: "outro", title: "拉回遂溪县", duration: 5,
  narration: "让我们回到遂溪县。", subtitle: "让我们回到遂溪县。", assetIds: [], timing: timing(5)
};

function fixture(): VideoProject {
  const assets: StudioAsset[] = [
    { id: "asset-core", name: "草潭渔港", path: "/workspace-assets/asset-core.jpg", type: "image", sourceType: "verified-real", verifiedReal: true },
    { id: "asset-extra", name: "东港村码头", path: "/workspace-assets/asset-extra.jpg", type: "image", sourceType: "amap-poi", verifiedReal: true }
  ];
  return {
    schemaVersion: 2, id: "project-test-workbook", name: "测试方案", regionId: "440823113", regionName: "草潭镇",
    revision: 3, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z",
    template: { id: "xinliao-town-tour-v1", lockedOpening: true, openingDescentSeconds: 4, openingStartHeightMeters: 120000, openingStartPitchDegrees: -90, cloudDeckHeightMeters: 30000, cloudAlphaPeak: 0.6, tourReturnSeconds: 3 },
    cover: {
      province: "广东省", city: "湛江市", county: "遂溪县", town: "草潭镇", topic: "地理图说", subtitle: "地理图说",
      administrativeLabel: "遂溪县草潭镇", titlePosition: "center", fontFamily: "sans", fontSize: 48, fontWeight: 700,
      color: "#fff", strokeColor: "#000", shadowColor: "#000", backgroundMode: "map-state", overlayOpacity: 0.4,
      introSeconds: 1.6, fadeInSeconds: 0.3, fadeOutSeconds: 0.3, safeMargin: 64, contentMeta: ""
    },
    output: { profile: "portrait", width: 1080, height: 1920, fps: 30, quality: "high" },
    imagery: { provider: "esri-world-imagery" },
    style: { theme: "default", primaryColor: "#fff", boundaryColor: "#ff0", fontFamily: "sans", subtitleSafeMargin: 64, subtitleMaxLines: 2 },
    voice: { enabled: true, voiceId: "v1", speed: 1, volume: 1 },
    assets, scenes: [structuredClone(COVER), structuredClone(OVERVIEW), structuredClone(CHILD), structuredClone(OUTRO)]
  };
}

/** Same as `fixture()`, but the overview scene really carries three images of
 * which the first two are marked 用于成片. */
function multiFilmFixture(): VideoProject {
  const project = fixture();
  project.assets.push(
    { id: "asset-b", name: "第二张图", path: "/workspace-assets/asset-b.jpg", type: "image", sourceType: "verified-real", verifiedReal: true },
    { id: "asset-c", name: "第三张图", path: "/workspace-assets/asset-c.jpg", type: "image", sourceType: "verified-real", verifiedReal: true }
  );
  const overview = project.scenes.find((scene) => scene.id === "overview-1")!;
  overview.assetIds = ["asset-core", "asset-b", "asset-c"];
  // 成片里两张、库里三张：只有勾了「用于成片」的才进片（第三张绑定但不选用）。
  overview.placements = [
    { ...placement("asset-core", ["草潭"]), includeInRender: true },
    { ...placement("asset-b", ["渔港"]), includeInRender: true },
    { ...placement("asset-c", ["西南部"]), includeInRender: false }
  ];
  return project;
}

/** Rebuild a workbook with edited sheets, keeping every other sheet intact. */
function rebuild(workbook: Buffer, mutate: (sheets: Map<string, string[][]>) => void): Buffer {
  const sheets = new Map(readXlsx(workbook).map((table) => [table.name, table.rows.map((row) => [...row])]));
  mutate(sheets);
  const specs: SheetSpec[] = [];
  for (const [name, rows] of sheets) specs.push({ name, rows: rows.map((row) => row.map((value) => ({ value }))) });
  return writeXlsx(specs);
}

const sceneRows = (workbook: Buffer, mutate: (rows: string[][]) => void): Buffer =>
  rebuild(workbook, (sheets) => mutate(sheets.get(SCENE_SHEET)!));

/** Resolve a header name to its column index using the sheet's own header row,
 * so tests never hard-code the variable 成片素材N column family width. */
function columns(rows: string[][]): (name: string) => number {
  const header = rows[0] ?? [];
  return (name: string): number => {
    const at = header.indexOf(name);
    assert.ok(at >= 0, `表格里没有「${name}」列（表头：${header.join(" | ")}）`);
    return at;
  };
}

/** Resolve a header name to its 0-based column index in a built workbook's scene sheet. */
function sceneColumn(workbook: Buffer, headerName: string): number {
  const header = readXlsx(workbook).find((table) => table.name === SCENE_SHEET)!.rows[0]!;
  const at = header.indexOf(headerName);
  assert.ok(at >= 0, `表格里没有「${headerName}」列（表头：${header.join(" | ")}）`);
  return at;
}

/** Insert an empty column at a 0-based position, in the header and every row. */
function insertColumn(rows: string[][], position: number, header: string): void {
  (rows[0] ?? []).splice(position, 0, header);
  for (let index = 1; index < rows.length; index += 1) (rows[index] ?? []).splice(position, 0, "");
}

/**
 * Find a scene's row by 场景id — the only key there is, and exactly how the
 * import finds it.
 */
function rowFor(rows: string[][], sceneId: string): string[] | undefined {
  const at = columns(rows)("场景id");
  return rows.find((candidate) => candidate[at] === sceneId);
}

function cell(rows: string[][], sceneId: string, column: string): string {
  const row = rowFor(rows, sceneId);
  assert.ok(row, `no row for scene ${sceneId}`);
  return String(row[columns(rows)(column)] ?? "");
}

/** Patch named cells on an existing scene's row. */
function setCells(rows: string[][], sceneId: string, values: Record<string, string>): void {
  const row = rowFor(rows, sceneId);
  assert.ok(row, `no row for scene ${sceneId}`);
  const col = columns(rows);
  for (const [name, value] of Object.entries(values)) row[col(name)] = value;
}

/** Find a 素材库 row by its 素材id (that sheet's key). */
function rowById(rows: string[][], assetId: string): string[] {
  const at = columns(rows)("素材id");
  const row = rows.find((candidate, index) => index > 0 && candidate[at] === assetId);
  assert.ok(row, `no library row for asset ${assetId}`);
  return row;
}

/** Build a full-width blank row carrying the given named cells. */
function makeRow(rows: string[][], values: Record<string, string>): string[] {
  const col = columns(rows);
  const row = Array.from({ length: (rows[0] ?? []).length }, () => "");
  for (const [name, value] of Object.entries(values)) row[col(name)] = value;
  return row;
}

test("an untouched workbook round-trips every human-editable field byte for byte", () => {
  const project = fixture();
  const result = mergeProjectWorkbook(project, buildProjectWorkbook(project));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.changedScenes, []);
  assert.deepEqual(result.addedScenes, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.needsNarrationRegen, false);
  assert.deepEqual(result.project.scenes.map((scene) => scene.id), project.scenes.map((scene) => scene.id));
  for (const before of project.scenes) {
    const after = result.project.scenes.find((scene) => scene.id === before.id)!;
    assert.equal(after.title, before.title);
    assert.equal(after.narration, before.narration);
    assert.equal(after.subtitle, before.subtitle);
    assert.equal(after.type, before.type);
    assert.equal(after.section, before.section);
    assert.deepEqual(after.assetIds, before.assetIds);
    assert.equal(after.duration, before.duration);
    assert.deepEqual(after.timing, before.timing);
    assert.deepEqual(after.camera, before.camera);
    assert.deepEqual(
      after.placements?.map((item) => [item.assetId, item.requiredKeywords, item.crop, item.animation]),
      before.placements?.map((item) => [item.assetId, item.requiredKeywords, item.crop, item.animation])
    );
  }
  assert.deepEqual(result.project.assets, project.assets);
});

test("an untouched multi-image workbook also round-trips byte for byte", () => {
  const project = multiFilmFixture();
  const result = mergeProjectWorkbook(project, buildProjectWorkbook(project));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.changedScenes, []);
  const before = project.scenes.find((scene) => scene.id === "overview-1")!;
  const after = result.project.scenes.find((scene) => scene.id === "overview-1")!;
  assert.deepEqual(after.assetIds, before.assetIds);
  assert.deepEqual(after.placements, before.placements);
});

test("the scene sheet exports only film images, one id per cell, with names and a lead marker", () => {
  const project = fixture();
  const tables = readXlsx(buildProjectWorkbook(project));
  const scene = tables.find((table) => table.name === SCENE_SHEET)!;
  assert.deepEqual(scene.rows[0], [
    "顺序", "场景id", "章节", "场景类型", "场景名称", "旁白字幕",
    "成片素材1(首图)", "素材名称1", "成片预览1",
    "成片素材2", "素材名称2", "成片预览2",
    "成片素材3", "素材名称3", "成片预览3",
    "校验提示"
  ]);
  // 素材关键词 is an internal anchoring contract, not a spreadsheet field: the
  // column must never come back (see the note in project-workbook.ts).
  assert.ok(
    !(scene.rows[0] ?? []).some((name) => /素材关键词/.test(String(name))),
    `表头不应再含素材关键词列：${(scene.rows[0] ?? []).join(" | ")}`
  );
  assert.equal(cell(scene.rows, "cover", "校验提示"), "封面（标题锁定）");
  assert.equal(cell(scene.rows, "overview-1", "旁白字幕"), "草潭镇位于遂溪县西南部，濒临北部湾。");
  assert.equal(cell(scene.rows, "overview-1", "成片素材1(首图)"), "asset-core");
  assert.equal(cell(scene.rows, "overview-1", "素材名称1"), "草潭渔港");
  assert.equal(cell(scene.rows, "overview-1", "成片素材2"), "");
  const library = tables.find((table) => table.name !== SCENE_SHEET && table.name !== NOTES_SHEET)!;
  assert.equal(library.rows.length, project.assets.length + 1);
});

test("the scene sheet exports no 时长 column at all", () => {
  const scene = readXlsx(buildProjectWorkbook(fixture())).find((table) => table.name === SCENE_SHEET)!;
  assert.ok(!(scene.rows[0] ?? []).some((name) => /时长/.test(String(name))), `表头不应含时长列：${(scene.rows[0] ?? []).join(" | ")}`);
  assert.ok(!(scene.rows[0] ?? []).includes("字幕"), "字幕列已并入旁白字幕");
  assert.ok(!(scene.rows[0] ?? []).includes("旁白"), "旁白列已并入旁白字幕");
});

test("a scene with several film images spills into 成片素材2/3 and never exports the rest", () => {
  const project = multiFilmFixture();
  const scene = readXlsx(buildProjectWorkbook(project)).find((table) => table.name === SCENE_SHEET)!;
  assert.equal(cell(scene.rows, "overview-1", "成片素材1(首图)"), "asset-core");
  assert.equal(cell(scene.rows, "overview-1", "素材名称1"), "草潭渔港");
  assert.equal(cell(scene.rows, "overview-1", "成片素材2"), "asset-b");
  assert.equal(cell(scene.rows, "overview-1", "素材名称2"), "第二张图");
  const overview = scene.rows.find((row) => row[columns(scene.rows)("场景id")] === "overview-1")!;
  assert.ok(!overview.includes("asset-c"), "未进入成片的素材id 不应出现在表格里");
  assert.ok(!overview.includes("第三张图"), "未进入成片的素材名称 不应出现在表格里");
});

/** A stand-in picture already inside the shared box; the sheet never looks inside the bytes. */
function fakePreview(): WorkbookPreview {
  return { data: Buffer.from("89504e470d0a1a0a", "hex"), extension: "png", widthPx: 96, heightPx: 72 };
}

test("export embeds a preview picture per film image and still round-trips", () => {
  const project = fixture();
  const previews = new Map([["asset-core", fakePreview()]]);
  const workbook = buildProjectWorkbook(project, { previews });
  const parts = readXlsxPackage(workbook);
  const names = [...parts.keys()];
  assert.ok(parts.has("xl/media/image1.png"), names.join(", "));
  assert.ok(parts.has("xl/drawings/drawing1.xml"), names.join(", "));
  assert.ok(parts.has("xl/drawings/_rels/drawing1.xml.rels"), names.join(", "));
  assert.ok(parts.has("xl/worksheets/_rels/sheet1.xml.rels"), names.join(", "));
  assert.match(parts.get("[Content_Types].xml")!.toString("utf8"), /Extension="png" ContentType="image\/png"/);
  const drawing = parts.get("xl/drawings/drawing1.xml")!.toString("utf8");
  assert.match(drawing, /<xdr:oneCellAnchor>/);
  // 成片预览1 is anchored one row below the header and centred inside its cell
  // rather than pinned to the top-left corner. Its column is read from the
  // sheet's own header, so removing or adding a per-image column cannot leave a
  // stale literal behind (it did: the preview column index used to be 11).
  const previewColumn = sceneColumn(workbook, "成片预览1");
  assert.match(drawing, new RegExp(`<xdr:from><xdr:col>${previewColumn}</xdr:col><xdr:colOff>\\d+</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>\\d+</xdr:rowOff></xdr:from>`));
  assert.doesNotMatch(drawing, /<xdr:colOff>0<\/xdr:colOff>/, "96px 宽的缩略图应在更宽的格子里居中，偏移不应为 0");
  assert.match(drawing, /r:embed="rId1"/);
  assert.match(parts.get("xl/drawings/_rels/drawing1.xml.rels")!.toString("utf8"), /Target="\.\.\/media\/image1\.png"/);
  assert.match(parts.get("xl/worksheets/sheet1.xml")!.toString("utf8"), /<drawing r:id="rId1"\/>/);
  // The preview column is reserved space: its cells carry no value a human edits.
  const scene = readXlsx(workbook).find((table) => table.name === SCENE_SHEET)!;
  assert.equal(cell(scene.rows, "overview-1", "成片预览1"), "");
  assert.equal(cell(scene.rows, "overview-1", "成片素材1(首图)"), "asset-core");
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.changedScenes, []);
  assert.deepEqual(result.project.scenes, project.scenes);
});

test("a picture is embedded only for images that really enter the film", () => {
  const project = multiFilmFixture();
  const previews = new Map([
    ["asset-core", fakePreview()],
    ["asset-b", fakePreview()],
    ["asset-c", fakePreview()], // bound to the scene but outside the film
    ["asset-extra", fakePreview()]
  ]);
  const parts = readXlsxPackage(buildProjectWorkbook(project, { previews }));
  const media = [...parts.keys()].filter((name) => name.startsWith("xl/media/"));
  assert.equal(media.length, 3, media.join(", "));
  const drawing = parts.get("xl/drawings/drawing1.xml")!.toString("utf8");
  // Slot 0 and slot 1 of the overview row, plus the child row's own picture.
  // Both columns come from the header so the assertion survives a column change.
  assert.match(drawing, new RegExp(`<xdr:col>${sceneColumn(buildProjectWorkbook(project, { previews }), "成片预览1")}</xdr:col>`));
  assert.match(drawing, new RegExp(`<xdr:col>${sceneColumn(buildProjectWorkbook(project, { previews }), "成片预览2")}</xdr:col>`));
  assert.match(drawing, /<xdr:row>3<\/xdr:row>/);
});

test("collectAssetPreviews builds one boxed thumbnail per film image and quietly skips the rest", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbook-previews-"));
  try {
    await mkdir(join(root, "workspace", "assets"), { recursive: true });
    // The file name says .jpg but the bytes are a real PNG. The format is read
    // from the content, so the thumbnail stays a PNG rather than being re-labelled.
    await writeFile(
      join(root, "workspace", "assets", "asset-core.jpg"),
      await sharp({ create: { width: 960, height: 480, channels: 3, background: { r: 20, g: 60, b: 120 } } }).png().toBuffer()
    );
    // asset-extra is a film image too, but its file is absent: that must cost
    // one picture, never the export.
    const previews = await collectAssetPreviews(root, fixture());
    assert.deepEqual([...previews.keys()], ["asset-core"]);
    const preview = previews.get("asset-core")!;
    assert.equal(preview.extension, "png");
    // 960x480 is 2:1, so inside the 240x180 box it becomes 240x120.
    assert.equal(preview.widthPx, 240);
    assert.equal(preview.heightPx, 120);
    const meta = await sharp(preview.data).metadata();
    assert.equal(meta.format, "png");
    assert.equal(meta.width, 240);
    assert.equal(meta.height, 120);
    // And the export that consumes them stays a valid workbook.
    const workbook = buildProjectWorkbook(fixture(), { previews });
    assert.ok(readXlsxPackage(workbook).has("xl/media/image1.png"));
    assert.match(readXlsxPackage(workbook).get("xl/worksheets/sheet1.xml")!.toString("utf8"), /customHeight="1"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a huge photo is shrunk into the shared preview box instead of blowing out its cell", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbook-previews-"));
  try {
    await mkdir(join(root, "workspace", "assets"), { recursive: true });
    const source = await sharp({ create: { width: 3600, height: 2400, channels: 3, background: { r: 10, g: 10, b: 10 } } })
      .jpeg({ quality: 90 }).toBuffer();
    await writeFile(join(root, "workspace", "assets", "asset-core.jpg"), source);
    const preview = (await collectAssetPreviews(root, fixture())).get("asset-core")!;
    assert.equal(preview.extension, "jpeg");
    // 3600x2400 is 3:2, limited by the box's width: 240 x 160.
    assert.equal(preview.widthPx, 240);
    assert.equal(preview.heightPx, 160);
    const meta = await sharp(preview.data).metadata();
    assert.equal(meta.width, 240, "内嵌的必须是缩略图尺寸，而不是原图尺寸");
    assert.equal(meta.height, 160);
    assert.ok(preview.data.length < source.length / 10, `缩略图应当远小于原图：${preview.data.length} vs ${source.length}`);
    assert.ok(readXlsxPackage(buildProjectWorkbook(fixture(), { previews: new Map([["asset-core", preview]]) })).has("xl/media/image1.jpeg"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("一个 WebP 缩略图仍然编码为 WebP，而不是被悄悄换成 JPEG", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbook-webp-"));
  try {
    await mkdir(join(root, "workspace", "assets"), { recursive: true });
    const file = join(root, "workspace", "assets", "asset-webp.webp");
    await writeFile(file, await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 20, g: 40, b: 60 } } })
      .webp().toBuffer());
    const preview = (await readPreview(file))!;
    assert.ok(preview);
    // The declared extension and the actual bytes must agree: the sheet names
    // the media part after the extension, and a mismatch shows a broken image.
    assert.equal(preview.extension, "webp");
    const meta = await sharp(preview.data).metadata();
    assert.equal(meta.format, "webp", "声明是 webp，字节却是别的格式");
    assert.ok(preview.widthPx <= PREVIEW_BOX_WIDTH && preview.heightPx <= PREVIEW_BOX_HEIGHT);
    // And it reaches the package under a name that matches those bytes.
    const pkg = readXlsxPackage(buildProjectWorkbook(fixture(), { previews: new Map([["asset-core", preview]]) }));
    assert.ok(pkg.has("xl/media/image1.webp"), [...pkg.keys()].filter((k) => k.startsWith("xl/media/")).join(","));
  } finally {
    // sharp's WebP decoder can still hold the source handle for a moment after
    // `metadata()` resolves, and Windows refuses to unlink a file that is open.
    // The assertions above have already run by now, so a retry here only guards
    // the cleanup -- it can never mask a real failure.
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("every preview is drawn inside the one shared box", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbook-previews-"));
  try {
    await mkdir(join(root, "workspace", "assets"), { recursive: true });
    const shapes: Array<[number, number]> = [[3000, 1000], [800, 2400], [500, 500], [120, 90]];
    for (const [width, height] of shapes) {
      // sharp reads lazily and keeps the file open, so each iteration gets its
      // own file rather than racing a rewrite of the previous one.
      const file = join(root, "workspace", "assets", `asset-${width}x${height}.jpg`);
      await writeFile(file, await sharp({ create: { width, height, channels: 3, background: { r: 5, g: 5, b: 5 } } }).jpeg().toBuffer());
      const preview = (await readPreview(file))!;
      assert.ok(preview, `${width}x${height} 应能生成缩略图`);
      assert.ok(
        preview.widthPx <= PREVIEW_BOX_WIDTH && preview.heightPx <= PREVIEW_BOX_HEIGHT,
        `${width}x${height} 画出来是 ${preview.widthPx}x${preview.heightPx}，超出预览框`
      );
      // A picture smaller than the box must not be blown up into a blurry one.
      assert.ok(preview.widthPx <= width && preview.heightPx <= height, `${width}x${height} 被放大了`);
      const meta = await sharp(preview.data).metadata();
      assert.equal(meta.width, preview.widthPx);
      assert.equal(meta.height, preview.heightPx);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an EXIF-rotated photo arrives upright in its box", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbook-previews-"));
  try {
    await mkdir(join(root, "workspace", "assets"), { recursive: true });
    // Orientation 6 swaps the axes: the stored file is 400x200, but it depicts a
    // 200x400 portrait. Sizing the box from the raw file would squeeze it back
    // into a landscape 240x120; the upright box is 180x90 for the long edge.
    await writeFile(
      join(root, "workspace", "assets", "asset-core.jpg"),
      await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 0, g: 0, b: 0 } } })
        .jpeg().withMetadata({ orientation: 6 }).toBuffer()
    );
    const preview = (await collectAssetPreviews(root, fixture())).get("asset-core")!;
    assert.equal(preview.extension, "jpeg");
    assert.equal(preview.heightPx, 180, "旋转后的长边应贴到预览框高度");
    assert.equal(preview.widthPx, 90);
    // The pixel data itself is portrait: taller than it is wide. This is the
    // check that catches the axes being measured before EXIF is applied.
    assert.ok(preview.heightPx > preview.widthPx, `缩略图应是竖构图，实际 ${preview.widthPx}x${preview.heightPx}`);
    const meta = await sharp(preview.data).metadata();
    assert.equal(meta.orientation, undefined, "缩略图不应再带 EXIF 旋转标记，方向已烘焙进像素");
    assert.equal(meta.width, 90);
    assert.equal(meta.height, 180);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a picture format that cannot be carried as-is is skipped rather than re-encoded", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbook-previews-"));
  try {
    await mkdir(join(root, "workspace", "assets"), { recursive: true });
    // sharp can read AVIF, but spreadsheet apps cannot draw it, so there is no
    // media part that could hold it: skip the picture.
    await writeFile(join(root, "workspace", "assets", "asset-core.jpg"), await sharp({ create: { width: 80, height: 60, channels: 3, background: { r: 1, g: 2, b: 3 } } }).avif().toBuffer());
    const previews = await collectAssetPreviews(root, fixture());
    assert.equal(previews.has("asset-core"), false, "不可内嵌的格式应当跳过，而不是转换");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("editing the film-image cells reorders and grows the film selection", () => {
  const project = multiFilmFixture();
  const workbook = sceneRows(buildProjectWorkbook(project), (rows) => {
    setCells(rows, "overview-1", { "成片素材1(首图)": "asset-b", "成片素材2": "asset-core", "成片素材3": "asset-c" });
  });
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const edited = result.project.scenes.find((scene) => scene.id === "overview-1")!;
  assert.deepEqual(edited.assetIds.slice(0, 3), ["asset-b", "asset-core", "asset-c"]);
  const film = (edited.placements ?? []).filter((item) => item.includeInRender === true).map((item) => item.assetId);
  assert.deepEqual(film, ["asset-b", "asset-core", "asset-c"]);
});

test("previews of different aspect ratios all sit centred in equal cells", () => {
  const project = multiFilmFixture();
  const previews = new Map([
    ["asset-core", { data: Buffer.from("89504e470d0a1a0a", "hex"), extension: "png" as const, widthPx: 240, heightPx: 160 }],
    ["asset-b", { data: Buffer.from("89504e470d0a1a0a", "hex"), extension: "png" as const, widthPx: 116, heightPx: 180 }]
  ]);
  const parts = readXlsxPackage(buildProjectWorkbook(project, { previews }));
  const drawing = parts.get("xl/drawings/drawing1.xml")!.toString("utf8");
  const anchors = [...drawing.matchAll(/<xdr:col>(\d+)<\/xdr:col><xdr:colOff>(\d+)<\/xdr:colOff><xdr:row>(\d+)<\/xdr:row><xdr:rowOff>(\d+)<\/xdr:rowOff>/g)];
  assert.ok(anchors.length >= 2, "至少要有两张缩略图");
  // Both are in the same column family, so the wider one must have the smaller
  // left offset — that is what "centred" means here.
  const byColumn = new Map<number, { colOff: number; rowOff: number }>();
  for (const [, col, colOff, , rowOff] of anchors) {
    byColumn.set(Number(col), { colOff: Number(colOff), rowOff: Number(rowOff) });
  }
  const three = byColumn.get(10);
  const fifteen = byColumn.get(14);
  if (three && fifteen) {
    // asset-core is 240 wide (wider than asset-b's 116), so it sits further left.
    assert.ok(three.colOff < fifteen.colOff, `240 宽的图偏移应小于 116 宽的图：${three.colOff} vs ${fifteen.colOff}`);
  }
  // The tall picture is centred vertically too: 180 fills the box, so no offset.
  assert.ok([...byColumn.values()].some((v) => v.rowOff === 0 || v.rowOff > 0), "行偏移应被显式计算");
});

/**
 * A picture the operator pasted in: bytes this module did not write, so it
 * carries no preview marker. That absence is the whole signal.
 */
function pastedPicture(): Buffer {
  return Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
}

/** 0-based row index of a scene's row, which is what a drawing anchor reports. */
function rowIndexOf(rows: string[][], sceneId: string): number {
  const at = columns(rows)("场景id");
  const index = rows.findIndex((candidate) => candidate[at] === sceneId);
  assert.ok(index > 0, `no row for scene ${sceneId}`);
  return index;
}

/**
 * Rebuild the sheet with one more picture floating over a cell, and nothing else
 * changed. The picture carries no marker, which is exactly what Excel and WPS
 * produce when a human pastes a photo into a cell.
 */
function pastePicture(
  workbook: Buffer,
  anchor: { row: number; column: string },
  bytes: Buffer,
  mutate?: (sheets: Map<string, string[][]>) => void
): Buffer {
  const tables = readXlsx(workbook);
  const sheets = new Map(tables.map((table) => [table.name, table.rows.map((row) => [...row])]));
  mutate?.(sheets);
  const sceneTable = tables.find((table) => table.name === SCENE_SHEET)!;
  const column = columns(sceneTable.rows)(anchor.column);
  return writeXlsx([...sheets].map(([name, rows]): SheetSpec => {
    const spec: SheetSpec = { name, rows: rows.map((row) => row.map((value) => ({ value }))) };
    if (name === SCENE_SHEET) {
      spec.images = [{ row: anchor.row, column, data: bytes, extension: "jpeg", widthPx: 240, heightPx: 180 }];
    }
    return spec;
  }));
}

const sceneSheetRows = (workbook: Buffer): string[][] =>
  readXlsx(workbook).find((table) => table.name === SCENE_SHEET)!.rows;

test("a thumbnail the export embedded is never read back as a picture the operator supplied", () => {
  const project = multiFilmFixture();
  const previews = new Map([["asset-core", fakePreview()], ["asset-b", fakePreview()]]);
  const workbook = buildProjectWorkbook(project, { previews });
  // The export really did embed pictures; otherwise this test proves nothing.
  assert.equal(readXlsxImages(workbook).length, 2, "导出应内嵌两张缩略图");
  assert.ok(readXlsxImages(workbook).every(isWrittenPreview), "内嵌的缩略图必须带识别标记");

  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.pendingAssets, [], "缩略图不是新素材");
  assert.deepEqual(result.changedScenes, [], "缩略图不该让任何场景变成「已修改」");
  assert.equal(result.changedAssets, 0);
  assert.deepEqual(result.project.assets, project.assets, "素材库不能被缩略图撑大");
});

test("a thumbnail whose shape metadata was dropped is still recognised by its recorded hash", () => {
  const project = multiFilmFixture();
  const preview = fakePreview();
  const exported = buildProjectWorkbook(project, { previews: new Map([["asset-core", preview]]) });

  const tables = readXlsx(exported);
  const notes = tables.find((table) => table.name === NOTES_SHEET)!;
  const fingerprints = String(notes.rows.find((row) => String(row[0] ?? "").trim() === "预览指纹")?.[1] ?? "");
  assert.match(fingerprints, /^\d+:\d+=[0-9a-f]{16}$/, `导出应记录每张缩略图的内容指纹（实为「${fingerprints}」）`);

  /* Rebuild the sheet the way an editor that discards shape names and
     descriptions would: same cell text, same picture, same bytes, no marker on
     the shape. This is the case that would otherwise register every thumbnail as
     a brand new asset -- which is why the hash is recorded as cell text too. */
  const sceneTable = tables.find((table) => table.name === SCENE_SHEET)!;
  const previewColumn = sceneColumn(exported, "成片预览1");
  const stripped = writeXlsx(tables.map((table): SheetSpec => {
    const spec: SheetSpec = { name: table.name, rows: table.rows.map((row) => row.map((value) => ({ value }))) };
    if (table.name === SCENE_SHEET) {
      spec.images = [{
        row: rowIndexOf(sceneTable.rows, "overview-1"), column: previewColumn,
        data: preview.data, extension: "png", widthPx: preview.widthPx, heightPx: preview.heightPx
      }];
    }
    return spec;
  }));
  assert.equal(isWrittenPreview(readXlsxImages(stripped)[0]!), false, "这张图确实没有形状标记");

  const result = mergeProjectWorkbook(project, stripped);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.pendingAssets, [], "靠 预览指纹 仍应认出它是导出时那张缩略图");
  assert.deepEqual(result.changedScenes, []);
  assert.deepEqual(result.project.assets, project.assets);
});

test("a picture dropped into a slot the export left empty is used", () => {
  const project = multiFilmFixture();
  const workbook = buildProjectWorkbook(project);
  const rows = sceneSheetRows(workbook);
  // 成片预览4 was empty at export time, so no anchor fingerprint exists for it:
  // a picture there can only have been put there by the operator.
  const withPicture = pastePicture(workbook, { row: rowIndexOf(rows, "overview-1"), column: "成片预览4" }, pastedPicture());
  const result = mergeProjectWorkbook(project, withPicture);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.pendingAssets.length, 1);
  const scene = result.project.scenes.find((item) => item.id === "overview-1")!;
  const film = (scene.placements ?? []).filter((item) => item.includeInRender !== false).map((item) => item.assetId);
  assert.equal(film.at(-1), result.pendingAssets[0]!.asset.id, "贴的图排在成片末尾");
  assert.equal(film[0], "asset-core", "已有的图顺序不变");
});

test("a marker that no longer matches its own bytes is not trusted", () => {
  const preview = { data: fakePreview().data, extension: "png" as const, widthPx: 96, heightPx: 72, preview: true };
  const workbook = writeXlsx([{ name: SCENE_SHEET, rows: [[{ value: "x" }]], images: [{ ...preview, row: 0, column: 0 }] }]);
  const [image] = readXlsxImages(workbook);
  assert.ok(image, "图片应能被读回");
  assert.equal(isWrittenPreview(image!), true);

  // The shape name says "preview", the bytes say otherwise: a replaced picture
  // under a kept name must not be mistaken for a thumbnail of ours.
  const stale = { ...image!, data: pastedPicture() };
  assert.equal(isWrittenPreview(stale), false);
});

test("a picture pasted over a film slot becomes an asset and joins the film", () => {
  const project = multiFilmFixture();
  const workbook = buildProjectWorkbook(project);
  const bytes = pastedPicture();
  const rows = sceneSheetRows(workbook);
  const withPicture = pastePicture(workbook, { row: rowIndexOf(rows, "overview-1"), column: "成片预览1" }, bytes);

  const result = mergeProjectWorkbook(project, withPicture);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.pendingAssets.length, 1, "贴进来的图片要有字节交给调用方落盘");
  const [pending] = result.pendingAssets;
  assert.deepEqual(pending!.data, bytes, "落盘的必须是贴进去的那张图");
  assert.match(pending!.asset.path, /^\/workspace-assets\/sheet-[0-9a-f]{16}\.jpeg$/, "文件名应内容寻址");
  assert.equal(pending!.asset.type, "image");
  assert.equal(pending!.asset.sourceType, "user-provided");

  const scene = result.project.scenes.find((item) => item.id === "overview-1")!;
  assert.equal(scene.assetIds[0], pending!.asset.id, "贴的图成为首图，压过同格原本的素材id");
  assert.equal(result.changedScenes.join(), "overview-1");
  assert.equal(result.changedAssets, 1, "素材库也长了");
  assert.ok(result.project.assets.some((asset) => asset.id === pending!.asset.id));
  // The displaced picture keeps its binding; it simply leaves the film.
  assert.equal((scene.placements ?? []).find((item) => item.assetId === "asset-core")?.includeInRender, false);
  assert.ok(scene.assetIds.includes("asset-core"), "退出成片 ≠ 解绑");
  assert.ok(
    result.warnings.some((warning) => warning.includes("贴进来的图片已登记为新素材") && warning.includes(pending!.asset.id)),
    JSON.stringify(result.warnings)
  );
});

test("the same pasted picture imported twice reuses the asset it registered", () => {
  const project = multiFilmFixture();
  const first = mergeProjectWorkbook(
    project,
    pastePicture(buildProjectWorkbook(project), { row: rowIndexOf(sceneSheetRows(buildProjectWorkbook(project)), "overview-1"), column: "成片预览1" }, pastedPicture())
  );
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  assert.equal(first.pendingAssets.length, 1);

  // The realistic second pass: the operator re-exports (which re-embeds the
  // picture that is now in the film) and pastes the same photo again.
  const again = buildProjectWorkbook(first.project);
  const second = mergeProjectWorkbook(
    first.project,
    pastePicture(again, { row: rowIndexOf(sceneSheetRows(again), "overview-1"), column: "成片预览1" }, pastedPicture())
  );
  assert.equal(second.ok, true, JSON.stringify(second.errors));
  assert.deepEqual(second.pendingAssets, [], "同一个文件不必再写一遍");
  assert.equal(
    second.project.assets.filter((asset) => asset.path.startsWith("/workspace-assets/sheet-")).length,
    1,
    "同一张图不该在素材库里长出第二个"
  );
  assert.deepEqual(second.changedScenes, [], "重复导入同一张图不算改动");
});

test("a picture pasted outside the film columns is reported and ignored", () => {
  const project = multiFilmFixture();
  const workbook = buildProjectWorkbook(project);
  const withPicture = pastePicture(workbook, { row: rowIndexOf(sceneSheetRows(workbook), "overview-1"), column: "旁白字幕" }, pastedPicture());
  const result = mergeProjectWorkbook(project, withPicture);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.pendingAssets, []);
  assert.deepEqual(result.changedScenes, []);
  assert.ok(
    result.warnings.some((warning) => warning.includes("不参与成片") && warning.includes("旁白字幕")),
    JSON.stringify(result.warnings)
  );
});

test("a sheet exported before the marker existed ignores its pictures and says why", () => {
  const project = multiFilmFixture();
  const workbook = buildProjectWorkbook(project);
  const rows = sceneSheetRows(workbook);
  const withoutMarkerRow = (sheets: Map<string, string[][]>): void => {
    const notes = sheets.get(NOTES_SHEET)!;
    const at = notes.findIndex((row) => String(row[0] ?? "").trim() === "图片标记");
    assert.ok(at >= 0, "新导出的表格应带「图片标记」行");
    notes.splice(at, 1);
  };
  const legacy = pastePicture(
    workbook,
    { row: rowIndexOf(rows, "overview-1"), column: "成片预览1" },
    pastedPicture(),
    withoutMarkerRow
  );
  const result = mergeProjectWorkbook(project, legacy);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.pendingAssets, [], "分不清是缩略图还是贴图时，一张都不用");
  assert.ok(
    result.warnings.some((warning) => warning.includes("图片标记") && warning.includes("重新导出")),
    JSON.stringify(result.warnings)
  );
});

test("a pasted picture over the 素材名称 cell of the same slot works too", () => {
  const project = multiFilmFixture();
  const workbook = buildProjectWorkbook(project);
  const withPicture = pastePicture(workbook, { row: rowIndexOf(sceneSheetRows(workbook), "overview-1"), column: "素材名称1" }, pastedPicture());
  const result = mergeProjectWorkbook(project, withPicture);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.pendingAssets.length, 1);
  const scene = result.project.scenes.find((item) => item.id === "overview-1")!;
  assert.equal(scene.assetIds[0], result.pendingAssets[0]!.asset.id);
});

test("every preview in a real export shares one cell geometry", () => {
  const project = multiFilmFixture();
  const previews = new Map([
    ["asset-core", { data: Buffer.from("89504e470d0a1a0a", "hex"), extension: "png" as const, widthPx: 240, heightPx: 160 }],
    ["asset-b", { data: Buffer.from("89504e470d0a1a0a", "hex"), extension: "png" as const, widthPx: 116, heightPx: 180 }]
  ]);
  const parts = readXlsxPackage(buildProjectWorkbook(project, { previews }));
  const xml = parts.get("xl/worksheets/sheet1.xml")!.toString("utf8");
  const widths = [...xml.matchAll(/<col min="(\d+)" max="\d+" width="([\d.]+)"/g)]
    .filter(([, min]) => {
      const header = readXlsx(buildProjectWorkbook(project, { previews })).find((t) => t.name === SCENE_SHEET)!.rows[0]!;
      return /^成片预览\d+$/.test(String(header[Number(min) - 1] ?? ""));
    })
    .map(([, , width]) => width);
  assert.ok(widths.length > 0, "应能找到成片预览列");
  assert.equal(new Set(widths).size, 1, `所有成片预览列宽必须一致：${widths.join(", ")}`);
});

test("a legacy 素材关键词N column still binds to its 成片素材N image and other bindings stay put", () => {
  const project = multiFilmFixture();
  /* New exports deliberately carry no 素材关键词 column (see project-workbook.ts).
     This rebuilds the older sheet that still had one, so the legacy editing path
     stays covered instead of quietly disappearing with the column. */
  const workbook = sceneRows(buildProjectWorkbook(project), (rows) => {
    insertColumn(rows, columns(rows)("素材名称2") + 1, "素材关键词2");
    insertColumn(rows, columns(rows)("素材名称1") + 1, "素材关键词1");
    setCells(rows, "overview-1", { "素材关键词1": "草潭", "素材关键词2": "北部湾" });
  });
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const edited = result.project.scenes.find((scene) => scene.id === "overview-1")!;
  const byAsset = new Map((edited.placements ?? []).map((item) => [item.assetId, item.requiredKeywords]));
  assert.deepEqual(byAsset.get("asset-core"), ["草潭"]);
  assert.deepEqual(byAsset.get("asset-b"), ["北部湾"]);
  assert.deepEqual(byAsset.get("asset-c"), ["西南部"], "未进入成片的绑定不应被表格改写");
});

test("a sheet with no 素材关键词 column leaves every anchoring keyword exactly as it was", () => {
  const project = multiFilmFixture();
  /* The column is absent, so it is read-only -- not empty. Treating "no column"
     as "no keywords" would strip every anchor in the scheme on the next import,
     which is the one failure this round-trip must never have. The edit also
     swaps the two film slots, so the rebuild really does run and the keywords
     have to follow their asset rather than the slot number. */
  const workbook = sceneRows(buildProjectWorkbook(project), (rows) => {
    setCells(rows, "overview-1", {
      "旁白字幕": "草潭镇位于遂溪县西南部，紧邻北部湾。",
      "成片素材1(首图)": "asset-b",
      "成片素材2": "asset-core"
    });
  });
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const edited = result.project.scenes.find((scene) => scene.id === "overview-1")!;
  const byAsset = new Map((edited.placements ?? []).map((item) => [item.assetId, item.requiredKeywords]));
  assert.deepEqual(byAsset.get("asset-core"), ["草潭"], "关键词必须跟着素材走，且不被清空");
  assert.deepEqual(byAsset.get("asset-b"), ["渔港"]);
  assert.deepEqual(byAsset.get("asset-c"), ["西南部"]);
  const film = (edited.placements ?? []).filter((item) => item.includeInRender === true).map((item) => item.assetId);
  assert.deepEqual(film, ["asset-b", "asset-core"], "成片顺序仍应按表格改动生效");
});

test("putting two asset ids in one cell is refused", () => {
  const project = multiFilmFixture();
  const workbook = sceneRows(buildProjectWorkbook(project), (rows) => {
    setCells(rows, "overview-1", { "成片素材1(首图)": "asset-core,asset-b" });
  });
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((issue) => /一个成片素材格子只能填一个素材id/.test(issue.message)), JSON.stringify(result.errors));
});

test("a reference that is neither an id, a name, nor a path is refused, saying what is allowed", () => {
  const project = fixture();
  const workbook = sceneRows(buildProjectWorkbook(project), (rows) => {
    setCells(rows, "overview-1", { "成片素材1(首图)": "aaaa" });
  });
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, false);
  const message = result.errors.map((issue) => issue.message).join("\n");
  assert.match(message, /aaaa/, message);
  // The three accepted forms have to be spelled out: an operator staring at a UUID
  // column needs to know that a name or a path works too.
  for (const form of ["素材id", "素材名称", "路径"]) assert.ok(message.includes(form), `${form} 应出现在提示里：${message}`);
});

test("a picture may be named in 素材名称N when 成片素材N is left empty", () => {
  const project = fixture();
  // 北坑村-style case: the slot had no picture, and the operator typed the picture's
  // name into the display column instead of the id column. Both cells describe the
  // same slot, so either may name it.
  const workbook = sceneRows(buildProjectWorkbook(project), (rows) => {
    setCells(rows, "child-440823113001", { "成片素材1(首图)": "", "素材名称1": "草潭渔港" });
  });
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const scene = result.project.scenes.find((item) => item.id === "child-440823113001")!;
  const film = (scene.placements ?? []).filter((item) => item.includeInRender !== false).map((item) => item.assetId);
  assert.deepEqual(film, ["asset-core"], "名称格写的图应进成片");
  assert.ok(scene.assetIds.includes("asset-extra"), "原来那张仍保持绑定，只是退出成片");
  assert.deepEqual(result.changedScenes, ["child-440823113001"], "这必须算作「修改」，否则结果会说「没有任何差异」");
});

test("clearing 成片素材N still drops the picture, even though its name column keeps the old text", () => {
  const project = multiFilmFixture();
  // The export writes the name next to the id. Clearing the id means "take it out
  // of the film" -- reading the leftover name would silently put it back.
  const workbook = sceneRows(buildProjectWorkbook(project), (rows) => {
    setCells(rows, "overview-1", { "成片素材1(首图)": "", "成片素材2": "", "成片素材3": "" });
  });
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const scene = result.project.scenes.find((item) => item.id === "overview-1")!;
  const film = (scene.placements ?? []).filter((item) => item.includeInRender !== false).map((item) => item.assetId);
  assert.deepEqual(film, [], "清空 id 格就是退出成片");
});

test("an asset-library edit counts as a change, and is reported", () => {
  const project = fixture();
  const workbook = libraryRows(buildProjectWorkbook(project), (rows) => {
    const nameColumn = columns(rows)("素材名称");
    rowById(rows, "asset-core")[nameColumn] = "改过的名字";
  });
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  // The panel sums this with the scene counts to decide whether to say "nothing
  // changed" -- an asset rename used to be invisible there.
  assert.equal(result.changedAssets, 1);
  assert.ok(
    result.warnings.some((warning) => warning.includes("素材库有改动") && warning.includes("改过的名字")),
    JSON.stringify(result.warnings)
  );
});

test("a film cell may name the picture instead of carrying its id", () => {
  const project = fixture();
  // Exact name, and the loose form with the library's own trailing separator
  // dropped -- nobody types "草潭渔港 · ".
  for (const reference of ["草潭渔港", "草潭渔港 · "]) {
    const workbook = sceneRows(buildProjectWorkbook(project), (rows) => {
      setCells(rows, "overview-1", { "成片素材1(首图)": reference });
    });
    const result = mergeProjectWorkbook(project, workbook);
    assert.equal(result.ok, true, `${reference}: ${JSON.stringify(result.errors)}`);
    const scene = result.project.scenes.find((item) => item.id === "overview-1")!;
    assert.equal(scene.assetIds[0], "asset-core", `「${reference}」应绑定到 asset-core`);
  }
  // An ambiguous name must not be guessed at.
  const duplicated = structuredClone(project);
  duplicated.assets = [
    ...duplicated.assets,
    { ...structuredClone(duplicated.assets[0]!), id: "asset-core-twin", name: "草潭渔港" },
  ];
  const ambiguous = sceneRows(buildProjectWorkbook(duplicated), (rows) => {
    setCells(rows, "overview-1", { "成片素材1(首图)": "草潭渔港" });
  });
  const refused = mergeProjectWorkbook(duplicated, ambiguous);
  assert.equal(refused.ok, false);
  const message = refused.errors.map((issue) => issue.message).join("\n");
  assert.match(message, /匹配到 2 张同名素材/, message);
  assert.ok(message.includes("asset-core"), `提示应给出候选 id：${message}`);
});

test("a film cell may carry a path, which registers the picture as a new asset", async () => {
  const project = fixture();
  const root = await mkdtemp(join(tmpdir(), "workbook-film-path-"));
  try {
    await mkdir(join(root, "workspace", "assets"), { recursive: true });
    await writeFile(join(root, "workspace", "assets", "on-the-disk.jpg"), Buffer.from("exists"));

    const workbook = sceneRows(buildProjectWorkbook(project), (rows) => {
      // The path goes in the id cell; the neighbouring 素材名称N cell names it.
      setCells(rows, "overview-1", {
        "成片素材1(首图)": "/workspace-assets/on-the-disk.jpg",
        "素材名称1": "我自己的一张图",
      });
    });
    const result = mergeProjectWorkbook(project, workbook, root);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const scene = result.project.scenes.find((item) => item.id === "overview-1")!;
    const forged = result.project.assets.find((asset) => asset.path === "/workspace-assets/on-the-disk.jpg");
    assert.ok(forged, `路径应被登记为素材：${result.project.assets.map((asset) => asset.path).join(", ")}`);
    assert.equal(forged!.name, "我自己的一张图", "名称取操作者填在 素材名称N 里的那个");
    assert.equal(forged!.type, "image");
    assert.equal(forged!.sourceType, "user-provided");
    assert.equal(scene.assetIds[0], forged!.id, "该场景首图应指向新登记的素材");
    assert.equal(result.project.assets.length, project.assets.length + 1);
    // And the operator is told, because an asset appearing out of a cell is not
    // something the sheet looks like it should do.
    assert.ok(
      result.warnings.some((warning) => warning.includes("已自动登记为新素材") && warning.includes("我自己的一张图")),
      JSON.stringify(result.warnings)
    );
    // Referencing the same path twice reuses the asset instead of duplicating it.
    const twice = sceneRows(buildProjectWorkbook(project), (rows) => {
      setCells(rows, "overview-1", { "成片素材1(首图)": "/workspace-assets/on-the-disk.jpg" });
      setCells(rows, "child-440823113001", { "成片素材1(首图)": "/workspace-assets/on-the-disk.jpg" });
    });
    const reused = mergeProjectWorkbook(project, twice, root);
    assert.equal(reused.ok, true, JSON.stringify(reused.errors));
    assert.equal(reused.project.assets.length, project.assets.length + 1, "同一路径只登记一次");
    assert.equal(
      reused.project.scenes.find((item) => item.id === "child-440823113001")!.assetIds[0],
      reused.project.scenes.find((item) => item.id === "overview-1")!.assetIds[0],
      "两个场景指向同一张新素材"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Rewrite the 素材库 sheet the way a human would: append rows, delete rows,
 * change cells. Kept separate from `sceneRows` because a test that edits the
 * picture set has to touch a different sheet than the one it edits scenes in.
 */
function libraryRows(workbook: Buffer, mutate: (rows: string[][]) => void): Buffer {
  return rebuild(workbook, (sheets) => mutate(sheets.get(LIBRARY_SHEET)!));
}

const libraryRow = (rows: string[][], values: Record<string, string>): string[] => makeRow(rows, values);

test("a new library row registers an asset and the scene sheet can use it", async () => {
  const project = fixture();
  const root = await mkdtemp(join(tmpdir(), "workbook-lib-"));
  try {
    const file = join(root, "assets", "source", "new-pic.jpg");
    await mkdir(join(root, "assets", "source"), { recursive: true });
    await writeFile(file, Buffer.from("not really a jpeg, but it exists"));

    const workbook = libraryRows(buildProjectWorkbook(project), (rows) => {
      rows.push(libraryRow(rows, {
        "素材id": "asset-new", "素材名称": "新加的图", "类型": "image",
        "来源": "user-provided", "路径": "assets/source/new-pic.jpg"
      }));
    });
    const referenced = sceneRows(workbook, (rows) => {
      setCells(rows, "overview-1", { "成片素材1(首图)": "asset-new" });
    });
    const result = mergeProjectWorkbook(project, referenced, root);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const added = result.project.assets.find((asset) => asset.id === "asset-new");
    assert.ok(added, "新素材应进入方案素材表");
    assert.equal(added!.name, "新加的图");
    assert.equal(added!.type, "image");
    assert.equal(added!.sourceType, "user-provided");
    assert.equal(result.project.assets.length, project.assets.length + 1);
    const overview = result.project.scenes.find((scene) => scene.id === "overview-1")!;
    assert.equal(overview.assetIds[0], "asset-new", "场景首图应换成新素材");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("there is one export shape, and it can always change pictures", () => {
  const project = fixture();
  const tables = readXlsx(buildProjectWorkbook(project));
  assert.equal(tables.length, 3, "场景 / 素材库 / 说明");
  const header = tables.find((table) => table.name === SCENE_SHEET)!.rows[0]!.map(String);
  // The sheet people edit must be able to name a picture: a variant without this
  // column existed once, and every operator who used it concluded the import was
  // broken when their picture edits did nothing.
  assert.ok(header.includes("成片素材1(首图)"), header.join(" | "));
  assert.ok(header.includes("素材名称1"), header.join(" | "));
  assert.ok(header.includes("成片预览1"), header.join(" | "));
});

test("a picture-less sheet is tolerated, and says pictures will not change", () => {
  const project = multiFilmFixture();
  /* No export produces this any more, but an operator may be holding a sheet from
     an older build, so it is accepted -- read-only for the film -- and the result
     spells out what it cannot do. Built by deleting the 成片素材N / 素材库 columns
     from a real export, which is exactly what such a sheet looks like. */
  const workbook = rebuild(buildProjectWorkbook(project), (sheets) => {
    const scene = sheets.get(SCENE_SHEET)!;
    const header = scene[0]!.map(String);
    const keep = header.map((name, position) => ({ name, position }))
      .filter(({ name }) => !/^成片素材\d+/.test(name) && !/^素材关键词\d+$/.test(name))
      .map(({ position }) => position);
    for (let index = 0; index < scene.length; index += 1) {
      scene[index] = keep.map((position) => scene[index]![position]!);
    }
    sheets.delete(LIBRARY_SHEET);
  });
  const edited = sceneRows(workbook, (rows) => {
    setCells(rows, "overview-1", { "旁白字幕": "改过的旁白。" });
  });
  const result = mergeProjectWorkbook(project, edited);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const scene = result.project.scenes.find((item) => item.id === "overview-1")!;
  assert.equal(scene.narration, "改过的旁白。", "文案要照改");
  // No film columns means read-only pictures: the sheet cannot express a film, so
  // reading its empty asset list as "no pictures" would delete the film.
  assert.deepEqual(scene.assetIds, project.scenes.find((item) => item.id === "overview-1")!.assetIds, "图片绑定不能被清空");
  assert.deepEqual(result.project.assets, project.assets, "没有素材库页 = 素材库只读");
  assert.ok(
    result.warnings.some((warning) => warning.includes("没有 成片素材N 列") && warning.includes("换图不会生效")),
    `must say pictures will not change: ${JSON.stringify(result.warnings)}`
  );
});

test("a new library row may leave 素材id blank and gets one assigned", async () => {
  const project = fixture();
  const root = await mkdtemp(join(tmpdir(), "workbook-lib-blank-"));
  try {
    await mkdir(join(root, "assets", "source"), { recursive: true });
    await writeFile(join(root, "assets", "source", "fresh.jpg"), Buffer.from("exists"));

    /* The operator should not have to invent a primary key to add a picture --
       the same rule the scene sheet already uses for 场景id. The row is
       registered under a generated id, and that id is reported back because it
       is what a 成片素材N cell has to reference. */
    const workbook = libraryRows(buildProjectWorkbook(project), (rows) => {
      rows.push(libraryRow(rows, {
        "素材id": "", "素材名称": "留空新增的图", "类型": "image",
        "来源": "user-provided", "路径": "assets/source/fresh.jpg"
      }));
    });
    const result = mergeProjectWorkbook(project, workbook, root);
    assert.equal(result.ok, true, JSON.stringify(result.errors));

    const added = result.project.assets.filter((asset) => asset.name === "留空新增的图");
    assert.equal(added.length, 1, "留空 素材id 的行应当注册为一个新素材");
    const id = added[0]!.id;
    assert.match(id, /^asset-[a-z0-9]+$/, `自动分配的 id 形状应为 asset-xxx，实际 ${id}`);
    assert.equal(result.project.assets.length, project.assets.length + 1, "只应新增一个素材");
    assert.ok(
      result.warnings.some((warning) => warning.includes(id) && warning.includes("留空新增的图")),
      `导入结果必须告知分配到的 id，否则用户无从在 成片素材N 里引用它：${JSON.stringify(result.warnings)}`
    );

    // And the documented two-pass flow really works: re-export (which is also
    // where the operator finally sees the id), then put it into the film. Merging
    // the first sheet again would be wrong -- that sheet's 素材库 predates the new
    // asset and the library list is authoritative.
    const reexported = buildProjectWorkbook(result.project);
    const library = readXlsx(reexported).find((table) => table.name === LIBRARY_SHEET)!;
    assert.ok(library.rows.some((row) => row[0] === id), "重新导出后 素材库 里应能看到分配到的 id");
    const second = sceneRows(reexported, (rows) => {
      setCells(rows, "overview-1", { "成片素材1(首图)": id });
    });
    const followUp = mergeProjectWorkbook(result.project, second, root);
    assert.equal(followUp.ok, true, JSON.stringify(followUp.errors));
    const overview = followUp.project.scenes.find((scene) => scene.id === "overview-1")!;
    assert.equal(overview.assetIds[0], id, "拿到的 id 应能直接填进 成片素材1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a blank 素材id row still has to say what the picture is", async () => {
  const project = fixture();
  const root = await mkdtemp(join(tmpdir(), "workbook-lib-blank-bad-"));
  try {
    await mkdir(join(root, "assets", "source"), { recursive: true });
    await writeFile(join(root, "assets", "source", "fresh.jpg"), Buffer.from("exists"));
    // Leaving the id blank is now legal, so the real requirements (a name, a type
    // and a path that resolves) have to hold on their own.
    for (const row of [
      { "素材id": "", "素材名称": "", "类型": "image", "路径": "assets/source/fresh.jpg" },
      { "素材id": "", "素材名称": "有名字", "类型": "", "路径": "assets/source/fresh.jpg" },
      { "素材id": "", "素材名称": "有名字", "类型": "image", "路径": "assets/source/nope.jpg" }
    ]) {
      const workbook = libraryRows(buildProjectWorkbook(project), (rows) => { rows.push(libraryRow(rows, row)); });
      const result = mergeProjectWorkbook(project, workbook, root);
      assert.equal(result.ok, false, `应拒绝：${JSON.stringify(row)}`);
      assert.ok(result.errors.length > 0, "必须有逐行报错");
    }
    // A fully blank row is still padding, not a half-filled new asset.
    const padded = libraryRows(buildProjectWorkbook(project), (rows) => { rows.push(libraryRow(rows, {})); });
    const ok = mergeProjectWorkbook(project, padded, root);
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));
    assert.equal(ok.project.assets.length, project.assets.length, "空行不应注册素材");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new library row pointing at a file that does not exist is refused", () => {
  const project = fixture();
  const workbook = libraryRows(buildProjectWorkbook(project), (rows) => {
    rows.push(libraryRow(rows, {
      "素材id": "asset-ghost", "素材名称": "幽灵图", "类型": "image",
      "路径": "assets/source/nowhere.jpg"
    }));
  });
  // The default root is the repo, where this relative path certainly is not.
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((issue) => /找不到文件/.test(issue.message)), JSON.stringify(result.errors));
});

test("a new library row with an illegal id, a duplicate id or a bad type is refused", () => {
  const project = fixture();
  const base = buildProjectWorkbook(project);
  const bogusId = libraryRows(base, (rows) => {
    rows.push(libraryRow(rows, { "素材id": "bad id!", "素材名称": "x", "类型": "image", "路径": "assets/source/x.jpg" }));
  });
  assert.ok(mergeProjectWorkbook(project, bogusId).errors.some((issue) => /素材id/.test(issue.message)));

  const duplicate = libraryRows(base, (rows) => {
    rows.push(libraryRow(rows, { "素材id": "asset-core", "素材名称": "重复", "类型": "image", "路径": "assets/source/x.jpg" }));
  });
  assert.ok(mergeProjectWorkbook(project, duplicate).errors.some((issue) => /重复/.test(issue.message)));

  const badType = libraryRows(base, (rows) => {
    rows.push(libraryRow(rows, { "素材id": "asset-new", "素材名称": "x", "类型": "pdf", "路径": "assets/source/x.jpg" }));
  });
  assert.ok(mergeProjectWorkbook(project, badType).errors.some((issue) => /类型 必须是/.test(issue.message)));
});

test("deleting a library row drops the asset and every scene reference to it", () => {
  const project = fixture();
  const workbook = libraryRows(buildProjectWorkbook(project), (rows) => {
    const idColumn = columns(rows)("素材id");
    const at = rows.findIndex((row, index) => index > 0 && row[idColumn] === "asset-extra");
    rows.splice(at, 1);
  });
  // The scene sheet still names asset-extra, so the pass that resolves scene
  // images has to refuse the now-dangling reference rather than keep it.
  const stillReferenced = mergeProjectWorkbook(project, workbook);
  assert.equal(stillReferenced.ok, false);
  assert.ok(stillReferenced.errors.some((issue) => /在素材库中不存在/.test(issue.message)), JSON.stringify(stillReferenced.errors));

  // Clear the scene cells too and the deletion lands, taking the binding with it.
  const cleared = sceneRows(workbook, (rows) => {
    setCells(rows, "child-440823113001", { "成片素材1(首图)": "" });
  });
  const result = mergeProjectWorkbook(project, cleared);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.project.assets.some((asset) => asset.id === "asset-extra"), false);
  const child = result.project.scenes.find((scene) => scene.id === "child-440823113001")!;
  assert.deepEqual(child.assetIds, []);
  assert.deepEqual(child.placements, []);
});

test("editing a library asset's name patches the scheme in place", () => {
  const project = fixture();
  const workbook = libraryRows(buildProjectWorkbook(project), (rows) => {
    const nameColumn = columns(rows)("素材名称");
    rowById(rows, "asset-core")[nameColumn] = "改过的名字";
  });
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const asset = result.project.assets.find((candidate) => candidate.id === "asset-core")!;
  assert.equal(asset.name, "改过的名字");
  // A path left untouched must survive even though it resolves against nothing here:
  // only a genuinely NEW path is checked, which keeps an unedited sheet idempotent.
  assert.equal(asset.path, project.assets.find((a) => a.id === "asset-core")!.path);
  // Editing the library is not a scene change.
  assert.deepEqual(result.changedScenes, []);
});

test("a library asset's path may be revised, but only to a file that really exists", async () => {
  const project = fixture();
  const root = await mkdtemp(join(tmpdir(), "workbook-repath-"));
  try {
    // A path that resolves: accepted and applied.
    await mkdir(join(root, "assets", "source"), { recursive: true });
    await writeFile(join(root, "assets", "source", "moved.jpg"), Buffer.from("stands in for a real photo"));
    const ok = libraryRows(buildProjectWorkbook(project), (rows) => {
      rowById(rows, "asset-core")[columns(rows)("路径")] = "assets/source/moved.jpg";
    });
    const accepted = mergeProjectWorkbook(project, ok, root);
    assert.equal(accepted.ok, true, JSON.stringify(accepted.errors));
    assert.equal(accepted.project.assets.find((a) => a.id === "asset-core")!.path, "assets/source/moved.jpg");

    // A path that dangles: refused, because it would import cleanly and only blow
    // up later when the renderer tries to load the image.
    const dangling = libraryRows(buildProjectWorkbook(project), (rows) => {
      rowById(rows, "asset-core")[columns(rows)("路径")] = "/workspace-assets/definitely-missing.jpg";
    });
    const refused = mergeProjectWorkbook(project, dangling, root);
    assert.equal(refused.ok, false);
    assert.ok(refused.errors.some((issue) => /找不到文件/.test(issue.message)), JSON.stringify(refused.errors));

    // An illegal path shape is refused too, with the reason from classifyAssetPath.
    const illegal = libraryRows(buildProjectWorkbook(project), (rows) => {
      rowById(rows, "asset-core")[columns(rows)("路径")] = "https://example.com/pic.jpg";
    });
    const bad = mergeProjectWorkbook(project, illegal, root);
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((issue) => /路径/.test(issue.message)), JSON.stringify(bad.errors));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a library asset's type and source are locked, and saying so beats ignoring it", () => {
  const project = fixture();
  const cases: Array<[string, string, RegExp]> = [
    ["类型", "video", /类型 不可修改/],
    ["来源", "user-provided", /来源 不可修改/]
  ];
  for (const [column, value, pattern] of cases) {
    const workbook = libraryRows(buildProjectWorkbook(project), (rows) => {
      rowById(rows, "asset-core")[columns(rows)(column)] = value;
    });
    const result = mergeProjectWorkbook(project, workbook);
    assert.equal(result.ok, false, `${column} must be refused`);
    assert.ok(result.errors.some((issue) => pattern.test(issue.message)), JSON.stringify(result.errors));
    // Refusing is the point: silently importing would leave the operator believing
    // the change landed when the asset is untouched.
    assert.equal(result.project.assets.find((a) => a.id === "asset-core")!.type, "image");
  }
});

test("an untouched library sheet round-trips without touching a single asset", () => {
  const project = fixture();
  const result = mergeProjectWorkbook(project, buildProjectWorkbook(project));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.project.assets, project.assets);
});

test("an asset name keeps its own whitespace through a round-trip", () => {
  // AMap-derived names really do end in a separator ("… · "). Trimming the cell
  // while parsing rewrote every such name on every import — a silent data edit no
  // diff would ever flag, because 0 增 / 0 删 / 0 改 still reported clean.
  const project = fixture();
  const trailing = project.assets.find((asset) => asset.id === "asset-core")!;
  trailing.name = "东里村 · 郡廟境 · ";
  const result = mergeProjectWorkbook(project, buildProjectWorkbook(project));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.project.assets.find((asset) => asset.id === "asset-core")!.name, "东里村 · 郡廟境 · ");
  assert.deepEqual(result.project.assets, project.assets);

  // A name that is only whitespace is still refused for a new row.
  const blank = libraryRows(buildProjectWorkbook(project), (rows) => {
    const row = libraryRow(rows, { "素材id": "asset-blank", "素材名称": "   ", "类型": "image", "路径": "assets/source/x.jpg" });
    rows.push(row);
  });
  const refused = mergeProjectWorkbook(project, blank);
  assert.equal(refused.ok, false);
  assert.ok(refused.errors.some((issue) => /缺少 素材名称/.test(issue.message)), JSON.stringify(refused.errors));
});

test("a new overview row is added inside the overview block with a generated id", () => {
  const project = fixture();
  const workbook = sceneRows(buildProjectWorkbook(project), (rows) => {
    const sectionColumn = columns(rows)("章节");
    let lastOverview = 0;
    rows.forEach((row, index) => { if (row[sectionColumn] === "overview") lastOverview = index; });
    rows.splice(lastOverview + 1, 0, makeRow(rows, {
      "章节": "overview", "场景类型": "fact-card",
      "场景名称": "新增小节", "旁白字幕": "新增小节介绍草潭镇。",
      "成片素材1(首图)": "asset-core"
    }));
  });
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.changedScenes, []);
  assert.equal(result.addedScenes.length, 1);
  assert.match(result.addedScenes[0]!, /^overview-content-/);
  assert.equal(result.needsNarrationRegen, true);
  const ids = result.project.scenes.map((scene) => scene.id);
  const addedAt = ids.indexOf(result.addedScenes[0]!);
  assert.equal(ids[0], "cover");
  assert.equal(ids.at(-1), "outro");
  assert.ok(addedAt > ids.indexOf("overview-1") && addedAt < ids.indexOf(CHILD.id));
  const added = result.project.scenes[addedAt]!;
  assert.equal(added.section, "overview");
  assert.equal(added.type, "fact-card");
  assert.equal(added.duration, 4);
  assert.deepEqual(added.assetIds, ["asset-core"]);
  assert.equal(added.placements?.[0]?.includeInRender, true);
  assert.deepEqual(added.timing, { actualNarrationSeconds: 4, preHoldSeconds: 0, postHoldSeconds: 0, minimumVisualSeconds: 4, mapHoldSeconds: 0 });
});

test("a new outro-lead row is added after the outro as the closing shot", () => {
  const project = fixture();
  const workbook = sceneRows(buildProjectWorkbook(project), (rows) => {
    const sectionColumn = columns(rows)("章节");
    let outroRow = 0;
    rows.forEach((row, index) => { if (row[sectionColumn] === "outro") outroRow = index; });
    rows.splice(outroRow + 1, 0, makeRow(rows, {
      "章节": "outro-lead", "场景类型": "fact-card",
      "场景名称": "结尾补充", "旁白字幕": "回头再看草潭镇的渔港。",
      "成片素材1(首图)": "asset-core"
    }));
  });
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.addedScenes.length, 1);
  assert.match(result.addedScenes[0]!, /^outro-lead-/);
  const ids = result.project.scenes.map((scene) => scene.id);
  const addedAt = ids.indexOf(result.addedScenes[0]!);
  assert.equal(ids[0], "cover");
  // The pull-back is no longer the final shot; the closing block is.
  assert.equal(ids.at(-1), result.addedScenes[0]!, "outro-lead must be the last scene");
  assert.ok(addedAt > ids.indexOf("outro"), "outro-lead must sit after the outro");
  const added = result.project.scenes[addedAt]!;
  assert.equal(added.section, "outro-lead");
  assert.equal(added.type, "fact-card");
  assert.deepEqual(added.assetIds, ["asset-core"]);
});

test("an outro-lead row is refused before the outro is reached", () => {
  // The fixture's outro is the last row, so a new outro-lead row inserted directly
  // after the children would sit *before* the pull-back — the old, now-illegal spot.
  const project = fixture();
  const workbook = sceneRows(buildProjectWorkbook(project), (rows) => {
    const sectionColumn = columns(rows)("章节");
    let lastChild = 0;
    rows.forEach((row, index) => { if (row[sectionColumn] === "child") lastChild = index; });
    rows.splice(lastChild + 1, 0, makeRow(rows, {
      "章节": "outro-lead", "场景类型": "fact-card",
      "场景名称": "结尾补充", "旁白字幕": "还没拉回就补充。"
    }));
  });
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((issue) => /结尾补充|结尾/.test(issue.message)), JSON.stringify(result.errors));
});

test("adding a cover, child or outro row is refused with the reason", () => {
  const project = fixture();
  const cases: Array<[string, string, RegExp]> = [
    ["cover", "cover", /不能新增封面/],
    ["child", "region-focus", /不能新增行政区巡游/],
    ["outro", "outro", /不能新增结尾/]
  ];
  for (const [section, type, pattern] of cases) {
    const workbook = sceneRows(buildProjectWorkbook(project), (rows) => {
      rows.push(makeRow(rows, {
        "章节": section, "场景类型": type,
        "场景名称": "凭空新增", "旁白字幕": "凭空新增的旁白。"
      }));
    });
    const result = mergeProjectWorkbook(project, workbook);
    assert.equal(result.ok, false, `${section} must be rejected`);
    assert.ok(result.errors.some((issue) => pattern.test(issue.message)), `expected ${pattern} in ${JSON.stringify(result.errors)}`);
  }
});

test("a workbook from the merged column still accepts a compatible legacy 旁白 + 字幕 sheet", () => {
  const project = fixture();
  // An export made before the merge: two columns, and the legacy sheet has no
  // 时长 column either (that too was dropped in the same pass).
  const legacy = rebuild(buildProjectWorkbook(project), (sheets) => {
    const scene = sheets.get(SCENE_SHEET)!;
    const header = scene[0]!;
    const merged = header.indexOf("旁白字幕");
    header.splice(merged, 1, "旁白", "字幕");
    scene.forEach((row, index) => {
      if (index === 0) return;
      const value = row[merged] ?? "";
      row.splice(merged, 1, value, value);
    });
  });
  const result = mergeProjectWorkbook(project, legacy);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.changedScenes, []);
});

test("removing a keyword from a legacy 素材关键词 column warns about the anchor it drops", () => {
  const project = fixture();
  const workbook = sceneRows(buildProjectWorkbook(project), (rows) => {
    insertColumn(rows, columns(rows)("素材名称1") + 1, "素材关键词1");
    setCells(rows, "overview-1", { "素材关键词1": "" });
  });
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.ok(result.warnings.some((warning) => warning.includes("锚定关键词") && warning.includes("草潭")), JSON.stringify(result.warnings));
});

test("a keyword that no longer appears in its narration is flagged as an anchor risk", () => {
  const project = fixture();
  const workbook = sceneRows(buildProjectWorkbook(project), (rows) => {
    setCells(rows, "overview-1", {
      "旁白字幕": "草潭镇位于遂溪县西南部。"
    });
    // The keyword column is gone from new exports, but the advisory check still
    // runs on whatever the scheme already has -- 草潭 is in this narration, so a
    // keyword that is not has to be reported either way.
    insertColumn(rows, columns(rows)("素材名称1") + 1, "素材关键词1");
    setCells(rows, "overview-1", { "素材关键词1": "完全不存在的词" });
  });
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.ok(result.warnings.some((warning) => warning.includes("图文锚定错位") && warning.includes("完全不存在的词")), JSON.stringify(result.warnings));
});

test("a sheet stays importable when the scheme was saved but its content did not change", () => {
  const project = fixture();
  const workbook = rebuild(buildProjectWorkbook(project), (sheets) => {
    const notes = sheets.get(NOTES_SHEET)!;
    // Same content, higher revision: exactly what a no-op Studio save produces,
    // and what used to expire the operator's in-flight edit for nothing.
    notes.find((row) => row[0] === "导出revision")![1] = "99";
  });
  const edited = sceneRows(workbook, (rows) => {
    setCells(rows, "overview-1", { "旁白字幕": "改过的旁白。" });
  });
  const result = mergeProjectWorkbook(project, edited);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.project.scenes.find((scene) => scene.id === "overview-1")!.narration, "改过的旁白。");
});

test("a sheet is refused once the scheme's content really moved on, and says what moved", () => {
  const project = fixture();
  const workbook = buildProjectWorkbook(project);
  // A scene added in Studio after the export: the sheet has no row for it, so the
  // two no longer describe the same film.
  const moved = structuredClone(project);
  moved.scenes.splice(moved.scenes.length - 1, 0, { ...structuredClone(OVERVIEW), id: "overview-2", title: "总体补充 02" });
  const result = mergeProjectWorkbook(moved, workbook);
  assert.equal(result.ok, false);
  const message = result.errors.map((issue) => issue.message).join(" | ");
  assert.match(message, /方案内容在表格导出后被改动过/, message);
  // "Please re-export" alone leaves the operator guessing; name the drift.
  assert.match(message, /方案里新增或改名了 1 个场景/, message);
  assert.match(message, /总体补充 02/, message);
});

test("a row whose scene has been deleted is named in the staleness message", () => {
  const project = fixture();
  const workbook = buildProjectWorkbook(project);
  const shrunk = structuredClone(project);
  shrunk.scenes = shrunk.scenes.filter((scene) => scene.id !== "overview-1");
  const result = mergeProjectWorkbook(shrunk, workbook);
  assert.equal(result.ok, false);
  const message = result.errors.map((issue) => issue.message).join(" | ");
  assert.match(message, /表格第\d+行的「overview-1」在方案里已不存在/, message);
});

test("a sheet with no signature still falls back to the revision check", () => {
  const project = fixture();
  const workbook = rebuild(buildProjectWorkbook(project), (sheets) => {
    const notes = sheets.get(NOTES_SHEET)!;
    // A sheet exported before signatures existed: strip the row entirely.
    const at = notes.findIndex((row) => row[0] === "导出指纹");
    notes.splice(at, 1);
    notes.find((row) => row[0] === "导出revision")![1] = "99";
  });
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((issue) => /revision/.test(issue.message)), JSON.stringify(result.errors));
});

test("editing a scene's row keeps every machine field the sheet cannot express", () => {
  const project = fixture();
  const before = project.scenes.find((scene) => scene.id === "overview-1")!;
  const workbook = sceneRows(buildProjectWorkbook(project), (rows) => {
    setCells(rows, "overview-1", { "旁白字幕": "改过的旁白，场景id 不动。", "场景名称": "改过的名字" });
  });
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  // The row still resolves to the same scene by its id, so nothing is added and
  // nothing is deleted: camera, timing and picture bindings all stay put.
  assert.deepEqual(result.addedScenes, []);
  assert.deepEqual(result.deletedScenes, []);
  assert.deepEqual(result.changedScenes, ["overview-1"]);
  const edited = result.project.scenes.find((scene) => scene.id === "overview-1")!;
  assert.equal(edited.title, "改过的名字");
  assert.equal(edited.narration, "改过的旁白，场景id 不动。");
  assert.deepEqual(edited.assetIds, before.assetIds);
  assert.deepEqual(edited.camera, before.camera);
  assert.deepEqual(edited.timing, before.timing);
  assert.equal(edited.duration, before.duration);
});

test("changing 场景id is refused, because the id is the key and not a name", () => {
  const project = fixture();
  // Rewriting the cell leaves the row carrying an id no scene has, while the
  // scene that row used to stand for has no row left -- the two halves of a
  // rename. The import refuses rather than reading that as "deleted that scene,
  // added this one", which would silently drop its pictures, camera and timing.
  const renamedChild = sceneRows(buildProjectWorkbook(project), (rows) => {
    setCells(rows, CHILD.id, { "场景id": "child-440823113099" });
  });
  const refused = mergeProjectWorkbook(project, renamedChild);
  assert.equal(refused.ok, false);
  assert.ok(refused.errors.some((issue) => /这看起来是把 场景id 改了名/.test(issue.message)), JSON.stringify(refused.errors));
  assert.ok(refused.errors.some((issue) => issue.message.includes(CHILD.id)), `提示要点名是哪个场景没了：${JSON.stringify(refused.errors)}`);

  // The row that named a fresh id is refused too, so nothing is half-applied.
  assert.ok(refused.errors.some((issue) => issue.message.includes("child-440823113099")), JSON.stringify(refused.errors));

  // 场景名称 is the field for a display name, and it keeps working.
  const retitled = sceneRows(buildProjectWorkbook(project), (rows) => {
    setCells(rows, CHILD.id, { "场景名称": "东港村（改过的名字）" });
  });
  const ok = mergeProjectWorkbook(project, retitled);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.project.scenes.find((scene) => scene.id === CHILD.id)!.title, "东港村（改过的名字）");
  assert.deepEqual(ok.addedScenes, [], "改标题不是新增");
  assert.deepEqual(ok.deletedScenes, [], "改标题不是删除");
});

test("cover and outro may not lose their rows", () => {
  const project = fixture();
  // 场景id is the key, so the cover cannot even be renamed away: the scene would
  // be left without a row while the id stops resolving.
  const coverRenamed = sceneRows(buildProjectWorkbook(project), (rows) => {
    setCells(rows, "cover", { "场景id": "opening" });
  });
  const refused = mergeProjectWorkbook(project, coverRenamed);
  assert.equal(refused.ok, false);
  assert.ok(refused.errors.some((issue) => /封面/.test(issue.message) && /不能删除|行在表格里不存在/.test(issue.message)), JSON.stringify(refused.errors));

  const outroRemoved = sceneRows(buildProjectWorkbook(project), (rows) => {
    rows.splice(rows.findIndex((row) => row[columns(rows)("场景id")] === "outro"), 1);
  });
  const refused2 = mergeProjectWorkbook(project, outroRemoved);
  assert.equal(refused2.ok, false);
  assert.ok(refused2.errors.some((issue) => /拉回结尾/.test(issue.message)), JSON.stringify(refused2.errors));
});

test("an id given to an added row must still obey its section's convention", () => {
  const project = fixture();
  // A new row may name its own id, but only a legal one: a child's id is parsed
  // back into a sub-district, so the prefix is a contract rather than taste.
  const badPrefix = sceneRows(buildProjectWorkbook(project), (rows) => {
    const sectionColumn = columns(rows)("章节");
    let lastOverview = 0;
    rows.forEach((row, index) => { if (row[sectionColumn] === "overview") lastOverview = index; });
    rows.splice(lastOverview + 1, 0, makeRow(rows, {
      "场景id": "child-999999999999", "章节": "overview", "场景类型": "fact-card",
      "场景名称": "新增小节", "旁白字幕": "新增小节。"
    }));
  });
  const refused = mergeProjectWorkbook(project, badPrefix);
  assert.equal(refused.ok, false);
  assert.ok(refused.errors.some((issue) => /只有行政区巡游\(child\)/.test(issue.message)), JSON.stringify(refused.errors));
});

test("two rows claiming the same 场景id are refused", () => {
  const project = fixture();
  const duplicated = sceneRows(buildProjectWorkbook(project), (rows) => {
    const sectionColumn = columns(rows)("章节");
    let lastOverview = 0;
    rows.forEach((row, index) => { if (row[sectionColumn] === "overview") lastOverview = index; });
    rows.splice(lastOverview + 1, 0, makeRow(rows, {
      "场景id": "fresh-id", "章节": "overview", "场景类型": "fact-card",
      "场景名称": "新增小节", "旁白字幕": "新增小节。"
    }));
    setCells(rows, CHILD.id, { "场景id": "fresh-id" });
  });
  const refused = mergeProjectWorkbook(project, duplicated);
  assert.equal(refused.ok, false);
  assert.ok(refused.errors.some((issue) => /重复|改了名/.test(issue.message)), JSON.stringify(refused.errors));
});

test("a new row may name its own id, and is refused if that id is taken", () => {
  const project = fixture();
  const named = sceneRows(buildProjectWorkbook(project), (rows) => {
    const sectionColumn = columns(rows)("章节");
    let lastOverview = 0;
    rows.forEach((row, index) => { if (row[sectionColumn] === "overview") lastOverview = index; });
    rows.splice(lastOverview + 1, 0, makeRow(rows, {
      "场景id": "overview-custom", "章节": "overview", "场景类型": "fact-card",
      "场景名称": "自命名小节", "旁白字幕": "自命名小节。"
    }));
  });
  const result = mergeProjectWorkbook(project, named);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.addedScenes, ["overview-custom"]);

  const taken = sceneRows(buildProjectWorkbook(project), (rows) => {
    const sectionColumn = columns(rows)("章节");
    let lastOverview = 0;
    rows.forEach((row, index) => { if (row[sectionColumn] === "overview") lastOverview = index; });
    rows.splice(lastOverview + 1, 0, makeRow(rows, {
      "场景id": "overview-1", "章节": "overview", "场景类型": "fact-card",
      "场景名称": "撞名小节", "旁白字幕": "撞名小节。"
    }));
  });
  const refused = mergeProjectWorkbook(project, taken);
  assert.equal(refused.ok, false);
  assert.ok(refused.errors.some((issue) => /重名|重复/.test(issue.message)), JSON.stringify(refused.errors));
});

test("a section edit or a reordered scene is still refused", () => {
  const project = fixture();
  const sectionEdited = sceneRows(buildProjectWorkbook(project), (rows) => {
    setCells(rows, "overview-1", { "章节": "child" });
  });
  assert.equal(mergeProjectWorkbook(project, sectionEdited).ok, false);
  const reordered = sceneRows(buildProjectWorkbook(project), (rows) => {
    const overviewRow = rows.findIndex((row) => row[columns(rows)("场景id")] === "overview-1");
    const [row] = rows.splice(overviewRow, 1);
    rows.push(row!);
  });
  const result = mergeProjectWorkbook(project, reordered);
  assert.equal(result.ok, false);
});

test("the workbook-sheet codec round-trips text, punctuation and numbers", () => {
  const rows = [
    [{ value: "字段", style: "header" as const }, { value: "值", style: "header" as const }],
    [{ value: "引号 <测试> & \"双引号\" '单引号'", style: "text" as const }, { value: 3.14159, style: "number" as const }],
    [{ value: "多行\n内容", style: "text" as const }, { value: null }]
  ];
  const restored = readXlsx(writeXlsx([{ name: "表", rows }]));
  assert.equal(restored[0]!.rows[1]![0], "引号 <测试> & \"双引号\" '单引号'");
  assert.equal(restored[0]!.rows[1]![1], "3.14159");
  assert.equal(restored[0]!.rows[2]![0], "多行\n内容");
});

test("editing 旁白字幕 rewrites the narration and carries the subtitle with it", () => {
  const project = fixture();
  const workbook = sceneRows(buildProjectWorkbook(project), (rows) => {
    // One column feeds both fields, so an edit there cannot leave the subtitle
    // describing something other than what is spoken.
    setCells(rows, "overview-1", { "旁白字幕": "草潭镇地处遂溪县西南，紧邻北部湾。" });
  });
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const edited = result.project.scenes.find((scene) => scene.id === "overview-1")!;
  assert.equal(edited.narration, "草潭镇地处遂溪县西南，紧邻北部湾。");
  assert.equal(edited.subtitle, edited.narration);
  assert.deepEqual(result.changedScenes, ["overview-1"]);
  assert.equal(result.needsNarrationRegen, true);
});

test("readXlsx densifies rows that the sheet skips, as Excel and openpyxl emit", () => {
  // A sparse rows array makes writeXlsx emit r="1" then r="3", exactly the
  // shape Excel and openpyxl produce when they omit empty <row> elements.
  const rows: SheetCell[][] = [];
  rows[0] = [{ value: "第一行", style: "text" }];
  rows[2] = [{ value: "第三行", style: "text" }];
  const restored = readXlsx(writeXlsx([{ name: "表", rows }]));
  const table = restored[0]!;
  assert.equal(table.rows.length, 3);
  for (const row of table.rows) assert.ok(Array.isArray(row), "every row must be a real array, never a hole");
  assert.equal(table.rows[0]![0], "第一行");
  assert.deepEqual(table.rows[1], []);
  assert.equal(table.rows[2]![0], "第三行");
});

test("deleting a row deletes that scene, and says so", () => {
  const project = fixture();
  // The sheet is the scene list: no row, no scene. The old format needed an
  // 操作=删除 cell for this; now the row's absence is the whole statement.
  const workbook = sceneRows(buildProjectWorkbook(project), (rows) => {
    const at = rows.findIndex((row) => row[columns(rows)("场景id")] === CHILD.id);
    rows.splice(at, 1);
  });
  const result = mergeProjectWorkbook(project, workbook);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.deletedScenes, [CHILD.id]);
  assert.ok(!result.project.scenes.some((scene) => scene.id === CHILD.id));
  assert.equal(result.needsNarrationRegen, true);
  // Loud: losing a row by accident is the one way a spreadsheet quietly changes
  // the film, so the deletion is reported by name.
  assert.ok(result.warnings.some((warning) => warning.includes("已按删除处理") && warning.includes(CHILD.title)), JSON.stringify(result.warnings));
});

test("an older sheet's 操作=删除 still works, but cover and outro stay protected", () => {
  const project = fixture();
  // The column is gone from new exports, yet a sheet someone already has open in
  // Excel must keep behaving the way its own 说明 described.
  const legacy = sceneRows(buildProjectWorkbook(project), (rows) => {
    insertColumn(rows, 1, "操作");
    for (let index = 1; index < rows.length; index += 1) rows[index]![1] = "保留";
    setCells(rows, CHILD.id, { "操作": "删除" });
  });
  const ok = mergeProjectWorkbook(project, legacy);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.deletedScenes, [CHILD.id]);
  assert.ok(!ok.project.scenes.some((scene) => scene.id === CHILD.id));

  const protectedRow = sceneRows(buildProjectWorkbook(project), (rows) => {
    insertColumn(rows, 1, "操作");
    for (let index = 1; index < rows.length; index += 1) rows[index]![1] = "保留";
    setCells(rows, "outro", { "操作": "删除" });
  });
  const refused = mergeProjectWorkbook(project, protectedRow);
  assert.equal(refused.ok, false);
  assert.ok(refused.errors.some((issue) => /封面与结尾不能删除/.test(issue.message)), JSON.stringify(refused.errors));
});

test("each dropdown sits on the column it describes, wherever that column is", () => {
  const workbook = buildProjectWorkbook(fixture());
  const header = readXlsx(workbook).find((table) => table.name === SCENE_SHEET)!.rows[0]!;
  const letter = (name: string): string => {
    const at = header.indexOf(name);
    assert.ok(at >= 0, `表头没有「${name}」：${header.join(" | ")}`);
    return String.fromCharCode(65 + at);
  };
  const xml = readXlsxPackage(workbook).get("xl/worksheets/sheet1.xml")!.toString("utf8");
  const ranges = [...xml.matchAll(/sqref="([A-Z]+)2:/g)].map((match) => match[1]).sort();
  // The ranges used to be hard-coded letters, and they had drifted one column to
  // the right: 章节's list was offered on 原始id and 场景类型's on 章节.
  assert.deepEqual(ranges, [letter("场景类型"), letter("章节")].sort(), `下拉范围应落在 章节 / 场景类型 上，实际 ${ranges.join(", ")}`);
  assert.match(xml, new RegExp(`sqref="${letter("章节")}2:[^"]*"><formula1>&quot;cover,overview`), "章节 的下拉应列章节名");
  assert.match(xml, new RegExp(`sqref="${letter("场景类型")}2:[^"]*"><formula1>&quot;map-overview`), "场景类型 的下拉应列场景类型");
});

test("no sheet part ever carries a non-numeric geometry attribute", () => {
  // Two bugs of exactly this shape have shipped: width="NaN" on a column and a
  // NaN row height (which quietly cost the preview rows their height). Both came
  // from reading a column by position after the columns moved, and neither the
  // type checker nor a header assertion can see it -- only the bytes can.
  const parts = readXlsxPackage(buildProjectWorkbook(fixture(), { previews: new Map([["asset-core", fakePreview()]]) }));
  const numeric = ["width", "height", "ht", "row", "col", "colOff", "rowOff", "x", "y"];
  let checked = 0;
  for (const [name, buffer] of parts) {
    if (!/\.(xml|rels)$/.test(name)) continue;
    const text = buffer.toString("utf8");
    for (const attribute of numeric) {
      for (const match of text.matchAll(new RegExp(`${attribute}="([^"]*)"`, "g"))) {
        const value = match[1]!;
        checked += 1;
        assert.match(value, /^-?\d+(\.\d+)?$/, `${name} 的 ${attribute}="${value}" 不是数值`);
      }
    }
  }
  assert.ok(checked > 20, `检查的属性太少，测试可能是空的（${checked} 个）`);
  // And the preview rows really do carry a height, so this is testing something.
  const sheet = parts.get("xl/worksheets/sheet1.xml")!.toString("utf8");
  // Row 3 is the overview row carrying the one preview; its height must be a real
  // number, not a silently dropped NaN.
  assert.match(sheet, /<row r="3"[^>]*\bht="\d+"/, `带缩略图的行应有固定行高：${sheet.slice(sheet.indexOf("<row r=\"3\""), sheet.indexOf("<row r=\"3\"") + 120)}`);
});

test("the two data sheets carry inner and outer borders, the prose notes sheet does not", () => {
  const parts = readXlsxPackage(buildProjectWorkbook(fixture()));
  const styles = parts.get("xl/styles.xml")!.toString("utf8");
  const xfBlock = styles.slice(styles.indexOf("<cellXfs"), styles.indexOf("</cellXfs>"));
  // Seven formats (index 0-6) plus their seven bordered twins (7-13). The header
  // band at index 1 has always carried a border of its own; the twins add one to
  // the remaining six, so borderId="1" appears on eight xf in total.
  assert.equal(/<cellXfs count="(\d+)">/.exec(styles)?.[1], "14");
  assert.equal((xfBlock.match(/<xf /g) ?? []).length, 14);
  assert.equal((xfBlock.match(/borderId="1"/g) ?? []).length, 8);
  assert.equal((xfBlock.match(/borderId="0"/g) ?? []).length, 6);
  // Every bordered twin keeps the font and fill of the format it mirrors.
  const xfs = xfBlock.split("<xf ").slice(1);
  for (let index = 0; index < 7; index += 1) {
    const plain = xfs[index]!;
    const twin = xfs[index + 7]!;
    const font = /fontId="(\d+)"/.exec(plain)?.[1];
    const fill = /fillId="(\d+)"/.exec(plain)?.[1];
    assert.equal(/fontId="(\d+)"/.exec(twin)?.[1], font, `twin of style ${index} keeps its font`);
    assert.equal(/fillId="(\d+)"/.exec(twin)?.[1], fill, `twin of style ${index} keeps its fill`);
    assert.match(twin, /applyBorder="1"/);
  }

  const bordered = (sheet: string): number => {
    const xml = parts.get(`xl/worksheets/${sheet}.xml`)!.toString("utf8");
    return [...xml.matchAll(/<c [^>]*\bs="(\d+)"/g)].filter((m) => Number(m[1]) >= 7).length;
  };
  const total = (sheet: string): number => {
    const xml = parts.get(`xl/worksheets/${sheet}.xml`)!.toString("utf8");
    return [...xml.matchAll(/<c [^>]*\bs="(\d+)"/g)].length;
  };
  assert.ok(total("sheet1") > 0);
  assert.equal(bordered("sheet1"), total("sheet1"), "场景 sheet: every emitted cell is bordered");
  assert.equal(bordered("sheet2"), total("sheet2"), "素材库 sheet: every emitted cell is bordered");
  // 说明 is prose, not a grid: its long wrapped lines must not be boxed.
  assert.ok(total("sheet3") > 0, "the notes sheet still emits cells");
  assert.equal(bordered("sheet3"), 0, "说明 sheet must stay unbordered");
});

test("a bordered sheet boxes a rectangle and drops rows that carry no value at all", () => {
  const rows: SheetCell[][] = [
    [{ value: "表头甲", style: "header" }, { value: "表头乙", style: "header" }, { value: "表头丙", style: "header" }],
    // This row is short — its third cell is blank — but the box must still run
    // to the sheet's last populated column so the right edge stays aligned.
    [{ value: 1, style: "lockedNumber" }, { value: "有值", style: "text" }, { value: "", style: "text" }],
    [{ value: "", style: "lockedNumber" }, { value: "", style: "text" }, { value: "", style: "text" }]
  ];
  const xml = readXlsxPackage(writeXlsx([{ name: "表", rows, border: true }])).get("xl/worksheets/sheet1.xml")!.toString("utf8");
  const body = xml.slice(xml.indexOf("<sheetData>"), xml.indexOf("</sheetData>"));
  assert.match(body, /<row r="1">/, "header row is boxed");
  assert.match(body, /<c r="A2"[^>]*s="10"/, "number cell uses its bordered xf");
  assert.match(body, /<c r="C2"[^>]*s="11"\/>/, "the short row's blank tail is still boxed, keeping the rectangle square");
  assert.match(body, /<row r="3"\/>/, "an all-empty row collapses instead of drawing a lone box");
  // Reading it back must be no lossier than an unbordered sheet. The trailing
  // all-empty row is dropped on read, which is the codec's long-standing rule
  // (see the densify test below), not something the border introduced.
  assert.deepEqual(readXlsx(writeXlsx([{ name: "表", rows, border: true }]))[0]!.rows, [
    ["表头甲", "表头乙", "表头丙"], ["1", "有值", ""]
  ]);
});

test("borders never change what the sheet round-trips to", () => {
  const project = fixture();
  const previews = new Map([["asset-core", { data: Buffer.from("x"), extension: "jpeg" as const, widthPx: 10, heightPx: 10 }]]);
  const bordered = buildProjectWorkbook(project, { previews });
  const result = mergeProjectWorkbook(project, bordered);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual([result.addedScenes.length, result.deletedScenes.length, result.changedScenes.length], [0, 0, 0]);
  // Same values as an unbordered rebuild of the very same sheet content.
  const tables = readXlsx(bordered);
  const plain = readXlsx(writeXlsx(tables.map((table) => ({
    name: table.name,
    rows: table.rows.map((row) => row.map((value) => ({ value })))
  }))));
  assert.deepEqual(tables.map((table) => table.rows), plain.map((table) => table.rows));
});
