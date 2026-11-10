import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildRenderSpec, clampMinimumDisplaySeconds, mapScenesToCues, parseSrt, subtitleOverrideChunks, updateProjectMeasuredDurations } from "../packages/render-spec/index.js";
import { buildProjectRenderSpec, makeProject, geometrySignature, mapRendererSignature, normalizeProject, readCanonicalCues, RENDERED_MAP_SOURCES } from "../apps/studio/project-service.js";
import { newRenderJob, selectSceneAssetsForRender } from "../apps/studio/render-engine.js";
import { normalizeTimedCueOverlaps } from "../apps/studio/render-timing.js";
import { normalizeSemanticText, validateVideoProject, type AssetPlacement, type VideoProject } from "../packages/project-schema/index.js";
import { allChildrenPresent, goldenDurationIsComparable } from "../apps/studio/golden-qa.js";
import { portraitChildCameraHeight, portraitChildCameraPreset } from "../packages/geo-camera/index.js";
import type { RenderSpec } from "../packages/render-spec/index.js";

const root = resolve(process.cwd());

test("Studio adds one unified content scene without exposing placeholder scene types", async () => {
  const [html, clientSource] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/index.html"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8")
  ]);

  assert.doesNotMatch(html, /id="addSceneType"/);
  // Adding a scene is offered on each BLOCK's own heading, not from a button in the
  // panel header: the header button gave no clue which block the new row would join.
  assert.doesNotMatch(html, /id="addScene"/);
  assert.match(clientSource, /type:\s*"image-card"/);
  assert.match(clientSource, /title:\s*"总体补充 01"/);
  // The added row joins the block the author is working in: the opening block by
  // default, or the closing block (结尾补充 NN) when a closing-block scene is
  // selected. An explicit request from a heading button overrides both.
  assert.match(clientSource, /title: nextContentSceneTitle\(section\)/);
  // The closing block begins EMPTY, so selecting the outro must also target it —
  // otherwise there is no way to create the very first 结尾补充 scene and the
  // button silently files an overview row instead (the "结尾加不了" report).
  assert.match(clientSource, /function addScene\(forceSection\)/);
  assert.match(clientSource, /forceSection === "outro-lead"/);
  assert.match(clientSource, /current\?\.section === "outro-lead" \|\| current\?\.section === "outro"/);
  assert.match(clientSource, /const section = inClosingBlock \? "outro-lead" : "overview";/);
  // Both blocks expose their own "+" on the heading, each binding an explicit section
  // so the target is unambiguous, and both share one debounce clock.
  assert.match(clientSource, /data-add-closing/);
  assert.match(clientSource, /data-add-overview/);
  assert.match(clientSource, /addSceneSafely\("outro-lead"\)/);
  assert.match(clientSource, /addSceneSafely\("overview"\)/);
  assert.match(clientSource, /function addSceneSafely\(forceSection\)/);
  assert.match(clientSource, /section === "overview"[\s\S]{0,200}data-add-overview/);
  assert.doesNotMatch(clientSource, /\$\("addSceneType"\)/);
});

test("Studio keeps legacy scene labels readable and distinguishes map-only scenes from missing assets", async () => {
  const [clientSource, styles] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.css"), "utf8")
  ]);

  assert.match(clientSource, /function sceneDisplayName\(scene, scenes = state\.project\?\.scenes \|\| \[\]\)/);
  assert.match(clientSource, /总体补充 \$\{String\(Math\.max\(0, genericIndex\) \+ 1\)\.padStart\(2, "0"\)\}/);
  assert.match(clientSource, /function sceneAssetStatus\(scene\)/);
  assert.match(clientSource, /if \(isMapOnlyScene\(scene\)\) return \{ label: "地图镜头", kind: "map-only" \};/);
  assert.match(clientSource, /label: "待配素材", kind: "missing-assets"/);
  assert.match(clientSource, /sceneAssetEmpty.*textContent = isMapOnlyScene/s);
  assert.match(clientSource, /requestAnimationFrame\(\(\) => \{[\s\S]*sceneTitle.*focus\(\)/);
  assert.match(styles, /\.timeline-clip\.map-only/);
});

test("Studio exposes only real render modes and hides technical editor noise", async () => {
  const [html, clientSource, serviceSource] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/index.html"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/project-service.ts"), "utf8")
  ]);

  assert.match(html, /value="draft">快速预览</);
  assert.match(html, /value="high">正式成片</);
  assert.doesNotMatch(html, /value="standard"/);
  assert.doesNotMatch(html, /id="actualDuration"/);
  assert.doesNotMatch(html, /id="placementAsset"/);
  assert.doesNotMatch(html, /id="minimumVisual"/);
  assert.doesNotMatch(html, /id="newProject"/);
  assert.doesNotMatch(html, /id="assetDrop"|id="assetList"|id="uploadButton"/);
  assert.match(html, /class="timeline-detail-tracks"/);
  assert.match(html, /class="region-cascade-disclosure"/);
  assert.match(clientSource, /specBadge"\)\.hidden = specFresh/);
  assert.match(clientSource, /const specFresh = Boolean\(state\.renderSpec\) && !state\.renderSpecStale/);
  assert.doesNotMatch(clientSource, /\/api\/regions/);
  assert.match(serviceSource, /quality: "high"/);
  assert.match(serviceSource, /legacy\.output\?\.quality === "draft" \? "draft" : "high"/);
});

test("Studio does not render an empty subtitle pill", async () => {
  const [html, clientSource] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/index.html"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8")
  ]);

  assert.match(html, /id="previewSubtitle" hidden aria-hidden="true"><\/p>/);
  assert.match(html, /id="safeAreaSubtitle" hidden aria-hidden="true"><\/b>/);
  assert.match(clientSource, /function cleanPreviewSubtitle\(value\)[\s\S]*?String\(value \|\| ""\)\.replace\(\/\\s\+\/g, ""\)\.trim\(\)/);
  assert.match(clientSource, /function splitPreviewSubtitle\(value, maximum = 14\)[\s\S]*?if \(!source\) return \[\];/);
  assert.match(clientSource, /function syncPreviewSubtitlesToAudio\(scene, audio\)[\s\S]*?if \(!entries\.length\) return showPreviewSubtitle\(scene\);/);
  // 预览字幕同样是两层：wash 按旁白进度擦出金色，ink 是还没讲到的白字。
  assert.match(clientSource, /function showPreviewSubtitle\(scene, index = 0\)[\s\S]*?preview-subtitle-wash[\s\S]*?preview-subtitle-ink[\s\S]*?preview\.hidden = !text;/);
  // 关掉字幕必须清空两层文字，否则空 span 会撑出一个空药丸。
  assert.doesNotMatch(clientSource, /preview\.textContent = text;/);
  assert.match(clientSource, /preview\.innerHTML = "";/);
  assert.match(clientSource, /safeArea\.textContent = text;[\s\S]*?safeArea\.hidden = !text;/);
});

test("Studio preview typography scales from the same pixel sizes as final composition", async () => {
  const [clientSource, styles, compositor] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.css"), "utf8"),
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts"), "utf8")
  ]);
  assert.match(clientSource, /portrait: \{ subtitlePx: 50, assetCaptionPx: 42 \}/);
  assert.match(clientSource, /const scale = previewWidth \/ outputWidth/);
  assert.match(clientSource, /--preview-subtitle-font-size/);
  assert.match(clientSource, /--preview-asset-caption-font-size/);
  assert.match(clientSource, /profile=\$\{encodeURIComponent\(project\.output\.profile\)\}/);
  assert.match(styles, /font-size:var\(--preview-subtitle-font-size,12px\)/);
  assert.match(styles, /font-size:var\(--preview-asset-caption-font-size,12px\)/);
  assert.match(compositor, /isPortrait \? 50 : isSquare \? 44 : 46/);
  assert.match(compositor, /isPortrait \? 42 : isSquare \? 30 : 25/);
});

test("Studio edits narration once and generates subtitle breaks automatically", async () => {
  const [html, clientSource, timingSource] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/index.html"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/render-timing.ts"), "utf8")
  ]);

  assert.match(html, /旁白与字幕/);
  assert.match(html, /导出视频时会按语义和画幅自动断句生成字幕/);
  assert.doesNotMatch(html, /id="subtitle"/);
  assert.match(clientSource, /scene\.narration = value;[\s\S]*?scene\.subtitle = value;/);
  assert.doesNotMatch(clientSource, /\$\("subtitle"\)/);
  assert.match(clientSource, /splitPreviewSubtitle\(scene\.narration, maximum\)/);
  // Subtitles now come from the render spec: the compositor used to re-divide
  // each narration cue by width, which sliced words in half.
  assert.match(timingSource, /const displayCues = spec\.subtitleCues;/);
  assert.match(timingSource, /const overrides = perCue/);
  assert.match(timingSource, /subtitle-overrides/);
});

test("golden QA validates the current project's complete child tour instead of requiring ten villages", () => {
  const childIds = Array.from({ length: 18 }, (_, index) => `village-${index + 1}`);
  const scenes = childIds.map((childId) => ({ section: "child", childId }));

  assert.equal(allChildrenPresent({ scenes, childTourOrder: childIds }), true);
  assert.equal(allChildrenPresent({ scenes, childTourOrder: childIds.slice(0, -1) }), false);
  assert.equal(allChildrenPresent({ scenes, childTourOrder: [...childIds.slice(0, -1), childIds[0]!] }), false);
  assert.equal(allChildrenPresent({ scenes, childTourOrder: [...childIds.slice(0, -1), "unknown-village"] }), false);
  assert.equal(allChildrenPresent({ scenes, childTourOrder: [...childIds].reverse() }), true);
});

test("Studio Golden QA never compares a project against a hard-coded different region", async () => {
  const [engineSource, qaSource] = await Promise.all([
    readFile(resolve(root, "apps/studio/render-engine.ts"), "utf8"),
    readFile(resolve(root, "apps/studio/golden-qa.ts"), "utf8")
  ]);
  assert.doesNotMatch(engineSource, /440825112-portrait-final\.mp4/);
  assert.match(engineSource, /`\$\{project\.regionId\}-\$\{project\.output\.profile\}-final\.mp4`/);
  assert.match(engineSource, /existsSync\(goldenCandidate\) \? goldenCandidate : undefined/);
  assert.match(qaSource, /perceptualParityEvaluated: compareGolden/);
  assert.match(qaSource, /goldenDurationIsComparable\(outputDuration, goldenDuration\)/);
  assert.match(qaSource, /averageSsim === null \|\| averageSsim >= 0\.55/);
});

test("Xilian follows editorial tourOrder and fits small villages for a portrait screen", async () => {
  const project = await makeProject(root, "440825106");
  const master = JSON.parse(await readFile(resolve(root, "content/regions.zh-CN.json"), "utf8")) as Record<string, { tourOrder: string[] }>;
  const childScenes = project.scenes.filter((scene) => scene.section === "child");
  assert.deepEqual(master["440825106"]!.tourOrder, [
    "440825106205", "440825106204", "440825106202", "440825106201", "440825106206", "440825106208",
    "440825106207", "440825106215", "440825106209", "440825106214", "440825106203", "440825106212",
    "440825106213", "440825106303", "440825106305", "440825106210", "440825106211", "440825106304"
  ]);
  assert.deepEqual(childScenes.map((scene) => scene.childId), master["440825106"]!.tourOrder);
  assert.equal(childScenes.length, 18);
  assert.ok(childScenes.every((scene) => Number(scene.camera?.height) >= 1_800 && Number(scene.camera?.height) <= 32_000));
  assert.ok(childScenes.some((scene) => Number(scene.camera?.height) < 11_500));
  const region = JSON.parse(await readFile(resolve(root, "data/regions/440825106.json"), "utf8")) as { childRegions: Array<{ id: string; bbox: [number, number, number, number] }> };
  const boundsById = new Map(region.childRegions.map((child) => [child.id, child.bbox]));
  for (const scene of childScenes) {
    const bounds = boundsById.get(String(scene.childId))!;
    assert.equal(scene.camera?.longitude, (bounds[0] + bounds[2]) / 2);
    assert.equal(scene.camera?.latitude, (bounds[1] + bounds[3]) / 2);
  }
});

test("supplemental management units stay on the map without joining the narrated tour", async () => {
  // 客路镇 draws 52 polygon units but narrates only 30 villages; the other 22 are
  // supplemental management units (forest farms) that keep their boundary but
  // must never receive a flight or a narration line.
  const project = await makeProject(root, "440882102");
  const region = JSON.parse(await readFile(resolve(root, "data/regions/440882102.json"), "utf8")) as {
    childRegions: Array<{ id: string }>;
    tourChildIds: string[];
    supplementalUnits: Array<{ id: string; includedInTour?: boolean }>;
  };
  const master = JSON.parse(await readFile(resolve(root, "content/regions.zh-CN.json"), "utf8")) as Record<string, { tourOrder: string[] }>;
  const childScenes = project.scenes.filter((scene) => scene.section === "child");

  assert.equal(region.childRegions.length, 52);
  assert.ok(region.supplementalUnits.length > 0);
  assert.ok(region.supplementalUnits.every((unit) => unit.includedInTour === false));
  assert.deepEqual(childScenes.map((scene) => String(scene.childId)), master["440882102"]!.tourOrder);
  assert.equal(childScenes.length, region.tourChildIds.length);

  const toured = new Set(childScenes.map((scene) => String(scene.childId)));
  for (const unit of region.supplementalUnits) assert.ok(!toured.has(String(unit.id)), `${unit.id} must not be toured`);
});

test("a tourOrder that names an untoured supplemental unit fails with an actionable message", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "tour-order-guard-"));
  try {
    await mkdir(join(scratch, "content"), { recursive: true });
    await mkdir(join(scratch, "data", "regions"), { recursive: true });
    await mkdir(join(scratch, "assets", "audio", "440882102"), { recursive: true });
    const master = JSON.parse(await readFile(resolve(root, "content/regions.zh-CN.json"), "utf8")) as Record<string, Record<string, unknown>>;
    const regionSource = JSON.parse(await readFile(resolve(root, "data/regions/440882102.json"), "utf8")) as { supplementalUnits: Array<{ id: string }> };
    await writeFile(join(scratch, "data", "regions", "440882102.json"), JSON.stringify(regionSource));
    await writeFile(join(scratch, "content", "regions.zh-CN.json"), JSON.stringify({
      ...master,
      "440882102": { ...master["440882102"]!, tourOrder: [...(master["440882102"]!.tourOrder as string[]), regionSource.supplementalUnits[0]!.id] }
    }));
    await writeFile(join(scratch, "assets", "audio", "440882102", "narration-edge.srt"),
      await readFile(resolve(root, "assets/audio/440882102/narration-edge.srt"), "utf8"));

    await assert.rejects(makeProject(scratch, "440882102"), /tourOrder 与可巡游下级行政区不一致/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
test("portrait RenderSpec exposes semantic single-line subtitle cues", async () => {
  const project = await makeProject(root, "440825112");
  project.output.profile = "portrait";
  const spec = await buildProjectRenderSpec(root, project);
  assert.ok(spec.subtitleCues.length > spec.narrationCues.length);
  assert.ok(spec.subtitleCues.every((cue) => [...cue.text].length <= 18));
  assert.ok(spec.subtitleCues.every((cue) => !cue.text.includes("\n")));
  assert.equal(spec.subtitleCues[0]?.start, spec.narrationCues[0]?.start);
  assert.equal(spec.subtitleCues.at(-1)?.end, spec.narrationCues.at(-1)?.end);
});

test("child narration may contain multiple sentences for automatic subtitle chunking", async () => {
  const project = await makeProject(root, "440825112");
  const scene = project.scenes.find((item) => item.section === "child")!;
  scene.narration = "第一句介绍村庄位置。第二句介绍当地风貌。";
  scene.subtitle = scene.narration;

  assert.doesNotThrow(() => validateVideoProject(project));
});

test("RenderSpec preserves the image name separately from its accessibility description", async () => {
  const project = await makeProject(root, "440825112");
  const scene = project.scenes.find((item) => item.placements?.length);
  const placement = scene?.placements?.[0];
  const asset = project.assets.find((item) => item.id === placement?.assetId);
  assert.ok(asset && placement);
  const originalPath = asset.path;
  asset.name = "北尾村 · 邱氏祠堂";
  placement.alt = "北尾村传统建筑的正面实景照片";
  const spec = await buildProjectRenderSpec(root, project);
  const renderedAsset = spec.assets.find((item) => item.id === asset.id);
  assert.equal(renderedAsset?.name, "北尾村 · 邱氏祠堂");
  assert.equal(renderedAsset?.path, originalPath);
  assert.equal(renderedAsset?.alt, "北尾村传统建筑的正面实景照片");
});

test("a scene ships only the images marked 用于成片, never an implicit first one", async () => {
  const project = await makeProject(root, "440825112");
  const scene = project.scenes.find((item) => (item.placements?.length ?? 0) > 0)!;
  const { includeInRender: _dropped, ...unflagged } = scene.placements![0]!;
  const candidates = [{ id: "one" }, { id: "two" }, { id: "three" }] as any;
  // 探测用的场景挂在项目之外：候选 id 不在素材库里，validateVideoProject 会先报
  // 「references missing asset」，与取片规则无关。
  const placements: AssetPlacement[] = [
    { ...unflagged, assetId: "one" },
    { ...unflagged, assetId: "two" },
    { ...unflagged, assetId: "three" }
  ];
  const probe = { ...scene, assetDisplayCount: 2, placements };
  // 一张都没标记 ⇒ 这一场在成片里就是没有图片。旧行为会按
  // `assetDisplayCount ?? 1` 塞进第一张，于是编辑器里看着「没有图片」的场景
  // 在成片里凭空多出一张 —— 这正是用户反馈的那个 bug。
  assert.deepEqual(selectSceneAssetsForRender(probe as never, candidates).map((asset) => asset.id), []);
  // 旧字段仍留在 schema 里（旧版本方案要能读），但它不再决定取哪几张。
  probe.placements[1]!.includeInRender = true;
  assert.deepEqual(selectSceneAssetsForRender(probe as never, candidates).map((asset) => asset.id), ["two"]);
  scene.assetDisplayCount = 1.5;
  assert.throws(() => validateVideoProject(project), /must be an integer/);
  scene.assetDisplayCount = 0;
  assert.throws(() => validateVideoProject(project), /must be between 1 and 100/);
});

test("a picture's minimum display never outlives its own scene", async () => {
  // 现场案例：「01 黄金开篇」旁白 0.05→7.29，那张「城月镇标」的最短展示被设成
  // 13.5 秒。合成端算 end = max(cueEnd + tail, start + minimumDisplaySeconds)，
  // 于是这张卡挂到 16.35 秒，跨过「总体补充 01」和「总体介绍 4」—— 后者一张图
  // 都没有，观众却在成片里看到上一场的照片。
  const sceneStart = 0.05;
  const sceneEnd = 7.287;
  const resolvedStart = 2.85;
  const available = Math.max(0.1, sceneEnd - resolvedStart);
  const clamped = clampMinimumDisplaySeconds(13.5, available);
  assert.equal(Number(clamped.toFixed(2)), 4.44);
  assert.equal(Number((resolvedStart + clamped).toFixed(2)), 7.29);
  assert.ok(resolvedStart + clamped <= sceneEnd + 1e-6, "卡必须在本场旁白结束前收掉");
  // 配置本来就短于窗口时原样保留，不做无谓改动。
  assert.equal(clampMinimumDisplaySeconds(4, available), 4);
  // 没有场景区间（不该发生）时不猜，保持配置值。
  assert.equal(clampMinimumDisplaySeconds(13.5, undefined), 13.5);
  // 窗口为负或 0 时兜住 0.1 秒下限，避免 0 长度 clip。
  assert.equal(clampMinimumDisplaySeconds(13.5, 0), 0.1);
  assert.ok(sceneEnd > sceneStart);
});

test("re-measuring narration pulls a stale minimum visual seconds down to the scene", () => {
  // 同一现场案例的源头：旁白变短后 timing 还留着旧的 13.5。这个值会被
  // 「新绑定的图片」继承成 minimumDisplaySeconds，所以必须跟着实测长度收下来。
  const project = {
    cover: { introSeconds: 1.6 },
    scenes: [
      { id: "cover", section: "cover", duration: 9 },
      {
        id: "opening",
        section: "overview",
        duration: 20,
        timing: { actualNarrationSeconds: 13.25, preHoldSeconds: 0, postHoldSeconds: 0, minimumVisualSeconds: 13.5, mapHoldSeconds: 0 }
      }
    ]
  } as unknown as VideoProject;
  const spec = {
    sceneCueRanges: [{ sceneId: "opening", start: 0.05, end: 7.287, cueStartIndex: 0, cueEndIndex: 0 }]
  } as unknown as RenderSpec;
  updateProjectMeasuredDurations(project, spec);
  const scene = project.scenes[1]!;
  assert.equal(scene.duration, 7.237);
  assert.equal(scene.timing!.actualNarrationSeconds, 7.237);
  assert.equal(scene.timing!.minimumVisualSeconds, 7.237);
});

test("a scene can select non-leading images for the rendered sequence", async () => {
  const project = await makeProject(root, "440825112");
  const scene = project.scenes.find((item) => (item.placements?.length ?? 0) > 0)!;
  const first = scene.placements![0]!;
  const alternateAsset = project.assets.find((asset) => asset.id !== first.assetId)!;
  const placements = [
    { ...first, includeInRender: false },
    { ...first, assetId: alternateAsset.id, includeInRender: true }
  ];
  scene.placements = placements;
  const candidates = placements.map((placement) => ({ id: placement.assetId })) as any;
  assert.doesNotThrow(() => validateVideoProject(project));
  assert.deepEqual(selectSceneAssetsForRender(scene, candidates).map((asset) => asset.id), [placements[1]!.assetId]);
});

test("Studio supports editing an asset display name without changing its file path", async () => {
  const [clientSource, css] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio-refine.css"), "utf8")
  ]);

  assert.match(clientSource, /function openAssetRename\(assetId\)/);
  assert.match(clientSource, /function confirmAssetRename\(\)/);
  assert.match(clientSource, /data-lib-rename/);
  assert.match(clientSource, /local\.name = name;[\s\S]*?touchAsset\(local\.id\);[\s\S]*?markDirty\(\);[\s\S]*?render\(\)/);
  assert.doesNotMatch(clientSource, /asset\.path = nextName|\.path = name;/);
  assert.match(css, /\.scene-bound-asset:has\(\.scene-asset-name-editor\)\{[^}]*grid-template-columns:46px minmax\(0,1fr\)/);
  assert.match(css, /\.scene-bound-asset:has\(\.scene-asset-name-editor\) \.scene-asset-name-editor input\{[^}]*width:100%[^}]*height:34px/);
});

test("uploaded assets use an extension-free display name while preserving their stored file extension", async () => {
  const [clientSource, storeSource] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/asset-store.ts"), "utf8")
  ]);

  assert.match(clientSource, /const displayName = file\.name\.replace\(\/\\\.\[\^\.\]\+\$\/, ""\) \|\| file\.name/);
  // The bytes go up as the request body: base64 inside JSON held two copies of
  // every upload in memory and inherited the 20 MB request cap, which rejected
  // ordinary phone video.
  assert.match(clientSource, /const query = new URLSearchParams\(\{ projectId: project\.id, name: file\.name, alt: displayName \}\);/);
  assert.match(clientSource, /api\(`\/api\/assets\/binary\?\$\{query\.toString\(\)\}`, \{/);
  assert.match(clientSource, /body: file,/);
  assert.doesNotMatch(clientSource, /readAsDataURL/);
  assert.match(storeSource, /const filename = `\$\{randomUUID\(\)\}\.\$\{extension\}`/);
  assert.match(storeSource, /const displayName = displayNameOf\(requestedName, id\)/);
  assert.match(storeSource, /path: `\/workspace-assets\/\$\{stored\.filename\}`/);
});

test("a scene with multiple assets persists the applied asset as its primary visual", async () => {
  const clientSource = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");

  assert.match(clientSource, /async function setPrimarySceneAsset\(id\)/);
  assert.match(clientSource, /const placementIndex = \(scene\.placements \|\| \[\]\)\.findIndex\(\(item\) => item\.assetId === id\)/);
  assert.match(clientSource, /state\.selectedAssetId = id/);
  assert.match(clientSource, /toastSuccess\(needsPersist \? "已设为首图并加入成片；点击“保存方案”后生效"/);
  assert.match(clientSource, /scene\.placements\.unshift\(placement\)/);
  assert.match(clientSource, /scene\.assetIds = \[id, \.\.\.\(scene\.assetIds \|\| \[\]\)\.filter/);
  assert.match(clientSource, /markDirty\(\)/);
  assert.match(clientSource, /data-set-primary-scene-asset/);
  assert.match(clientSource, /设为首图/);
  assert.match(clientSource, /placement\.includeInRender = true/);
});

test("golden QA skips perceptual comparison against a materially older edit", () => {
  assert.equal(goldenDurationIsComparable(288.6, 164.6), false);
  assert.equal(goldenDurationIsComparable(288.6, 287.4), true);
});

test("assets selected for the final render are stably prioritized in the scene", async () => {
  const clientSource = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");

  assert.match(clientSource, /function prioritizeIncludedSceneAssets\(scene\)/);
  assert.match(clientSource, /scene\.placements = \[\.\.\.included, \.\.\.excluded\]/);
  assert.match(clientSource, /scene\.assetIds = \[\.\.\.orderedIds,/);
  assert.match(clientSource, /placement\.includeInRender = included;\s*prioritizeIncludedSceneAssets\(scene\)/);
});

test("scene reordering persists and regenerates linked cue and tour order", async () => {
  const project = await makeProject(root, "440825106");
  const childIndexes = project.scenes
    .map((scene, index) => scene.section === "child" ? index : -1)
    .filter((index) => index >= 0);
  const firstIndex = childIndexes[0]!;
  const secondIndex = childIndexes[1]!;
  const first = project.scenes[firstIndex]!;
  const second = project.scenes[secondIndex]!;
  project.scenes[firstIndex] = second;
  project.scenes[secondIndex] = first;

  const normalized = await normalizeProject(root, project);
  const reorderedChildren = normalized.scenes.filter((scene) => scene.section === "child");
  assert.equal(reorderedChildren[0]?.id, second.id);
  assert.equal(reorderedChildren[1]?.id, first.id);
  assert.equal(reorderedChildren[0]?.narration, second.narration);
  assert.deepEqual(reorderedChildren[0]?.placements, second.placements);

  const spec = await buildProjectRenderSpec(root, normalized);
  assert.deepEqual(spec.childTourOrder.slice(0, 2), [second.childId, first.childId]);
  assert.equal(spec.sceneCueRanges.find((range) => range.sceneId === second.id)?.text, second.narration);
});

test("portrait child framing responds to boundary width and height", () => {
  const compact = portraitChildCameraHeight([109.9281453, 20.3569991, 109.9471387, 20.3972231]);
  const wide = portraitChildCameraHeight([109.89, 20.36, 109.96, 20.40]);
  assert.ok(compact >= 1_800 && compact < 11_500);
  assert.ok(wide > compact);
  const asymmetric = portraitChildCameraPreset(
    { longitude: 109.8954, latitude: 20.3855, height: 11_500, heading: 0, pitch: -64 },
    [109.8900226, 20.3434288, 109.9372462, 20.3901876]
  );
  assert.equal(asymmetric.longitude, (109.8900226 + 109.9372462) / 2);
  assert.equal(asymmetric.latitude, (20.3434288 + 20.3901876) / 2);
  assert.ok(asymmetric.height > 9_000);
});

test("Xinliao migration imports five verified production visuals with stable cue mappings", async () => {
  const project = await makeProject(root, "440825112");
  assert.equal(project.schemaVersion, 2);
  assert.equal(project.cover.introSeconds, 1.6);
  assert.equal(project.assets.length, 5);
  assert.ok(project.assets.every((asset) => asset.verifiedReal));
  assert.deepEqual(project.assets.map((asset) => asset.id), ["shrimp-farm", "aquaculture-aerial", "shrimp-sheds-aerial", "mangrove", "leidasha"]);
  const placements = project.scenes.flatMap((scene) => scene.placements ?? []);
  assert.equal(placements.length, 5);
  assert.equal(placements.find((item) => item.assetId === "leidasha")?.fit, "contain");
  const childScenes = project.scenes.filter((scene) => scene.section === "child");
  assert.deepEqual(childScenes.map((scene) => scene.childName), ["新丰村", "三丰村", "后海村", "八一村", "塘口村", "东塘村", "堰头村", "北尾村", "港六村", "南湾村"]);
  assert.ok(childScenes.every((scene) => scene.camera?.transition === "fly"));
});

test("skill-locked scene sections reject incompatible custom scene types and ordering", async () => {
  const project = await makeProject(root, "440825112");
  validateVideoProject(project);
  const wrongType = structuredClone(project);
  wrongType.scenes.find((scene) => scene.section === "overview")!.type = "outro";
  assert.throws(() => validateVideoProject(wrongType), /outside its locked overview section/);
  const wrongOrder = structuredClone(project);
  const overview = wrongOrder.scenes.findIndex((scene) => scene.section === "overview");
  const child = wrongOrder.scenes.findIndex((scene) => scene.section === "child");
  [wrongOrder.scenes[overview], wrongOrder.scenes[child]] = [wrongOrder.scenes[child]!, wrongOrder.scenes[overview]!];
  assert.throws(() => validateVideoProject(wrongOrder), /场景顺序/);
});

test("the closing supplement section only lives after the pull-back outro", async () => {
  const project = await makeProject(root, "440825112");
  // A project that plays 结尾补充 after the pull-back stays valid, and the closing
  // block — not the outro — is what ends the tape.
  const accepted = structuredClone(project);
  const outroIndex = accepted.scenes.findIndex((scene) => scene.section === "outro");
  assert.ok(outroIndex >= 0);
  const leadScene: typeof accepted.scenes[number] = {
    ...structuredClone(accepted.scenes[outroIndex]!),
    id: "outro-lead-1", type: "fact-card", section: "outro-lead"
  };
  accepted.scenes.splice(outroIndex + 1, 0, leadScene);
  validateVideoProject(accepted);
  assert.equal(accepted.scenes.at(-1)!.section, "outro-lead");

  // …but it may not be dragged in front of the pull-back it follows.
  // Which guard catches it depends on where it lands, so accept either reason.
  const tooEarly = structuredClone(accepted);
  const lead = tooEarly.scenes.findIndex((scene) => scene.section === "outro-lead");
  const moved = tooEarly.scenes.splice(lead, 1)[0]!;
  tooEarly.scenes.splice(1, 0, moved);
  assert.throws(
    () => validateVideoProject(tooEarly),
    /结尾补充必须排在拉回上级区域结尾之后|场景顺序必须保持封面、总体介绍、行政区巡游、拉回结尾、结尾补充/
  );
});

test("scene-to-cue mapping uses text and supports one scene split into multiple provider cues", async () => {
  const project = await makeProject(root, "440825112");
  const cues = await readCanonicalCues(root, project.regionId);
  const mappings = mapScenesToCues(project.scenes, cues);
  const food = mappings.find((range) => range.sceneId === "overview-8");
  assert.ok(food);
  assert.equal(food.cueStartIndex, 7);
  assert.equal(food.cueEndIndex, 8);
  assert.equal(mappings.find((range) => range.sceneId === "child-440825112206")?.cueStartIndex, 11);
});

test("semantic matching ignores presentation symbols omitted from TTS subtitles", () => {
  assert.equal(
    normalizeSemanticText("🥭 “覃斗芒果”：2005年入选国家地理标志保护产品"),
    normalizeSemanticText("覃斗芒果”：2005年入选国家地理标志保护产品")
  );
});

test("cache signature is deterministic and invalidates on camera or cue timing changes", async () => {
  const renderSpecSource = await readFile(resolve(root, "packages/render-spec/index.ts"), "utf8");
  const serviceSource = await readFile(resolve(root, "apps/studio/project-service.ts"), "utf8");
  assert.match(renderSpecSource, /mapRendererVersion: input\.rendererSignature \?\? MAP_RENDERER_CACHE_VERSION/);
  assert.match(serviceSource, /export async function mapRendererSignature/);
  assert.match(serviceSource, /"apps\/cesium-player\/public\/runtime\.js"/);
  const project = await makeProject(root, "440825112");
  const cues = await readCanonicalCues(root, project.regionId);
  const geometry = await geometrySignature(root, project.regionId);
  const first = buildRenderSpec({ project, cues, geometrySignature: geometry, generatedAt: "2026-01-01T00:00:00.000Z" });
  const second = buildRenderSpec({ project, cues, geometrySignature: geometry, generatedAt: "2027-01-01T00:00:00.000Z" });
  assert.equal(first.cacheSignature, second.cacheSignature);
  const changedProject = structuredClone(project);
  changedProject.scenes.find((scene) => scene.section === "child")!.camera!.height += 500;
  const cameraChanged = buildRenderSpec({ project: changedProject, cues, geometrySignature: geometry });
  assert.notEqual(first.cacheSignature, cameraChanged.cacheSignature);
  const changedCues = cues.map((cue, index) => index === 0 ? { ...cue, end: cue.end + 0.2 } : cue);
  const cueChanged = buildRenderSpec({ project, cues: changedCues, geometrySignature: geometry });
  assert.notEqual(first.cacheSignature, cueChanged.cacheSignature);
  const imageryChangedProject = structuredClone(project);
  imageryChangedProject.imagery.provider = "esri-world-imagery";
  const imageryChanged = buildRenderSpec({ project: imageryChangedProject, cues, geometrySignature: geometry });
  assert.notEqual(first.cacheSignature, imageryChanged.cacheSignature);
});

test("editing the Cesium sources invalidates the cached map video", async () => {
  // Regression: the focus-mask frame footprint and the child-tour flight origin
  // were both fixed in runtime.js without bumping the hand-maintained cache
  // version, so exports for every already-cached region silently re-encoded map
  // video captured by the old camera. The signature must be a function of the
  // files that rasterise the map, not of a string someone has to remember.
  const sandbox = await mkdtemp(join(tmpdir(), "renderer-signature-"));
  try {
    for (const relative of RENDERED_MAP_SOURCES) {
      const path = join(sandbox, relative);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `// ${relative}\n`, "utf8");
    }
    const before = await mapRendererSignature(sandbox);
    assert.equal(await mapRendererSignature(sandbox), before, "the signature must be deterministic");
    await writeFile(join(sandbox, "apps/cesium-player/public/runtime.js"), "// camera fix\n", "utf8");
    assert.notEqual(await mapRendererSignature(sandbox), before, "editing runtime.js must invalidate the cache");
    await writeFile(join(sandbox, RENDERED_MAP_SOURCES.at(-1)!), "", "utf8");
    assert.notEqual(await mapRendererSignature(sandbox), before, "editing the capture script must invalidate the cache");
    const live = await mapRendererSignature(root);
    assert.match(live, /^sha256:[0-9a-f]{64}$/);
    const project = await makeProject(root, "440825112");
    const cues = await readCanonicalCues(root, project.regionId);
    const geometry = await geometrySignature(root, project.regionId);
    const constantOnly = buildRenderSpec({ project, cues, geometrySignature: geometry });
    const fromSources = buildRenderSpec({ project, cues, geometrySignature: geometry, rendererSignature: live });
    assert.notEqual(fromSources.cacheSignature, constantOnly.cacheSignature, "the rendered-source signature must take effect");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Studio exposes selectable satellite imagery and forwards it to preview and export", async () => {
  const [html, clientSource, engineSource, runtimeSource, playerHtml] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/index.html"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/render-engine.ts"), "utf8"),
    readFile(resolve(root, "apps/cesium-player/public/runtime.js"), "utf8"),
    readFile(resolve(root, "apps/cesium-player/public/index.html"), "utf8")
  ]);
  assert.match(html, /id="imageryProviderSelect"/);
  assert.match(html, /mapbox-satellite/);
  assert.match(html, /esri-world-imagery/);
  assert.match(html, /bing-aerial/);
  assert.match(clientSource, /imageryProviderSelect/);
  assert.match(engineSource, /"--imagery", project\.imagery\.provider/);
  assert.match(runtimeSource, /MapboxImageryProvider/);
  assert.match(runtimeSource, /ArcGisMapServerImageryProvider/);
  assert.match(runtimeSource, /BingMapsImageryProvider/);
  assert.match(runtimeSource, /imagery-config\.json/);
  assert.match(runtimeSource, /影像源加载失败/);
  assert.match(playerHtml, /id="runtimeError"/);
});

test("subtitle line overrides preserve the spoken semantic text", async () => {
  const project = await makeProject(root, "440825112");
  const cues = await readCanonicalCues(root, project.regionId);
  const mappings = mapScenesToCues(project.scenes, cues);
  const scene = project.scenes.find((item) => item.id === "overview-1")!;
  scene.subtitle = "徐闻县新寮镇位于徐闻东北部海域，\n是徐闻唯一的海岛建制镇，\n由新寮岛、后海岛等岛屿组成，下辖10个行政村。";
  const overrides = subtitleOverrideChunks(scene, mappings.find((item) => item.sceneId === scene.id)!, cues);
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0]?.chunks.length, 3);
  scene.subtitle = "这是一段不同的字幕";
  assert.throws(() => subtitleOverrideChunks(scene, mappings[0]!, cues), /改变了配音语义/);
});

test("cover, preview and composition share one persisted duration", async () => {
  const project = await makeProject(root, "440825112");
  const cues = await readCanonicalCues(root, project.regionId);
  const spec = buildRenderSpec({ project, cues, geometrySignature: await geometrySignature(root, project.regionId), timelineDurationSeconds: 219 });
  assert.equal(project.scenes.find((scene) => scene.section === "cover")?.duration, project.cover.introSeconds);
  assert.equal(spec.cover.introSeconds, project.cover.introSeconds);
  assert.equal(spec.totalDurationSeconds, 220.6);
});

test("render jobs have isolated roots and the Studio server no longer overwrites canonical content", async () => {
  const one = newRenderJob("project-one", resolve(root, "workspace/jobs"));
  const two = newRenderJob("project-two", resolve(root, "workspace/jobs"));
  assert.notEqual(one.id, two.id);
  assert.notEqual(one.jobRoot, two.jobRoot);
  const serverSource = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");
  assert.doesNotMatch(serverSource, /writeFile\(masterPath/);
  assert.doesNotMatch(serverSource, /renderBusy/);
  const engineSource = await readFile(resolve(root, "apps/studio/render-engine.ts"), "utf8");
  assert.match(engineSource, /jobRoot, "sandbox"/);
  assert.match(engineSource, /tmpdir\(\), "geo-video-studio"/);
  assert.match(engineSource, /ensureDirectoryLink\(sandbox, visibleSandbox\)/);
  // Re-linking a sandbox that already exists used to fail with EEXIST, so every
  // retry and every interrupted-job recovery died before doing any work.
  assert.match(engineSource, /export async function ensureDirectoryLink/);
  assert.match(engineSource, /if \(!stats\.isSymbolicLink\(\)\) return;/);
  assert.match(engineSource, /GEO_VIDEO_PROJECT_ROOT: cwd/);
  assert.match(engineSource, /project\.snapshot\.json/);
  assert.match(engineSource, /render-spec\.json/);
});

test("Studio keeps one task-first export history with explicit output actions", async () => {
  const [serverSource, html, clientSource, css, engineSource, runtimeSource] = await Promise.all([
    readFile(resolve(root, "apps/studio/server.ts"), "utf8"),
    readFile(resolve(root, "apps/studio/public/index.html"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.css"), "utf8"),
    readFile(resolve(root, "apps/studio/render-engine.ts"), "utf8"),
    readFile(resolve(root, "apps/cesium-player/public/runtime.js"), "utf8")
  ]);
  // Job records are written on every progress tick. Plain concurrent writes
  // truncated and interleaved each other, physically splicing two records into
  // one unparseable file, and left the durable record behind the in-memory one.
  assert.match(serverSource, /function writeJsonSerialized/);
  assert.match(serverSource, /await writeJsonAtomicResilient\(path, value\)/);
  assert.doesNotMatch(serverSource, /void mkdir\(job\.jobRoot, \{ recursive: true \}\)\.then\(\(\) => writeFile/);
  assert.doesNotMatch(serverSource, /writeFile\(join\(job\.jobRoot, "job\.json"\)/);
  assert.match(serverSource, /\/api\/jobs/);
  assert.match(serverSource, /open-output/);
  assert.match(serverSource, /Export does not belong to the current project/);
  assert.doesNotMatch(html, /最近完成的视频/);
  assert.doesNotMatch(html, /id="outputLocationCard"/);
  assert.match(html, /id="exportModal"/);
  assert.match(html, /id="exportHistory"/);
  assert.match(html, /id="openExportPanel"/);
  assert.doesNotMatch(html, /id="previewButton"/);
  assert.doesNotMatch(clientSource, /previewButton/);
  assert.match(html, /id="sceneBoundAssets"/);
  assert.match(html, /id="sceneAssetSelectionSummary"/);
  assert.match(html, /id="assetInput"/);
  assert.match(html, /id="sceneAssetPicker"/);
  assert.match(html, /id="coverPreview"/);
  const inspectorMarkup = html.match(/<aside class="inspector panel">[\s\S]*?<\/aside>/)?.[0] ?? "";
  assert.doesNotMatch(inspectorMarkup, /导出前检查/);
  assert.match(clientSource, /loadLatestExport/);
  assert.doesNotMatch(clientSource, /status=completed/);
  assert.match(clientSource, /job\.projectId !== projectId/);
  assert.match(clientSource, /belongsToCurrentProject/);
  assert.match(clientSource, /function loadExportHistory/);
  assert.match(clientSource, /导出任务已添加/);
  assert.match(clientSource, /data-export-action="open"/);
  assert.match(clientSource, /data-export-action="cancel"/);
  assert.match(clientSource, /data-export-action="delete"/);
  assert.match(serverSource, /request\.method === "DELETE" && jobMatch/);
  assert.match(serverSource, /deleteTerminalJob/);
  assert.match(clientSource, /job\.output/);
  assert.match(clientSource, /setExportPanel/);
  assert.match(clientSource, /uploadTargetSceneId/);
  assert.match(clientSource, /bindAssetToScene/);
  assert.match(clientSource, /function sceneAssetDisplayCount\(scene\)/);
  assert.match(clientSource, /data-toggle-scene-asset-export/);
  assert.match(clientSource, /function materializeSceneAssetSelection\(scene\)/);
  assert.match(engineSource, /selectSceneAssetsForRender\(scene, sceneAssets\)/);
  assert.match(engineSource, /sequenceCount: kept\.length/);
  assert.match(engineSource, /selectionKey: `\$\{scene\.id\}:\$\{sequenceIndex\}:\$\{asset\.id\}`/);
  assert.match(clientSource, /removeAssetFromScene/);
  assert.match(clientSource, /待配素材/);
  assert.match(clientSource, /地图镜头/);
  assert.match(clientSource, /\/cover-preview\?v=/);
  assert.match(serverSource, /ensureProjectCoverPreview/);
  assert.match(serverSource, /generateCoverAsset/);
  assert.match(serverSource, /\/cover-preview/);
  assert.match(serverSource, /request\.method === "POST" && coverPreviewMatch/);
  assert.match(serverSource, /createHash\("sha256"\)/);
  assert.match(clientSource, /function scheduleCoverPreview/);
  assert.match(clientSource, /setTimeout\(refreshCoverPreview, 250\)/);
  assert.match(clientSource, /await response\.blob\(\)/);
  assert.match(clientSource, /coverPreviewObjectUrl/);
  assert.match(clientSource, /function isOpeningScene/);
  assert.match(clientSource, /action: "play-opening"/);
  assert.match(clientSource, /editorFastPreview: true/);
  assert.match(clientSource, /skipDescent: false/);
  assert.match(clientSource, /revealSeconds: 1\.4/);
  assert.match(clientSource, /let action = "show-tour-frame"/);
  assert.match(clientSource, /function showSelectedTourFrame/);
  // The editor installs the child-tour context before every preview so the
  // parent overview camera carries the same range scale the export uses.
  // Otherwise the editor parks its opening frame on a different range and the
  // first village flight reads as a camera jump.
  assert.match(clientSource, /function tourPreviewPayload/);
  assert.match(clientSource, /function pushTourContext/);
  assert.match(clientSource, /action: "prepare-tour"/);
  // Every path that renders the opening preview has to install the context
  // first, including a plain replay of that preview.
  assert.match(clientSource, /function playSelectedScenePreview\(\) \{[\s\S]*?pushTourContext\(\);[\s\S]*?action: "play-opening"/);
  assert.match(clientSource, /scene\.section === "outro"/);
  assert.match(clientSource, /action = "play-tour-outro"/);
  // Tour timestamps sent to the player are presentation-relative: the player
  // adds the region's own opening descent before seeking, exactly as the capture
  // run does. Studio adding the render spec's descent on top of that seeked 3 s
  // late for every region that ships without an `openingDescent` block
  // (乌石镇, 西连镇), so the preview landed on a different frame than the export.
  assert.match(clientSource, /time = last\.end/);
  assert.match(clientSource, /time = active\.start/);
  assert.doesNotMatch(clientSource, /time = openingSeconds \+ /);
  assert.doesNotMatch(clientSource, /openingSeconds:/);
  assert.match(runtimeSource, /const openingSeconds = openingDescent \? openingDescent\.seconds : 0;/);
  assert.doesNotMatch(html, /id="previewKicker"|id="previewTitle"/);
  assert.match(html, /class="preview-copy subtitle-only"/);
  assert.match(clientSource, /state\.renderSpec\.subtitleCues/);
  assert.match(clientSource, /function splitPreviewSubtitle/);
  assert.match(clientSource, /function syncPreviewSubtitlesToAudio\(scene, audio\)/);
  assert.match(clientSource, /const audioTime = Number\(audio\.currentTime \|\| 0\)/);
  // 预览字幕与成片一致：思源黑体 Medium、无底纹、单行不折行（折行会切断逐字着色），
  // 放不下时按比例缩字号，而不是换成两行。
  assert.match(css, /\.preview-copy\.subtitle-only p[^}]*white-space:nowrap/);
  assert.match(css, /\.preview-copy\.subtitle-only p[^}]*max-width:100%/);
  // 金色层要压在白色字之上，否则会被不透明的白字盖住、进度永远看不见。
  assert.match(css, /\.preview-subtitle-wash\{position:absolute;z-index:1;[^}]*clip-path:inset\(0 var\(--subtitle-cut,100%\) 0 0\)/);
  assert.match(clientSource, /function fitPreviewSubtitle\(preview\)/);
  assert.match(css, /font:500[^;]*GeoSubtitle/);
  assert.doesNotMatch(css, /\.preview-copy\.subtitle-only p[^}]*background:#041018c7/);
  // 预览素材现在分两条通道（图片 <img> / 视频 <video>），「加载好了没」收进了
  // previewMediaReady()；见 tests/studio-preview-video.test.ts。
  assert.match(clientSource, /media\.complete && media\.naturalWidth > 0/);
  assert.match(clientSource, /previewAsset\.onerror = mediaFailed;/);
  assert.match(clientSource, /event\.data\.event === "opening-label-visible" && isOpeningScene\(scene\)/);
  assert.match(clientSource, /event\.data\.event === "tour-flight-complete"/);
  assert.match(clientSource, /state\.previewAssetReadySceneId = scene\.id/);
  assert.match(clientSource, /const waitsForMapReveal = isOpeningScene\(scene\) \|\| scene\.section === "child"/);
  assert.match(clientSource, /const cameraLocked = !waitsForMapReveal \|\| state\.previewAssetReadySceneId === scene\.id/);
  // The reveal has to honour the stage placement, not the panel selection: during
  // playback the flight-complete handler must show the picture the film is on.
  assert.match(clientSource, /function revealSelectedSceneAsset\(placement = state\.playbackStageActive \? state\.playbackStagePlacement : selectedPlacement\(\)\)[\s\S]*?setPreviewAssetVisible\(cameraLocked && previewMediaReady\(previewMediaElement\(\)\)\)/);
  assert.match(clientSource, /state\.previewAssetReadySceneId = scene\.id;[\s\S]*?revealSelectedSceneAsset\(\)/);
  assert.match(clientSource, /function selectScene\(sceneId, preview = false\)[\s\S]*?setPreviewAssetVisible\(false\);[\s\S]*?state\.previewAssetReadySceneId = null;[\s\S]*?state\.selectedSceneId = sceneId/);
  assert.match(css, /\.preview-asset\.is-visible/);
  assert.match(html, /id="previewAssetCaption" class="preview-asset-caption"/);
  assert.match(clientSource, /previewAssetCaption\.textContent = asset\.name/);
  assert.match(clientSource, /previewAssetCaption\.classList\.toggle\("is-visible", visible\)/);
  assert.match(css, /\.preview-asset-caption\{[^}]*left:calc\(7% \+ 10px\)/);
  assert.match(css, /\.preview-asset-caption\{[^}]*text-align:left[^}]*text-overflow:ellipsis/);
  assert.match(css, /\.preview-asset-caption\{[^}]*padding:0/);
  assert.doesNotMatch(css, /\.preview-asset-caption\{[^}]*background:/);
  assert.doesNotMatch(css, /\.preview-asset-caption\{[^}]*border-radius:/);
  assert.match(css, /\.preview-shade\.is-visible/);
  assert.match(clientSource, /previewAsset\.onload = revealLoadedAsset/);
  assert.match(clientSource, /previewAsset\.src = assetUrl\(asset\);/);
  assert.match(clientSource, /previewAssetFrame\.style\.setProperty\("--asset-scale", String\(placement\.scale\)\)/);
  assert.match(clientSource, /previewAssetFrame\.style\.setProperty\("--asset-motion-duration", `\$\{Math\.max\(2, Number\(scene\.duration\) \|\| 8\)\}s`\)/);
  assert.match(clientSource, /const motionClasses = \["motion-push-in", "motion-pull-out", "motion-pan-left", "motion-pan-right"\]/);
  assert.match(clientSource, /previewAsset\.classList\.toggle\("motion-push-in", placement\.animation === "push-in"\)/);
  assert.match(clientSource, /previewAsset\.classList\.toggle\("motion-pull-out", placement\.animation === "pull-out"\)/);
  assert.match(clientSource, /previewAsset\.classList\.toggle\("motion-pan-left", placement\.animation === "pan-left"\)/);
  assert.match(clientSource, /previewAsset\.classList\.toggle\("motion-pan-right", placement\.animation === "pan-right"\)/);
  assert.match(css, /@keyframes preview-asset-push-in/);
  assert.match(css, /@keyframes preview-asset-pull-out/);
  assert.match(css, /@keyframes preview-asset-pan-left/);
  assert.match(css, /@keyframes preview-asset-pan-right/);
  assert.match(css, /@keyframes preview-asset-push-in\{from\{transform:scale\(1\)\}to\{transform:scale\(var\(--asset-motion-zoom,1\.07\)\)\}/);
  assert.match(css, /@keyframes preview-asset-pull-out\{from\{transform:scale\(var\(--asset-motion-zoom,1\.07\)\)\}to\{transform:scale\(1\)\}/);
  assert.doesNotMatch(css, /@keyframes preview-asset-push-in\{[^}]*translate3d/);
  assert.match(html, /id="previewAssetFrame" class="preview-asset-frame"/);
  assert.match(css, /\.preview-asset-frame\{[^}]*overflow:hidden/);
  assert.match(css, /scale\(var\(--asset-enter-scale,\.985\)\)/);
  assert.doesNotMatch(clientSource, /dataset\.previewKey/);
  assert.match(css, /\.preview-asset-frame\{[^}]*opacity:0[^}]*filter:blur\(1\.5px\)[^}]*transition:opacity \.42s/);
  assert.match(css, /\.preview-asset-frame\.is-visible\{[^}]*opacity:1[^}]*filter:blur\(0\)/);
  const visualTimelineSource = await readFile(resolve(root, "packages/render-spec/visual-timeline.ts"), "utf8");
  assert.match(engineSource, /const plan = planVisualClip\(\{/);
  assert.match(visualTimelineSource, /scene\.section === "child" && range\s*\? range\.start \+ flight/);
  // 共享计划仍限制所有场景的结束边界，并将相同字段写入正式导出清单。
  assert.match(visualTimelineSource, /\.\.\.\(range \? \{ notAfterNarrationSeconds: range\.end \} : \{\}\)/);
  assert.match(visualTimelineSource, /clampMinimumDisplaySeconds\(configuredMinimumSeconds, availableSeconds\)/);
  assert.match(engineSource, /notAfterNarrationSeconds: plan\.notAfterNarrationSeconds/);
  assert.match(engineSource, /notBeforeNarrationSeconds: plan\.notBeforeNarrationSeconds/);
  assert.match(engineSource, /minimumDisplaySeconds: plan\.minimumDisplaySeconds/);
  assert.match(engineSource, /最短展示 \$\{plan\.configuredMinimumSeconds\} 秒超过本场旁白长度/);
  assert.match(visualTimelineSource, /: range && sequenceIndex === 0\s*\? range\.start/);
  assert.match(engineSource, /label: asset\.name/);
  const compositorSource = await readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts"), "utf8");
  assert.match(compositorSource, /const resolvedStart = Math\.max\(cueDrivenStart, notBefore\)/);
  assert.match(compositorSource, /const hardEnd = visual\.notAfterNarrationSeconds === undefined/);
  assert.match(compositorSource, /resolvedEnd = Math\.min\(hardEnd, Math\.max\(naturalEnd,/);
  assert.match(compositorSource, /function assertEverySelectedVisualIsRenderable\(source: VisualClip\[\], resolved: ResolvedVisualClip\[\]\)/);
  assert.match(compositorSource, /Selected visuals have no visible video frame/);
  assert.match(compositorSource, /assertEverySelectedVisualIsRenderable\(visualManifest\.clips \?\? \[\], visuals\)/);
});

test("Studio export supports a durable multi-task queue with per-task controls", async () => {
  const [serverSource, engineSource, html, clientSource, css] = await Promise.all([
    readFile(resolve(root, "apps/studio/server.ts"), "utf8"),
    readFile(resolve(root, "apps/studio/render-engine.ts"), "utf8"),
    readFile(resolve(root, "apps/studio/public/index.html"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio-refine.css"), "utf8")
  ]);
  assert.match(serverSource, /queuedRenders/);
  assert.match(serverSource, /maxConcurrentExports/);
  assert.match(serverSource, /function pumpRenderQueue/);
  assert.match(serverSource, /enqueueRender\(job, project\)/);
  assert.match(serverSource, /queuedJobs: queuedRenders\.length/);
  assert.match(engineSource, /queuePosition\?: number/);
  assert.match(engineSource, /projectTitle: project\.name/);
  assert.match(html, /id="exportRunningCount"/);
  assert.match(html, /id="exportQueuedCount"/);
  assert.match(html, /添加导出任务/);
  assert.doesNotMatch(html, /id="jobPanel"/);
  assert.match(clientSource, /exportStatusLabel/);
  assert.match(clientSource, /queuePosition/);
  assert.match(clientSource, /setTimeout\(\(\) => loadExportHistory/);
  assert.match(html, /id="exportButtonStatus"/);
  /* The queue is service-global, so the counters also fold in in-flight jobs that
     belong to other projects and survive a project switch. */
  assert.match(clientSource, /const isTerminal = \(job\) => \["completed", "failed", "cancelled"\]\.includes\(job\.status\)/);
  assert.match(clientSource, /api\("\/api\/jobs\?active=1&limit=100"\)/);
  assert.match(clientSource, /const foreignActive = globalActive\.filter\(\(job\) => job\.projectId !== projectId && !isTerminal\(job\)\)/);
  assert.match(clientSource, /const running = jobs\.filter\(\(job\) => !isTerminal\(job\) && job\.status !== "queued"\)/);
  assert.match(clientSource, /const queued = jobs\.filter\(\(job\) => job\.status === "queued"\)/);
  assert.match(clientSource, /const runningTotal = running\.length \+ foreignRunning\.length/);
  assert.match(clientSource, /const queuedTotal = queued\.length \+ foreignQueued\.length/);
  assert.match(clientSource, /\$\("exportRunningCount"\)\.textContent = String\(runningTotal\)/);
  assert.match(clientSource, /\$\("exportQueuedCount"\)\.textContent = String\(queuedTotal\)/);
  assert.match(clientSource, /`\$\{runningTotal\} 个处理中，\$\{queuedTotal\} 个等待/);
  assert.match(clientSource, /切换方案不会中断/);
  assert.match(clientSource, /if \(!\(await saveBeforeAction\("继续导出"\)\)\) return;\s+if \(!state\.readiness\?\.ready\) return toast\("导出前检查未通过，请查看右侧清单"\)/);
  assert.match(clientSource, /\$\("renderButton"\)\.disabled = state\.dirty \|\| !state\.readiness\?\.ready/);
  assert.match(clientSource, /readiness-item \$\{statusOf\(item\)\}/);
  /* Advisory checks stay out of the export gate: they report authoring drift the
     render self-heals, so they render as a warning rather than a failure. */
  assert.match(clientSource, /const statusOf = \(item\) => \(item\.pass \? "pass" : item\.advisory \? "warn" : "fail"\)/);
  assert.match(clientSource, /const markerOf = \(item\) => \(item\.pass \? "✓" : item\.advisory \? "•" : "!"\)/);
  assert.match(serverSource, /ready: checks\.every\(\(item\) => item\.pass \|\| item\.advisory\)/);
  assert.doesNotMatch(serverSource, /readiness\.checks\.filter\(\(item\) => !item\.pass\)/);
  assert.match(css, /readiness-item\.warn>span\{/);
  assert.match(css, /Export queue: compact, task-first delivery UI/);
});

test("Studio timing keeps parent-return metadata aligned with the rewritten narration SRT", async () => {
  const source = await readFile(resolve(root, "apps/studio/render-timing.ts"), "utf8");
  assert.match(source, /metadataOutroCueIndex = Number\(duration\.outroPause\.outroCueIndex\)/);
  assert.match(source, /shifted\[metadataOutroCueIndex\]/);
});

test("Studio materializes Edge TTS rates with an explicit sign", async () => {
  const source = await readFile(resolve(root, "apps/studio/render-engine.ts"), "utf8");
  assert.match(source, /const voiceRatePercent = Math\.round\(\(project\.voice\.speed - 1\) \* 100\)/);
  assert.match(source, /current\.voiceRate = `\$\{voiceRatePercent >= 0 \? "\+" : ""\}\$\{voiceRatePercent\}%`/);
});

test("Studio exposes grouped drag sorting and moves complete scene objects", async () => {
  const [clientSource, css] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.css"), "utf8")
  ]);
  assert.match(clientSource, /function reorderScene\(sourceId, targetId, placeAfter = false\)/);
  assert.match(clientSource, /source\.section !== target\.section/);
  assert.match(clientSource, /scenes\.splice\(targetIndex, 0, moved\)/);
  assert.match(clientSource, /bindSceneSorting\(\)/);
  assert.match(clientSource, /旁白、字幕、素材和镜头将同步移动/);
  assert.match(css, /\.scene-sortable\.drag-over/);
});

test("Studio scene list exposes linked CRUD without rendering disabled template controls", async () => {
  const [clientSource, css] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.css"), "utf8")
  ]);
  assert.match(clientSource, /function sceneCanManage\(scene\)/);
  assert.match(
    clientSource,
    /function sceneCanManage\(scene\) \{\s*\n\s*return Boolean\(scene && \(scene\.section === "overview" \|\| scene\.section === "outro-lead"\)\);/
  );
  assert.match(clientSource, /"封面、下级行政区和结尾由模板统一管理，不能复制"/);
  assert.doesNotMatch(clientSource, /scene\?\.section === "child"\) return true/);
  assert.match(clientSource, /if \(scene\.section === "child"\) return state\.project\.scenes\.filter\(\(item\) => item\.section === "child"\)\.length > 1/);
  assert.match(clientSource, /function duplicateScene\(sceneId\)/);
  assert.match(clientSource, /const duplicate = structuredClone\(source\)/);
  assert.match(clientSource, /scenes\.splice\(sourceIndex \+ 1, 0, duplicate\)/);
  assert.match(clientSource, /旁白、字幕、素材和镜头同步复制/);
  assert.match(clientSource, /function deleteScene\(sceneId\)/);
  assert.doesNotMatch(clientSource, /window\.confirm\(/);
  assert.match(clientSource, /toast\("场景及其关联内容已删除；点击“保存方案”后生效"\)/);
  assert.doesNotMatch(clientSource, /toast\("场景及其关联内容已删除"\);\s*await saveProject\(\)/);
  assert.match(clientSource, /data-edit-scene/);
  assert.match(clientSource, /data-duplicate-scene/);
  assert.match(clientSource, /data-delete-scene/);
  assert.match(clientSource, /const manageActions = scene\.id === state\.selectedSceneId \? `<span class="scene-inline-actions">/);
  assert.match(clientSource, /class="scene-delete-action" data-delete-scene/);
  assert.match(clientSource, /sceneCanManage\(scene\) \? `<button[^`]*data-duplicate-scene[\s\S]*?sceneCanDelete\(scene\) \? `<button[^`]*data-delete-scene/);
  assert.doesNotMatch(clientSource, /scene-template-lock|模板保护/);
  assert.match(clientSource, /\$\("deleteScene"\)\.hidden = !sceneCanDelete\(scene\)/);
  assert.match(css, /\.scene-inline-actions/);
});

test("deleted overview and child scenes stay deleted after project normalization", async () => {
  const project = await makeProject(root, "440825112");
  const removedOverview = project.scenes.find((scene) => scene.section === "overview")!;
  const removedChild = project.scenes.find((scene) => scene.section === "child")!;
  project.scenes = project.scenes.filter((scene) => scene.id !== removedOverview.id && scene.id !== removedChild.id);

  const normalized = await normalizeProject(root, project);
  assert.equal(normalized.scenes.some((scene) => scene.id === removedOverview.id), false);
  assert.equal(normalized.scenes.some((scene) => scene.id === removedChild.id), false);

  const spec = await buildProjectRenderSpec(root, normalized);
  assert.equal(spec.childTourOrder.includes(removedChild.childId!), false);
  assert.deepEqual(
    spec.childTourOrder,
    normalized.scenes.filter((scene) => scene.section === "child").map((scene) => scene.childId)
  );
});

test("renaming a child scene updates every displayed administrative name", async () => {
  const [clientSource, runtimeSource, renderEngineSource, renderSpecSource] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/cesium-player/public/runtime.js"), "utf8"),
    readFile(resolve(root, "apps/studio/render-engine.ts"), "utf8"),
    readFile(resolve(root, "packages/render-spec/index.ts"), "utf8")
  ]);
  assert.match(clientSource, /scene\.childName = nextName/);
  assert.match(clientSource, /replaceSceneNameReference\(scene\.narration, previousName, nextName\)/);
  assert.match(clientSource, /action: "update-tour-labels"/);
  assert.match(runtimeSource, /configuredStop\?\.name \?\? feature\.properties\?\.name/);
  assert.match(runtimeSource, /function applyTourStopLabelNames\(stops = \[\]\)/);
  assert.match(runtimeSource, /action === "update-tour-labels"/);
  assert.match(renderEngineSource, /const childDisplayNames = new Map/);
  assert.match(renderEngineSource, /name: childDisplayNames\.get\(String\(child\.id\)\) \|\| child\.name/);
  assert.match(renderSpecSource, /id: scene\.childId, name: scene\.childName, camera: scene\.camera/);
});

test("creating a project commits the new editor state before optional panel refreshes", async () => {
  const source = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");
  assert.match(source, /state\.project = project;[\s\S]*?state\.selectedSceneId = project\.scenes\[0\]\?\.id \|\| null/);
  assert.match(source, /state\.renderSpec = null;\s*state\.renderSpecStale = false;\s*state\.readiness = null;\s*state\.dirty = false/);
  assert.match(source, /showOutputLocation\(null\);[\s\S]*?render\(\);[\s\S]*?try \{ await locateRegion\(project\.regionId\); \}/);
  const syncSource = /async function syncProjectState\(\) \{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(syncSource, /const project = state\.project;\s*const projectId = project\?\.id/);
  assert.match(syncSource, /if \(state\.project !== project \|\| state\.specRequest !== requestId \|\| state\.editEpoch !== requestEpoch \|\| state\.dirty\) return/);
  assert.match(source, /state\.previewAudio = null; state\.previewAudioProjectId = null/);
});

test("play scope label resolves the selected scene without leaking a map callback variable", async () => {
  const source = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");
  // ▶ 的语义是「只播这一场」，文案必须跟着走，否则播放条在说另一件事。
  assert.match(source, /\$\("playScope"\)\.textContent = selectedScene\(\) \? `只播「\$\{selectedScene\(\)\.title\}」`/);
  assert.doesNotMatch(source, /\$\("playScope"\)\.textContent = scene \?/);
});

test("clicking a scene moves playback to that scene instead of returning to the head", async () => {
  const source = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");
  assert.match(source, /function selectSceneFromUi\(sceneId\)/);
  assert.match(source, /const continuePlaying = Boolean\(state\.playTimer\)/);
  assert.match(source, /selectScene\(sceneId, false\);[\s\S]*?previewSelectedScene\(\)/);
  // 连播中点到另一场 = 快进，不是切去单场试听，所以要把状态带过去。
  assert.match(source, /if \(continuePlaying\) startPlaybackFromSelected\(\{ continuous \}\)/);
  assert.match(source, /\.scene-item\[data-scene-id\], \.timeline-clip\[data-scene-id\]/);
  assert.match(source, /state\.playheadSeconds = sceneStartSeconds\(selectedScene\(\)\)/);
  assert.match(source, /function startPlaybackFromSelected\(\{ continuous = false \} = \{\}\)/);
  assert.match(source, /function togglePlayback\(\) \{ if \(state\.playTimer\) return stopPlayback\(\); startPlaybackFromSelected\(\); \}/);
});

test("clicking a child scene previews its complete administrative camera segment", async () => {
  const source = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");
  assert.match(source, /action = "play-tour-segment"/);
  // Presentation-relative: the player adds the region's opening descent itself.
  assert.match(source, /time = active\.start/);
  assert.match(source, /targetId: scene\.childId/);
  assert.match(source, /playPreviewNarration\(scene, false, openingNarrationDelaySeconds\(scene\)\)/);
  assert.match(source, /function schedulePlaybackAdvance\(\)[\s\S]*?pollAudioClock/);
  // 签名多了 `{ completed }` 参数（播完 vs 手动暂停），断言的意图只是「它会清字幕定时器」。
  assert.match(source, /function stopPlayback\(\{ completed = false \} = \{\}\)[\s\S]*?clearPreviewSubtitleTimers\(\)/);
  assert.match(source, /function playFromBeginning\(\)/);
  assert.match(source, /selectScene\(first\.id, false\)/);
  assert.match(source, /function startPlaybackFromSelected\(\{ continuous = false \} = \{\}\)[\s\S]*?const scene = selectedScene\(\)[\s\S]*?previewSelectedScene\(\)/);
});

test("the editor playhead and the total duration share one origin", async () => {
  // Render-spec cue ranges are measured from the start of the *narration*, and
  // the compositor lays that narration down after two lead-ins: the cover still
  // and the opening descent (`narrationStartSeconds` in the composition
  // manifest). `totalDurationSeconds` counts both, so the playhead must too —
  // otherwise every scene reads one descent earlier than the video plays it.
  const clientSource = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");
  assert.match(clientSource, /function timelineOffsetSeconds\(\)/);
  assert.match(clientSource, /state\.renderSpec\?\.cover\?\.introSeconds \?\? state\.project\.cover\?\.introSeconds/);
  assert.match(clientSource, /state\.renderSpec\?\.opening\?\.descentSeconds \?\? state\.project\.template\?\.openingDescentSeconds/);
  assert.match(clientSource, /return cover \+ descent;/);
  assert.match(clientSource, /if \(scene\.section === "cover"\) return 0;/);
  assert.match(clientSource, /return offset \+ Math\.max\(0, Number\(cueRange\.start \|\| 0\)\)/);
  // The cover is scene 0, so the spec-less fallback has to skip it: `sceneDuration`
  // already returns the intro for it and the offset carries it as well.
  assert.match(clientSource, /\.filter\(\(item\) => item\.section !== "cover"\)/);

  const project = await makeProject(root, "440825112");
  const spec = await buildProjectRenderSpec(root, project);
  assert.ok(spec.cover.introSeconds > 0, "shipped projects open with a cover");
  assert.ok(spec.opening.descentSeconds > 0, "shipped projects open with a descent");
  assert.equal(
    spec.totalDurationSeconds,
    spec.cover.introSeconds + spec.timelineDurationSeconds,
    "the total is the cover plus the map timeline"
  );
  // The map timeline is the descent plus the narration, so the cue clock cannot
  // already contain the descent — that is what makes the playhead offset two
  // lead-ins rather than one.
  assert.ok(
    Math.abs(spec.timelineDurationSeconds - (spec.narrationDurationSeconds + spec.opening.descentSeconds)) <= 1,
    `map timeline ${spec.timelineDurationSeconds}s should be the ${spec.opening.descentSeconds}s descent plus ${spec.narrationDurationSeconds}s of narration (ceil adds up to a second)`
  );
  const scenesById = new Map(spec.scenes.map((scene) => [scene.sceneId, scene]));
  const firstNarration = spec.sceneCueRanges.find((range) => scenesById.get(range.sceneId)?.section !== "cover");
  assert.ok(firstNarration, "the map timeline has narration cues");
  assert.equal(
    spec.sceneCueRanges.filter((range) => scenesById.get(range.sceneId)?.section === "cover").length,
    0,
    "the cover has no narration cue of its own"
  );
  // The narration opens the cue clock, so the playhead of the first narrated
  // scene is exactly the two lead-ins (cover + descent). Reading it as the cover
  // alone is the bug this pins down. The first cue sits well inside the descent,
  // which is what makes the cue clock descent-exclusive.
  assert.ok(
    Number(firstNarration.start) < spec.opening.descentSeconds,
    `first cue ${firstNarration.start}s should open the narration, well inside the ${spec.opening.descentSeconds}s descent`
  );
  assert.ok(
    spec.cover.introSeconds + spec.opening.descentSeconds > spec.cover.introSeconds,
    "the corrected playhead offset is strictly larger than the cover alone"
  );
});

test("Studio playback synchronizes the generated narration audio with scene cue ranges", async () => {
  const [clientSource, serverSource, playerSource, renderEngineSource] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/server.ts"), "utf8"),
    readFile(resolve(root, "apps/cesium-player/public/runtime.js"), "utf8"),
    readFile(resolve(root, "apps/studio/render-engine.ts"), "utf8")
  ]);
  assert.match(clientSource, /function playPreviewNarration\(scene, preserveContinuity = false, delaySeconds = 0\)/);
  assert.match(clientSource, /function unlockPreviewAudioFromGesture\(scene\)/);
  assert.match(clientSource, /audio\.muted = true;[\s\S]*?playAudioElement\(audio\)/);
  assert.match(clientSource, /unlockPreviewAudioFromGesture\(scene\);[\s\S]*?playPreviewNarration\(scene/);
  assert.match(clientSource, /function seekPreviewAudio\(audio, target, onReady\)/);
  assert.match(clientSource, /audio\.addEventListener\("seeked", handleSeeked, \{ once: true \}\)/);
  assert.match(clientSource, /seekPreviewAudio\(audio, target, resume\)/);
  assert.match(clientSource, /audio\.muted = false;[\s\S]*?playAudioElement\(audio\)/);
  assert.match(clientSource, /if \(delaySeconds > 0\)[\s\S]*?audio\.pause\(\);[\s\S]*?audio\.currentTime = target/);
  assert.match(clientSource, /function syncPreviewSubtitlesToAudio\(scene, audio\)/);
  assert.match(clientSource, /const audioTime = Number\(audio\.currentTime \|\| 0\)/);
  assert.match(clientSource, /audioTime \+ 0\.015 >= entry\.start && audioTime < entry\.end/);
  assert.match(clientSource, /function schedulePlaybackAdvance\(\)[\s\S]*?pollAudioClock/);
  assert.match(clientSource, /audio\.currentTime \|\| 0\) \+ 0\.02 >= Number\(range\.end \|\| 0\)/);
  assert.match(clientSource, /function openingSubtitleDelaySeconds\(scene\)[\s\S]*?return openingNarrationDelaySeconds\(scene\)/);
  assert.match(clientSource, /function previewSubtitleEntries\(scene\)[\s\S]*?state\.renderSpec\.subtitleCues \|\| \[\]\)\.filter/);
  assert.match(clientSource, /function showPreviewSubtitle\(scene, index = 0\)[\s\S]*?const entries = previewSubtitleEntries\(scene\)/);
  assert.doesNotMatch(clientSource, /speechSynthesis|SpeechSynthesisUtterance|utterance\.onstart/);
  assert.match(clientSource, /state\.previewAudioErrorShown = true/);
  assert.match(clientSource, /function openingPreviewSettings\(\)/);
  assert.match(clientSource, /function openingNarrationDelaySeconds\(scene\)/);
  assert.match(clientSource, /function openingNarrationDelaySeconds\(scene\)[\s\S]*?descentSeconds \+ STUDIO_OPENING_PREVIEW_TIMING\.revealDelaySeconds/);
  assert.match(clientSource, /event\.data\.event === "opening-label-visible"/);
  assert.match(clientSource, /STUDIO_OPENING_PREVIEW_TIMING\.assetDelayAfterLabelSeconds \* 1000/);
  assert.match(playerSource, /event: "opening-label-visible"/);
  assert.match(renderEngineSource, /const openingAssetDelayFromNarrationSeconds = 2\.8/);
  assert.match(renderEngineSource, /openingDelaySeconds: openingAssetDelayFromNarrationSeconds/);
  const visualTimelineSource = await readFile(resolve(root, "packages/render-spec/visual-timeline.ts"), "utf8");
  assert.match(visualTimelineSource, /scene\.id === input\.openingSceneId && range\s*\? range\.start \+ openingDelay/);
  assert.match(clientSource, /sceneDuration\(scene\) \+ narrationDelay/);
  assert.match(clientSource, /playPreviewNarration\(nextScene, true, openingNarrationDelaySeconds\(nextScene\)\)/);
  assert.match(clientSource, /Math\.max\(0, delaySeconds\) \* 1000/);
  assert.match(clientSource, /sceneCueRanges\?\.find/);
  assert.match(clientSource, /audio\.currentTime = expected/);
  assert.match(clientSource, /state\.previewAudio\?\.pause\(\)/);
  assert.match(serverSource, /narration-audio/);
  assert.match(serverSource, /function streamSeekableMedia/);
  assert.match(serverSource, /"accept-ranges": "bytes"/);
  assert.match(serverSource, /response\.writeHead\(206/);
  assert.match(serverSource, /"content-range": `bytes \$\{start\}-\$\{end\}\/\$\{size\}`/);
  assert.match(serverSource, /findProjectNarrationAudio/);
  assert.match(serverSource, /narrationSignature\(snapshot\) === currentSignature/);
  assert.match(serverSource, /voiceId: candidate\.voice\.voiceId/);
  assert.match(serverSource, /speed: candidate\.voice\.speed/);
  assert.match(serverSource, /narrationSignature\(baselineProject\) === currentSignature/);
});

test("Studio offers explicit project saving and invalidates stale narration after text edits", async () => {
  const [html, clientSource] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/index.html"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8")
  ]);
  assert.match(html, /id="saveProjectButton" class="save-project-action">保存方案/);
  assert.match(clientSource, /\$\("saveProjectButton"\)\.onclick = \(\) => setSaveProjectOpen\(true\)/);
  assert.match(clientSource, /function setSaveProjectOpen\(open\)[\s\S]*?\$\("saveProjectModal"\)\.hidden = !open/);
  assert.match(clientSource, /function markDirty\(\)[\s\S]*?renderSaveState\("dirty"\)/);
  assert.doesNotMatch(clientSource, /state\.saveTimer = setTimeout/);
  const saveSource = /async function saveProject\(\) \{[\s\S]*?\n\}/.exec(clientSource)?.[0] ?? "";
  assert.match(saveSource, /const project = state\.project/);
  assert.match(saveSource, /const previousRevision = project\.revision/);
  assert.match(saveSource, /project\.revision = saved\.revision/);
  assert.match(saveSource, /if \(project\.revision !== previousRevision\) \{[\s\S]*?state\.previewAudio = null;[\s\S]*?state\.previewAudioProjectId = null;/);
  const guardSource = /async function saveBeforeAction\([\s\S]*?\n\}/.exec(clientSource)?.[0] ?? "";
  assert.match(guardSource, /if \(!state\.project \|\| !state\.dirty\) return true/);
  assert.match(guardSource, /if \(!ok\) return false/);
  assert.match(guardSource, /await saveProject\(\)/);
  assert.match(guardSource, /return !state\.dirty/);
  assert.match(clientSource, /narration-audio\?revision=\$\{encodeURIComponent\(state\.project\.revision \|\| 0\)\}/);
  assert.match(clientSource, /scene\[key\] = value; markDirty\(\); render\(\)/);
});

test("canonical SRT parser reads the formal twenty-cue narration", async () => {
  const source = await readFile(resolve(root, "apps/video-compositor/captions/440825112.srt"), "utf8");
  const cues = parseSrt(source);
  assert.equal(cues.length, 20);
  assert.match(cues[11]!.text, /后海村.*雷打沙海滩/);
});

test("provider cue cross-fades are closed without changing spoken text", () => {
  const cues = normalizeTimedCueOverlaps([
    { index: 0, start: 0.1, end: 10.727, text: "第一句" },
    { index: 1, start: 10.677, end: 20.247, text: "第二句" }
  ]);
  assert.equal(cues[0]?.end, 10.677);
  assert.equal(cues[0]?.text, "第一句");
  assert.equal(cues[1]?.start, 10.677);
});

test("editing the project keeps the last render spec so clip widths stay put", async () => {
  /* Every timing the editor shows — scene-list seconds, clip widths, subtitle
     cues, the preview playhead — is read from the render spec, and the fallback
     `scene.duration` is only rewritten on export, so the two disagree. Releasing
     the spec on every edit made the whole strip re-measure itself from those
     drifted values, which resized every clip whenever a single scene was added. */
  const [clientSource, css] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio-refine.css"), "utf8")
  ]);
  const markDirty = /function markDirty\(\)\s*\{[\s\S]*?\n\}/.exec(clientSource)?.[0];
  assert.ok(markDirty, "markDirty must exist");
  assert.doesNotMatch(markDirty, /state\.renderSpec = null/, "markDirty must not release the spec");
  assert.match(markDirty, /state\.renderSpecStale = true/);
  assert.match(clientSource, /state\.renderSpec = spec; state\.renderSpecStale = false; state\.readiness = readiness/);
  // A failed refresh keeps the spec too, otherwise the strip reshuffles itself on
  // the one path where no fresh timings are coming.
  const syncSource = /async function syncProjectState\(\) \{[\s\S]*?\n\}/.exec(clientSource)?.[0] ?? "";
  const syncFailure = /catch \(error\) \{\s*if \(state\.project !== project \|\| state\.specRequest !== requestId \|\| state\.editEpoch !== requestEpoch\) return;[\s\S]*?\n  \}/.exec(syncSource)?.[0];
  assert.ok(syncFailure, "syncProjectState must have a failure branch");
  assert.doesNotMatch(syncFailure, /state\.renderSpec = null/);
  assert.match(syncFailure, /state\.renderSpecStale = true/);
  // Switching project still drops the spec outright — those timings belong to
  // another project and must never be reused.
  assert.match(clientSource, /async function openSavedProject\(id\)[\s\S]*?state\.renderSpec = null;\s*\n\s*state\.renderSpecStale = false;/);
  assert.match(clientSource, /async function createProjectFromList\(name\)[\s\S]*?state\.renderSpec = null;\s*\n\s*state\.renderSpecStale = false;/);
  // Clip width is a pure function of the scene's own duration, so one scene can
  // never widen another.
  assert.match(clientSource, /style="width:\$\{Math\.max\(112, Math\.round\(sceneDuration\(scene\) \* 13\)\)\}px"/);
  assert.match(css, /\.timeline-clip\{[^}]*flex:0 0 auto/);
});

test("the memoized project list notices a project written by another process", async () => {
  /* `/api/projects` is memoized because building it opens every stored revision,
     and a memo that never expires also hides everything this process did not
     write — a git checkout, a second Studio, a script. That reads as "my project
     disappeared" rather than "the cache is stale", and only a restart cured it. */
  const serverSource = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");
  assert.match(serverSource, /const signature = await projectsRootSignature\(\);/);
  assert.match(serverSource, /if \(!projectListPromise \|\| projectListSignature !== signature\) \{/);
  assert.match(serverSource, /hash\.update\(`\$\{name\}:\$\{info\.size\}:\$\{Math\.floor\(info\.mtimeMs\)\}\\n`\)/);
  assert.match(serverSource, /let projectListSignature: string \| undefined;/);
  // A failed build must clear the signature too, or the next call would reuse a
  // promise that already rejected.
  assert.match(serverSource, /projectListPromise = undefined;\s*\n\s*projectListSignature = undefined;/);
});

test("one damaged revision cannot make a project unopenable", async () => {
  /* `readProject` used to parse every stored revision and let the first failure
     reject the whole call, so a single torn snapshot turned every later GET,
     save, /validate and export of that project into an error. `buildProjectList`
     already skips unparseable revisions; reading by id has to agree with it. */
  const serverSource = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");
  assert.match(serverSource, /PROJECT_REVISION_UNREADABLE/);
  assert.match(serverSource, /if \(code === "EMFILE" \|\| code === "ENFILE"\) throw error;/);
  /* The "nothing readable" outcome, stated as behaviour rather than as the exact
     guard that produced it. `readProject` used to collect a `project` variable
     and test it after the loop; it now returns from inside the loop (so the
     materialisation cache can be written on the way out) and falls through to
     this throw. Both mean the same thing: once every candidate has been tried
     and rejected, the scheme is unopenable and says so. */
  assert.match(serverSource, /throw new Error\(`Project \$\{projectId\} has no readable revision`\);/);
  /* And the walk-back must still be a walk-back: a candidate that fails to
     normalise has to continue to the next one, not abort. Reading the exact
     loop here is what keeps "one damaged revision cannot make a project
     unopenable" honest for the materialised path too. */
  const readBody = serverSource.slice(
    serverSource.indexOf("async function readProject"),
    serverSource.indexOf("function invalidateProjectCache")
  );
  assert.match(readBody, /for \(const name of candidates\)/, "必须逐个候选往下走");
  assert.match(readBody, /PROJECT_REVISION_UNREADABLE[\s\S]*?\n\s*\}\s*\n\s*\}/, "不可读的快照要先记录再继续，而不是抛出");
  assert.doesNotMatch(readBody, /PROJECT_REVISION_UNREADABLE[\s\S]{0,400}?throw error;[\s\S]{0,80}?\n\s*\}\s*\n\s*\}/, "普通不可读不能直接冒泡（EMFILE/ENFILE 除外）");
  /* And it must reach the newest revision without opening the older ones: the
     scheme here had 315 snapshots of ~370 KB, so "parse them all to pick the
     latest" cost 1418 ms per read with every other request queued behind it.
     The ordering rule itself is tested in studio-project-retention.test.ts. */
  assert.match(serverSource, /const candidates = await projectSnapshotCandidates\(projectId\);/);
  assert.match(serverSource, /return orderProjectSnapshots\(await readdir\(projectsRoot\), safeId\(projectId\)\);/);
});

test("a narration edit re-measures its own clip without waiting for the spec round trip", async () => {
  /* A scene's length follows its narration, but the authoritative number only
     arrives after the autosave debounce, a PUT and a spec rebuild — measured on
     a live project at +4.3s after the last keystroke, during which the strip
     still showed the *previous* text's length. The editor now estimates with the
     very formula the server falls back to whenever the narration no longer
     lines up with the TTS cues, so the clip, its seconds and the headline total
     follow the cursor; the spec takes the drafts over once it lands. */
  const [clientSource, serviceSource] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8"),
    readFile(resolve(root, "apps/studio/project-service.ts"), "utf8")
  ]);

  // The estimate has to mirror the server fallback, otherwise the strip would
  // jump the moment the real spec arrives.
  assert.match(serviceSource, /const duration = Math\.max\(2, \[\.\.\.scene\.narration\]\.length \/ 4\.1\)/);
  assert.match(clientSource, /const NARRATION_CHARS_PER_SECOND = 4\.1/);
  assert.match(clientSource, /return Math\.max\(2, \[\.\.\.String\(narration \?\? ""\)\]\.length \/ NARRATION_CHARS_PER_SECOND\)/);

  // The draft is written wherever the text changes, and read before the spec.
  const editNarration = /if \(key === "narration"\)[\s\S]*?\n  \}/.exec(clientSource)?.[0];
  assert.ok(editNarration, "editScene must handle narration");
  assert.match(editNarration, /scene\.subtitle = value;\s*\n\s*draftSceneDuration\(scene\);\s*\n\s*markDirty\(\); render\(\)/);
  const editTitle = /if \(key === "title" && scene\.section === "child"\)[\s\S]*?\n  \}/.exec(clientSource)?.[0];
  assert.ok(editTitle, "editScene must handle a child rename, which rewrites the narration too");
  assert.match(editTitle, /draftSceneDuration\(scene\)/);
  for (const callSite of ["duplicateScene", "addScene", "splitOverviewScene"]) {
    assert.match(clientSource, new RegExp(`${callSite}\\([\\s\\S]*?draftSceneDuration`), `${callSite} must seed the scenes it creates`);
  }
  const sceneDuration = /function sceneDuration\(scene\)[\s\S]*?\n\}/.exec(clientSource)?.[0];
  assert.ok(sceneDuration, "sceneDuration must exist");
  assert.match(sceneDuration, /const draft = pendingSceneDuration\(scene\);[\s\S]*?if \(draft !== null\) return draft;/);

  // A refresh already in flight must not clear an edit made while it ran, and a
  // draft must never survive into another project whose scene ids look alike.
  assert.match(clientSource, /const requestEpoch = state\.editEpoch;/);
  assert.match(clientSource, /releaseSettledDrafts\(requestEpoch\)/);
  assert.match(clientSource, /if \(draft\.epoch <= requestEpoch\) state\.durationDrafts\.delete\(sceneId\)/);
  assert.match(clientSource, /draft && draft\.projectId === state\.project\?\.id \? draft\.seconds : null/);

  // The headline total has to move with the strip, or one clip could grow ten
  // seconds while 总时长 stood still.
  assert.match(clientSource, /Number\(state\.renderSpec\.totalDurationSeconds \|\| 0\) \+ pendingDurationDelta\(\)/);
});

test("a deleted export record cannot be written back by the render it belonged to", async () => {
  /* Cancelling marks the record `cancelled` before the child process is reaped,
     so a delete can land while the render is still winding down. `persistJob`
     used to register and write unconditionally, which resurrected the record —
     relabelled `failed`, because `cancelledJobs` had already been cleared — and
     recreated its directory. */
  const serverSource = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");

  assert.match(serverSource, /const deletedJobs = new Set<string>\(\);/);
  assert.match(serverSource, /const runningJobs = new Map<string, Promise<void>>\(\);/);

  for (const [name, pattern] of [
    ["persistJob", /function persistJob\(job: RenderJobRecord\): void \{/],
    ["updateJob", /function updateJob\(job: RenderJobRecord, patch: Partial<RenderJobRecord>\): void \{/],
    ["loadJob", /async function loadJob\(id: string\): Promise<RenderJobRecord \| null> \{/]
  ] as const) {
    const body = new RegExp(`${pattern.source}[\\s\\S]*?\\n\\}`).exec(serverSource)?.[0];
    assert.ok(body, `${name} must exist`);
    assert.match(body, /deletedJobs\.has\(job\.id\)|deletedJobs\.has\(id\)/, `${name} must ignore a deleted job`);
  }

  const pump = /function pumpRenderQueue\(\): void \{[\s\S]*?\n\}/.exec(serverSource)?.[0];
  assert.ok(pump, "pumpRenderQueue must exist");
  assert.match(pump, /runningJobs\.set\(next\.job\.id, running\)/);

  const del = /async function deleteTerminalJob\(job: RenderJobRecord\): Promise<void> \{[\s\S]*?\n\}/.exec(serverSource)?.[0];
  assert.ok(del, "deleteTerminalJob must exist");
  assert.match(del, /runningJobs\.get\(job\.id\)[\s\S]*?Promise\.race\(\[running, new Promise\(\(settle\) => setTimeout\(settle, 30_000\)\)\]\)/);
  assert.match(del, /persistChains\.get\(join\(job\.jobRoot, "job\.json"\)\)\?\.catch/);
  assert.ok(del.indexOf("deletedJobs.add(job.id)") < del.indexOf("await rm(jobPath"),
    "the job must be marked deleted before its directory is removed");
});

test("caches keyed on a content signature evict the revision they replace", async () => {
  /* Every one of these caches names its entry after the content that produced
     it, so an edit writes a new entry and strands the previous one. Nothing
     reclaimed them: the cover preview storage had 16 files for deleted projects
     plus nine revisions for one live project, and the map cache held twelve
     revisions of a single region+profile (~3 GB). */
  const [serverSource, engineSource, catalogSource] = await Promise.all([
    readFile(resolve(root, "apps/studio/server.ts"), "utf8"),
    readFile(resolve(root, "apps/studio/render-engine.ts"), "utf8"),
    readFile(resolve(root, "apps/studio/admin-catalog.ts"), "utf8")
  ]);

  const prune = /async function pruneProjectCoverPreviews\([\s\S]*?\n\}/.exec(serverSource)?.[0];
  assert.ok(prune, "pruneProjectCoverPreviews must exist");
  assert.match(prune, /\.filter\(\(name\) => name\.startsWith\(prefix\) && name !== keepFilename\)/);

  const preview = /async function ensureProjectCoverPreview\(project: VideoProject\): Promise<string> \{[\s\S]*?\n\}/.exec(serverSource)?.[0];
  assert.ok(preview, "ensureProjectCoverPreview must exist");
  assert.equal((preview.match(/pruneProjectCoverPreviews\(/g) ?? []).length, 2,
    "both the cache-hit and the regenerate path must evict the other signatures");

  const deleteProject = /async function deleteProject\(projectId: string\): Promise<void> \{[\s\S]*?\n\}/.exec(serverSource)?.[0];
  assert.ok(deleteProject, "deleteProject must exist");
  /* The interactive delete is deliberately tiny: it records durable intent (a
     tombstone) and hands the filesystem work to `removeProjectFiles`. Doing the
     removals inline measured 31.8 seconds, because every unlink is fronted by
     the sandbox's safe-delete guard. */
  assert.match(deleteProject, /await writeFile\(projectTombstonePath\(id\)/,
    "the tombstone must be written before the delete returns, or a restart resurrects the scheme");
  assert.match(deleteProject, /scheduleProjectDeletion\(id\);/);

  const remove = /async function removeProjectFiles\(id: string\): Promise<boolean> \{[\s\S]*?\n\}/.exec(serverSource)?.[0];
  assert.ok(remove, "removeProjectFiles must exist");
  assert.match(remove, /pruneProjectCoverPreviews\(id\)/);
  /* Order is load-bearing, not stylistic. The boundary directory is the bulky
     recursive part, and the safe-delete guard refuses a delete once it would
     cross its process-lifetime budget. The cheap snapshots are unlinked first so
     that a refusal of the bulky boundary step still leaves the scheme tombstoned
     and hidden rather than stranded. */
  const snapshotsAt = remove.indexOf("await Promise.all(snapshots.map");
  const boundaryAt = remove.indexOf("deleteBoundarySnapshot(root, id)");
  assert.ok(boundaryAt >= 0 && snapshotsAt >= 0, "removeProjectFiles must unlink snapshots and the boundary tree");
  assert.ok(snapshotsAt < boundaryAt, "先删轻量的 json 快照，再删笨重的边界目录，被拦下时可重试");
  // The leftover probe must not count the tombstone itself as work to be done,
  // or a fully-deleted scheme could never retire its marker.
  assert.match(remove, /name !== `\$\{id\}\.deleted`/, "残留判定必须排除 tombstone 自身");

  const sweep = /async function sweepDeletedProjects\(\): Promise<void> \{[\s\S]*?\n\}/.exec(serverSource)?.[0];
  assert.ok(sweep, "tombstones need a startup sweep, or a refused delete is lost on restart");
  assert.match(sweep, /name\.endsWith\("\.deleted"\)/);

  const mapPrune = /async function pruneSupersededMapCache\([\s\S]*?\n\}/.exec(engineSource)?.[0];
  assert.ok(mapPrune, "pruneSupersededMapCache must exist");
  assert.match(mapPrune, /const artifact = `\$\{regionId\}-map-\$\{profile\}\.mp4`;/);
  assert.match(mapPrune, /info\.mtimeMs > cutoff\) return;/);
  assert.equal((engineSource.match(/await pruneSupersededMapCache\(root, project\.regionId, project\.output\.profile, spec\.cacheSignature\);/g) ?? []).length, 2,
    "both cache write paths must evict the revisions they replace");

  assert.match(catalogSource, /name\.startsWith\("admin-divisions\.v"\) && name !== keep/);
});

test("the preview iframe boots only the one region the open project asks for", async () => {
  /* The iframe used to carry a hardcoded default region in index.html, which
     boot() then replaced with the remembered project's URL. Measured in a real
     browser: the throwaway document started loading at +230ms, its six skybox
     textures and a boundary geojson were aborted at +2409ms, and the wanted URL
     navigated at +2450ms. That default URL also omitted studioPreview, so the
     discarded boot ran the heavy export-grade profile (screen-space error 1.0,
     preloadAncestors/Siblings on) instead of the preview profile. */
  const [html, source] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/index.html"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8")
  ]);

  const iframe = /<iframe id="cesiumPreview"[^>]*>/.exec(html)?.[0];
  assert.ok(iframe, "the preview iframe must exist");
  assert.doesNotMatch(iframe, /\bsrc=/, "a hardcoded src starts a boot that gets thrown away");

  const assign = /\$\("cesiumPreview"\)\.src = previewUrl/.exec(source)?.[0];
  assert.ok(assign, "render() must be the only thing that assigns the preview src");
  assert.match(source, /if \(state\.previewUrl !== previewUrl\) \{ state\.previewUrl = previewUrl;/,
    "a re-render over the same URL must not reload the preview");
  // The scheme id rides along as `boundary`: the preview has to read that
  // scheme's frozen boundary rather than whatever `data/` holds now, or
  // re-importing a region would redraw a scheme that was already authored.
  assert.match(source, /`\$\{CESIUM_PREVIEW_ORIGIN\}\/\?region=\$\{encodeURIComponent\(project\.regionId\)\}&profile=\$\{encodeURIComponent\(project\.output\.profile\)\}&studioPreview=2&imagery=\$\{encodeURIComponent\(loadedImagery\)\}&boundary=\$\{encodeURIComponent\(project\.id\)\}&parentOrigin=\$\{encodeURIComponent\(location\.origin\)\}`/,
    "the assigned URL must carry studioPreview so the preview uses the light profile, and boundary so it reads the scheme's frozen data");
  // The URL pins the provider the iframe was *loaded* with. A later basemap switch
  // travels over postMessage, so the src (and with it the pixel-stream session) stays.
  assert.match(source, /const loadedImagery = state\.previewImagery \|\| imageryProvider;/,
    "basemap switches must not rewrite the iframe URL");
  assert.match(source, /action: "switch-imagery"/, "the studio asks the running player to swap its tile source");
});

test("a bound scene asset can be removed by keyboard and at any asset count", async () => {
  /* The bound-asset card announced itself as role="button" and claimed Enter/Space
     for selection even when the key came from the 移除 button nested inside it.
     preventDefault() there cancelled the button's own activation, so 移除 never
     fired from the keyboard and a scene kept its assets however few it had. */
  const clientSource = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");

  assert.match(clientSource,
    /\.scene-bound-asset"\)\.forEach\(\(card\) => card\.onkeydown = \(event\) => \{[\s\S]*?if \(event\.target !== card\) return;[\s\S]*?if \(event\.key !== "Enter" && event\.key !== " "\) return;/,
    "only the card itself may swallow Enter/Space; nested buttons keep their native activation");
  assert.doesNotMatch(clientSource, /role="button" aria-label="选择素材/,
    "a card that wraps real buttons must not also pose as a button");

  const remove = /function removeAssetFromScene\(id\) \{[\s\S]*?\n\}/.exec(clientSource)?.[0];
  assert.ok(remove, "removeAssetFromScene must exist");
  assert.match(remove!, /scene\.placements = \(scene\.placements \|\| \[\]\)\.filter\(\(item\) => item\.assetId !== id\);/);
  assert.match(remove!, /scene\.assetIds = \(scene\.assetIds \|\| \[\]\)\.filter\(\(value\) => value !== id\);/);
  assert.doesNotMatch(remove!, /length <= 1|length < 2|至少|保留一/,
    "no guard may refuse to remove the last asset of a scene");
  assert.match(clientSource, /该场景已无素材（Ctrl\+Z 可恢复）/,
    "removing the last asset has to say the scene is now empty and how to undo it");
  assert.match(clientSource, /也可按 Ctrl\+Z 撤销上一步素材操作/,
    "the empty state has to offer the undo path");
});

test("a request for a project that does not exist is a 404, not a bad request", async () => {
  /* The request handler answered 400 for every error it caught, so
     `GET /api/projects/<unknown>` reported "bad request" for a well-formed
     request whose only problem was that the resource is absent — while the job
     and asset routes answered 404 for exactly the same situation. */
  const source = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");
  // The class moved to its own module so the asset store can refuse an upload
  // with a status too; the router still has to import that one.
  const httpError = await readFile(resolve(root, "apps/studio/http-error.ts"), "utf8");
  assert.match(httpError, /export class HttpError extends Error \{/, "a status must be able to travel with the error");
  assert.match(httpError, /readonly status: number;/, "the carried status is part of the contract");
  assert.match(source, /import \{ HttpError \} from "\.\/http-error\.js";/);
  assert.match(source, /if \(!candidates\.length\) throw new HttpError\(404, `Project \$\{projectId\} not found`\);/,
    "a missing project has to say it is missing");
  assert.match(source, /const status = error instanceof HttpError \? error\.status : 400;/,
    "the top-level handler has to honour the carried status");
  assert.equal((source.match(/"Job not found"/g) ?? []).length, 3,
    "the sibling job routes must keep answering 404 as they already did");
});


