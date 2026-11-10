import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();

test("premium typography and mix tokens are enforced by the compositor", async () => {
  const source = await readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts"), "utf8");
  assert.match(source, /Noto Sans SC/);
  assert.match(source, /Roboto Flex/);
  assert.match(source, /isPortrait \? 50 : isSquare \? 44 : 46/);
  assert.match(source, /isPortrait \? 42 : isSquare \? 30 : 25/);
  // Subtitles sit 25% of the frame height above the bottom edge in every profile — the
  // distance is counted from that edge upward, and it names the line's own distance above
  // it. That is a composition choice (it replaced the 35.9% that tracked the Douyin collect
  // button), and the centre (not the box bottom) is what gets anchored.
  assert.match(source, /const subtitleBottomPercent = 25;/);
  assert.match(source, /const subtitleBottomPx = Math\.round\(profile\.height \* \(subtitleBottomPercent \/ 100\)\)/);
  assert.match(source, /\.subtitle\{[^}]*bottom:\$\{subtitleBottomPx\}px[^}]*transform:translate\(-50%,50%\)/);
  // 字幕不再有底纹药丸：Medium 字重 + 无边距底色，靠字影压住底图。
  assert.match(source, /font-weight:500/);
  assert.match(source, /\.subtitle-inner\{position:relative;display:inline-block;padding:0;border-radius:0;background:none;white-space:nowrap\}/);
  // 单行是硬约束：折行会让歌词式着色在换行处断开，所以 nowrap + 量宽缩字号兜底。
  assert.match(source, /;white-space:nowrap\}\.subtitle-inner\{/);
  assert.match(source, /const fitSubtitles = \(\) =>/);
  assert.match(source, /if \(document\.fonts && document\.fonts\.ready\)/);
  // 逐字点亮：同一句铺两层，wash 用 clip-path 从左往右擦出来，aria-hidden 防重复朗读。
  assert.match(source, /<span id="caption-wash-\$\{index\}" class="subtitle-wash" aria-hidden="true">/);
  // 金色层必须压在白字之上：两层文字重叠，wash 若没有 z-index 会被不透明的白字完全盖住，
  // 进度就永远看不见（实测 40% 进度整句仍是纯白）。
  // 墨层必须显式声明纯白：早期靠从 body 继承，漏一处就是黑字（实测踩过）。
  assert.match(source, /\.subtitle-ink\{[^}]*color:#fff\}/);
  assert.match(source, /\.subtitle-wash\{position:absolute;z-index:1;[^}]*clip-path:inset\(0 100% 0 0\)/);
  assert.match(source, /"#caption-wash-\$\{index\}",\{clipPath:"inset\(0 100% 0 0\)"\}/);
  assert.doesNotMatch(source, /background:rgba\(4,10,15,\.72\)/);
  assert.match(source, /GeoSubtitle/);
  assert.match(source, /data-volume="0\.2"/);
  assert.doesNotMatch(source, /<img class="brand-mark"/);
  assert.doesNotMatch(source, /id="topbar"/);
  assert.doesNotMatch(source, /\.topbar\{/);
  assert.match(source, /content\/visuals/);
  assert.match(source, /generated-illustrative/);
  assert.match(source, /visual-bg/);
  assert.doesNotMatch(source, /box-shadow:0 0 16px/);
});

test("portrait capture and visual identity contracts are wired end to end", async () => {
  const [capture, tokensRaw, logo] = await Promise.all([
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/capture-frames.ts"), "utf8"),
    readFile(resolve(root, "design/tokens.json"), "utf8"),
    readFile(resolve(root, "design/assets/geo-documentary-mark.png"))
  ]);
  const tokens = JSON.parse(tokensRaw) as {
    colors: { boundaryParent: string; boundarySelected: string; boundaryChild: string };
    boundary: { underlayVisibilityThreshold: number; underlayAlphaScale: number; underlayFadeExponent: number };
    motion: { boundaryRevealStyle: string };
    socialVideo: { primaryProfile: string; aspectRatio: string };
  };
  assert.match(capture, /profile=\$\{profileName\}/);
  assert.match(capture, /flightRestartIntervalSeconds = 0\.5/);
  assert.match(capture, /async function warmRestartFrame/);
  assert.match(capture, /for \(let pass = 0; pass < 3; pass \+= 1\)/);
  assert.match(capture, /restartedPng = await warmRestartFrame\(page, cdp, seconds\)/);
  assert.match(capture, /if \(restartedPng\) \{\s*png = restartedPng;/);
  assert.match(capture, /stop\.start \+ stop\.flightDuration/);
  assert.match(capture, /hasTourReturn \? \[\{ start: videoTourReturnStart, end: tourReturnEnd \}\] : \[\]/);
  assert.match(capture, /\[videoTourReturnStart, \(videoTourReturnStart \+ tourReturnEnd\) \/ 2, tourReturnEnd\]/);
  assert.match(capture, /Math\.floor\(range\.end \* fps\) \+ 1/);
  assert.match(capture, /openingSeconds = regionRecord\.openingDescent/);
  assert.match(capture, /videoTourStops = tourStops\.map/);
  assert.match(capture, /\{ start: 0, end: introDynamicEnd \}/);
  assert.match(capture, /openingSeconds > 0 \? \[\{ start: 0, duration: openingSeconds \}\] : \[\]/);
  assert.match(capture, /requestedEndTime !== undefined/);
  assert.equal(tokens.colors.boundaryParent, "#2D9CDB");
  assert.equal(tokens.colors.boundarySelected, "#FFD166");
  assert.equal(tokens.colors.boundaryChild, "#E8F0F5");
  assert.equal(tokens.boundary.underlayVisibilityThreshold, 0.68);
  assert.equal(tokens.boundary.underlayAlphaScale, 0.42);
  assert.equal(tokens.boundary.underlayFadeExponent, 1.5);
  assert.equal(tokens.motion.boundaryRevealStyle, "arc-length-paced-segmented-grounded-pen-draw");
  assert.equal(tokens.socialVideo.primaryProfile, "portrait");
  assert.equal(tokens.socialVideo.aspectRatio, "9:16");
  assert.ok(logo.byteLength > 100_000);
});

test("photo captions stay inside their measured narration cues during image crossfades", async () => {
  const source = await readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts"), "utf8");
  // DOM ids are unique per clip instance (a library asset may be scheduled into
  // several time windows), so figure/img/caption ids use the clip index while
  // the asset id is preserved in data-visual-id for diagnostics.
  assert.match(source, /id="visual-caption-\$\{index\}"/);
  assert.match(source, /data-visual-id="\$\{visual\.id\}"/);
  assert.match(source, /narrationOffset \+ visual\.cueStart/);
  assert.match(source, /narrationOffset \+ visual\.cueEnd/);
});

test("every image selected for the final film receives a visible compositor window", async () => {
  const [engine, compositor] = await Promise.all([
    readFile(resolve(root, "apps/studio/render-engine.ts"), "utf8"),
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts"), "utf8")
  ]);
  assert.match(engine, /selectionKey: `\$\{scene\.id\}:\$\{sequenceIndex\}:\$\{asset\.id\}`/);
  assert.match(compositor, /MINIMUM_RENDERED_VISUAL_SECONDS = 0\.5/);
  assert.match(compositor, /resolved\.length !== source\.length/);
  assert.match(compositor, /Selected visuals missing from composition/);
  assert.match(compositor, /Selected visuals have no visible video frame/);
  assert.match(compositor, /renderedForAtLeastOneFrame && staysInsideScene/);
  const goldenQa = await readFile(resolve(root, "apps/studio/golden-qa.ts"), "utf8");
  assert.match(goldenQa, /allSelectedVisualsRendered/);
  assert.match(goldenQa, /join\(input\.renderRoot, "renders", "diagnostics"/);
  assert.match(goldenQa, /selectedVisualCount\) === Number\(visualSync\.renderedVisualCount/);
  assert.match(goldenQa, /Number\(visual\.displayDurationSeconds\) >= 0\.5/);
  assert.match(engine, /runGoldenQa\(\{ root, jobRoot, renderRoot: sandbox/);
});

test("final delivery includes validated Douyin and Kuaishou publishing copy", async () => {
  const [skill, reference, script, cli, qa] = await Promise.all([
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/SKILL.md"), "utf8"),
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/references/social-publishing-copy.md"), "utf8"),
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/generate-publish-copy.ts"), "utf8"),
    readFile(resolve(root, "scripts/geo-video.ts"), "utf8"),
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/references/qa-checklist.md"), "utf8")
  ]);
  assert.match(skill, /Douyin and Kuaishou work descriptions/);
  assert.match(reference, /42–60 visible characters/);
  assert.match(script, /PUBLISH_COPY_READY/);
  assert.match(cli, /case "publish-copy"/);
  assert.match(qa, /## Publishing copy/);
});

test("runtime implements the world-to-region cloud-penetration opening", async () => {
  const source = await readFile(resolve(root, "apps/cesium-player/public/runtime.js"), "utf8");
  assert.match(source, /OPENING_DESCENT_DEFAULTS/);
  assert.match(source, /resolveOpeningDescent/);
  assert.match(source, /function descentCameraState/);
  assert.match(source, /const overviewHeight = Number\(overview\.height\) \* \(childTour \? PARENT_OVERVIEW_CAMERA_HEIGHT_SCALE : 1\)/);
  assert.match(source, /height: lerp\(cfg\.startHeightMeters, overviewHeight, heightProgress\)/);
  assert.match(source, /const approachDegrees = clamp\(/);
  assert.match(source, /lon: lerp\(startLon, Number\(overview\.lon\), eased\)/);
  assert.match(source, /startHeightMeters/);
  assert.match(source, /function openingCloudAlpha/);
  assert.match(source, /function openingCloudVeilAlpha/);
  assert.match(source, /function openingCloudDeckAlpha/);
  assert.match(source, /function buildOpeningClouds/);
  assert.match(source, /Cesium\.CloudCollection/);
  assert.match(source, /slice: spec\.slice/);
  assert.match(source, /cloudDeckHeightMeters/);
  assert.match(source, /function updateOpeningClouds/);
  assert.match(source, /cloudPassOverlay/);
  assert.match(source, /cloudDeckOverlay/);
  assert.match(source, /if \(openingDescent && time < openingDescent\.seconds\)/);
  assert.match(source, /presentationTime = openingDescent \? Math\.max\(0, time - openingDescent\.seconds\) : time/);
  assert.match(source, /showGroundAtmosphere = openingActive/);
});

test("child tour keeps the parent boundary but retires the parent name", async () => {
  const source = await readFile(resolve(root, "apps/cesium-player/public/runtime.js"), "utf8");
  // The two parent layers have opposite jobs, so they must not share a phase
  // input. The outline holds TOUR_PARENT_BOUNDARY_STRENGTH as quiet hierarchy
  // context for the whole village tour. The name is an opening-overview
  // treatment: it retires with the overview ramp as the first village flight
  // begins and never returns - not through the tour, not in the closing
  // overview - so it must not be clamped up to a floor or restored by a peak.
  assert.match(source, /const parentLabelStrength = parentNameStrengthAt\(\{/);
  assert.match(source, /overviewStrength: overviewParentLabelStrength/);
  assert.doesNotMatch(source, /TOUR_PARENT_LABEL_STRENGTH|tourFloor|overviewPeak/);
  assert.match(source, /const TOUR_PARENT_BOUNDARY_STRENGTH = 0\.82/);
  assert.match(source, /parentContextStrength[\s\S]*parentSettled && childTour \? TOUR_PARENT_BOUNDARY_STRENGTH : 0/);
  assert.doesNotMatch(source, /showTourParentLabel|PARENT_TOUR_LABEL_SCALE|PARENT_TOUR_LABEL_OFFSET_Y/);
});

test("parent and child administrative names use a restrained black outline without background masks", async () => {
  const source = await readFile(resolve(root, "apps/cesium-player/public/runtime.js"), "utf8");
  assert.match(source, /const PARENT_LABEL_OUTLINE = Cesium\.Color\.BLACK/);
  assert.match(source, /const CHILD_LABEL_OUTLINE = Cesium\.Color\.BLACK/);
  assert.match(source, /const PARENT_LABEL_FONT_SIZE = 86/);
  assert.match(source, /const CHILD_LABEL_FONT_SIZE = 56/);
  assert.match(source, /const STUDIO_PREVIEW_TYPOGRAPHY_SCALE/);
  assert.match(source, /Math\.max\(0\.1, Math\.min\(1, innerWidth \/ previewOutputWidth\)\)/);
  assert.match(source, /innerWidth \/ previewOutputWidth/);
  assert.match(source, /scaledTypographyPx\(PARENT_LABEL_FONT_SIZE\)/);
  assert.match(source, /scaledTypographyPx\(CHILD_LABEL_FONT_SIZE\)/);
  assert.match(source, /const LABEL_OUTLINE_WIDTH = 2\.8/);
  assert.match(source, /const LABEL_OUTLINE_MAX_ALPHA = 1;/);
  assert.match(source, /const LABEL_OUTLINE_ALPHA_RATIO = 1\.05/);
  assert.match(source, /const CHILD_LABEL_OUTLINE_WIDTH = 3\.4/);
  assert.match(source, /const CHILD_LABEL_OUTLINE_MAX_ALPHA = 1;/);
  assert.match(source, /const RETURN_CHILD_LABEL_OUTLINE_WIDTH = 5\.4/);
  assert.match(source, /const RETURN_CHILD_LABEL_OUTLINE_ALPHA_RATIO = 1\.45/);
  assert.match(source, /returnState\s*\? RETURN_CHILD_LABEL_OUTLINE_WIDTH\s*:\s*CHILD_LABEL_OUTLINE_WIDTH/);
  assert.match(source, /presentation\.alpha \* RETURN_CHILD_LABEL_OUTLINE_ALPHA_RATIO/);
  assert.match(source, /outlineWidth: Math\.max\(1\.25, scaledVisualPx\(LABEL_OUTLINE_WIDTH\)\)/);
  assert.match(source, /PARENT_LABEL_OUTLINE\.withAlpha\(readableLabelOutlineAlpha\(parentLabelStrength\)\)/);
  assert.match(source, /:\s*readableChildLabelOutlineAlpha\(presentation\.alpha\)\)\s*\n\s*\);/);
  assert.match(source, /const PARENT_LABEL_FILL = Cesium\.Color\.WHITE/);
  assert.match(source, /id: `parent-topic-label-\$\{region\.id\}`,[\s\S]*?showBackground:\s*false/);
  assert.match(source, /id: `child-label-\$\{featureId\}`,[\s\S]*?showBackground:\s*false/);
  assert.match(source, /id: `\$\{key\}-label-\$\{regionData\.id\}`,[\s\S]*?showBackground:\s*false/);
  assert.doesNotMatch(source, /parentTopicLabelMaskProperty/);
  assert.doesNotMatch(source, /childLabelMaskPropertiesById|CHILD_LABEL_MASK_MAX_ALPHA|backgroundColor:\s*labelMask/);
  assert.match(source, /setColorProperty\(property, PARENT_BOUNDARY\.withAlpha\(PARENT_FILL_ALPHA\)\)/);
});

test("return overview matches the opening parent-boundary treatment", async () => {
  const source = await readFile(resolve(root, "apps/cesium-player/public/runtime.js"), "utf8");
  assert.match(source, /const PARENT_OVERVIEW_BOUNDARY_STRENGTH = 1/);
  assert.match(source, /const RETURN_CHILD_BOUNDARY_ALPHA_SCALE = 0\.5/);
  assert.match(source, /const TOUR_PARENT_BOUNDARY_Z_INDEX = 100/);
  assert.match(source, /const RETURN_PARENT_BOUNDARY_Z_INDEX = 180/);
  assert.match(source, /const parentBoundaryZIndex = returnState/);
  assert.match(source, /returnState \? PARENT_OVERVIEW_BOUNDARY_STRENGTH : 0/);
  assert.match(source, /baseAlpha \* \(returnState \? RETURN_CHILD_BOUNDARY_ALPHA_SCALE : 1\)/);
  assert.match(source, /id: `parent-stable-[\s\S]*?underlayStrength: 0/);
  assert.match(source, /id: `parent-draw-[\s\S]*?underlayStrength: 0/);
});

test("parent boundary stays hidden through cloud descent and does not flash after tracing", async () => {
  const source = await readFile(resolve(root, "apps/cesium-player/public/runtime.js"), "utf8");
  assert.doesNotMatch(source, /parentStableBoundaryEntities\[index(?: \+ 1)?\]\.show/);
  assert.match(source, /const persistentRevealStrength = parentSettled \? parentContextStrength : 1/);
  // 交接必须是「Cesium 先上、画布后撤」：旧实现两层同帧互换，而 Cesium 的材质
  // 更新晚一帧提交，于是稳定帧两边都没画上（成片实测 6533 → 0 → 6171）。
  assert.match(source, /const BOUNDARY_HANDOFF_HOLD_SECONDS = 0\.1/);
  assert.match(source, /const canvasShare = editorParentPreviewHold \|\| !parentSettled/);
  assert.match(source, /viewSignature === editorBoundaryLastViewSignature/);
  assert.match(source, /const boundaryCanvasStrength = persistentRevealStrength \* canvasShare/);
  assert.match(source, /const cesiumRevealStrength = parentSettled \? persistentRevealStrength : 0/);
  assert.doesNotMatch(source, /editorTourParentBoundaryHold/);
  assert.match(source, /const segmentAlpha = localReveal > 0\.001 && cesiumRevealStrength > 0\.001/);
  assert.match(source, /for \(const property of parentStableBoundaryColorProperties\)[\s\S]*?PARENT_BOUNDARY\.withAlpha\(BOUNDARY_PREWARM_ALPHA\)/);
  assert.doesNotMatch(source, /const alpha = useEditorBoundaryCanvas \? BOUNDARY_PREWARM_ALPHA : 0\.96 \* cesiumRevealStrength/);
  assert.match(source, /const PARENT_LABEL_FADE_DURATION = 0\.28/);
  assert.match(source, /const parentLabelReveal = smootherStep\(rangeProgress\(/);
  assert.match(source, /revealStart \+ revealDuration \* 0\.8,\s*\n\s*PARENT_LABEL_FADE_DURATION/);
  assert.match(source, /PARENT_OVERVIEW_LABEL_STRENGTH \* parentOverviewStrength \* parentLabelReveal/);
});

test("formal narration uses premium voice, natural pauses, loudness QA, and draft-only SAPI", async () => {
  const source = await readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/generate-narration.ts"), "utf8");
  assert.match(source, /zh-CN-YunyangNeural/);
  assert.match(source, /normalizeEdgeTtsRate\(content\.voiceRate \?\? "-4%"\)/);
  assert.match(source, /return `\$\{percent >= 0 \? "\+" : ""\}\$\{percent\}%`/);
  assert.match(source, /function runEdgeTtsWithRetry[\s\S]*?attempt <= 3/);
  assert.match(source, /input = input\.replaceAll\(record\.term, record\.spokenForm\)/);
  assert.match(source, /restoreCanonicalPronunciations\(cue\.text, content\.pronunciations\)/);
  assert.match(source, /join\("\\n\\n"\)/);
  assert.match(source, /loudnorm=I=-16:TP=-1\.5:LRA=11/);
  assert.match(source, /Windows SAPI fallback is draft-only/);
  assert.match(source, /formalReleaseReady/);
});

test("subtitle preprocessing preserves provider sentences for one profile-aware semantic split", async () => {
  const source = await readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/generate-subtitles.py"), "utf8");
  assert.match(source, /for cue in parse_srt\(source\)/);
  assert.match(source, /provider-sentence-source/);
  assert.match(source, /content\.get\("subtitleProtectedPhrases", \[\]\)/);
  assert.doesNotMatch(source, /cues = split_single_line_cues\(parse_srt\(source\)/);
});

test("design source and skill document the grounded boundary contract", async () => {
  const [tokensRaw, nodeMapRaw, boundaryRules, skill] = await Promise.all([
    readFile(resolve(root, "design/tokens.json"), "utf8"),
    readFile(resolve(root, "design/figma-node-map.json"), "utf8"),
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/references/boundary-and-clean-presentation.md"), "utf8"),
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/SKILL.md"), "utf8")
  ]);
  const tokens = JSON.parse(tokensRaw) as { boundary: { grounded: boolean; forbidden: string[] }; motion: { path: string; parentRevealCamera: string } };
  const nodeMap = JSON.parse(nodeMapRaw) as { status: string; file: { fileKey: string }; components: Record<string, { figmaNodeId: string }> };
  assert.equal(tokens.boundary.grounded, true);
  assert.ok(tokens.boundary.forbidden.includes("altitude-offset"));
  assert.equal(tokens.motion.path, "ellipsoid-geodesic");
  assert.equal(tokens.motion.parentRevealCamera, "fixed");
  assert.equal(nodeMap.status, "connected");
  assert.equal(nodeMap.file.fileKey, "3o7fht8p72Aog2YnRzph5n");
  assert.equal(nodeMap.components["Boundary State"]?.figmaNodeId, "31:20");
  assert.match(boundaryRules, /Never use an altitude offset/);
  assert.match(skill, /Administrative boundaries are always grounded/);
});

test("skill enforces natural narration, Arabic digits, documentary images, and persistent boundaries", async () => {
  const [skill, narrative, evidence, boundary, qa, runtime] = await Promise.all([
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/SKILL.md"), "utf8"),
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/references/narrative-style.md"), "utf8"),
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/references/thematic-visual-evidence.md"), "utf8"),
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/references/boundary-and-clean-presentation.md"), "utf8"),
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/references/qa-checklist.md"), "utf8"),
    readFile(resolve(root, "apps/cesium-player/public/runtime.js"), "utf8")
  ]);
  assert.match(skill, /Arabic digits/);
  assert.match(narrative, /Write for the ear/);
  assert.match(evidence, /Reject government-work substitutes/);
  assert.match(evidence, /verified campus/);
  assert.match(boundary, /persistent scene context/);
  assert.match(qa, /Parent and context-child boundaries remain continuously visible/);
  assert.match(skill, /retain every previously introduced boundary and name/);
  assert.match(runtime, /const isVisited = Boolean\(tour && stopIndex !== undefined && stopIndex < tour\.index\)/);
  assert.match(runtime, /CHILD_BOUNDARY\.withAlpha\(alpha\)/);
  assert.match(runtime, /const touredChildIds = new Set/);
  assert.match(runtime, /supplementalChildIds\.has\(featureId\) && !touredChildIds\.has\(featureId\)/);
});

test("doctor reports where the Cesium Ion token comes from, and fails only when terrain needs it", async () => {
  /* doctor answered with Boolean(process.env.CESIUM_ION_TOKEN), while the player
     resolves the token from the environment first and then from
     config/project.yaml. A token supplied by the config file was therefore
     reported as missing. doctor also stayed green (exit 0) for a project whose
     terrain cannot load without a token, because nothing tied the two together. */
  const source = await readFile(resolve(root, "scripts/geo-video.ts"), "utf8");
  const body = /function doctor\(\): void \{[\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(body, "doctor must exist");
  assert.ok(body.includes('const ionTokenFromConfig = configScalar("cesium_ion_token");'),
    "the config file is a real source for the token, so doctor has to read it");
  assert.ok(body.includes('cesiumIonToken: ionTokenFromEnv ? "from CESIUM_ION_TOKEN" : ionTokenFromConfig ? "from config/project.yaml" : "absent"'),
    "the report must name the source instead of collapsing to a boolean");
  assert.ok(body.includes('const terrainNeedsIon = /^(world-terrain|ion:)/.test(terrainProvider);'),
    "terrain that is backed by Cesium Ion has to be recognised");
  assert.ok(body.includes("if (terrainUnserviceable) {"), "an unserviceable terrain must be reported, not swallowed");
  assert.ok(body.includes("terrainNeedsIon && !ionToken"), "an unserviceable terrain must also fail the exit code");
  assert.ok(!body.includes("cesiumIonToken: Boolean(process.env.CESIUM_ION_TOKEN)"),
    "the environment variable alone is not the whole answer");
});

