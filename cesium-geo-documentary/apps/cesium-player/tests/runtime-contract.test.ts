import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("Cesium map scenes keep branding and attribution chrome out of frame", async () => {
  const source = await readFile(resolve(process.cwd(), "apps/cesium-player/public/index.html"), "utf8");
  assert.doesNotMatch(source, /id="topline"/);
  assert.doesNotMatch(source, /id="sourceNote"/);
  assert.match(source, /\.cesium-viewer-bottom \{ display: none !important; \}/);
  assert.match(source, /#hud \{ display: none; \}/);
});

test("Cesium runtime exposes the deterministic render contract", async () => {
  const [source, tokensRaw] = await Promise.all([
    readFile(resolve(process.cwd(), "apps/cesium-player/public/runtime.js"), "utf8"),
    readFile(resolve(process.cwd(), "design/tokens.json"), "utf8")
  ]);
  const tokens = JSON.parse(tokensRaw) as {
    colors: { boundaryParent: string; fillParent: string };
    motion: {
      tourReturnSeconds: number;
      tourReturnSecondsRange: number[];
      childLabelRule: string;
      tourReturnAudioRule: string;
      childBoundaryHandoffRule: string;
    };
  };
  for (const method of ["initialize", "loadRegion", "seek", "playOpeningPreview", "renderFrame", "getFrameStatus", "getDiagnostics", "dispose"]) {
    assert.match(source, new RegExp(`\\b${method}\\b`));
  }
  assert.doesNotMatch(source, /Math\.random|Date\.now|setTimeout\s*\(/);
  assert.doesNotMatch(source, /clampToGround:\s*false/);
  assert.doesNotMatch(source, /polygon\.(?:height|extrudedHeight)\s*=/);
  assert.doesNotMatch(source, /fromDegrees\([^\n]*,\s*(?:500|520|600|750|760|780)\s*\)/);
  assert.match(source, /addGroundedBoundary/);
  assert.match(source, /zIndex:\s*mainZIndex/);
  assert.match(source, /child-selection-/);
  assert.match(source, /childSelectionColorPropertiesById/);
  assert.match(source, /const featureFillProperties = childFillPropertiesById\.get\(featureId\) \|\| \[\]/);
  assert.match(source, /featureFillProperties\.push\(colorProperty\)/);
  assert.match(source, /for \(const \[id, entities\] of childFillEntitiesById\.entries\(\)\)/);
  assert.match(source, /stableOverlayState\(strength, 0\.18, 0\.025\)/);
  assert.match(source, /entity\.show = overlay\.visible/);
  assert.doesNotMatch(source, /childFillPropertiesById\.set\(featureId,\s*colorProperty\)/);
  assert.match(source, /Cesium\.EllipsoidGeodesic/);
  assert.match(source, /phasedFlightHeight/);
  assert.match(source, /if \(!tour\) return selectedCamera/);
  assert.doesNotMatch(source, /selectedCamera\.height\s*\*\s*1\.32/);
  assert.match(source, /PARENT_BOUNDARY = Cesium\.Color\.fromCssColorString\("#2D9CDB"\)/);
  assert.doesNotMatch(source, /#8B1E1E/);
  assert.doesNotMatch(source, /#67D5D1/);
  assert.match(source, /SELECTED_BOUNDARY = Cesium\.Color\.fromCssColorString\("#FFD166"\)/);
  assert.match(source, /CHILD_BOUNDARY = Cesium\.Color\.fromCssColorString\("#E8F0F5"\)/);
  assert.match(source, /\(mainAlpha - 0\.68\) \/ 0\.32/);
  assert.match(source, /Math\.max\(BOUNDARY_PREWARM_ALPHA, Math\.pow\(synchronized, 1\.5\) \* 0\.42 \* underlayStrength\)/);
  assert.match(source, /id: `parent-stable-[\s\S]*?underlayStrength: 0/);
  assert.match(source, /id: `parent-draw-[\s\S]*?underlayStrength: 0/);
  assert.match(source, /const isVisited = Boolean\(tour && stopIndex !== undefined && stopIndex < tour\.index\)/);
  assert.doesNotMatch(source, /entity\.show = Boolean\(match && childStrength/);
  assert.match(source, /const firstTourStart = stops\.length > 0/);
  assert.match(source, /setColorProperty\(property, CHILD_BOUNDARY\.withAlpha\(alpha\)\)/);
  assert.doesNotMatch(source, /Cesium\.Color\.lerp\(base, SELECTED_BOUNDARY/);
  assert.match(source, /childSelectionEntitiesById/);
  assert.match(source, /selectionEntities\[index\]\.show = true/);
  assert.match(source, /selectionEntities\[index \+ 1\]\.show = true/);
  assert.match(source, /stableOverlayState\(strength, 0\.99, BOUNDARY_PREWARM_ALPHA\)/);
  assert.match(source, /new Cesium\.CallbackProperty/);
  assert.match(source, /const CHILD_BOUNDARY_Z_INDEX = 120/);
  assert.match(source, /const SELECTED_BOUNDARY_Z_INDEX = 160/);
  assert.match(source, /zIndex:\s*CHILD_BOUNDARY_Z_INDEX/);
  assert.match(source, /zIndex:\s*SELECTED_BOUNDARY_Z_INDEX/);
  assert.match(source, /PARENT_DRAW_SEGMENTS/);
  assert.match(source, /function partialPathAlongPath\(positions, progress\)/);
  assert.match(source, /const positionsProperty = new Cesium\.ConstantProperty\(segment\.positions\)/);
  assert.doesNotMatch(source, /positionsProperty\.setValue\(partialPathAlongPath\(segment\.positions, localReveal\)\)/);
  assert.match(source, /parent-pen-/);
  assert.match(source, /parent-stable-/);
  assert.match(source, /parentSettled = reveal >= 0\.999/);
  assert.doesNotMatch(source, /parentRevealEntities\[index(?: \+ 1)?\]\.show/);
  assert.doesNotMatch(source, /parentStableBoundaryEntities\[index(?: \+ 1)?\]\.show/);
  assert.doesNotMatch(source, /parent-beam-/);
  assert.doesNotMatch(source, /Cesium\.PolylineGlowMaterialProperty/);
  assert.doesNotMatch(source, /outsideMask|tipPaths|beamActive|flowPulse/);
  assert.match(source, /const BOUNDARY_PREWARM_ALPHA = 0\.001/);
  assert.match(source, /parentBoundaryColor\.alpha/);
  assert.match(source, /visible: parentStableBoundaryEntities\.every\(\(entity\) => entity\.show !== false\)/);
  assert.match(source, /function drawEditorBoundaryReveal\(reveal, drawLayerStrength, force = false\)/);
  assert.match(source, /function renderedGlobeTileCount\(\)/);
  assert.match(source, /const effectiveTimeoutMs = studioPreview \? Math\.min\(timeoutMs, 20000\) : timeoutMs/);
  assert.match(source, /if \(studioPreview\) \{\s*previewImageryFallback = true;\s*renderStable = true;\s*viewer\.scene\.requestRender\(\);\s*return;/);
  assert.match(source, /if \(studioPreview && hasVisibleImagery\)[\s\S]*?visiblePasses >= 6 && now - visibleSince >= 180[\s\S]*?renderStable = true;\s*return;/);
  assert.match(source, /query\.has\("studioPreview"\) && previewImageryFallback/);
  assert.doesNotMatch(source, /studioPreview && renderedGlobeTileCount\(\) > 0/);
  assert.match(source, /viewer\.scene\.globe\.maximumScreenSpaceError = studioPreview \? 1\.5 : 1\.0/);
  assert.match(source, /viewer\.scene\.globe\.preloadAncestors = !studioPreview/);
  assert.match(source, /viewer\.scene\.globe\.preloadSiblings = !studioPreview/);
  assert.match(source, /Cesium\.SceneTransforms\.worldToWindowCoordinates/);
  assert.match(source, /const persistentRevealStrength = parentSettled \? parentContextStrength : 1/);
  // 画笔 → Cesium 的交接：Cesium 那层先在稳定帧升到全量，画布再顶
  // BOUNDARY_HANDOFF_HOLD_SECONDS 才撤。旧写法两层同帧互换，会在稳定帧留下一个
  // 空洞（成片实测 6533 → 0 → 6171 边界像素，见 runtime-contract 里那条专门的测试）。
  assert.match(source, /const BOUNDARY_HANDOFF_HOLD_SECONDS = 0\.1/);
  assert.match(source, /const canvasShare = editorParentPreviewHold \|\| !parentSettled/);
  assert.match(source, /const boundaryCanvasStrength = persistentRevealStrength \* canvasShare/);
  assert.match(source, /const cesiumRevealStrength = parentSettled \? persistentRevealStrength : 0/);
  assert.doesNotMatch(source, /editorTourParentBoundaryHold/);
  assert.match(source, /editorBoundaryPendingReveal = reveal;\s*editorBoundaryPendingStrength = boundaryCanvasStrength/);
  assert.match(source, /const parentContextStrength = Math\.max\(/);
  assert.match(source, /const TOUR_PARENT_BOUNDARY_STRENGTH = 0\.82/);
  assert.match(source, /const PARENT_OVERVIEW_BOUNDARY_STRENGTH = 1/);
  assert.match(source, /parentSettled && childTour \? TOUR_PARENT_BOUNDARY_STRENGTH : 0/);
  assert.match(source, /for \(const property of parentStableBoundaryColorProperties\)[\s\S]*?PARENT_BOUNDARY\.withAlpha\(BOUNDARY_PREWARM_ALPHA\)/);
  assert.doesNotMatch(source, /const alpha = useEditorBoundaryCanvas \? BOUNDARY_PREWARM_ALPHA : 0\.96 \* cesiumRevealStrength/);
  assert.match(source, /const segmentAlpha = localReveal > 0\.001 && cesiumRevealStrength > 0\.001/);
  assert.match(source, /const PARENT_LABEL_FADE_DURATION = 0\.28/);
  assert.match(source, /const parentLabelReveal = smootherStep\(rangeProgress\(/);
  assert.match(source, /revealStart \+ revealDuration \* 0\.8,\s*\r?\n\s*PARENT_LABEL_FADE_DURATION/);
  assert.match(source, /PARENT_OVERVIEW_LABEL_STRENGTH \* parentOverviewStrength \* parentLabelReveal/);
  assert.match(source, /function addGroundedBoundary[\s\S]*?clampToGround: true/);
  assert.match(source, /const PARENT_BOUNDARY_WIDTH = 3\.5;/);
  assert.match(source, /const STUDIO_PREVIEW_VISUAL_SCALE/);
  // Grounded weights stay at their authored values for every shipped profile and
  // only scale up for a higher-resolution master. Never shrink below 1 and never
  // double-apply inside the Studio preview.
  assert.match(source, /const OUTPUT_RESOLUTION_SCALE = location\.search\.includes\("studioPreview="\)/);
  assert.match(source, /Math\.max\(1, Math\.min\(4, innerWidth \/ previewOutputWidth\)\)/);
  assert.match(source, /value \* STUDIO_PREVIEW_VISUAL_SCALE \* OUTPUT_RESOLUTION_SCALE/);
  // The base imagery layer is graded so the boundary hierarchy keeps a
  // predictable contrast across regions and providers.
  assert.match(source, /const VISUAL_GRADE_DEFAULTS = \{/);
  assert.match(source, /baseLayer\.brightness = visualGrade\.imageryBrightness/);
  assert.match(source, /baseLayer\.saturation = visualGrade\.imagerySaturation/);
  assert.match(source, /const STUDIO_PREVIEW_TYPOGRAPHY_SCALE = location\.search\.includes\("studioPreview="\)[\s\S]*?Math\.max\(0\.1, Math\.min\(1, innerWidth \/ previewOutputWidth\)\)/);
  assert.match(source, /const PARENT_DRAW_WIDTH = 3\.5;/);
  assert.match(source, /const PARENT_UNDERLAY_WIDTH = 7;/);
  assert.match(source, /const CHILD_UNDERLAY_WIDTH = 4;/);
  assert.match(source, /const SUPPLEMENTAL_BOUNDARY_WIDTH = 1\.5;/);
  assert.doesNotMatch(source, /PARENT_HALO_WIDTH|PARENT_FLOW_WIDTH|PARENT_CORE_WIDTH|PARENT_ORBIT/);
  assert.doesNotMatch(source, /extrudedHeight: PARENT_RELIEF_HEIGHT_METERS/);
  assert.doesNotMatch(source, /function updateCinematicBloom/);
  assert.match(source, /postProcessStages\.bloom\.enabled = false/);
  assert.match(source, /Math\.abs\(reveal - editorBoundaryLastReveal\) < 1 \/ 45/);
  assert.match(source, /viewSignature === editorBoundaryLastViewSignature/);
  assert.match(source, /drawLayerStrength <= 0\.001/);
  assert.match(source, /context\.shadowBlur = 0/);
  assert.match(source, /rgba\(45, 156, 219, \$\{0\.96 \* drawLayerStrength\}\)/);
  assert.match(source, /currentTime = 0;[\s\S]*?updateScene\(0\);[\s\S]*?buildOpeningClouds\(\)/);
  assert.doesNotMatch(source, /movingWindowAlongClosedPath|parent-orbit-/);
  assert.match(source, /orbitHoldSeconds/);
  assert.match(source, /scaledVisualPx\(PARENT_DRAW_WIDTH\)/);
  assert.match(source, /const CHILD_BOUNDARY_WIDTH = 2;/);
  assert.match(source, /const TOUR_PARENT_BOUNDARY_Z_INDEX = 100/);
  assert.match(source, /const RETURN_PARENT_BOUNDARY_Z_INDEX = 180/);
  assert.match(source, /zIndex: TOUR_PARENT_BOUNDARY_Z_INDEX/);
  assert.match(source, /const parentBoundaryZIndex = returnState[\s\S]*RETURN_PARENT_BOUNDARY_Z_INDEX[\s\S]*TOUR_PARENT_BOUNDARY_Z_INDEX/);
  assert.match(source, /setNumberProperty\(parentStableBoundaryEntities\[index \+ 1\]\.polyline\.zIndex, parentBoundaryZIndex \+ 1\)/);
  assert.match(source, /const SELECTED_BOUNDARY_WIDTH = 4;/);
  assert.match(source, /const SELECTED_UNDERLAY_WIDTH = 8;/);
  assert.match(source, /const PARENT_LABEL_FONT_SIZE = 86/);
  assert.match(source, /const CHILD_LABEL_FONT_SIZE = 56/);
  assert.match(source, /font: `500 \$\{scaledTypographyPx\(CHILD_LABEL_FONT_SIZE\)\}px "Noto Sans SC"/);
  assert.match(source, /font: `600 \$\{scaledTypographyPx\(CHILD_LABEL_FONT_SIZE\)\}px "Noto Sans SC"/);
  assert.match(source, /font: `600 \$\{scaledTypographyPx\(PARENT_LABEL_FONT_SIZE\)\}px "Noto Sans SC"/);
  assert.match(source, /const PARENT_LABEL_OUTLINE = Cesium\.Color\.BLACK/);
  assert.match(source, /const CHILD_LABEL_OUTLINE = Cesium\.Color\.BLACK/);
  assert.match(source, /const LABEL_OUTLINE_WIDTH = 2\.8/);
  assert.match(source, /const CHILD_LABEL_OUTLINE_WIDTH = 3\.4/);
  assert.match(source, /const PARENT_BOUNDARY_WIDTH = 3\.5;/);
  assert.match(source, /const CHILD_BOUNDARY_WIDTH = 2;/);
  assert.match(source, /viewer\.scene\.postRender\.addEventListener\(\(\) => \{\s*drawEditorBoundaryReveal\(editorBoundaryPendingReveal, editorBoundaryPendingStrength, true\)/);
  assert.match(source, /const LABEL_OUTLINE_MAX_ALPHA = 1/);
  assert.match(source, /const LABEL_OUTLINE_ALPHA_RATIO = 1\.05/);
  assert.match(source, /const readableLabelOutlineAlpha = \(fillAlpha\) =>/);
  assert.match(source, /const readableChildLabelOutlineAlpha = \(fillAlpha\) =>/);
  assert.match(source, /outlineWidth: Math\.max\(1\.25, scaledVisualPx\(LABEL_OUTLINE_WIDTH\)\)/);
  assert.match(source, /outlineWidth: Math\.max\(1\.5, scaledVisualPx\(CHILD_LABEL_OUTLINE_WIDTH\)\)/);
  assert.match(source, /PARENT_LABEL_OUTLINE\.withAlpha\(readableLabelOutlineAlpha\(parentLabelStrength\)\)/);
  assert.match(source, /CHILD_LABEL_OUTLINE\.withAlpha\(returnState[\s\S]*?readableChildLabelOutlineAlpha\(presentation\.alpha\)\)/);
  assert.match(source, /const PARENT_LABEL_FILL = Cesium\.Color\.WHITE/);
  assert.match(source, /id: `parent-topic-label-\$\{region\.id\}`,[\s\S]*?showBackground:\s*false/);
  assert.match(source, /id: `child-label-\$\{featureId\}`,[\s\S]*?showBackground:\s*false/);
  assert.match(source, /id: `\$\{key\}-label-\$\{regionData\.id\}`,[\s\S]*?showBackground:\s*false/);
  assert.doesNotMatch(source, /parentTopicLabelMaskProperty/);
  assert.doesNotMatch(source, /childLabelMaskPropertiesById|CHILD_LABEL_MASK_MAX_ALPHA|backgroundColor:\s*labelMask/);
  // The parent overview fill is a static terrain-classified surface: the alpha
  // is a named constant tied to tokens.colors.fillParent, written at load and
  // left alone afterwards so it cannot rebuild ground batches.
  assert.match(source, /const PARENT_FILL_ALPHA = 0\.09/);
  assert.match(source, /fill: PARENT_BOUNDARY\.withAlpha\(PARENT_FILL_ALPHA\)/);
  assert.match(source, /setColorProperty\(property, PARENT_BOUNDARY\.withAlpha\(PARENT_FILL_ALPHA\)\)/);
  assert.doesNotMatch(source, /PARENT_BOUNDARY\.withAlpha\(0\)/);
  assert.match(source, /childLabelPositionsById\.set\(featureId, position\)/);
  // The parent *boundary* has to stay on screen for the whole village tour; the
  // parent *name* has to do the opposite. The name is an opening-overview
  // treatment - it introduces the region, retires with the overview ramp as the
  // first village flight begins, and never comes back, including the closing
  // overview. It therefore has no tour floor and no closing peak, and the call
  // site must not feed it one.
  assert.match(source, /const parentLabelStrength = parentNameStrengthAt\(\{/);
  assert.match(source, /overviewStrength: overviewParentLabelStrength/);
  assert.doesNotMatch(source, /tourFloor|TOUR_PARENT_LABEL_STRENGTH|overviewPeak/);
  assert.match(source, /const PARENT_OVERVIEW_LABEL_STRENGTH = 0\.9/);
  assert.doesNotMatch(source, /showTourParentLabel|PARENT_TOUR_LABEL_SCALE|PARENT_TOUR_LABEL_OFFSET_Y/);
  assert.doesNotMatch(source, /RETURN_PARENT_LABEL_REVEAL_START/);
  assert.doesNotMatch(source, /const returnParentLabelStrength = returnState/);
  assert.match(source, /const overviewParentLabelStrength = parentLabelStrengthAt\(\s*PARENT_OVERVIEW_LABEL_STRENGTH \* parentOverviewStrength \* parentLabelReveal\s*\)/);
  // Child labels respond to camera distance and are deconflicted on every
  // frame. The old return-only pass let neighbouring village names stack up
  // while the tour was still flying.
  assert.match(source, /function declutterChildLabels\(candidates\)/);
  assert.match(source, /function childLabelScreenBox\(id, authoredScale, rank\)/);
  assert.match(source, /const declutteredLabelIds = labelDistanceOptions\.declutter/);
  assert.match(source, /state\.presentation\.visible && declutteredLabelIds\.has\(key\)/);
  assert.match(source, /scaleByDistance: labelScaleByDistance\(\)/);
  assert.match(source, /translucencyByDistance: labelTranslucencyByDistance\(\)/);
  assert.match(source, /const LABEL_SCALE_NEAR_VALUE = 1\.1/);
  assert.match(source, /function resolveLabelReferenceDistance\(\)/);
  assert.doesNotMatch(source, /declutteredReturnLabelIds/);
  assert.doesNotMatch(source, /const returnVisibleLabelIds = returnState/);
  assert.match(source, /const parentContextStrength = Math\.max\([\s\S]*?returnState \? PARENT_OVERVIEW_BOUNDARY_STRENGTH : 0/);
  assert.doesNotMatch(source, /RETURN_PARENT_BOUNDARY_STRENGTH/);
  assert.match(source, /declutteredLabelIds\.has\(key\)/);
  assert.match(source, /regionData\.cameraProfiles\?\.\[profileName\]/);
  assert.match(source, /portraitChildCameraScale/);
  assert.match(source, /stop\?\.cameraProfiles\?\.\[profileName\]/);
  assert.match(source, /id: `child-label-\$\{featureId\}`,[\s\S]*?show:\s*false,[\s\S]*?position:/);
  assert.match(source, /tourLabelPresentationAt\(time, tour, returnState, stop, stopIndex\)/);
  assert.match(source, /presentation\.scale \* returnLabelScale/);
  assert.match(source, /labelEntity\.show = visible/);
  assert.match(source, /configuredStop\?\.name \?\? feature\.properties\?\.name/);
  assert.match(source, /function applyTourStopLabelNames\(stops = \[\]\)/);
  assert.match(source, /action === "update-tour-labels"/);
  // The editor must install the child-tour context before it previews anything.
  // An export materialises the region as `parent-child-tour`, which is what
  // applies PARENT_OVERVIEW_CAMERA_HEIGHT_SCALE to the overview camera; without
  // the early configuration the editor parks the opening frame on the raw preset
  // range and the first village flight reads as a camera jump.
  assert.match(source, /action === "prepare-tour"\) configureStudioTour\(event\.data\.preview/);
  assert.match(source, /prepareStudioTour: configureStudioTour/);
  assert.match(source, /childLabelScalePropertiesById/);
  assert.doesNotMatch(source, /distanceDisplayCondition/);
  assert.match(source, /visibleChildLabelIds/);
  assert.doesNotMatch(source, /childLabelColorProperties\b/);
  assert.match(source, /TOUR_RETURN_DURATION_SECONDS = 4\.4/);
  assert.match(source, /TOUR_RETURN_MIN_SECONDS = 3\.8/);
  assert.match(source, /TOUR_RETURN_MAX_SECONDS = 5\.0/);
  assert.match(source, /function tourReturnStateAt\(time\)/);
  assert.match(source, /region\?\.tourReturnStart \?\? region\?\.tourOutroStart/);
  assert.match(source, /if \(returnState\.rawProgress >= 0\.999\) return selectedCamera/);
  assert.match(source, /return geodesicCameraState\(tourStopCamera\(returnState\.last\), selectedCamera, returnState\.rawProgress\)/);
  assert.match(source, /silentDuringMovement: region\?\.tourReturnSilent !== false/);
  assert.match(source, /closingNarrationAllowed/);
  assert.match(source, /event\.data\.action === "play-opening"/);
  assert.match(source, /event\.data\.action === "show-tour-frame"/);
  assert.match(source, /async function showStudioTourFrame/);
  assert.match(source, /showStudioTourFrame[\s\S]*?const openingSeconds = openingDescent \? openingDescent\.seconds : 0;[\s\S]*?seek\(openingSeconds \+ Math\.max/);
  assert.match(source, /function playStudioTourSegment/);
  assert.match(source, /function playStudioTourOutro/);
  assert.match(source, /action === "play-tour-outro"/);
  assert.match(source, /action === "play-tour-segment"/);
  assert.match(source, /segmentStart \+ \(now - startedAt\) \/ 1000/);
  assert.match(source, /event: "tour-flight-complete"/);
  assert.match(source, /segmentStart \+ Number\(stop\.flightDuration \|\| 0\)/);
  assert.match(source, /region\.tourReturnSilent = true/);
  assert.match(source, /region\.tourReturnDurationSeconds = clamp/);
  assert.match(source, /const baseOpening = openingDescent \?\? \{/);
  assert.match(source, /\.\.\.OPENING_DESCENT_DEFAULTS/);
  assert.match(source, /startHeightMeters: Math\.max\(800000/);
  assert.match(source, /const overviewHeight = Number\(overview\.height\) \* \(childTour \? PARENT_OVERVIEW_CAMERA_HEIGHT_SCALE : 1\)/);
  assert.match(source, /height: lerp\(cfg\.startHeightMeters, overviewHeight, heightProgress\)/);
  // The first village flight leaves from the settled parent overview, i.e. the
  // camera that is already on screen. Resolving the raw overview preset there
  // skipped PARENT_OVERVIEW_CAMERA_HEIGHT_SCALE and snapped the first frame of
  // the tour 10 % of the preset range outward (乌石镇 portrait: 29 097 m instead
  // of 26 187 m) before the flight eased back in.
  const originBlock = source
    .split("// ---- child-tour flight origin (pure, test-extractable) --------------------")[1]
    ?.split("// ---- end child-tour flight origin ----------------------------------------")[0];
  assert.ok(originBlock, "the child-tour flight origin must stay extractable between its markers");
  const tourFlightOriginCamera = new Function(`${originBlock}
    return tourFlightOriginCamera;`)() as (
    previousStopCamera: unknown,
    parentOverviewCamera: unknown
  ) => unknown;
  const stopCamera = { lon: 109.9164, lat: 20.6115, height: 7417, heading: 0, pitch: -64 };
  const overviewCamera = { lon: 109.8717, lat: 20.5645, height: 29097 * 0.9, heading: 0, pitch: -64 };
  assert.equal(tourFlightOriginCamera(stopCamera, overviewCamera), stopCamera, "later legs leave the previous village");
  assert.equal(tourFlightOriginCamera(null, overviewCamera), overviewCamera, "the first leg leaves the on-screen overview");
  assert.match(source, /tourFlightOriginCamera\(\s*tour\.previous \? tourStopCamera\(tour\.previous\) : null,\s*selectedCamera\s*\)/);
  // `selectedCamera` is the scaled overview; the flight must not reach for the
  // unscaled preset again.
  assert.doesNotMatch(source, /heightScale/, "the tour flight must not resolve camera heights from a raw preset");
  assert.match(source, /new Cesium\.CloudCollection\(\{ noiseDetail: 16 \}\)/);
  assert.match(source, /cloud\.parallaxLayer = spec\.altitudeKm >= 4 \? "far"/);
  assert.match(source, /layer === "near" \? 0\.11 : layer === "mid" \? 0\.065 : 0\.035/);
  assert.match(source, /const volumeStrength = layer === "near" \? 0\.012 : layer === "mid" \? 0\.18 : 0\.22/);
  assert.match(source, /viewer\.scene\.fog\.density = 0\.00022 \+ veil \* 0\.00072/);
  assert.match(source, /cesiumContainer\.style\.filter = `brightness/);
  assert.match(source, /if \(raw < 0\.72\) return 0\.58/);
  assert.match(source, /const editorFastPreview = overrides\.editorFastPreview === true/);
  assert.match(source, /if \(editorParentPreviewHold\) return selectedCamera/);
  assert.match(source, /const skipDescent = editorFastPreview && overrides\.skipDescent !== false/);
  assert.match(source, /duration: clamp\(Number\(overrides\.revealSeconds \?\? 1\.4\)/);
  assert.match(source, /currentTime = skipDescent \? openingDescent\.seconds \+ elapsed : elapsed/);
  assert.match(source, /currentTime = openingDescent\.seconds \+ editorSettledHoldOffset\(\)/);
  assert.match(source, /parentRevealTimingOverride = null/);
  assert.match(source, /parentSettled\s*\?\s*\(editorParentPreviewHold \? 1/);
  assert.match(source, /previewAnimationFrame = requestAnimationFrame\(tick\)/);
  assert.equal(tokens.colors.boundaryParent, "#2D9CDB");
  assert.equal(tokens.colors.fillParent, "rgba(45, 156, 219, 0.09)");
  assert.equal(tokens.motion.tourReturnSeconds, 4.4);
  assert.deepEqual(tokens.motion.tourReturnSecondsRange, [3.8, 5]);
  assert.equal(tokens.motion.childLabelRule, "visited-tour-units-persist-current-emphasized");
  assert.equal(tokens.motion.tourReturnAudioRule, "silent-during-movement-closing-after-exact-camera-lock");
  assert.equal(tokens.motion.childBoundaryHandoffRule, "stable-context-lines-callback-selection-no-zero-alpha-material-writes");
});

test("MultiPolygon child regions retain every Cesium fill entity", async () => {
  const [source, childGeometryRaw] = await Promise.all([
    readFile(resolve(process.cwd(), "apps/cesium-player/public/runtime.js"), "utf8"),
    readFile(resolve(process.cwd(), "data/normalized/440825112-children.geojson"), "utf8")
  ]);
  const childGeometry = JSON.parse(childGeometryRaw) as {
    features: Array<{ properties?: { id?: string }; geometry?: { type?: string; coordinates?: unknown[] } }>;
  };
  const xinfeng = childGeometry.features.find((feature) => feature.properties?.id === "440825112203");
  assert.equal(xinfeng?.geometry?.type, "MultiPolygon");
  assert.equal(xinfeng?.geometry?.coordinates?.length, 2);
  assert.match(source, /featureFillProperties\.push\(colorProperty\)/);
  assert.match(source, /featureFillEntities\.push\(entity\)/);
  assert.match(source, /stableOverlayState\(strength, 0\.18, 0\.025\)/);
  assert.match(source, /for \(const entity of entities\) entity\.show = overlay\.visible/);
  assert.doesNotMatch(source, /setColorProperty\(property, SELECTED_BOUNDARY\.withAlpha\(0\.18 \* strength\)\)/);
});

test("Cesium runtime keeps the focus mask, terrain and named features inside the boundary contract", async () => {
  const source = await readFile(resolve(process.cwd(), "apps/cesium-player/public/runtime.js"), "utf8");
  // Out-of-region focus mask: inverse polygon with the region punched out, low
  // alpha, terrain-classified. It must stay a single grounded classification
  // surface so it cannot rebuild ground batches or occlude the imagery.
  assert.match(source, /const FOCUS_MASK_COLOR = Cesium\.Color\.fromCssColorString\("#021018"\)/);
  assert.match(source, /const FOCUS_MASK_DEFAULTS = \{ enabled: true, alpha: 0\.24/);
  assert.match(source, /function resolveFocusMaskBounds\(expansion\)/);
  assert.match(source, /new Cesium\.PolygonHierarchy\(outer, holes\)/);
  assert.match(source, /classificationType: Cesium\.ClassificationType\.TERRAIN/);
  assert.match(source, /setColorProperty\(focusMaskColorProperty, FOCUS_MASK_COLOR\.withAlpha\(/);
  // The recession ramp must be anchored to the settle moment. Scheduling it
  // inside the trace let it run part-way while the parentSettled gate was still
  // shut, so the mask popped on at a mid-ramp alpha instead of easing from zero.
  assert.match(source, /const revealSettle = parentRevealTimingOverride\?\.settle \?\? PARENT_SETTLE_DURATION;/);
  assert.match(source, /const focusMaskRampStart = revealStart \+ revealDuration \+ revealSettle;/);
  assert.match(source, /rangeProgress\(time, focusMaskRampStart, focusMaskOptions\.fadeSeconds\)/);
  assert.doesNotMatch(source, /focusMaskOptions\.alpha \* rangeProgress\(time, revealStart \+ revealDuration \* 0\.7/);
  assert.match(source, /fadeSeconds: 3\.6 \}/);
  // Terrain is a config/query switch and must degrade to the ellipsoid instead
  // of blanking the map when the provider is unreachable.
  assert.match(source, /async function createTerrainProvider\(runtimeConfig\)/);
  assert.match(source, /Cesium\.CesiumTerrainProvider\.fromIonAssetId\(assetId/);
  assert.match(source, /Cesium\.ArcGISTiledElevationTerrainProvider\.fromUrl\(/);
  assert.match(source, /Cesium\.CesiumTerrainProvider\.fromUrl\(requested\.slice\("url:"\.length\)\)/);
  assert.match(source, /new Cesium\.EllipsoidTerrainProvider\(\)/);
  assert.match(source, /query\.get\("terrain"\) \|\| terrainConfig\.provider \|\| "ellipsoid"/);
  assert.match(source, /terrainProvider: terrain\.provider/);
  assert.match(source, /errors\.push\("terrain-unavailable: cesium ion token missing"\)/);
  assert.doesNotMatch(source, /terrainProvider: new Cesium\.EllipsoidTerrainProvider\(\),/);
  // Elevation must stay a rendering choice only: neither the boundary geometry
  // nor any entity gains an altitude offset when real terrain is enabled.
  assert.doesNotMatch(source, /positions.*ellipsoid.*height\s*\+=/);
  assert.doesNotMatch(source, /sampledHeight|terrainHeightAt/);
  // Named features read verified geometry from data/features and sweep once
  // along their own arc length. They never re-trace or pulse.
  assert.match(source, /async function buildNamedFeatureLayers\(regionData\)/);
  assert.match(source, /await fetch\(withDataVersion\(`\/data\/features\/\$\{encodeURIComponent\(id\)\}\.geojson`\)\)/);
  assert.match(source, /const FEATURE_RIVER_COLOR = Cesium\.Color\.fromCssColorString\("#4AA8FF"\)/);
  assert.match(source, /const localReveal = clamp\(\(presentation\.reveal - segment\.startProgress\) \/ duration, 0, 1\)/);
  assert.match(source, /String\(item\.type\) === "revealNamedFeature" && String\(item\.target\) === id/);
  assert.match(source, /zIndex: FEATURE_Z_INDEX/);
  assert.match(source, /const FEATURE_Z_INDEX = 60/);
  assert.doesNotMatch(source, /featureOrbit|featurePulse|featureBeam/);
  // GeoJSON reaches the runtime both as a FeatureCollection (region geometry)
  // and as a single Feature (one named reach). Reading collection.features
  // directly made the single-Feature case iterate nothing, so the river was
  // fetched, accepted, and then silently never drawn.
  assert.match(source, /function featureList\(collection\) \{/);
  assert.match(source, /if \(collection\.type === "Feature"\) return \[collection\];/);
  assert.match(source, /const features = featureList\(collection\);/);
  assert.match(source, /errors\.push\(`named-feature-empty: \$\{id\}`\)/);
  assert.doesNotMatch(source, /for \(const feature of collection\.features \|\| \[\]\)/);
  // Diagnostics must report the layer that is actually painted, not only the
  // prewarmed complete-ring primitive that always sits at 0.001.
  assert.match(source, /paintAlpha: parentPaintAlpha/);
  assert.match(source, /visibleSegmentCount: parentVisibleSegments/);
  assert.match(source, /terrainProvider: activeTerrainLabel/);
  assert.match(source, /visibleLabelBoxes/);
  assert.match(source, /overlappedLabelPairs/);
  // getDiagnostics() closes over module scope. Keeping the resolved runtime
  // config inside initialize() made every diagnostics call throw a
  // ReferenceError, which silently hid the whole report.
  assert.match(source, /let runtimeConfig = \{\};/);
  assert.match(source, /runtimeConfig = \{ \.\.\.publicImageryConfig, \.\.\.serverRuntimeConfig \};/);
  assert.doesNotMatch(source, /const runtimeConfig = \{ \.\.\.publicImageryConfig/);
});

test("the focus mask is sized against the camera footprint, not only the bounding box", async () => {
  const [source, regionRaw] = await Promise.all([
    readFile(resolve(process.cwd(), "apps/cesium-player/public/runtime.js"), "utf8"),
    readFile(resolve(process.cwd(), "data/regions/440823105.json"), "utf8")
  ]);
  // The overview camera is applied as lookAt(target, HeadingPitchRange(heading,
  // pitch, range)) on the region centre, so the visible ground is a trapezoid
  // whose far edge is the wide one. Sizing the mask against the bounding box
  // alone let its own left and right edges enter frame as two straight,
  // geographically meaningless seams on a portrait-tall region shot landscape.
  assert.match(source, /const FOCUS_MASK_FRUSTUM_FOV_DEGREES = 60/);
  assert.match(source, /const FOCUS_MASK_FRAME_ASPECTS = \{ landscape: 1920 \/ 1080, portrait: 1080 \/ 1920, square: 1 \}/);
  assert.match(source, /const FOCUS_MASK_FOOTPRINT_MARGIN = 1\.25/);
  assert.match(source, /function frameGroundFootprintCorners\(rangeMeters, pitchDegrees, headingDegrees, aspectRatio, fovDegrees\)/);
  assert.match(source, /function focusMaskFrameFootprint\(\)/);
  assert.match(source, /const frameFootprint = focusMaskFrameFootprint\(\);/);
  assert.match(source, /const bounds = coverFocusMaskBounds\(floorBounds, frameFootprint\);/);
  assert.match(source, /focusMaskResolved = \{ bounds, holes: holes\.length, alpha: 0, frameFootprint \}/);
  assert.match(source, /frameFootprint: focusMaskResolved\.frameFootprint/);
  assert.match(source, /Array\.isArray\(region\?\.bbox\)/);
  // Execute the shipped maths instead of pattern-matching it. The block closes over
  // exactly one runtime constant, CAMERA_PITCH, so hand it the shipped literal
  // rather than a copy that could drift.
  const mathsBlock = source
    .split("// ---- focus mask frame footprint maths (pure, test-extractable) ------------")[1]
    ?.split("// ---- end focus mask frame footprint maths ---------------------------------")[0];
  assert.ok(mathsBlock, "the focus mask footprint maths must stay extractable between its markers");
  const cameraPitchLiteral = source.match(/const CAMERA_PITCH = (-?[\d.]+);/);
  assert.ok(cameraPitchLiteral, "CAMERA_PITCH must stay a literal the extracted maths can be handed");
  const maths = new Function("CAMERA_PITCH", `${mathsBlock}
    return { frameGroundFootprintCorners, focusMaskFootprintBounds, coverFocusMaskBounds, FOCUS_MASK_FRAME_ASPECTS, FOCUS_MASK_FOOTPRINT_MARGIN };`)(Number(cameraPitchLiteral[1])) as {
    frameGroundFootprintCorners: (
      rangeMeters: number, pitchDegrees: number, headingDegrees: number, aspectRatio: number, fovDegrees: number
    ) => Array<{ east: number; north: number }> | null;
    focusMaskFootprintBounds: (preset: Record<string, number> | null, profile: string) => {
      west: number; east: number; south: number; north: number;
    } | null;
    coverFocusMaskBounds: (
      base: { west: number; east: number; south: number; north: number },
      cover: { west: number; east: number; south: number; north: number } | null
    ) => { west: number; east: number; south: number; north: number };
    FOCUS_MASK_FRAME_ASPECTS: Record<string, number>;
    FOCUS_MASK_FOOTPRINT_MARGIN: number;
  };
  // 江洪镇 440823105 in landscape: a 34710 m slant range at the -64 degree overview
  // pitch frames 60 degrees across the long edge, so the far corners sit ~23.8 km
  // east/west of the target. Close to the numbers the pre-fix runtime was measured
  // against (a ~192 px uncovered band at each frame edge of a 1920 px frame).
  const landscape = maths.frameGroundFootprintCorners(34710, -64, 0, 1920 / 1080, 60);
  assert.ok(landscape);
  assert.equal(landscape.length, 4);
  assert.ok(Math.abs(Math.max(...landscape.map((corner) => Math.abs(corner.east))) - 23811) < 60);
  assert.ok(Math.abs(Math.max(...landscape.map((corner) => corner.north)) - 14902) < 60);
  assert.ok(Math.abs(Math.min(...landscape.map((corner) => corner.north)) + 10827) < 60);
  // The frame footprint must out-reach the bounding-box box, or the seam returns.
  const region = JSON.parse(regionRaw) as { bbox: number[] };
  const [west, south, east, north] = region.bbox.map(Number) as [number, number, number, number];
  const bboxHalfWidth = ((east - west) / 2) * 111320 * Math.cos((((south + north) / 2) * Math.PI) / 180);
  const farHalfWidth = Math.max(...landscape.map((corner) => Math.abs(corner.east)));
  assert.ok(
    farHalfWidth > bboxHalfWidth * 3.2,
    `the landscape frame reaches ${Math.round(farHalfWidth)} m while bbox * 3.2 gives ${Math.round(bboxHalfWidth * 3.2)} m`
  );
  // Portrait frames the 60 degrees vertically, so the same preset reaches far less
  // sideways: the union then stays close to the bounding-box box.
  const portrait = maths.frameGroundFootprintCorners(34710, -64, 0, 1080 / 1920, 60);
  assert.ok(portrait);
  assert.ok(Math.abs(Math.max(...portrait.map((corner) => Math.abs(corner.east))) - 15691) < 60);
  // A region with no usable preset, or a camera at the horizon or straight down,
  // yields no trapezoid so the caller keeps the bounding-box box instead of guessing.
  assert.equal(maths.frameGroundFootprintCorners(0, -64, 0, 1, 60), null);
  assert.equal(maths.frameGroundFootprintCorners(34710, -90, 0, 1, 60), null);
  assert.equal(maths.frameGroundFootprintCorners(34710, -64, 0, 1, 60)?.length, 4);
  assert.equal(maths.focusMaskFootprintBounds(null, "landscape"), null);
  assert.equal(maths.focusMaskFootprintBounds({ longitude: 109.7, latitude: 21, height: 0 }, "landscape"), null);
  // A preset that omits the pitch takes the runtime overview pitch, which also
  // proves CAMERA_PITCH really reaches the extracted block.
  assert.ok(maths.focusMaskFootprintBounds({ longitude: 109.7, latitude: 21, height: 34710 }, "landscape"));
  // Sweep every shipped region and profile: the frame the overview camera can see
  // must fit inside the rectangle the runtime builds for it. This is the only way
  // to catch the seam, because a mask edge that enters frame still reports
  // `enabled: true, alpha: 0.24` in getDiagnostics().
  const maskedModes = new Set(["parent-topic", "parent-child-tour"]);
  const regionFiles = await readdir(resolve(process.cwd(), "data/regions"));
  const shortfalls: string[] = [];
  let combinations = 0;
  let footprints = 0;
  for (const file of regionFiles.filter((name) => name.endsWith(".json"))) {
    const data = JSON.parse(await readFile(resolve(process.cwd(), "data/regions", file), "utf8")) as {
      id: string; name?: string; presentationMode?: string; bbox?: number[];
      cameraPreset?: Record<string, number>; cameraProfiles?: Record<string, Record<string, number>>;
    };
    if (!maskedModes.has(data.presentationMode ?? "") || !Array.isArray(data.bbox)) continue;
    const [bWest, bSouth, bEast, bNorth] = data.bbox.map(Number) as [number, number, number, number];
    const centerLon = (bWest + bEast) / 2;
    const centerLat = (bSouth + bNorth) / 2;
    // Same floor as resolveFocusMaskBounds(): region bbox x bboxExpand.
    const floor = {
      west: centerLon - (Math.max(0.01, bEast - bWest) * 3.2) / 2,
      east: centerLon + (Math.max(0.01, bEast - bWest) * 3.2) / 2,
      south: centerLat - (Math.max(0.01, bNorth - bSouth) * 3.2) / 2,
      north: centerLat + (Math.max(0.01, bNorth - bSouth) * 3.2) / 2
    };
    for (const profile of Object.keys(maths.FOCUS_MASK_FRAME_ASPECTS)) {
      const preset = data.cameraProfiles?.[profile] ?? data.cameraPreset;
      if (!preset || !Number.isFinite(Number(preset.height))) continue;
      const footprint = maths.focusMaskFootprintBounds(preset, profile);
      const bounds = maths.coverFocusMaskBounds(floor, footprint);
      const targetLon = Number(preset.longitude);
      const targetLat = Number(preset.latitude);
      const lonScale = 111320 * Math.cos((targetLat * Math.PI) / 180);
      // Both the preset range and the child-tour range (PARENT_OVERVIEW_CAMERA_HEIGHT_SCALE).
      for (const rangeScale of [1, 0.9]) {
        combinations += 1;
        const corners = maths.frameGroundFootprintCorners(
          Number(preset.height) * rangeScale,
          Number(preset.pitch ?? -64),
          Number(preset.heading) || 0,
          maths.FOCUS_MASK_FRAME_ASPECTS[profile] ?? 1,
          60
        );
        if (!corners) continue;
        footprints += 1;
        for (const corner of corners) {
          const lon = targetLon + corner.east / lonScale;
          const lat = targetLat + corner.north / 111320;
          const outside = Math.max(
            (bounds.west - lon) * lonScale, (lon - bounds.east) * lonScale,
            (bounds.south - lat) * 111320, (lat - bounds.north) * 111320
          );
          if (outside > 0) {
            shortfalls.push(`${data.name ?? data.id} ${profile} x${rangeScale}: short by ${Math.round(outside)} m`);
          }
        }
      }
    }
  }
  assert.ok(combinations > 100, `expected the shipped region set to be swept, swept ${combinations}`);
  // Guard against a silent no-op sweep: a footprint that resolves to null would
  // leave the bounding-box floor as the only sizing rule and still pass.
  assert.ok(footprints > 100, `expected the presets to resolve footprints, resolved ${footprints}`);
  assert.deepEqual(shortfalls, []);
});

test("the portrait overview frames the boundary it draws, not the extent it was imported against", async () => {
  const source = await readFile(resolve(process.cwd(), "apps/cesium-player/public/runtime.js"), "utf8");
  assert.match(source, /const PORTRAIT_OVERVIEW_FRAME_ASPECT = 1080 \/ 1920/);
  assert.match(source, /const PORTRAIT_OVERVIEW_FRUSTUM_FOV_DEGREES = 60/);
  assert.match(source, /const PORTRAIT_OVERVIEW_SAFE_FRACTION = 0\.82/);
  assert.match(source, /const PORTRAIT_OVERVIEW_MAXIMUM_RANGE_METERS = 180_000/);
  assert.match(source, /function portraitOverviewFrustumTangents\(aspectRatio\)/);
  assert.match(source, /function portraitOverviewScreenFractions\(eastMeters, northMeters, rangeMeters, pitchDegrees, tangents\)/);
  assert.match(source, /function portraitOverviewExtent\(bounds, geometry\)/);
  assert.match(source, /function portraitOverviewProjectedBox\(points, rangeMeters, pitchDegrees, tangents\)/);
  assert.match(source, /function portraitOverviewTarget\(points, pitchDegrees, safeFraction, tangents\)/);
  assert.match(source, /function applyPortraitZoomToLayer\(regionData, geometry\)/);
  // The frame has to be derived where it is computed, and before the label ramp
  // reads the range it comes from -- otherwise a project's frozen boundary
  // snapshot pins the stale target for the whole video.
  assert.match(source, /region = applyPortraitZoomToLayer\(await regionResponse\.json\(\), geometry\);\r?\n    labelReferenceDistance = resolveLabelReferenceDistance\(\);/);

  const block = source
    .split("// ---- portrait overview framing (pure, test-extractable) -------------------")[1]
    ?.split("// ---- end portrait overview framing ----------------------------------------")[0];
  assert.ok(block, "the portrait overview framing maths must stay extractable between its markers");
  const cameraPitchLiteral = source.match(/const CAMERA_PITCH = (-?[\d.]+);/);
  assert.ok(cameraPitchLiteral, "CAMERA_PITCH must stay a literal the extracted maths can be handed");
  const maths = new Function("CAMERA_PITCH", `${block}
    return { portraitOverviewFrustumTangents, portraitOverviewScreenFractions, portraitOverviewRange, portraitOverviewExtent,
      portraitOverviewProjectedBox, portraitOverviewTarget, applyPortraitZoomToLayer,
      PORTRAIT_OVERVIEW_FRAME_ASPECT, PORTRAIT_OVERVIEW_SAFE_FRACTION, PORTRAIT_OVERVIEW_MINIMUM_RANGE_METERS,
      PORTRAIT_OVERVIEW_RECENTER_TOLERANCE,
      PORTRAIT_OVERVIEW_EARTH_METERS_PER_DEGREE, PORTRAIT_OVERVIEW_LATITUDE_METERS_PER_DEGREE };`)(Number(cameraPitchLiteral[1])) as {
    portraitOverviewFrustumTangents: (aspect?: number) => { horizontal: number; vertical: number };
    portraitOverviewScreenFractions: (
      eastMeters: number, northMeters: number, rangeMeters: number, pitchDegrees: number,
      tangents?: { horizontal: number; vertical: number }
    ) => { x: number; y: number };
    portraitOverviewRange: (
      points: Array<{ east: number; north: number }>, pitchDegrees: number, safeFraction?: number,
      tangents?: { horizontal: number; vertical: number }
    ) => number;
    portraitOverviewProjectedBox: (
      points: Array<{ east: number; north: number }>, rangeMeters: number, pitchDegrees: number,
      tangents?: { horizontal: number; vertical: number }
    ) => { minX: number; maxX: number; minY: number; maxY: number; centreX: number; centreY: number } | null;
    portraitOverviewTarget: (
      points: Array<{ east: number; north: number }>, pitchDegrees: number, safeFraction?: number,
      tangents?: { horizontal: number; vertical: number }
    ) => { eastMeters: number; northMeters: number; rangeMeters: number };
    portraitOverviewExtent: (
      bounds: number[] | null, geometry: unknown
    ) => { longitude: number; latitude: number; points: Array<{ east: number; north: number }> } | null;
    applyPortraitZoomToLayer: (region: Record<string, unknown>, geometry: unknown) => {
      cameraProfiles: { portrait: { longitude: number; latitude: number; height: number; pitch: number } };
      cameraPreset?: { height: number };
    } | Record<string, unknown>;
    PORTRAIT_OVERVIEW_FRAME_ASPECT: number;
    PORTRAIT_OVERVIEW_SAFE_FRACTION: number;
    PORTRAIT_OVERVIEW_MINIMUM_RANGE_METERS: number;
    PORTRAIT_OVERVIEW_RECENTER_TOLERANCE: number;
    PORTRAIT_OVERVIEW_EARTH_METERS_PER_DEGREE: number;
    PORTRAIT_OVERVIEW_LATITUDE_METERS_PER_DEGREE: number;
  };
  const safe = maths.PORTRAIT_OVERVIEW_SAFE_FRACTION;
  const tangents = maths.portraitOverviewFrustumTangents();
  // Cesium hands the frustum FOV to the wider screen axis, so a 9:16 frame spends
  // all 60 of its degrees vertically and reaches cos-ratio less sideways. The
  // sideways tangent is what turns the frustum into the documented 36 degree
  // horizontal field the child portrait presets are authored against.
  assert.ok(Math.abs(tangents.vertical - Math.tan(Math.PI / 6)) < 1e-9);
  assert.ok(Math.abs(tangents.horizontal - 0.3249) < 0.0002);

  // A point east of the target lands east of centre, a point south lands below
  // it (negative, since the fractions count up the frame), and the same east
  // offset reads wider nearer the camera: that asymmetry is the whole reason the
  // fit is solved per vertex instead of off the box.
  assert.ok(maths.portraitOverviewScreenFractions(10_000, 0, 30_000, -64, tangents).x > 0);
  assert.ok(maths.portraitOverviewScreenFractions(0, -10_000, 30_000, -64, tangents).y < 0);
  assert.ok(maths.portraitOverviewScreenFractions(0, 10_000, 30_000, -64, tangents).y > 0);
  const near = maths.portraitOverviewScreenFractions(10_000, -5_000, 30_000, -64, tangents).x;
  const far = maths.portraitOverviewScreenFractions(10_000, 5_000, 30_000, -64, tangents).x;
  assert.ok(near > far, `the near edge must read wider, got ${near} vs ${far}`);
  assert.equal(maths.portraitOverviewScreenFractions(0, 0, 30_000, -90, tangents).y, 0);

  // 草潭镇 440823113 is the reported defect: a boundary revision moved the extent
  // 873 m east of the target the record was still aiming at, and the portrait
  // frame drew the boundary visibly off centre. The fit must take its centre from
  // the boundary, and must keep every vertex inside the safe fraction.
  const stale = JSON.parse(await readFile(resolve(process.cwd(), "data/regions/440823113.json"), "utf8")) as {
    bbox: number[]; cameraProfiles: { portrait: Record<string, number> };
  };
  const geometry = JSON.parse(await readFile(resolve(process.cwd(), "data/normalized/440823113.geojson"), "utf8"));
  const [west, south, east, north] = stale.bbox.map(Number) as [number, number, number, number];
  const stalePortrait = { ...stale.cameraProfiles.portrait, longitude: west, latitude: south, height: 1 };
  const derived = maths.applyPortraitZoomToLayer(
    { bbox: stale.bbox, cameraProfiles: { portrait: stalePortrait }, cameraPreset: { height: 32811 } },
    geometry
  ) as { cameraProfiles: { portrait: { longitude: number; latitude: number; height: number; pitch: number } } };
  const fitted = derived.cameraProfiles.portrait;
  assert.equal(fitted.pitch, -64, "the fit must not disturb the authored pitch");
  assert.ok(fitted.height > maths.PORTRAIT_OVERVIEW_MINIMUM_RANGE_METERS);
  assert.ok(fitted.height < 32811, "portrait is cut from the full-area preset, so it stays inside it");

  const extent = maths.portraitOverviewExtent(stale.bbox, geometry);
  assert.ok(extent);
  assert.ok(extent.points.length > 1_000, "the fit reads the drawn ring, not the bounding box");
  // Replay the returned camera: shift the ring into the target's frame, then read
  // every vertex back out through the same projection the fit was solved against.
  // The longitude scale is the one `applyPortraitZoomToLayer` itself used, so a
  // round-trip that is off centre here is off centre in the rendered frame.
  const metresPerDegreeLongitude = maths.PORTRAIT_OVERVIEW_EARTH_METERS_PER_DEGREE * Math.cos((extent.latitude * Math.PI) / 180);
  const shiftEast = (fitted.longitude - extent.longitude) * metresPerDegreeLongitude;
  const shiftNorth = (fitted.latitude - extent.latitude) * maths.PORTRAIT_OVERVIEW_LATITUDE_METERS_PER_DEGREE;
  const aimOffset = Math.hypot(shiftEast, shiftNorth);
  assert.ok(aimOffset < 1_500, `the frame must aim at the boundary, not 873 m away from it: ${aimOffset} m`);
  const framed = extent.points.map((point) => ({ east: point.east - shiftEast, north: point.north - shiftNorth }));

  // The target is not the geographic centre, and that is deliberate: the frame of
  // a pitched camera is a trapezoid whose near edge is magnified (measured 1.0 %
  // of frame left-right and 2.4 % top-bottom on the shipped player at 540x960, in
  // the direction asserted here). What matters is that the *drawn* box is centred.
  const geographic = maths.portraitOverviewProjectedBox(extent.points, fitted.height, fitted.pitch, tangents);
  assert.ok(geographic);
  assert.ok(
    Math.abs(geographic.centreX) > 0.005 || Math.abs(geographic.centreY) > 0.005,
    "aiming at the geographic centre is what leaves the drawing off centre; the recentring has to be visible here"
  );
  const recentred = maths.portraitOverviewProjectedBox(framed, fitted.height, fitted.pitch, tangents);
  assert.ok(recentred);
  assert.ok(
    Math.abs(recentred.centreX) <= maths.PORTRAIT_OVERVIEW_RECENTER_TOLERANCE,
    `the drawn box must come back centred sideways: ${recentred.centreX}`
  );
  assert.ok(
    Math.abs(recentred.centreY) <= maths.PORTRAIT_OVERVIEW_RECENTER_TOLERANCE,
    `the drawn box must come back centred vertically: ${recentred.centreY}`
  );

  // Recentring also earns the tighter fit: the drawn width reaches the safe
  // bound instead of falling short of it.
  assert.ok(
    framed.length > 0
      && Math.max(...framed.map((point) => Math.abs(
        maths.portraitOverviewScreenFractions(point.east, point.north, fitted.height, fitted.pitch, tangents).x
      ))) > safe - 0.005,
    "the fit should be tight against the safe bound once the drawing is centred"
  );

  for (const point of framed) {
    const screen = maths.portraitOverviewScreenFractions(point.east, point.north, fitted.height, fitted.pitch, tangents);
    assert.ok(Math.abs(screen.x) <= safe + 1e-6, `vertex escaped the frame sideways: ${screen.x}`);
    assert.ok(Math.abs(screen.y) <= safe + 1e-6, `vertex escaped the frame vertically: ${screen.y}`);
    // The child tour and the closing return re-use this camera at
    // PARENT_OVERVIEW_CAMERA_HEIGHT_SCALE, which grows the outline by 1/0.9.
    assert.ok(Math.abs(screen.x) / 0.9 <= 1, "the tour pull-in must not push the perimeter off screen");
  }

  // A short boundary has nothing to recentre against and must not produce NaN:
  // `portraitOverviewTarget` still has to return a usable range.
  const empty = maths.portraitOverviewTarget([], -64, safe, tangents);
  assert.equal(empty.eastMeters, 0);
  assert.equal(empty.northMeters, 0);
  assert.ok(empty.rangeMeters > 0);

  // Records without geometry still frame, from the box.
  const boxOnly = maths.applyPortraitZoomToLayer(
    { bbox: stale.bbox, cameraProfiles: { portrait: stalePortrait } },
    null
  ) as { cameraProfiles: { portrait: { height: number } } };
  assert.ok(boxOnly.cameraProfiles.portrait.height > maths.PORTRAIT_OVERVIEW_MINIMUM_RANGE_METERS);
  assert.ok(Number.isFinite(boxOnly.cameraProfiles.portrait.height));
  // A record with no portrait profile is left alone: a prefecture's single preset
  // is the wide context shot the opening descent starts from.
  const prefecture = { bbox: stale.bbox, cameraPreset: { longitude: 1, latitude: 2, height: 3 } };
  assert.equal(maths.applyPortraitZoomToLayer(prefecture, geometry), prefecture);
  // A truncated ring must not be mistaken for the boundary: 新安街道办事处
  // 440306017 ships a two-point ring against a 0.07 x 0.09 degree box, and
  // fitting that sliver would park the camera inside the subject.
  const degenerate = maths.applyPortraitZoomToLayer(
    { bbox: [113.8532504, 22.5175816, 113.9246942, 22.6069388], cameraProfiles: { portrait: stalePortrait } },
    {
      type: "FeatureCollection",
      features: [{
        geometry: {
          type: "Polygon",
          coordinates: [[[113.91018128306251, 22.606923568004063], [113.8532504, 22.5175816], [113.91018128306251, 22.606923568004063]]]
        }
      }]
    }
  ) as { cameraProfiles: { portrait: { height: number } } };
  assert.ok(degenerate.cameraProfiles.portrait.height > 8_000, `a truncated ring was trusted: ${degenerate.cameraProfiles.portrait.height}`);
});

test("the editor's settled overview hold lands after the out-of-region recession completes", async () => {
  const source = await readFile(resolve(process.cwd(), "apps/cesium-player/public/runtime.js"), "utf8");
  // Studio holds one settled frame after replaying the pen, and that frame is
  // all the user sees of the overview scene. Parking it on the trace settle --
  // which is where the recession ramp is anchored -- left the mask at ~7% of its
  // configured alpha (measured 0.0183 of 0.24) and the editor showed an overview
  // frame with no darkening outside the region while the exported video is
  // visibly dimmed from the same moment on. getDiagnostics() reports the alpha,
  // not whether it is late enough, so only this assertion can catch a regression.
  assert.match(source, /const PARENT_SETTLE_TIME = PARENT_REVEAL_START \+ PARENT_REVEAL_DURATION \+ PARENT_SETTLE_DURATION;/);
  assert.match(source, /function settledOverviewHoldSeconds\(settleTime, fadeSeconds, maskEnabled\)/);
  assert.match(source, /currentTime = openingDescent\.seconds \+ editorSettledHoldOffset\(\);/);
  assert.doesNotMatch(
    source,
    /currentTime = openingDescent\.seconds \+ PARENT_REVEAL_START/,
    "the hold offset must not be inlined again: it has to include the recession fade"
  );

  const holdBlock = source
    .split("// ---- opening preview hold maths (pure, test-extractable) ------------------")[1]
    ?.split("// ---- end opening preview hold maths ---------------------------------------")[0];
  assert.ok(holdBlock, "the opening preview hold maths must stay extractable between its markers");
  const settledOverviewHoldSeconds = new Function(`${holdBlock}
    return settledOverviewHoldSeconds;`)() as (
    settleTime: number, fadeSeconds: number, maskEnabled: boolean
  ) => number | null;

  // Executed, not pattern-matched: the shipped constants for a region shot with
  // the default 3.6 s fade.
  const settleTime = 0.35 + 2.2 + 0.34;
  const fadeSeconds = 3.6;
  const hold = settledOverviewHoldSeconds(settleTime, fadeSeconds, true);
  assert.ok(hold !== null);
  assert.ok(
    hold >= settleTime + fadeSeconds,
    `the hold must outlast the recession ramp: hold ${hold} s vs settle + fade ${settleTime + fadeSeconds} s`
  );
  assert.ok(Math.abs(hold - 7.29) < 1e-9);
  // With the mask switched off there is nothing to wait for, and the hold falls
  // back to exactly what it used to be.
  assert.ok(Math.abs((settledOverviewHoldSeconds(settleTime, fadeSeconds, false) ?? 0) - 3.69) < 1e-9);
  // A caller that cannot supply a settle moment must get no hold at all rather
  // than a NaN that would seek the player to an undefined time.
  assert.equal(settledOverviewHoldSeconds(0, fadeSeconds, true), null);
  assert.equal(settledOverviewHoldSeconds(Number.NaN, fadeSeconds, true), null);
});

test("Cesium runtime stamps authored data requests with the server data version", async () => {
  const source = await readFile(resolve(process.cwd(), "apps/cesium-player/public/runtime.js"), "utf8");
  assert.match(source, /function withDataVersion\(url\)/);
  assert.match(source, /runtimeConfig\.dataVersion/);
  // A raw fetch of authored data would let the browser replay a boundary the
  // operator already re-imported: every request has to go through the stamper.
  assert.doesNotMatch(source, /fetch\(\s*`\/data\//);
  assert.doesNotMatch(source, /fetch\(\s*`\/\$\{String\(/);
});

// 「视频开头画完边界之后闪了一下」——成片里边界像素 6533 → 0 → 6171
// （map t=5.433 / 5.467 / 5.500），就是稳定那一帧两边都没画上：
// 画布画笔的强度被硬切成 0，而 Cesium 那层的材质更新晚一帧才提交。
test("the pen hands the parent boundary to the Cesium segments without a one-frame hole", async () => {
  const source = await readFile(resolve(process.cwd(), "apps/cesium-player/public/runtime.js"), "utf8");
  // 交接余量：30fps 下 0.1 ≈ 3 帧。
  assert.match(source, /const BOUNDARY_HANDOFF_HOLD_SECONDS = 0\.1;/);
  // 稳定那一帧就把 Cesium 层升到全量（给它一帧去提交），画布再多顶一小段。
  assert.match(source, /const cesiumRevealStrength = parentSettled \? persistentRevealStrength : 0;/);
  assert.match(source, /const settledFor = time - \(revealStart \+ revealDuration\);/);
  assert.match(source, /const canvasShare = editorParentPreviewHold \|\| !parentSettled\s*\r?\n?\s*\|\| settledFor < BOUNDARY_HANDOFF_HOLD_SECONDS \? 1 : 0;/);
  assert.match(source, /const boundaryCanvasStrength = persistentRevealStrength \* canvasShare;/);
  // 旧的硬切（两层同帧互换）与「交叉淡出」都不许回来：前者留空洞，后者把线冲淡。
  assert.doesNotMatch(source, /const boundaryCanvasStrength = useBoundaryRevealCanvas \? persistentRevealStrength : 0;/);
  assert.doesNotMatch(source, /const cesiumRevealStrength = persistentRevealStrength \* \(1 - canvasShare\);/);
});

// 天地图 `cia` 注记是 256 px 位图，地名只有 9–10 px 高。竖屏成片只有 1080 px 宽，
// 照原尺寸铺上去等于不可读（实测成片里 9 px，手机上约 4 pt），而本项目自绘的标签是
// 46–86 px。位图没有字号，唯一的杠杆是声明更大的瓦片让 Cesium 把同一张图铺到更大
// 的屏幕面积上 —— 合约就是「注记层必须放大，底图必须不放大」。
test("the Tianditu label layer is declared larger than its 256 px tiles so place names survive a 1080-wide frame", async () => {
  const source = await readFile(resolve(process.cwd(), "apps/cesium-player/public/runtime.js"), "utf8");
  // 2 的幂：`getLevelWithMaximumTexelSpacing` 走 Math.round(level)，中间值会让层级
  // 随纬度/相机高度在两档之间跳动，画面上的字号忽大忽小。
  assert.match(source, /const ANNOTATION_TILE_SCALE = \(\(\) => \{[\s\S]*?return 2;/);
  assert.match(source, /const ANNOTATION_TILE_PX = 256 \* ANNOTATION_TILE_SCALE;/);
  assert.match(source, /annotationLayer = new Cesium\.ImageryLayer\(\s*tiandituLayerProvider\("cia", runtimeConfig\.tiandituToken, ANNOTATION_TILE_PX\)\s*\)/);
  // 底图（`img`）不跟着放大：它是卫星影像，放大会整体发虚。
  assert.match(source, /tiandituLayerProvider\("img", runtimeConfig\.tiandituToken\)/);
  // 服务端返回的永远是 256 px，所以瓦片像素只是声明值，不是请求值。
  assert.match(source, /tileWidth: tilePx,/);
  assert.match(source, /tileHeight: tilePx,/);
  assert.doesNotMatch(source, /tileWidth: 256,\s*\r?\n\s*tileHeight: 256,/);
});
