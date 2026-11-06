import {
  closingNarrationStateAt,
  parentLabelStrengthAt,
  parentNameStrengthAt,
  stableOverlayState,
  tourHighlightStrength,
  tourLabelPresentationAt
} from "./tour-presentation.js?v=parent-persist-v7";

(() => {
  "use strict";

  const Cesium = window.Cesium;
  const STUDIO_PREVIEW_VISUAL_SCALE = location.search.includes("studioPreview=")
    ? Math.max(0.56, Math.min(1, innerWidth / 720))
    : 1;
  const previewProfile = new URLSearchParams(location.search).get("profile") || (innerHeight > innerWidth ? "portrait" : "landscape");
  const previewOutputWidth = previewProfile === "landscape" ? 1920 : 1080;
  // All grounded line and outline weights are authored against the profile's
  // documented pixel width (1920 landscape / 1080 portrait and square), which is
  // exactly what capture uses. Resolution scaling therefore stays at 1 for every
  // shipped profile and only grows for a higher-resolution master, so weights
  // keep their proportion to the frame instead of thinning out at 4K.
  const OUTPUT_RESOLUTION_SCALE = location.search.includes("studioPreview=")
    ? 1
    : Math.max(1, Math.min(4, innerWidth / previewOutputWidth));
  const STUDIO_PREVIEW_TYPOGRAPHY_SCALE = location.search.includes("studioPreview=")
    ? Math.max(0.1, Math.min(1, innerWidth / previewOutputWidth))
    : 1;
  const CAMERA_PITCH = -64;
  const FLIGHT_DURATION = 8;
  const FLIGHT_APEX_MIN_METERS = 500;
  const FLIGHT_APEX_MAX_METERS = 2800;
  const TOUR_RETURN_DURATION_SECONDS = 4.4;
  const TOUR_RETURN_MIN_SECONDS = 3.8;
  const TOUR_RETURN_MAX_SECONDS = 5.0;
  // The parent overview is reused as the final tour-return camera. A modest
  // reduction keeps the administrative area comfortably larger in both
  // scenes while preserving the surrounding geographic context.
  const PARENT_OVERVIEW_CAMERA_HEIGHT_SCALE = 0.9;
  const OPENING_DESCENT_DEFAULTS = {
    seconds: 3,
    startHeightMeters: 900000,
    startPitchDegrees: -52,
    cloudDeckHeightMeters: 45000,
    cloudsEnabled: true,
    cloudAlphaPeak: 0.95
  };
  const OPENING_CLOUD_LAYOUT = [
    { dLon: -2.20, dLat: 1.30, sizeKm: 118, aspect: 0.62, thicknessKm: 34, altitudeKm: 7, slice: 0.36, alpha: 0.82, brightness: 1.02 },
    { dLon: -1.42, dLat: 1.52, sizeKm: 142, aspect: 0.70, thicknessKm: 38, altitudeKm: -3, slice: 0.48, alpha: 0.88, brightness: 1.04 },
    { dLon: -0.55, dLat: 1.38, sizeKm: 104, aspect: 0.58, thicknessKm: 31, altitudeKm: 5, slice: 0.60, alpha: 0.80, brightness: 0.99 },
    { dLon: 0.38, dLat: 1.55, sizeKm: 152, aspect: 0.66, thicknessKm: 42, altitudeKm: 0, slice: 0.42, alpha: 0.92, brightness: 1.05 },
    { dLon: 1.32, dLat: 1.28, sizeKm: 112, aspect: 0.74, thicknessKm: 35, altitudeKm: 8, slice: 0.55, alpha: 0.84, brightness: 1.01 },
    { dLon: 2.18, dLat: 1.42, sizeKm: 136, aspect: 0.60, thicknessKm: 39, altitudeKm: -5, slice: 0.32, alpha: 0.87, brightness: 1.03 },
    { dLon: -2.42, dLat: 0.58, sizeKm: 148, aspect: 0.68, thicknessKm: 41, altitudeKm: 1, slice: 0.50, alpha: 0.90, brightness: 1.00 },
    { dLon: -1.62, dLat: 0.62, sizeKm: 96, aspect: 0.56, thicknessKm: 29, altitudeKm: 9, slice: 0.64, alpha: 0.78, brightness: 0.98 },
    { dLon: -0.82, dLat: 0.72, sizeKm: 132, aspect: 0.72, thicknessKm: 37, altitudeKm: -4, slice: 0.39, alpha: 0.90, brightness: 1.06 },
    { dLon: 0.00, dLat: 0.60, sizeKm: 158, aspect: 0.64, thicknessKm: 44, altitudeKm: 2, slice: 0.53, alpha: 0.96, brightness: 1.08 },
    { dLon: 0.84, dLat: 0.78, sizeKm: 108, aspect: 0.60, thicknessKm: 32, altitudeKm: 7, slice: 0.35, alpha: 0.83, brightness: 1.02 },
    { dLon: 1.66, dLat: 0.54, sizeKm: 146, aspect: 0.76, thicknessKm: 40, altitudeKm: -2, slice: 0.58, alpha: 0.91, brightness: 1.04 },
    { dLon: 2.46, dLat: 0.72, sizeKm: 102, aspect: 0.58, thicknessKm: 30, altitudeKm: 5, slice: 0.44, alpha: 0.79, brightness: 0.99 },
    { dLon: -2.12, dLat: -0.18, sizeKm: 108, aspect: 0.72, thicknessKm: 33, altitudeKm: 6, slice: 0.57, alpha: 0.82, brightness: 1.01 },
    { dLon: -1.30, dLat: -0.06, sizeKm: 154, aspect: 0.62, thicknessKm: 43, altitudeKm: -5, slice: 0.34, alpha: 0.94, brightness: 1.07 },
    { dLon: -0.48, dLat: -0.18, sizeKm: 116, aspect: 0.66, thicknessKm: 35, altitudeKm: 4, slice: 0.51, alpha: 0.86, brightness: 1.00 },
    { dLon: 0.34, dLat: 0.02, sizeKm: 164, aspect: 0.70, thicknessKm: 46, altitudeKm: -1, slice: 0.62, alpha: 1.00, brightness: 1.10 },
    { dLon: 1.18, dLat: -0.22, sizeKm: 124, aspect: 0.58, thicknessKm: 36, altitudeKm: 8, slice: 0.40, alpha: 0.88, brightness: 1.03 },
    { dLon: 2.06, dLat: -0.04, sizeKm: 150, aspect: 0.74, thicknessKm: 42, altitudeKm: -6, slice: 0.54, alpha: 0.93, brightness: 1.05 },
    { dLon: -2.48, dLat: -0.88, sizeKm: 138, aspect: 0.64, thicknessKm: 39, altitudeKm: -2, slice: 0.46, alpha: 0.88, brightness: 1.02 },
    { dLon: -1.58, dLat: -0.72, sizeKm: 100, aspect: 0.70, thicknessKm: 30, altitudeKm: 7, slice: 0.63, alpha: 0.80, brightness: 0.99 },
    { dLon: -0.72, dLat: -0.94, sizeKm: 146, aspect: 0.60, thicknessKm: 41, altitudeKm: -4, slice: 0.37, alpha: 0.92, brightness: 1.06 },
    { dLon: 0.12, dLat: -0.78, sizeKm: 112, aspect: 0.68, thicknessKm: 34, altitudeKm: 5, slice: 0.56, alpha: 0.85, brightness: 1.01 },
    { dLon: 0.96, dLat: -0.96, sizeKm: 156, aspect: 0.72, thicknessKm: 44, altitudeKm: 0, slice: 0.43, alpha: 0.96, brightness: 1.08 },
    { dLon: 1.86, dLat: -0.76, sizeKm: 106, aspect: 0.58, thicknessKm: 32, altitudeKm: 8, slice: 0.61, alpha: 0.82, brightness: 1.00 },
    { dLon: 2.52, dLat: -0.96, sizeKm: 142, aspect: 0.66, thicknessKm: 40, altitudeKm: -3, slice: 0.38, alpha: 0.90, brightness: 1.04 },
    { dLon: -1.98, dLat: -1.54, sizeKm: 118, aspect: 0.62, thicknessKm: 35, altitudeKm: 4, slice: 0.52, alpha: 0.84, brightness: 1.01 },
    { dLon: -1.04, dLat: -1.48, sizeKm: 150, aspect: 0.74, thicknessKm: 42, altitudeKm: -5, slice: 0.35, alpha: 0.92, brightness: 1.06 },
    { dLon: -0.04, dLat: -1.62, sizeKm: 102, aspect: 0.58, thicknessKm: 31, altitudeKm: 7, slice: 0.59, alpha: 0.80, brightness: 0.99 },
    { dLon: 0.92, dLat: -1.48, sizeKm: 158, aspect: 0.68, thicknessKm: 45, altitudeKm: -1, slice: 0.45, alpha: 0.96, brightness: 1.08 },
    { dLon: 1.92, dLat: -1.58, sizeKm: 124, aspect: 0.64, thicknessKm: 36, altitudeKm: 6, slice: 0.55, alpha: 0.86, brightness: 1.02 }
  ];
  const PARENT_REVEAL_START = 0.35;
  const PARENT_REVEAL_DURATION = 2.2;
  const PARENT_SETTLE_DURATION = 0.34;
  // 画笔（画布层）与 Cesium 线段的交接余量，单位秒（30fps 下 0.1 ≈ 3 帧）。
  // 两者画的是同一根线：稳定前由画布画（跟随相机、逐帧精确），稳定后交给 Cesium
  // 的 ground polyline。硬切不安全 —— Cesium 可能晚一帧提交材质更新，那一帧两边
  // 都没画上，成片里就是「边界突然闪一下」：调风镇实测边界像素 6533 → 0 → 6171
  // （map t=5.433 / 5.467 / 5.500），本地 capture 也复现到同样的单帧空洞。
  // 修法是**保持画布**到 Cesium 那一层确实提交完成后再切：留 3 帧余量，两层都是
  // 接近不透明的同一根线，叠加几乎不改变观感（0.96 再叠 0.96 ≈ 0.998），
  // 而交叉淡出会让线在过渡里明显变淡，所以不做淡出。
  const BOUNDARY_HANDOFF_HOLD_SECONDS = 0.1;
  // The parent trace is complete here, and the out-of-region recession is
  // anchored to exactly this moment before it eases in.
  const PARENT_SETTLE_TIME = PARENT_REVEAL_START + PARENT_REVEAL_DURATION + PARENT_SETTLE_DURATION;
  const CHILD_BOUNDARY_START = 3.15;
  const CHILD_BOUNDARY_DURATION = 1.35;
  const SELECTED_FILL_START = 3.55;
  const SELECTED_FILL_DURATION = 1.25;
  const PARENT_LABEL_FADE_DURATION = 0.28;
  const BOUNDARY_UNDERLAY = Cesium.Color.fromCssColorString("#021018");
  const PARENT_BOUNDARY = Cesium.Color.fromCssColorString("#2D9CDB");
  const PARENT_LABEL_FILL = Cesium.Color.WHITE;
  const PARENT_LABEL_OUTLINE = Cesium.Color.BLACK;
  const CHILD_LABEL_OUTLINE = Cesium.Color.BLACK;
  const LABEL_OUTLINE_WIDTH = 2.8;
  const CHILD_LABEL_OUTLINE_WIDTH = 3.4;
  const LABEL_OUTLINE_MAX_ALPHA = 1;
  const LABEL_OUTLINE_ALPHA_RATIO = 1.05;
  const CHILD_LABEL_OUTLINE_MAX_ALPHA = 1;
  const CHILD_LABEL_OUTLINE_ALPHA_RATIO = 1.05;
  const RETURN_CHILD_LABEL_OUTLINE_WIDTH = 5.4;
  const RETURN_CHILD_LABEL_OUTLINE_ALPHA_RATIO = 1.45;
  const SELECTED_BOUNDARY = Cesium.Color.fromCssColorString("#FFD166");
  const CHILD_BOUNDARY = Cesium.Color.fromCssColorString("#E8F0F5");
  // Widths follow design/tokens.json `boundary` and the grounded boundary
  // contract: parent 7 px underlay + 3.5 px main, child 4 px + 2 px,
  // selected 8 px + 4 px, supplemental 1.5 px.
  const PARENT_BOUNDARY_WIDTH = 3.5;
  const PARENT_DRAW_WIDTH = 3.5;
  const PARENT_UNDERLAY_WIDTH = 7;
  const CHILD_BOUNDARY_WIDTH = 2;
  const CHILD_UNDERLAY_WIDTH = 4;
  const SELECTED_BOUNDARY_WIDTH = 4;
  const SELECTED_UNDERLAY_WIDTH = 8;
  const SUPPLEMENTAL_BOUNDARY_WIDTH = 1.5;
  // Overview fill alpha mirrors tokens.colors.fillParent. It is written once and
  // then left alone: the fill stays a static terrain-classified surface so it
  // never rebuilds ground batches or costs the parent line.
  const PARENT_FILL_ALPHA = 0.09;
  // Base-layer grade. Satellite providers hand back whatever tone their own
  // mosaic happens to carry, so the cool-white direct-child line reads
  // differently from one county to the next. Pulling every master onto one
  // muted, slightly darkened base gives the boundary hierarchy a predictable
  // contrast instead of a per-region lottery. Override in
  // apps/cesium-player/public/imagery-config.json under `visual`.
  const VISUAL_GRADE_DEFAULTS = {
    imageryBrightness: 0.9,
    imageryContrast: 1.05,
    imagerySaturation: 0.78,
    imageryGamma: 1,
    imageryHue: 0
  };
  // Every runtime visual knob shares one resolver. Booleans only accept
  // booleans and numbers only accept finite numbers, so a malformed value in
  // imagery-config.json falls back to the documented default instead of
  // silently switching a layer off or grading the master to black.
  function resolveOptions(raw, defaults) {
    const source = raw && typeof raw === "object" ? raw : {};
    const resolved = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const fallback = defaults[key];
      if (typeof fallback === "boolean") {
        if (typeof source[key] === "boolean") resolved[key] = source[key];
        continue;
      }
      const value = Number(source[key]);
      if (Number.isFinite(value)) resolved[key] = value;
    }
    return resolved;
  }
  // ImageryLayer.hue is in radians; 0 leaves the imagery colour unmodified.
  const resolveVisualGrade = (raw) => resolveOptions(raw, VISUAL_GRADE_DEFAULTS);
  // ---- Label distance response -------------------------------------------
  // Cesium multiplies Label.scale by the scaleByDistance factor (see
  // EYE_DISTANCE_SCALING in LabelCollectionVS: `scale *= distanceScale`), so
  // these ratios ride on top of the authored keyframe scale instead of
  // replacing it. The reference distance is derived from the region's own
  // overview preset, which reproduces the documented type size exactly at the
  // overview and only lets the closer tour shots grow and far pull-backs shrink.
  const LABEL_SCALE_NEAR_RATIO = 0.5;
  const LABEL_SCALE_NEAR_VALUE = 1.1;
  const LABEL_SCALE_FAR_RATIO = 3;
  const LABEL_SCALE_FAR_VALUE = 0.68;
  const LABEL_TRANSLUCENCY_NEAR_RATIO = 1;
  const LABEL_TRANSLUCENCY_FAR_RATIO = 2.8;
  const LABEL_DECLUTTER_PADDING_X = 5;
  const LABEL_DECLUTTER_PADDING_Y = 3;
  const LABEL_DISTANCE_DEFAULTS = { distanceScale: true, translucency: true, declutter: true };
  // ---- Out-of-region focus mask ------------------------------------------
  // Documentary framing cue: everything outside the narrated administrative
  // area sits under a low-opacity dark surface while the area itself keeps the
  // untouched terrain texture. Alpha stays far below the "opaque region fill"
  // the imagery contract forbids.
  const FOCUS_MASK_COLOR = Cesium.Color.fromCssColorString("#021018");
  const FOCUS_MASK_DEFAULTS = { enabled: true, alpha: 0.24, bboxExpand: 3.2, fadeSeconds: 3.6 };
  // A rectangle sized only against `region.bbox` follows the bounding box, not the
  // frame. The overview camera is applied as `lookAt(target, HeadingPitchRange(
  // heading, pitch, range))` on the region centre, so `cameraPreset.height` is the
  // *slant range* to that ground target and the visible ground is a trapezoid whose
  // far edge is the wide one. Sizing the rectangle against the bounding box alone
  // therefore let the mask's own left and right edges walk into frame as two
  // straight, geographically meaningless seams. That is not a corner case: of the
  // 138 shipped region x profile x range-scale combinations, 86 were short of the
  // frame, worst by 113 km (茂名市 440900 portrait). The maths that closes it is the
  // block below, which sizes the rectangle against the frame footprint as well.
  // ---- focus mask frame footprint maths (pure, test-extractable) ------------
  // Cesium applies `PerspectiveFrustum.fov` to the wider screen axis and the runtime
  // never overrides it, so the overview frames 60 degrees across the long edge.
  // Aspect comes from the profile — the same documented frame the pixel weights are
  // authored against. The footprint maths is exact for a flat ellipsoid, so the
  // margin only has to absorb terrain relief, the flight apex and the child-tour
  // range scale. Everything here takes plain numbers and uses only `Math` so the
  // render contract test can execute it instead of pattern-matching the source.
  const FOCUS_MASK_FRUSTUM_FOV_DEGREES = 60;
  const FOCUS_MASK_FRAME_ASPECTS = { landscape: 1920 / 1080, portrait: 1080 / 1920, square: 1 };
  const FOCUS_MASK_FOOTPRINT_MARGIN = 1.25;
  // Ground offsets of the four frustum corners relative to the point the camera
  // looks at, in metres east/north.
  function frameGroundFootprintCorners(rangeMeters, pitchDegrees, headingDegrees, aspectRatio, fovDegrees) {
    const range = Number(rangeMeters);
    const pitch = Math.abs(Number(pitchDegrees));
    const aspect = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
    const radians = (degrees) => (degrees * Math.PI) / 180;
    const halfLongEdge = radians(Number(fovDegrees) / 2);
    // A camera looking straight down (or at the horizon) has no usable trapezoid.
    if (!Number.isFinite(range) || range <= 0) return null;
    if (!Number.isFinite(pitch) || pitch <= 5 || pitch >= 89) return null;
    const sinPitch = Math.sin(radians(pitch));
    const cosPitch = Math.cos(radians(pitch));
    const tanHalfWidth = Math.tan(aspect >= 1
      ? halfLongEdge
      : Math.atan(Math.tan(halfLongEdge) * aspect));
    const tanHalfHeight = Math.tan(aspect >= 1
      ? Math.atan(Math.tan(halfLongEdge) / aspect)
      : halfLongEdge);
    const heading = radians(Number(headingDegrees) || 0);
    const corners = [];
    for (const sideX of [-1, 1]) {
      for (const sideY of [-1, 1]) {
        // Downward component of the corner ray, negated: still positive means the
        // ray is travelling down. sideY = 1 is the shallow corner, the far one.
        const down = sinPitch - cosPitch * tanHalfHeight * sideY;
        if (down <= 1e-6) return null;
        const travel = (range * sinPitch) / down;
        const along = travel * (cosPitch + sinPitch * tanHalfHeight * sideY) - range * cosPitch;
        const across = travel * tanHalfWidth * sideX;
        corners.push({
          east: along * Math.sin(heading) + across * Math.cos(heading),
          north: along * Math.cos(heading) - across * Math.sin(heading)
        });
      }
    }
    return corners;
  }

  // Frame footprint of one camera preset in degrees, already grown by the margin.
  // Uses the preset range unscaled: the child-tour overview pulls the camera in by
  // PARENT_OVERVIEW_CAMERA_HEIGHT_SCALE, which only shrinks the footprint, so the
  // unscaled range stays the conservative case. Returns null for an unusable
  // preset, leaving the bbox box as the only sizing rule.
  function focusMaskFootprintBounds(preset, profileName) {
    const centerLon = Number(preset?.longitude);
    const centerLat = Number(preset?.latitude);
    if (!Number.isFinite(centerLon) || !Number.isFinite(centerLat)) return null;
    const corners = frameGroundFootprintCorners(
      Number(preset.height),
      Number(preset.pitch ?? CAMERA_PITCH),
      Number(preset.heading) || 0,
      FOCUS_MASK_FRAME_ASPECTS[profileName] ?? FOCUS_MASK_FRAME_ASPECTS.landscape,
      FOCUS_MASK_FRUSTUM_FOV_DEGREES
    );
    if (!corners) return null;
    const metersPerDegreeLat = 111320;
    const metersPerDegreeLon = metersPerDegreeLat * Math.max(0.02, Math.cos((centerLat * Math.PI) / 180));
    const bounds = { west: centerLon, east: centerLon, south: centerLat, north: centerLat };
    for (const corner of corners) {
      const lon = centerLon + (corner.east * FOCUS_MASK_FOOTPRINT_MARGIN) / metersPerDegreeLon;
      const lat = centerLat + (corner.north * FOCUS_MASK_FOOTPRINT_MARGIN) / metersPerDegreeLat;
      bounds.west = Math.min(bounds.west, lon);
      bounds.east = Math.max(bounds.east, lon);
      bounds.south = Math.min(bounds.south, lat);
      bounds.north = Math.max(bounds.north, lat);
    }
    return bounds;
  }

  // Union of the bbox floor and the frame footprint: the mask only ever grows.
  function coverFocusMaskBounds(base, cover) {
    if (!cover) return base;
    return {
      west: Math.max(-179.9, Math.min(base.west, cover.west)),
      east: Math.min(179.9, Math.max(base.east, cover.east)),
      south: Math.max(-89.9, Math.min(base.south, cover.south)),
      north: Math.min(89.9, Math.max(base.north, cover.north))
    };
  }
  // ---- end focus mask frame footprint maths ---------------------------------
  // ---- portrait overview framing (pure, test-extractable) -------------------
  // The portrait overview is the establishing shot: the whole administrative
  // area framed in a 9:16 frame. Both of its numbers used to be read back out of
  // the region record instead of derived from the boundary, and that is what
  // went wrong.
  //
  // `cameraProfiles.portrait` is a cached fit. `import-shapefile.py` refreshes
  // `bbox` and `cameraPreset` from the boundary it just read but preserves the
  // portrait profile verbatim (`existing.get("portrait") or {...}`), so when a
  // boundary revision moves the extent the frame keeps aiming at the old one:
  // 草潭镇 440823113 was re-imported after an internal boundary revision and
  // kept a target 873 m west of its current centre. Measured on the shipped
  // player at 540x960 that frame held a 94 px left margin against 35 px on the
  // right, i.e. the boundary visibly pushed off centre -- the reported defect.
  // A project's frozen boundary snapshot carries the same stale value, so the
  // repair has to happen where the frame is computed, not in the data.
  //
  // The range was a magic multiplier (`max(width, height) * 2250 * 0.8`) that
  // ignores the frame aspect and the frustum, so one nominal scale produced
  // 56 %..91 % width coverage across the 25 shipped townships, and the widest of
  // them (东里镇 440882110) overflowed the frame once the child tour pulled the
  // camera in.
  //
  // Both are now derived from the geometry the player actually draws, using the
  // same 60 degree long-edge frustum the focus-mask maths documents: the
  // smallest slant range that keeps every boundary vertex inside
  // `SAFE_FRACTION` of the frame. That is ArcGIS's zoom-to-layer evaluated
  // against the extent rather than the bounding box, and it is a pure function
  // of the boundary -- a re-import can no longer leave a stale portrait frame
  // behind.
  //
  // The safe fraction is deliberately less than the frame. The child tour and
  // the closing return re-use this camera at PARENT_OVERVIEW_CAMERA_HEIGHT_SCALE
  // (0.9), which grows the outline by 1/0.9; at 0.82 the tightest moment of the
  // video is 0.91, so the perimeter never touches the frame edge.
  //
  // Aiming at the geographic extent centre is not the same as centring the
  // drawing, because the projection is not affine: a point south of the target
  // sits at a shorter depth and is magnified, so an extent that is symmetric on
  // the ground draws as a trapezoid whose pixel box leans. Measured on the
  // shipped player at 540x960 with the target on 草潭镇's extent centre, the
  // drawn box held a 58 px left margin against 47 px on the right and 302 px on
  // top against 256 px at the bottom -- 1.0 % and 2.4 % of the frame. The target
  // is therefore walked to the fixed point where the *projected* box is
  // centred, which is what ArcGIS's zoom-to-layer shows, and which also lets the
  // range tighten (草潭镇 27671 m -> 26593 m, the drawn width reaching the 0.82
  // bound exactly instead of 0.80).
  const PORTRAIT_OVERVIEW_FRAME_ASPECT = 1080 / 1920;
  const PORTRAIT_OVERVIEW_FRUSTUM_FOV_DEGREES = 60;
  const PORTRAIT_OVERVIEW_SAFE_FRACTION = 0.82;
  const PORTRAIT_OVERVIEW_MINIMUM_RANGE_METERS = 4_000;
  const PORTRAIT_OVERVIEW_MAXIMUM_RANGE_METERS = 180_000;
  const PORTRAIT_OVERVIEW_EARTH_METERS_PER_DEGREE = 111_320;
  const PORTRAIT_OVERVIEW_LATITUDE_METERS_PER_DEGREE = 110_570;
  // Degrees. The record's box is written from this same ring at 7 decimals, so a
  // ring that is the drawing boundary matches it far inside this; a truncated or
  // degenerate ring misses by orders of magnitude.
  const PORTRAIT_OVERVIEW_EXTENT_TOLERANCE_DEGREES = 0.0001;
  // Recentring fixed point. The linearised map has unit gain -- shifting the
  // target by one ground metre moves the drawing by one ground metre at the
  // target depth -- so it is damped below 1 to stop it oscillating, and iterated
  // until the residual is far below a pixel. Both bounds are in half-frame units.
  const PORTRAIT_OVERVIEW_RECENTER_GAIN = 0.7;
  const PORTRAIT_OVERVIEW_RECENTER_ITERATIONS = 40;
  const PORTRAIT_OVERVIEW_RECENTER_TOLERANCE = 0.0001;

  // Cesium hands `PerspectiveFrustum.fov` to the wider screen axis, so a
  // portrait frame spends all 60 of its degrees vertically and reaches
  // `aspect` times less sideways.
  function portraitOverviewFrustumTangents(aspectRatio) {
    const aspect = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : PORTRAIT_OVERVIEW_FRAME_ASPECT;
    const halfLongEdge = Math.tan((PORTRAIT_OVERVIEW_FRUSTUM_FOV_DEGREES * Math.PI) / 360);
    return aspect >= 1
      ? { horizontal: halfLongEdge, vertical: Math.tan(Math.atan(halfLongEdge / aspect)) }
      : { horizontal: Math.tan(Math.atan(halfLongEdge * aspect)), vertical: halfLongEdge };
  }

  // Screen position of a ground point, in half-frame units, for a camera parked
  // `range` metres from the point it looks at. `lookAt(HeadingPitchRange)`
  // orients the camera at its target, so the basis is forward = cos(pitch) *
  // north - sin(pitch) * up with camera-up = sin(pitch) * north + cos(pitch) *
  // up. The pitched ground plane frames a trapezoid rather than a rectangle: the
  // near edge of the extent sits at a shorter depth and is magnified, and that
  // is the side which runs out of frame first.
  function portraitOverviewScreenFractions(eastMeters, northMeters, rangeMeters, pitchDegrees, tangents) {
    const scale = tangents || portraitOverviewFrustumTangents();
    const pitch = Math.abs(Number(pitchDegrees) || 0) * (Math.PI / 180);
    const depth = Number(rangeMeters) + northMeters * Math.cos(pitch);
    if (!(depth > 0)) return { x: Infinity, y: Infinity };
    return {
      x: eastMeters / (depth * scale.horizontal),
      y: (northMeters * Math.sin(pitch)) / (depth * scale.vertical)
    };
  }

  // Smallest range whose frame holds every point inside the safe fraction. Every
  // constraint is linear in the range, so this solves them instead of walking a
  // candidate list. Both axes share the `- north * cos(pitch)` term: the depth
  // at a point is `range + north * cos(pitch)`, so a point south of the target
  // is nearer and tolerates a proportionally smaller range, which is the same
  // relation `portraitOverviewScreenFractions` reads back out.
  function portraitOverviewRange(points, pitchDegrees, safeFraction, tangents) {
    const scale = tangents || portraitOverviewFrustumTangents();
    const share = Number.isFinite(safeFraction) && safeFraction > 0 && safeFraction <= 1
      ? safeFraction
      : PORTRAIT_OVERVIEW_SAFE_FRACTION;
    const pitch = Math.abs(Number(pitchDegrees) || 0) * (Math.PI / 180);
    const sinPitch = Math.sin(pitch);
    const cosPitch = Math.cos(pitch);
    const horizontal = share * scale.horizontal;
    const vertical = share * scale.vertical;
    let range = PORTRAIT_OVERVIEW_MINIMUM_RANGE_METERS;
    for (const point of Array.isArray(points) ? points : []) {
      const east = Number(point?.east);
      const north = Number(point?.north);
      if (!Number.isFinite(east) || !Number.isFinite(north)) continue;
      range = Math.max(
        range,
        Math.abs(east) / horizontal - north * cosPitch,
        (Math.abs(north) * sinPitch) / vertical - north * cosPitch
      );
    }
    return Math.min(PORTRAIT_OVERVIEW_MAXIMUM_RANGE_METERS, Math.ceil(range));
  }

  // The drawn extents of `points` in half-frame units, as a box plus its centre.
  // `centreX`/`centreY` are what the recentring loop drives to zero; they are
  // read with the same `portraitOverviewScreenFractions` the fit is written
  // against, so a frame that reports centred here is centred in the rendered
  // frame and not merely on the ground.
  function portraitOverviewProjectedBox(points, rangeMeters, pitchDegrees, tangents) {
    const scale = tangents || portraitOverviewFrustumTangents();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const point of Array.isArray(points) ? points : []) {
      const fraction = portraitOverviewScreenFractions(point?.east, point?.north, rangeMeters, pitchDegrees, scale);
      if (!Number.isFinite(fraction.x) || !Number.isFinite(fraction.y)) continue;
      minX = Math.min(minX, fraction.x);
      maxX = Math.max(maxX, fraction.x);
      minY = Math.min(minY, fraction.y);
      maxY = Math.max(maxY, fraction.y);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    return { minX, maxX, minY, maxY, centreX: (minX + maxX) / 2, centreY: (minY + maxY) / 2 };
  }

  // Ground offset from the extent centre to the target that centres the drawing,
  // together with the range at that target. Shifting the target is what moves
  // the drawing, so the loop shifts it by the measured pixel offset converted
  // back to metres at the current depth, and re-solves the range because it
  // depends on where the target sits. The best iterate is kept rather than the
  // last, so a shape the damping suits badly still returns a converged-ish
  // answer instead of a diverged one.
  function portraitOverviewTarget(points, pitchDegrees, safeFraction, tangents) {
    const scale = tangents || portraitOverviewFrustumTangents();
    const usable = (Array.isArray(points) ? points : [])
      .map((point) => ({ east: Number(point?.east), north: Number(point?.north) }))
      .filter((point) => Number.isFinite(point.east) && Number.isFinite(point.north));
    if (usable.length === 0) {
      return { eastMeters: 0, northMeters: 0, rangeMeters: PORTRAIT_OVERVIEW_MINIMUM_RANGE_METERS };
    }
    const pitch = Math.abs(Number(pitchDegrees) || 0) * (Math.PI / 180);
    const sinPitch = Math.sin(pitch);
    let eastMeters = 0;
    let northMeters = 0;
    let best = null;
    for (let iteration = 0; iteration < PORTRAIT_OVERVIEW_RECENTER_ITERATIONS; iteration += 1) {
      const shifted = usable.map((point) => ({
        east: point.east - eastMeters,
        north: point.north - northMeters
      }));
      const rangeMeters = portraitOverviewRange(shifted, pitchDegrees, safeFraction, scale);
      const box = portraitOverviewProjectedBox(shifted, rangeMeters, pitchDegrees, scale);
      if (!box) break;
      const error = Math.hypot(box.centreX, box.centreY);
      if (!best || error < best.error) {
        best = { error, eastMeters, northMeters, rangeMeters };
      }
      if (error <= PORTRAIT_OVERVIEW_RECENTER_TOLERANCE) break;
      // `y` reads out as `north * sin(pitch) / depth`; at a pitch of zero every
      // point projects onto the horizon line and there is nothing to recentre
      // vertically, so the north term is dropped rather than divided by zero.
      const northGain = sinPitch > 1e-6 ? sinPitch : 0;
      eastMeters += PORTRAIT_OVERVIEW_RECENTER_GAIN * box.centreX * rangeMeters * scale.horizontal;
      northMeters += PORTRAIT_OVERVIEW_RECENTER_GAIN
        * ((box.centreY * rangeMeters * scale.vertical) / (northGain || 1));
    }
    return best
      ? { eastMeters: best.eastMeters, northMeters: best.northMeters, rangeMeters: best.rangeMeters }
      : { eastMeters: 0, northMeters: 0, rangeMeters: PORTRAIT_OVERVIEW_MINIMUM_RANGE_METERS };
  }

  // Every boundary vertex in metres east/north of the extent centre, plus that
  // centre -- the frame's starting target, which `portraitOverviewTarget` then
  // offsets. Vertices rather than bounding-box corners: the corners are the
  // conservative box, and fitting them keeps a west-east extreme that actually
  // sits mid-latitude ~10 % too far away.
  //
  // A ring that does not reach the record's own bounding box is not the drawing
  // boundary -- 新安街道办事处 440306017 ships a two-point ring against a
  // 0.07 x 0.09 degree box -- and fitting that sliver would park the camera
  // inside the subject. Only a ring that spans the recorded box is trusted;
  // otherwise the box corners frame the region, which is also the fallback for a
  // record carrying no geometry at all.
  function portraitOverviewExtent(bounds, geometry) {
    const box = Array.isArray(bounds) && bounds.length === 4 ? bounds.map(Number) : null;
    const boxUsable = Boolean(box) && box.every(Number.isFinite) && box[2] > box[0] && box[3] > box[1];
    const vertices = [];
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    const features = Array.isArray(geometry?.features) ? geometry.features : geometry?.type === "Feature" ? [geometry] : [];
    for (const feature of features) {
      const shape = feature?.geometry;
      const polygons = shape?.type === "Polygon"
        ? [shape.coordinates]
        : shape?.type === "MultiPolygon" ? shape.coordinates : [];
      for (const polygon of Array.isArray(polygons) ? polygons : []) {
        const ring = Array.isArray(polygon) ? polygon[0] : null;
        if (!Array.isArray(ring)) continue;
        for (const pair of ring) {
          const longitude = Number(pair?.[0]);
          const latitude = Number(pair?.[1]);
          if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
          vertices.push([longitude, latitude]);
          west = Math.min(west, longitude);
          east = Math.max(east, longitude);
          south = Math.min(south, latitude);
          north = Math.max(north, latitude);
        }
      }
    }
    const ringSpansRecordedBox = vertices.length > 0 && (
      !boxUsable
      || (
        west <= box[0] + PORTRAIT_OVERVIEW_EXTENT_TOLERANCE_DEGREES
        && east >= box[2] - PORTRAIT_OVERVIEW_EXTENT_TOLERANCE_DEGREES
        && south <= box[1] + PORTRAIT_OVERVIEW_EXTENT_TOLERANCE_DEGREES
        && north >= box[3] - PORTRAIT_OVERVIEW_EXTENT_TOLERANCE_DEGREES
      )
    );
    if (boxUsable && !ringSpansRecordedBox) {
      west = box[0];
      east = box[2];
      south = box[1];
      north = box[3];
    }
    if (!Number.isFinite(west) || !Number.isFinite(south) || east <= west || north <= south) return null;
    const longitude = (west + east) / 2;
    const latitude = (south + north) / 2;
    const metersPerDegreeLongitude = PORTRAIT_OVERVIEW_EARTH_METERS_PER_DEGREE * Math.cos((latitude * Math.PI) / 180);
    const source = ringSpansRecordedBox ? vertices : [[west, south], [east, south], [east, north], [west, north]];
    return {
      longitude,
      latitude,
      points: source.map(([lon, lat]) => ({
        east: (lon - longitude) * metersPerDegreeLongitude,
        north: (lat - latitude) * PORTRAIT_OVERVIEW_LATITUDE_METERS_PER_DEGREE
      }))
    };
  }

  // Region record whose portrait profile is re-derived from the boundary it will
  // draw. Only records that already carry a portrait profile are touched: a
  // prefecture or district record has none, and its single `cameraPreset` is the
  // wide context shot the opening descent starts from.
  function applyPortraitZoomToLayer(regionData, geometry) {
    const profile = regionData?.cameraProfiles?.portrait;
    if (!profile) return regionData;
    const extent = portraitOverviewExtent(regionData?.bbox, geometry);
    if (!extent) return regionData;
    const pitch = profile.pitch ?? CAMERA_PITCH;
    const target = portraitOverviewTarget(extent.points, pitch, PORTRAIT_OVERVIEW_SAFE_FRACTION);
    return {
      ...regionData,
      cameraProfiles: {
        ...regionData.cameraProfiles,
        portrait: {
          ...profile,
          longitude:
            extent.longitude
            + target.eastMeters
              / (PORTRAIT_OVERVIEW_EARTH_METERS_PER_DEGREE * Math.cos((extent.latitude * Math.PI) / 180)),
          latitude: extent.latitude + target.northMeters / PORTRAIT_OVERVIEW_LATITUDE_METERS_PER_DEGREE,
          height: target.rangeMeters
        }
      }
    };
  }
  // ---- end portrait overview framing ----------------------------------------
  // ---- opening preview hold maths (pure, test-extractable) ------------------
  // Offset past the opening descent at which the editor replay parks its final
  // frame. That single frame is what Studio keeps on screen once the pen has
  // drawn, so it has to sit late enough for every layer of the settled look to
  // have arrived. The parent trace settles at `settleTime`, and the
  // out-of-region recession is deliberately anchored to that same settle before
  // easing in over the mask's own fade, so a hold pinned to the settle moment
  // freezes the mask around a quarter of the way up its ramp — measured 0.0183
  // of a configured 0.24, which reads as no recession at all while the exported
  // video is visibly dimmed from the same moment onwards. The trailing margin
  // covers committing the completed boundary and the region label.
  function settledOverviewHoldSeconds(settleTime, fadeSeconds, maskEnabled) {
    const settle = Number(settleTime);
    if (!Number.isFinite(settle) || settle <= 0) return null;
    const recession = maskEnabled ? Math.max(0, Number(fadeSeconds) || 0) : 0;
    return settle + recession + 0.8;
  }
  // ---- end opening preview hold maths ---------------------------------------
  // ---- Tianditu label legibility -------------------------------------------
  /* 天地图的 `cia`（影像注记）是 256 px 位图，地名只有 9–10 px 高 —— 桌面地图的
     字号。竖屏成片只有 1080 px 宽，它占幅宽不到 1%（手机上约 4 pt），而本项目
     自绘的标签是 46–86 px，两者差 5 倍，同一个画面里像两个尺度。
     位图注记没有字号可调，唯一的杠杆是让 Cesium 把同一张瓦片铺到更大的屏幕面积
     上：`levelZeroMaximumTexelSpacing` 与 `tileWidth` 成反比（Cesium 1.143
     `getLevelWithMaximumTexelSpacing`），声明 512 px 瓦片会让请求层级整体低一级，
     每张瓦片随之被放大两倍 —— 字大一倍，代价是轻微发虚。
     倍数只能取 2 的幂：中间值会落在 `Math.round(level)` 的临界点上，同一趟导出里
     层级会随纬度和相机高度跳变，画面上的字号忽大忽小。`?annScale=` 只给 A/B
     验证脚本用，正式抓帧走这里的常量。 */
  const ANNOTATION_TILE_SCALE = (() => {
    const override = Number(new URLSearchParams(location.search).get("annScale"));
    if (Number.isFinite(override) && override > 0) return Math.max(1, Math.min(4, override));
    return 2;
  })();
  const ANNOTATION_TILE_PX = 256 * ANNOTATION_TILE_SCALE;
  // ---- Named physical features (rivers, ridges, ...) ---------------------
  const FEATURE_RIVER_COLOR = Cesium.Color.fromCssColorString("#4AA8FF");
  const FEATURE_LABEL_FONT_SIZE = 46;
  const FEATURE_RIVER_WIDTH = 3;
  const FEATURE_RIVER_HALO_WIDTH = 8;
  const FEATURE_SEGMENTS = 14;
  const FEATURE_Z_INDEX = 60;
  const FEATURE_REVEAL_DEFAULT_SECONDS = 2.6;
  const FEATURE_DEFAULTS = { enabled: true };
  const CHILD_BOUNDARY_Z_INDEX = 120;
  const SELECTED_BOUNDARY_Z_INDEX = 160;
  // Child geography wins shared edges during the tour. The hierarchy reverses
  // only for the closing overview, where the parent perimeter is the subject.
  const TOUR_PARENT_BOUNDARY_Z_INDEX = 100;
  const RETURN_PARENT_BOUNDARY_Z_INDEX = 180;
  const PARENT_LABEL_FONT_SIZE = 86;
  const CHILD_LABEL_FONT_SIZE = 56;
  const RETURN_LABEL_SCALE = 0.68;
  const PARENT_OVERVIEW_BOUNDARY_STRENGTH = 1;
  const TOUR_PARENT_BOUNDARY_STRENGTH = 0.82;
  const PARENT_OVERVIEW_LABEL_STRENGTH = 0.9;
  const RETURN_CHILD_BOUNDARY_ALPHA_SCALE = 0.5;
  const PARENT_DRAW_SEGMENTS = 56;
  // Keep every ground primitive resident with an imperceptible non-zero alpha.
  // Runtime show/hide or zero-alpha transitions can rebuild Cesium batches.
  const BOUNDARY_PREWARM_ALPHA = 0.001;
  const scaledVisualPx = (value) => Number((value * STUDIO_PREVIEW_VISUAL_SCALE * OUTPUT_RESOLUTION_SCALE).toFixed(3));
  const scaledTypographyPx = (value) => Number((value * STUDIO_PREVIEW_TYPOGRAPHY_SCALE).toFixed(3));
  const readableLabelOutlineAlpha = (fillAlpha) => Math.min(
    LABEL_OUTLINE_MAX_ALPHA,
    Math.max(0, Number(fillAlpha) || 0) * LABEL_OUTLINE_ALPHA_RATIO
  );
  const readableChildLabelOutlineAlpha = (fillAlpha) => Math.min(
    CHILD_LABEL_OUTLINE_MAX_ALPHA,
    Math.max(0, Number(fillAlpha) || 0) * CHILD_LABEL_OUTLINE_ALPHA_RATIO
  );
  let viewer = null;
  let region = null;
  let fromRegion = null;
  let timeline = null;
  let annotationLayer = null;
  let annotationWindows = [];
  /** Label-tile request bookkeeping; exported through `getDiagnostics`. */
  const annotationStats = { retries: 0, recovered: 0, failed: 0 };
  let fromBoundarySource = null;
  let selectedBoundarySource = null;
  let siblingBoundaryEntities = [];
  let fromOutlineEntities = [];
  let selectedOutlineEntities = [];
  let fromLabelEntity = null;
  let selectedLabelEntity = null;
  let fromFillProperties = [];
  let fromOutlineProperties = [];
  let selectedFillProperties = [];
  let selectedOutlineProperties = [];
  let fromLabelProperties = [];
  let selectedLabelProperties = [];
  let contextParentOutlineEntities = [];
  let parentTopic = false;
  let childTour = false;
  let parentFillSource = null;
  let parentFillProperties = [];
  let childFillSource = null;
  let childFillPropertiesById = new Map();
  let childFillEntitiesById = new Map();
  let parentRevealEntities = [];
  let parentRevealRings = [];
  let parentRevealColorProperties = [];
  let parentDrawSegments = [];
  let parentStableBoundaryEntities = [];
  let parentStableBoundaryColorProperties = [];
  let parentStableUnderlayColorProperties = [];
  let parentPenEntity = null;
  let parentPenPositionProperty = null;
  let parentPenColorProperty = null;
  let childBoundaryEntities = [];
  let childBoundaryColorProperties = [];
  let childBoundaryColorPropertiesById = new Map();
  let childSelectionEntities = [];
  let childSelectionEntitiesById = new Map();
  let childSelectionColorPropertiesById = new Map();
  let supplementalChildIds = new Set();
  let childLabelEntities = [];
  let childLabelEntitiesById = new Map();
  let childLabelColorPropertiesById = new Map();
  let childLabelScalePropertiesById = new Map();
  let childLabelPositionsById = new Map();
  let previousVisibleLabelIds = new Set();
  // Camera-to-subject distance that the label type sizes were authored against.
  // Rebuilt per region from its own overview preset; the fallback matches the
  // common portrait overview so labels never start out unscaled.
  let labelReferenceDistance = 42000;
  let labelDistanceOptions = { ...LABEL_DISTANCE_DEFAULTS };
  let focusMaskOptions = { ...FOCUS_MASK_DEFAULTS };
  let focusMaskEntity = null;
  let focusMaskColorProperty = null;
  let focusMaskResolved = null;
  let featureOptions = { ...FEATURE_DEFAULTS };
  let namedFeatureSources = [];
  let namedFeatures = [];
  let activeTerrainLabel = "ellipsoid";
  // Module scope, not a local of initialize(): getDiagnostics() reports the
  // resolved provider, and a local here made the whole diagnostics call throw.
  let runtimeConfig = {};

  /**
   * Authoring data (region JSON, child boundaries, feature geometry) is
   * re-imported on the machine that serves this page, so a cached copy can
   * outlive the data it describes. The server stamps `/runtime-config.json`
   * with the newest mtime under `data/**`; appending it here means unchanged
   * data still hits the browser cache, while a re-import lands on a brand-new
   * URL instead of replaying yesterday's boundary.
   */
  // A scheme renders from the boundary it was authored against, not from
  // whatever `data/` holds right now. The Studio preview passes the scheme id,
  // and the player asks the server for that scheme's frozen copy first, falling
  // back to the live workspace data. Without the parameter — bare `?region=`
  // playback, or the frame-capture sandbox — nothing changes.
  let boundaryScopeId = null;
  let boundaryScopeResolved = false;
  function resolveBoundaryScope() {
    if (boundaryScopeResolved) return boundaryScopeId;
    boundaryScopeResolved = true;
    const value = new URLSearchParams(location.search).get("boundary");
    boundaryScopeId = value && /^[a-zA-Z0-9_-]+$/.test(value) ? value : null;
    return boundaryScopeId;
  }
  function withDataVersion(url) {
    let target = url;
    const scope = resolveBoundaryScope();
    if (scope) target += (target.includes("?") ? "&" : "?") + "boundary=" + encodeURIComponent(scope);
    const version = runtimeConfig.dataVersion;
    if (!version) return target;
    return target + (target.includes("?") ? "&" : "?") + "v=" + encodeURIComponent(String(version));
  }
  let parentTopicLabelEntity = null;
  let parentTopicLabelProperties = [];
  let parentTopicLabelPositionProperty = null;
  let parentTopicLabelScaleProperty = null;
  let parentTopicLabelPixelOffsetProperty = null;
  let cityCamera = { lon: 110.32, lat: 21.0, height: 480000, heading: 0, pitch: CAMERA_PITCH };
  let currentTime = 0;
  let presentationTime = 0;
  let openingDescent = null;
  let cloudCollection = null;
  let openingClouds = [];
  const cloudDeckOverlay = document.getElementById("cloudDeckOverlay");
  const cloudPassOverlay = document.getElementById("cloudPassOverlay");
  const cesiumContainer = document.getElementById("cesiumContainer");
  const editorBoundaryOverlay = document.getElementById("editorBoundaryOverlay");
  let initialized = false;
  let renderStable = false;
  let previewImageryFallback = false;
  let previewAnimationFrame = null;
  let parentRevealTimingOverride = null;
  let editorParentPreviewHold = false;
  let editorBoundaryLastReveal = -1;
  let editorBoundaryLastStrength = -1;
  let editorBoundaryLastViewSignature = "";
  let editorBoundaryPendingReveal = 0;
  let editorBoundaryPendingStrength = 0;
  const errors = [];

  const titleEl = document.getElementById("sceneTitle");
  const statusEl = document.getElementById("status");
  const runtimeErrorEl = document.getElementById("runtimeError");
  const query = new URLSearchParams(location.search);
  if (query.has("studioPreview")) document.body.dataset.studioPreview = "1";
  // Formal capture opts into the same screen-space trace used by Studio.
  // Cesium's grounded reveal primitives are intentionally segmented and can
  // commit one segment at a time, while the pen billboard moves continuously.
  // Keeping this opt-in avoids changing the production camera/imagery quality
  // settings while making the exported trace frame-exact with the pen.
  if (query.has("boundaryCanvas")) document.body.dataset.boundaryCanvas = "1";
  if (query.get("diagnostics") === "1") document.body.dataset.diagnostics = "1";
  if (query.get("clean") === "1") document.body.dataset.clean = "1";

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smootherStep = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const rangeProgress = (time, start, duration) => smootherStep(clamp((time - start) / duration, 0, 1));

  function setColorProperty(property, color) {
    const previous = property.getValue(viewer?.clock?.currentTime);
    const unchanged = previous
      && Math.abs(previous.red - color.red) <= 0.0001
      && Math.abs(previous.green - color.green) <= 0.0001
      && Math.abs(previous.blue - color.blue) <= 0.0001
      && Math.abs(previous.alpha - color.alpha) <= 0.0001;
    if (!unchanged) property.setValue(color);
  }

  function setNumberProperty(property, value) {
    const previous = Number(property.getValue(viewer?.clock?.currentTime));
    if (!Number.isFinite(previous) || Math.abs(previous - value) > 0.0001) property.setValue(value);
  }

  // Mirrors czm_nearFarScalar so the JS-side screen boxes used for avoidance
  // see exactly the scale Cesium is about to apply in the vertex shader.
  function nearFarRamp(reference, nearRatio, nearValue, farRatio, farValue, distance) {
    const near = reference * nearRatio;
    const far = reference * farRatio;
    if (!(far > near) || !Number.isFinite(distance)) return nearValue;
    return lerp(nearValue, farValue, clamp((distance - near) / (far - near), 0, 1));
  }

  const labelDistanceScale = (distance) => (labelDistanceOptions.distanceScale
    ? nearFarRamp(
        labelReferenceDistance,
        LABEL_SCALE_NEAR_RATIO,
        LABEL_SCALE_NEAR_VALUE,
        LABEL_SCALE_FAR_RATIO,
        LABEL_SCALE_FAR_VALUE,
        distance
      )
    : 1);

  const labelScaleByDistance = () => (labelDistanceOptions.distanceScale
    ? new Cesium.NearFarScalar(
        labelReferenceDistance * LABEL_SCALE_NEAR_RATIO,
        LABEL_SCALE_NEAR_VALUE,
        labelReferenceDistance * LABEL_SCALE_FAR_RATIO,
        LABEL_SCALE_FAR_VALUE
      )
    : undefined);

  const labelTranslucencyByDistance = () => (labelDistanceOptions.translucency
    ? new Cesium.NearFarScalar(
        labelReferenceDistance * LABEL_TRANSLUCENCY_NEAR_RATIO,
        1,
        labelReferenceDistance * LABEL_TRANSLUCENCY_FAR_RATIO,
        0
      )
    : undefined);

  // The overview preset frames the subject from a pitched camera, so the label
  // ramp is authored against the slant range to that ground point rather than
  // the raw ellipsoid height.
  function resolveLabelReferenceDistance() {
    const profileName = query.get("profile") || (innerHeight > innerWidth ? "portrait" : "landscape");
    const preset = region?.cameraProfiles?.[profileName] || region?.cameraPreset;
    const height = Number(preset?.height) || 38000;
    const pitch = Number(preset?.pitch ?? CAMERA_PITCH);
    return height / Math.max(0.35, Math.sin(Math.abs(Cesium.Math.toRadians(pitch))));
  }

  // Builds the on-screen box a child label actually occupies, including the
  // distance factor, so avoidance decisions match the rendered glyph instead of
  // a fixed guess.
  function childLabelScreenBox(id, authoredScale, rank) {
    const entity = childLabelEntitiesById.get(String(id));
    const position = entity?.position?.getValue(viewer.clock.currentTime);
    if (!position) return null;
    const point = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, position);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    const text = String(entity?.label?.text?.getValue(viewer.clock.currentTime) ?? "");
    const distance = Cesium.Cartesian3.distance(viewer.camera.positionWC, position);
    const distanceScale = labelDistanceScale(distance);
    const fontSize = scaledTypographyPx(CHILD_LABEL_FONT_SIZE) * authoredScale * distanceScale;
    return {
      id: String(id),
      rank,
      x: point.x,
      y: point.y,
      distance,
      distanceScale,
      renderedScale: authoredScale * distanceScale,
      textLength: Array.from(text).length,
      halfWidth: Math.max(fontSize, Array.from(text).length * fontSize * 0.48 + 5),
      halfHeight: fontSize * 0.72
    };
  }

  // Screen-space avoidance for the child labels, applied on every frame rather
  // than only during the closing pull-back. Rank keeps the active stop first so
  // a quiet neighbour can never push the narrated place name off screen, and a
  // label that survived the previous frame is preferred over a fresh one so the
  // set does not flicker while the camera is still moving.
  function declutterChildLabels(candidates) {
    const ordered = [...candidates].sort((a, b) => (
      a.rank - b.rank
      || Number(previousVisibleLabelIds.has(b.id)) - Number(previousVisibleLabelIds.has(a.id))
      || a.y - b.y
      || a.x - b.x
    ));
    const accepted = [];
    const visible = new Set();
    for (const candidate of ordered) {
      const overlaps = accepted.some((other) => (
        Math.abs(candidate.x - other.x) < candidate.halfWidth + other.halfWidth + LABEL_DECLUTTER_PADDING_X
        && Math.abs(candidate.y - other.y) < candidate.halfHeight + other.halfHeight + LABEL_DECLUTTER_PADDING_Y
      ));
      if (overlaps) continue;
      accepted.push(candidate);
      visible.add(candidate.id);
    }
    return visible;
  }

  function drawEditorBoundaryReveal(reveal, drawLayerStrength, force = false) {
    if (!editorBoundaryOverlay) return;
    const context = editorBoundaryOverlay.getContext("2d");
    if (!context) return;
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(1, editorBoundaryOverlay.clientWidth);
    const height = Math.max(1, editorBoundaryOverlay.clientHeight);
    const targetWidth = Math.round(width * pixelRatio);
    const targetHeight = Math.round(height * pixelRatio);
    if (editorBoundaryOverlay.width !== targetWidth || editorBoundaryOverlay.height !== targetHeight) {
      editorBoundaryOverlay.width = targetWidth;
      editorBoundaryOverlay.height = targetHeight;
    }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    const cameraPosition = viewer?.camera?.positionCartographic;
    const viewSignature = cameraPosition
      ? [
          targetWidth,
          targetHeight,
          cameraPosition.longitude.toFixed(8),
          cameraPosition.latitude.toFixed(8),
          cameraPosition.height.toFixed(2),
          viewer.camera.heading.toFixed(6),
          viewer.camera.pitch.toFixed(6),
          viewer.camera.roll.toFixed(6)
        ].join(":")
      : `${targetWidth}:${targetHeight}`;
    const forceClear = reveal <= 0.001;
    if (!force && !forceClear
      && Math.abs(reveal - editorBoundaryLastReveal) < 1 / 45
      && Math.abs(drawLayerStrength - editorBoundaryLastStrength) < 1 / 45
      && viewSignature === editorBoundaryLastViewSignature) return;
    editorBoundaryLastReveal = reveal;
    editorBoundaryLastStrength = drawLayerStrength;
    editorBoundaryLastViewSignature = viewSignature;
    context.clearRect(0, 0, width, height);
    // The canvas is the authoritative animated stroke in both preview and
    // deterministic export. Ground-clamped Cesium polyline geometry is rebuilt
    // asynchronously when its positions change, so it cannot stay frame-exact
    // with a seek-driven capture. After the trace settles, the prewarmed static
    // Cesium segments take over and remain visible through the tour.
    if (reveal <= 0.001 || drawLayerStrength <= 0.001 || !viewer) return;
    const paths = [];
    for (const segment of parentDrawSegments) {
      const duration = Math.max(0.0001, segment.endProgress - segment.startProgress);
      const localReveal = clamp((reveal - segment.startProgress) / duration, 0, 1);
      if (localReveal <= 0.001) continue;
      const positions = partialPathAlongPath(segment.positions, localReveal);
      const points = positions
        .map((position) => Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, position))
        .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
      if (points.length >= 2) {
        paths.push(points);
      }
    }
    const strokePaths = (color, lineWidth) => {
      context.save();
      context.strokeStyle = color;
      context.lineWidth = lineWidth;
      context.lineCap = "butt";
      context.lineJoin = "round";
      context.shadowColor = "transparent";
      context.shadowBlur = 0;
      for (const points of paths) {
        context.beginPath();
        context.moveTo(points[0].x, points[0].y);
        for (let index = 1; index < points.length; index += 1) context.lineTo(points[index].x, points[index].y);
        context.stroke();
      }
      context.restore();
    };
    // Match the production contract: one solid lake-blue semantic line. Parent
    // boundaries never gain a second dark outline in later scenes.
    strokePaths(`rgba(45, 156, 219, ${0.96 * drawLayerStrength})`, scaledVisualPx(PARENT_DRAW_WIDTH));
  }

  function groundPositions(ring) {
    return ring.map(([longitude, latitude]) => Cesium.Cartesian3.fromDegrees(longitude, latitude));
  }

  function boundaryUnderlayProperty(mainColorProperty, underlayStrength = 1) {
    return new Cesium.CallbackProperty((time, result) => {
      const main = mainColorProperty.getValue(time);
      const color = Cesium.Color.clone(BOUNDARY_UNDERLAY, result || new Cesium.Color());
      const mainAlpha = main?.alpha ?? 0;
      const synchronized = clamp((mainAlpha - 0.68) / 0.32, 0, 1);
      color.alpha = Math.max(BOUNDARY_PREWARM_ALPHA, Math.pow(synchronized, 1.5) * 0.42 * underlayStrength);
      return color;
    }, false);
  }

  function addGroundedBoundary({ id, positions, mainColorProperty, mainWidth, underlayWidth, zIndex, underlayStrength = 1 }) {
    const underlayZIndex = typeof zIndex === "number" ? zIndex : zIndex.underlay;
    const mainZIndex = typeof zIndex === "number" ? zIndex + 1 : zIndex.main;
    const underlay = viewer.entities.add({
      id: `${id}-underlay`,
      polyline: {
        positions,
        width: underlayWidth,
        clampToGround: true,
        arcType: Cesium.ArcType.GEODESIC,
        zIndex: underlayZIndex,
        material: new Cesium.ColorMaterialProperty(boundaryUnderlayProperty(mainColorProperty, underlayStrength))
      }
    });
    const main = viewer.entities.add({
      id,
      polyline: {
        positions,
        width: mainWidth,
        clampToGround: true,
        arcType: Cesium.ArcType.GEODESIC,
        zIndex: mainZIndex,
        material: new Cesium.ColorMaterialProperty(mainColorProperty)
      }
    });
    return [underlay, main];
  }

  function interpolateAngle(from, to, t) {
    const start = Cesium.Math.toRadians(from);
    const delta = Cesium.Math.negativePiToPi(Cesium.Math.toRadians(to) - start);
    return Cesium.Math.toDegrees(start + delta * smootherStep(t));
  }

  function phasedFlightHeight(fromHeight, toHeight, rawProgress, surfaceDistance) {
    const eased = smootherStep(clamp(rawProgress, 0, 1));
    const apexExtra = clamp(surfaceDistance * 0.08, FLIGHT_APEX_MIN_METERS, FLIGHT_APEX_MAX_METERS);
    const travelArc = Math.pow(Math.sin(Math.PI * eased), 1.35);
    return lerp(fromHeight, toHeight, eased) + apexExtra * travelArc;
  }

  function geodesicCameraState(fromCamera, toCamera, rawProgress) {
    const start = Cesium.Cartographic.fromDegrees(fromCamera.lon, fromCamera.lat);
    const end = Cesium.Cartographic.fromDegrees(toCamera.lon, toCamera.lat);
    const geodesic = new Cesium.EllipsoidGeodesic(start, end, Cesium.Ellipsoid.WGS84);
    const eased = smootherStep(clamp(rawProgress, 0, 1));
    const point = geodesic.interpolateUsingFraction(eased, new Cesium.Cartographic());
    return {
      lon: Cesium.Math.toDegrees(point.longitude),
      lat: Cesium.Math.toDegrees(point.latitude),
      height: phasedFlightHeight(fromCamera.height, toCamera.height, rawProgress, geodesic.surfaceDistance || 0),
      heading: interpolateAngle(fromCamera.heading, toCamera.heading, rawProgress),
      pitch: lerp(fromCamera.pitch, toCamera.pitch, eased)
    };
  }

  function resolveOpeningDescent(regionData) {
    const config = regionData?.openingDescent;
    if (!config || config.enabled === false) return null;
    const seconds = clamp(Number(config.seconds ?? OPENING_DESCENT_DEFAULTS.seconds), 2, 16);
    const cloudsDisabled = query.get("clouds") === "0";
    return {
      seconds,
      startHeightMeters: Math.max(800000, Number(config.startHeightMeters ?? OPENING_DESCENT_DEFAULTS.startHeightMeters)),
      startPitchDegrees: clamp(Number(config.startPitchDegrees ?? OPENING_DESCENT_DEFAULTS.startPitchDegrees), -90, -30),
      cloudDeckHeightMeters: Math.max(20000, Number(config.cloudDeckHeightMeters ?? OPENING_DESCENT_DEFAULTS.cloudDeckHeightMeters)),
      cloudsEnabled: !cloudsDisabled && config.clouds !== false,
      cloudAlphaPeak: clamp(Number(config.cloudAlphaPeak ?? OPENING_DESCENT_DEFAULTS.cloudAlphaPeak), 0, 1)
    };
  }

  function descentCameraState(time) {
    const overview = cameraForRegion(region);
    const cfg = openingDescent;
    const raw = clamp(time / cfg.seconds, 0, 1);
    const eased = smootherStep(raw);
    const heightProgress = Math.pow(eased, 0.86);
    // The descent and the settled parent overview must share one exact target.
    // Otherwise the first boundary frame switches from the raw region height
    // to the child-tour overview scale and creates a visible one-frame zoom.
    const overviewHeight = Number(overview.height) * (childTour ? PARENT_OVERVIEW_CAMERA_HEIGHT_SCALE : 1);
    // A gentle geographic approach adds depth without turning the descent
    // into an orbit. Every component converges on the exact overview camera.
    const headingRadians = Cesium.Math.toRadians(Number(overview.heading ?? 0));
    const approachDegrees = clamp((cfg.startHeightMeters - overviewHeight) / 2_600_000, 0.18, 0.38);
    const startLon = Number(overview.lon) - Math.sin(headingRadians) * approachDegrees;
    const startLat = Number(overview.lat) - Math.cos(headingRadians) * approachDegrees * 0.62;
    return {
      lon: lerp(startLon, Number(overview.lon), eased),
      lat: lerp(startLat, Number(overview.lat), eased),
      height: lerp(cfg.startHeightMeters, overviewHeight, heightProgress),
      heading: Number(overview.heading ?? 0),
      pitch: lerp(cfg.startPitchDegrees, Number(overview.pitch ?? CAMERA_PITCH), eased)
    };
  }

  function openingCloudAlpha(time, cameraHeight) {
    const cfg = openingDescent;
    if (!cfg || !cfg.cloudsEnabled) return 0;
    const raw = clamp(time / cfg.seconds, 0, 1);
    const peak = cfg.cloudAlphaPeak;
    // Keep the high-altitude deck readable, then let the volume build as the
    // camera reaches it. The slower exit leaves a few wisps at the edges
    // instead of making the whole cloud layer disappear on one frame.
    const altitudeBoost = clamp((cfg.cloudDeckHeightMeters * 7 - cameraHeight) / (cfg.cloudDeckHeightMeters * 6), 0, 1);
    if (raw < 0.36) return peak * lerp(0.08, 0.22, smootherStep(raw / 0.36)) * lerp(0.72, 1, altitudeBoost);
    if (raw < 0.68) return peak * lerp(0.22, 1, smootherStep((raw - 0.36) / 0.32));
    if (raw < 0.86) return peak * lerp(1, 0.72, smootherStep((raw - 0.68) / 0.18));
    return peak * 0.72 * (1 - smootherStep((raw - 0.86) / 0.14));
  }

  function openingCloudVeilAlpha(time) {
    if (!openingDescent || !openingDescent.cloudsEnabled) return 0;
    const raw = clamp(time / openingDescent.seconds, 0, 1);
    // This is the close-to-lens cloud volume, not a global white flash.
    if (raw < 0.54) return 0;
    if (raw < 0.72) return 0.58 * smootherStep((raw - 0.54) / 0.18);
    if (raw < 0.86) return lerp(0.58, 0.44, smootherStep((raw - 0.72) / 0.14));
    return 0.44 * (1 - smootherStep((raw - 0.86) / 0.14));
  }

  function openingCloudDeckAlpha(time) {
    if (!openingDescent || !openingDescent.cloudsEnabled) return 0;
    const raw = clamp(time / openingDescent.seconds, 0, 1);
    // The deck is a distant bank: it should be visible, but not wash the map
    // out before the camera reaches the actual cloud volume.
    if (raw < 0.28) return lerp(0.04, 0.16, smootherStep(raw / 0.28));
    if (raw < 0.68) return lerp(0.16, 0.34, smootherStep((raw - 0.28) / 0.40));
    if (raw < 0.86) return lerp(0.34, 0.26, smootherStep((raw - 0.68) / 0.18));
    return 0.26 * (1 - smootherStep((raw - 0.86) / 0.14));
  }

  function buildOpeningClouds() {
    if (!openingDescent || !openingDescent.cloudsEnabled) return;
    if (!Cesium.CloudCollection || !Cesium.CumulusCloud || cloudCollection) return;
    const center = cameraForRegion(region);
    const deck = openingDescent.cloudDeckHeightMeters;
    cloudCollection = new Cesium.CloudCollection({ noiseDetail: 16 });
    viewer.scene.primitives.add(cloudCollection);
    openingClouds = OPENING_CLOUD_LAYOUT.map((spec) => {
      const widthMeters = spec.sizeKm * 1000;
      const depthMeters = spec.sizeKm * spec.aspect * 1000;
      const cloud = cloudCollection.add({
        position: Cesium.Cartesian3.fromDegrees(center.lon + spec.dLon, center.lat + spec.dLat, deck + spec.altitudeKm * 1000),
        scale: new Cesium.Cartesian2(widthMeters, depthMeters),
        maximumSize: new Cesium.Cartesian3(widthMeters, depthMeters, spec.thicknessKm * 1000),
        slice: spec.slice,
        color: Cesium.Color.WHITE.withAlpha(0.001),
        brightness: Math.min(1.18, spec.brightness * 1.08)
      });
      cloud.baseAlpha = spec.alpha;
      cloud.baseLongitude = center.lon + spec.dLon;
      cloud.baseLatitude = center.lat + spec.dLat;
      cloud.baseAltitude = deck + spec.altitudeKm * 1000;
      cloud.baseWidth = widthMeters;
      cloud.baseDepth = depthMeters;
      cloud.parallaxLayer = spec.altitudeKm >= 4 ? "far" : spec.altitudeKm <= -2 ? "near" : "mid";
      return cloud;
    });
  }

  function updateOpeningClouds(time, cameraHeight) {
    if (!cloudCollection) return;
    if (!openingDescent || time >= openingDescent.seconds) {
      cloudCollection.show = false;
      if (cloudDeckOverlay) cloudDeckOverlay.style.opacity = "0";
      if (cloudPassOverlay) cloudPassOverlay.style.opacity = "0";
      if (viewer?.scene?.fog) viewer.scene.fog.enabled = false;
      if (cesiumContainer) cesiumContainer.style.filter = "none";
      return;
    }
    const alpha = openingCloudAlpha(time, cameraHeight);
    cloudCollection.show = alpha > 0.004;
    const raw = clamp(time / openingDescent.seconds, 0, 1);
    for (const cloud of openingClouds) {
      const layer = cloud.parallaxLayer || "mid";
      const layerAlpha = layer === "far"
        ? 1 - smootherStep(clamp((raw - 0.64) / 0.24, 0, 1))
        : layer === "near"
          ? smootherStep(clamp((raw - 0.46) / 0.20, 0, 1))
            * (1 - 0.58 * smootherStep(clamp((raw - 0.78) / 0.16, 0, 1)))
          : 0.52 + 0.48 * Math.sin(Math.PI * clamp(raw, 0, 1));
      // Cesium supplies the depth cue; the screen-space pass supplies the
      // soft envelope. The near layer is deliberately lighter so a single
      // close cloud never turns into a dark, circular billboard artifact.
      const volumeStrength = layer === "near" ? 0.012 : layer === "mid" ? 0.18 : 0.22;
      const color = Cesium.Color.WHITE.withAlpha(alpha * volumeStrength * layerAlpha * (cloud.baseAlpha ?? 1));
      cloud.color = color;
      const speed = layer === "near" ? 0.11 : layer === "mid" ? 0.065 : 0.035;
      const verticalDrift = layer === "near" ? -0.025 : layer === "far" ? 0.018 : 0.008;
      cloud.position = Cesium.Cartesian3.fromDegrees(
        cloud.baseLongitude + (raw - 0.5) * speed,
        cloud.baseLatitude + (raw - 0.5) * verticalDrift,
        cloud.baseAltitude
      );
      const approachScale = 1 + raw * (layer === "near" ? 0.30 : layer === "mid" ? 0.16 : 0.06);
      cloud.scale = new Cesium.Cartesian2(cloud.baseWidth * approachScale, cloud.baseDepth * approachScale);
    }
    const veil = openingCloudVeilAlpha(time);
    if (viewer?.scene?.fog) {
      viewer.scene.fog.enabled = veil > 0.015;
      viewer.scene.fog.density = 0.00022 + veil * 0.00072;
      viewer.scene.fog.screenSpaceErrorFactor = 1.6 + veil * 2.4;
    }
    if (cesiumContainer) {
      const exposure = 1 + veil * 0.06;
      const contrast = 1 - veil * 0.07;
      const saturation = 1 - veil * 0.12;
      cesiumContainer.style.filter = `brightness(${exposure.toFixed(3)}) contrast(${contrast.toFixed(3)}) saturate(${saturation.toFixed(3)})`;
    }
    if (cloudDeckOverlay) {
      cloudDeckOverlay.style.opacity = openingCloudDeckAlpha(time).toFixed(4);
      cloudDeckOverlay.style.transform = `scale(${(1.05 + raw * 0.16).toFixed(4)}) translate(${((raw - 0.5) * -28).toFixed(2)}px, ${((raw - 0.5) * 20).toFixed(2)}px)`;
    }
    if (cloudPassOverlay) {
      cloudPassOverlay.style.opacity = veil.toFixed(4);
      cloudPassOverlay.style.transform = `scale(${(1.06 + raw * 0.13).toFixed(4)}) translate(${((raw - 0.5) * -31).toFixed(2)}px, ${((raw - 0.5) * 17).toFixed(2)}px)`;
      cloudPassOverlay.style.backgroundPosition = `${(42 + raw * 18).toFixed(2)}% ${(40 - raw * 12).toFixed(2)}%, ${(68 - raw * 22).toFixed(2)}% ${(62 + raw * 10).toFixed(2)}%, center`;
    }
  }

  function largestOuterRing(geometry) {
    if (!geometry) return [];
    if (geometry.type === "Polygon") return geometry.coordinates[0] || [];
    if (geometry.type === "MultiPolygon") {
      return geometry.coordinates.reduce((best, polygon) => {
        const candidate = polygon[0] || [];
        return candidate.length > best.length ? candidate : best;
      }, []);
    }
    return [];
  }

  function outerRings(geometry) {
    if (!geometry) return [];
    if (geometry.type === "Polygon") return geometry.coordinates.length > 0 ? [geometry.coordinates[0]] : [];
    if (geometry.type === "MultiPolygon") return geometry.coordinates.map((polygon) => polygon[0]).filter(Boolean);
    return [];
  }

  // GeoJSON reaches this runtime in two shapes: a FeatureCollection (region and
  // city geometry) and a single Feature (a named physical feature such as a
  // river reach). Normalise both so every caller iterates one flat list instead
  // of silently skipping the single-Feature case.
  function featureList(collection) {
    if (!collection) return [];
    if (collection.type === "Feature") return [collection];
    if (Array.isArray(collection.features)) return collection.features;
    return [];
  }

  function pathLength(positions) {
    let length = 0;
    for (let index = 1; index < positions.length; index += 1) {
      length += Cesium.Cartesian3.distance(positions[index - 1], positions[index]);
    }
    return length;
  }

  function partitionPath(positions, requestedSegments) {
    if (positions.length < 2) return [];
    const count = Math.max(1, Math.min(requestedSegments, positions.length - 1));
    return Array.from({ length: count }, (_, index) => {
      const start = Math.floor(index * (positions.length - 1) / count);
      const end = Math.max(start + 1, Math.floor((index + 1) * (positions.length - 1) / count));
      return positions.slice(start, Math.min(positions.length, end + 1));
    }).filter((segment) => segment.length >= 2);
  }

  function positionAlongPath(positions, progress) {
    if (positions.length === 0) return undefined;
    if (positions.length === 1 || progress <= 0) return positions[0];
    if (progress >= 1) return positions.at(-1);
    const lengths = [];
    let total = 0;
    for (let index = 1; index < positions.length; index += 1) {
      const length = Cesium.Cartesian3.distance(positions[index - 1], positions[index]);
      lengths.push(length);
      total += length;
    }
    let remaining = total * progress;
    for (let index = 0; index < lengths.length; index += 1) {
      const length = lengths[index];
      if (remaining <= length) {
        return Cesium.Cartesian3.lerp(positions[index], positions[index + 1], length > 0 ? remaining / length : 0, new Cesium.Cartesian3());
      }
      remaining -= length;
    }
    return positions.at(-1);
  }

  function partialPathAlongPath(positions, progress) {
    if (positions.length < 2) return positions;
    const clamped = clamp(progress, 0, 1);
    if (clamped >= 1) return positions;
    if (clamped <= 0) return [positions[0], positions[0]];
    const lengths = [];
    let total = 0;
    for (let index = 1; index < positions.length; index += 1) {
      const length = Cesium.Cartesian3.distance(positions[index - 1], positions[index]);
      lengths.push(length);
      total += length;
    }
    let remaining = total * clamped;
    const visible = [positions[0]];
    for (let index = 0; index < lengths.length; index += 1) {
      const length = lengths[index];
      if (remaining >= length) {
        visible.push(positions[index + 1]);
        remaining -= length;
        continue;
      }
      visible.push(Cesium.Cartesian3.lerp(positions[index], positions[index + 1], length > 0 ? remaining / length : 0, new Cesium.Cartesian3()));
      break;
    }
    return visible.length >= 2 ? visible : [positions[0], positions[0]];
  }

  function boundsFromFeatureCollection(collection) {
    let west = Number.POSITIVE_INFINITY;
    let south = Number.POSITIVE_INFINITY;
    let east = Number.NEGATIVE_INFINITY;
    let north = Number.NEGATIVE_INFINITY;
    const visit = (value) => {
      if (!Array.isArray(value)) return;
      if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
        west = Math.min(west, value[0]);
        south = Math.min(south, value[1]);
        east = Math.max(east, value[0]);
        north = Math.max(north, value[1]);
        return;
      }
      value.forEach(visit);
    };
    for (const feature of featureList(collection)) visit(feature.geometry?.coordinates);
    return { west, south, east, north };
  }

  function removeEntityList(entities) {
    for (const entity of entities) viewer.entities.remove(entity);
    entities.length = 0;
  }

  function buildSiblingBoundaries(collection) {
    removeEntityList(siblingBoundaryEntities);
    const neutral = Cesium.Color.fromCssColorString("#E8F0F5").withAlpha(0.72);
    for (const feature of featureList(collection)) {
      const featureId = String(feature.properties?.id ?? feature.properties?.adcode ?? "");
      for (const ring of outerRings(feature.geometry)) {
        const positions = groundPositions(ring);
        if (positions.length < 2) continue;
        const colorProperty = new Cesium.ConstantProperty(neutral);
        siblingBoundaryEntities.push(...addGroundedBoundary({
          id: `sibling-${featureId}-${siblingBoundaryEntities.length}`,
          positions,
          mainColorProperty: colorProperty,
          mainWidth: scaledVisualPx(CHILD_BOUNDARY_WIDTH),
          underlayWidth: scaledVisualPx(CHILD_UNDERLAY_WIDTH),
          zIndex: 10
        }));
      }
    }
  }

  function buildContextParentOutline(collection) {
    removeEntityList(contextParentOutlineEntities);
    const parentColor = PARENT_BOUNDARY.withAlpha(0.98);
    for (const feature of featureList(collection)) {
      for (const ring of outerRings(feature.geometry)) {
        const positions = groundPositions(ring);
        if (positions.length < 2) continue;
        const colorProperty = new Cesium.ConstantProperty(parentColor);
        contextParentOutlineEntities.push(...addGroundedBoundary({
          id: `context-parent-outline-${contextParentOutlineEntities.length}`,
          positions,
          mainColorProperty: colorProperty,
          mainWidth: scaledVisualPx(PARENT_BOUNDARY_WIDTH),
          underlayWidth: scaledVisualPx(PARENT_UNDERLAY_WIDTH),
          zIndex: 20,
          underlayStrength: 0
        }));
      }
    }
  }

  // The focus mask is the inverse of the narrated area: one rectangle covering
  // far more than the camera can ever frame, with the administrative outer ring
  // punched out as a hole. Everything outside the hole therefore reads as
  // receded context while the area itself keeps its untouched terrain texture.
  //
  // "Far more than the camera can frame" is measured against the frame, not the
  // bounding box: the outer rectangle is the union of a bbox-derived floor (which
  // guarantees the punched hole sits well inside its outer ring) and the settled
  // overview camera's ground footprint.
  function focusMaskFrameFootprint() {
    const profileName = query.get("profile") || (innerHeight > innerWidth ? "portrait" : "landscape");
    const preset = region?.cameraProfiles?.[profileName] || region?.cameraPreset;
    return focusMaskFootprintBounds(preset, profileName);
  }

  function resolveFocusMaskBounds(expansion) {
    const bbox = Array.isArray(region?.bbox) ? region.bbox.map(Number) : null;
    if (!bbox || bbox.length !== 4 || !bbox.every(Number.isFinite)) return null;
    const [west, south, east, north] = bbox;
    const spanLon = Math.max(0.01, east - west) * expansion;
    const spanLat = Math.max(0.01, north - south) * expansion;
    const centerLon = (west + east) / 2;
    const centerLat = (south + north) / 2;
    return {
      west: Math.max(-179.9, centerLon - spanLon / 2),
      east: Math.min(179.9, centerLon + spanLon / 2),
      south: Math.max(-89.9, centerLat - spanLat / 2),
      north: Math.min(89.9, centerLat + spanLat / 2)
    };
  }

  function buildFocusMask(parentGeometry) {
    if (focusMaskEntity) {
      viewer.entities.remove(focusMaskEntity);
      focusMaskEntity = null;
    }
    focusMaskColorProperty = null;
    focusMaskResolved = null;
    if (!focusMaskOptions.enabled) return;
    const floorBounds = resolveFocusMaskBounds(focusMaskOptions.bboxExpand);
    if (!floorBounds) return;
    const frameFootprint = focusMaskFrameFootprint();
    const bounds = coverFocusMaskBounds(floorBounds, frameFootprint);
    const holes = [];
    for (const feature of featureList(parentGeometry)) {
      for (const ring of outerRings(feature.geometry)) {
        const positions = groundPositions(ring);
        if (positions.length >= 4) holes.push(new Cesium.PolygonHierarchy(positions));
      }
    }
    if (holes.length === 0) return;
    const outer = groundPositions([
      [bounds.west, bounds.south],
      [bounds.east, bounds.south],
      [bounds.east, bounds.north],
      [bounds.west, bounds.north]
    ]);
    focusMaskColorProperty = new Cesium.ConstantProperty(FOCUS_MASK_COLOR.withAlpha(BOUNDARY_PREWARM_ALPHA));
    focusMaskEntity = viewer.entities.add({
      id: `focus-mask-${region.id}`,
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(outer, holes),
        material: new Cesium.ColorMaterialProperty(focusMaskColorProperty),
        outline: false,
        classificationType: Cesium.ClassificationType.TERRAIN,
        // The mask is context, never a subject: it must not intercept picking.
        perPositionHeight: false
      }
    });
    focusMaskResolved = { bounds, holes: holes.length, alpha: 0, frameFootprint };
  }

  // Named physical features (rivers, ridges, coast reaches) come from
  // data/features/{ref}.geojson and are referenced by region.featureRefs. They
  // are revealed once along their own arc length when the narration names them,
  // then retained as quiet geographic context.
  function featureRingsByType(geometry) {
    const type = geometry?.type;
    const rings = [];
    if (type === "LineString") rings.push(geometry.coordinates);
    else if (type === "MultiLineString") rings.push(...geometry.coordinates);
    else if (type === "Polygon") rings.push(...geometry.coordinates);
    else if (type === "MultiPolygon") rings.push(...geometry.coordinates.flat());
    return rings
      .map((ring) => ring.map(([longitude, latitude]) => [Number(longitude), Number(latitude)]))
      .filter((ring) => ring.length >= 2 && ring.every((pair) => Number.isFinite(pair[0]) && Number.isFinite(pair[1])));
  }

  function namedFeaturePresentation(id) {
    const entry = namedFeatures.find((item) => item.id === String(id));
    if (!entry) return null;
    const action = entry.action;
    if (!action) {
      // No timeline cue: keep a declared feature as stable context from the
      // first settled overview frame instead of holding it back forever.
      const reveal = rangeProgress(presentationTime, PARENT_REVEAL_START, PARENT_REVEAL_DURATION);
      return { visible: reveal > 0.001, reveal, alpha: reveal };
    }
    const reveal = rangeProgress(presentationTime, Number(action.time) || 0, Math.max(0.2, Number(action.duration) || FEATURE_REVEAL_DEFAULT_SECONDS));
    return { visible: reveal > 0.001, reveal, alpha: reveal };
  }

  async function buildNamedFeatureLayers(regionData) {
    namedFeatures = [];
    const refs = Array.isArray(regionData?.featureRefs) ? regionData.featureRefs.map(String) : [];
    if (!featureOptions.enabled || refs.length === 0) return;
    const actions = Array.isArray(timeline?.actions) ? timeline.actions : [];
    for (const id of refs) {
      const response = await fetch(withDataVersion(`/data/features/${encodeURIComponent(id)}.geojson`));
      if (!response.ok) {
        errors.push(`named-feature-missing: ${id}`);
        continue;
      }
      const collection = await response.json();
      const features = featureList(collection);
      if (features.length === 0) {
        errors.push(`named-feature-empty: ${id}`);
        continue;
      }
      const action = actions.find((item) => (
        String(item.type) === "revealNamedFeature" && String(item.target) === id
      ));
      const segments = [];
      const availableLengths = [];
      for (const feature of features) {
        for (const ring of featureRingsByType(feature.geometry)) {
          const positions = groundPositions(ring);
          availableLengths.push(pathLength(positions));
        }
      }
      const totalLength = availableLengths.reduce((sum, length) => sum + length, 0) || 1;
      let cursor = 0;
      const entities = [];
      let longestRing = [];
      let longestLength = -1;
      for (const feature of features) {
        for (const ring of featureRingsByType(feature.geometry)) {
          const positions = groundPositions(ring);
          const length = pathLength(positions);
          if (length > longestLength) {
            longestLength = length;
            longestRing = ring;
          }
          const segmentCount = Math.max(1, Math.round(FEATURE_SEGMENTS * length / totalLength));
          for (const piece of partitionPath(positions, segmentCount)) {
            const pieceLength = pathLength(piece);
            const startProgress = cursor / totalLength;
            cursor += pieceLength;
            const endProgress = cursor / totalLength;
            // One material per segment so the reach can be drawn once, along its
            // own flow direction, at the moment its name is spoken. Geometry stays
            // resident and only alpha changes, which is the same guarantee the
            // parent boundary trace relies on.
            const segmentColorProperty = new Cesium.ConstantProperty(FEATURE_RIVER_COLOR.withAlpha(BOUNDARY_PREWARM_ALPHA));
            segments.push({ startProgress, endProgress, colorProperty: segmentColorProperty });
            entities.push(...addGroundedBoundary({
              id: `feature-${id}-${entities.length}`,
              positions: piece,
              mainColorProperty: segmentColorProperty,
              mainWidth: scaledVisualPx(FEATURE_RIVER_WIDTH),
              underlayWidth: scaledVisualPx(FEATURE_RIVER_HALO_WIDTH),
              zIndex: FEATURE_Z_INDEX,
              underlayStrength: 0.6
            }));
          }
        }
      }
      if (entities.length === 0) continue;
      const declaredLabelPoint = features
        .map((feature) => feature.properties?.labelPoint)
        .find((point) => Array.isArray(point) && point.length >= 2);
      const fallbackPoint = longestRing.length > 0 ? longestRing[Math.floor(longestRing.length / 2)] : null;
      const labelPoint = declaredLabelPoint || fallbackPoint;
      const declaredName = features
        .map((feature) => feature.properties?.name || feature.properties?.label)
        .find((name) => typeof name === "string" && name.trim().length > 0);
      let labelEntity = null;
      let labelProperties = [];
      if (labelPoint) {
        const fill = new Cesium.ConstantProperty(Cesium.Color.WHITE.withAlpha(0));
        const outline = new Cesium.ConstantProperty(CHILD_LABEL_OUTLINE.withAlpha(0));
        labelProperties = [fill, outline];
        labelEntity = viewer.entities.add({
          id: `feature-label-${id}`,
          show: false,
          position: Cesium.Cartesian3.fromDegrees(Number(labelPoint[0]), Number(labelPoint[1])),
          label: {
            text: String(declaredName || id),
            font: `500 ${scaledTypographyPx(FEATURE_LABEL_FONT_SIZE)}px "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif`,
            fillColor: fill,
            outlineColor: outline,
            outlineWidth: Math.max(1.5, scaledVisualPx(CHILD_LABEL_OUTLINE_WIDTH)),
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            showBackground: false,
            scaleByDistance: labelScaleByDistance(),
            translucencyByDistance: labelTranslucencyByDistance(),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, scaledVisualPx(-12)),
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        });
      }
      namedFeatureSources.push(...entities);
      namedFeatures.push({
        id,
        action: action || null,
        entities,
        segments,
        labelEntity,
        labelProperties
      });
    }
  }

  function updateNamedFeatureLayers() {
    if (namedFeatures.length === 0) return;
    for (const entry of namedFeatures) {
      const presentation = namedFeaturePresentation(entry.id);
      if (!presentation) continue;
      // Arc-length reveal: each segment switches on as the trace reaches it, so
      // the reach is drawn once in its own flow direction and then held. No
      // pulsing, no re-trace, no geometry churn.
      for (const segment of entry.segments) {
        const duration = Math.max(0.0001, segment.endProgress - segment.startProgress);
        const localReveal = clamp((presentation.reveal - segment.startProgress) / duration, 0, 1);
        const alpha = localReveal > 0.001
          ? Math.max(BOUNDARY_PREWARM_ALPHA, 0.96 * presentation.alpha)
          : BOUNDARY_PREWARM_ALPHA;
        setColorProperty(segment.colorProperty, FEATURE_RIVER_COLOR.withAlpha(alpha));
      }
      if (entry.labelEntity) {
        const labelAlpha = presentation.alpha;
        entry.labelEntity.show = labelAlpha > 0.02;
        if (entry.labelProperties.length === 2) {
          setColorProperty(entry.labelProperties[0], Cesium.Color.WHITE.withAlpha(labelAlpha));
          setColorProperty(entry.labelProperties[1], CHILD_LABEL_OUTLINE.withAlpha(readableChildLabelOutlineAlpha(labelAlpha)));
        }
      }
    }
  }

  async function buildParentTopicLayers(parentGeometry, childGeometry) {
    supplementalChildIds = new Set((region?.supplementalUnits || []).map((item) => String(item.id)));
    const touredChildIds = new Set((region?.tourStops || []).map((item) => String(item.id)));
    parentFillSource = await Cesium.GeoJsonDataSource.load(parentGeometry, {
      clampToGround: true,
      fill: PARENT_BOUNDARY.withAlpha(PARENT_FILL_ALPHA),
      stroke: Cesium.Color.TRANSPARENT,
      strokeWidth: 0
    });
    viewer.dataSources.add(parentFillSource);
    parentFillProperties = [];
    for (const entity of parentFillSource.entities.values) {
      if (!entity.polygon) continue;
      const colorProperty = new Cesium.ConstantProperty(PARENT_BOUNDARY.withAlpha(PARENT_FILL_ALPHA));
      entity.polygon.material = new Cesium.ColorMaterialProperty(colorProperty);
      entity.polygon.outline = false;
      entity.polygon.classificationType = Cesium.ClassificationType.TERRAIN;
      parentFillProperties.push(colorProperty);
    }

    // Recede everything outside the narrated area, then draw the named physical
    // features that the narration will call out. Both are grounded surfaces, so
    // they cannot introduce the altitude offsets the boundary contract forbids.
    labelReferenceDistance = resolveLabelReferenceDistance();
    buildFocusMask(parentGeometry);
    await buildNamedFeatureLayers(region);

    childFillSource = await Cesium.GeoJsonDataSource.load(childGeometry, {
      clampToGround: true,
      fill: SELECTED_BOUNDARY.withAlpha(0.18),
      stroke: Cesium.Color.TRANSPARENT,
      strokeWidth: 0
    });
    viewer.dataSources.add(childFillSource);
    childFillPropertiesById = new Map();
    childFillEntitiesById = new Map();
    for (const entity of childFillSource.entities.values) {
      if (!entity.polygon) continue;
      const values = entity.properties?.getValue(viewer.clock.currentTime) || {};
      const featureId = String(values.id ?? values.adcode ?? entity.id);
      const colorProperty = new Cesium.CallbackProperty((_time, result) => {
        const strength = tourHighlightStrength(tourStateAt(presentationTime), tourReturnStateAt(presentationTime), featureId);
        const overlay = stableOverlayState(strength, 0.18, 0.025);
        const color = Cesium.Color.clone(SELECTED_BOUNDARY, result || new Cesium.Color());
        color.alpha = overlay.alpha;
        return color;
      }, false);
      entity.polygon.material = new Cesium.ColorMaterialProperty(colorProperty);
      entity.polygon.outline = false;
      entity.polygon.classificationType = Cesium.ClassificationType.TERRAIN;
      entity.show = false;
      const featureFillProperties = childFillPropertiesById.get(featureId) || [];
      featureFillProperties.push(colorProperty);
      childFillPropertiesById.set(featureId, featureFillProperties);
      const featureFillEntities = childFillEntitiesById.get(featureId) || [];
      featureFillEntities.push(entity);
      childFillEntitiesById.set(featureId, featureFillEntities);
    }

    removeEntityList(parentRevealEntities);
    removeEntityList(parentStableBoundaryEntities);
    if (parentPenEntity) viewer.entities.remove(parentPenEntity);
    parentPenEntity = null;
    parentPenPositionProperty = null;
    parentPenColorProperty = null;
    parentRevealRings = [];
    parentRevealColorProperties = [];
    parentDrawSegments = [];
    parentStableBoundaryColorProperties = [];
    parentStableUnderlayColorProperties = [];
    const ringRecords = [];
    for (const feature of parentGeometry.features || []) {
      for (const ring of outerRings(feature.geometry)) {
        const positions = groundPositions(ring);
        if (positions.length < 2) continue;
        parentRevealRings.push(positions);
        ringRecords.push({ positions, length: pathLength(positions) });
      }
    }
    for (const item of ringRecords) {
      const colorProperty = new Cesium.ConstantProperty(PARENT_BOUNDARY.withAlpha(BOUNDARY_PREWARM_ALPHA));
      parentStableBoundaryColorProperties.push(colorProperty);
      const entities = addGroundedBoundary({
        id: `parent-stable-${parentStableBoundaryEntities.length}`,
        positions: item.positions,
        mainColorProperty: colorProperty,
        mainWidth: scaledVisualPx(PARENT_BOUNDARY_WIDTH),
        underlayWidth: scaledVisualPx(PARENT_UNDERLAY_WIDTH),
        zIndex: TOUR_PARENT_BOUNDARY_Z_INDEX,
        underlayStrength: 0
      });
      // Keep the settled ground primitive prewarmed. Alpha controls visual
      // visibility so Cesium never rebuilds the terrain batch at handoff.
      entities[0].show = true;
      entities[1].show = true;
      parentStableBoundaryEntities.push(...entities);
    }
    const totalRingLength = ringRecords.reduce((sum, item) => sum + item.length, 0) || 1;
    const rawSegments = ringRecords.flatMap((item) => {
      const segmentCount = Math.max(4, Math.round(PARENT_DRAW_SEGMENTS * item.length / totalRingLength));
      return partitionPath(item.positions, segmentCount).map((positions) => ({ positions, length: pathLength(positions) }));
    });
    const totalSegmentLength = rawSegments.reduce((sum, item) => sum + item.length, 0) || 1;
    let segmentCursor = 0;
    for (let index = 0; index < rawSegments.length; index += 1) {
      const segment = rawSegments[index];
      const startProgress = segmentCursor / totalSegmentLength;
      segmentCursor += segment.length;
      const endProgress = segmentCursor / totalSegmentLength;
      const colorProperty = new Cesium.ConstantProperty(PARENT_BOUNDARY.withAlpha(BOUNDARY_PREWARM_ALPHA));
      // Keep the complete segment resident from initialization. Visibility is
      // controlled by alpha; changing ground-clamped positions during capture
      // would rebuild geometry asynchronously and make the pen outrun the line.
      const positionsProperty = new Cesium.ConstantProperty(segment.positions);
      const widthProperty = new Cesium.ConstantProperty(scaledVisualPx(PARENT_DRAW_WIDTH));
      parentRevealColorProperties.push(colorProperty);
      parentDrawSegments.push({ ...segment, colorProperty, positionsProperty, widthProperty, startProgress, endProgress, lastLocalReveal: -1 });
      const drawEntities = addGroundedBoundary({
        id: `parent-draw-${index}`,
        positions: positionsProperty,
        mainColorProperty: colorProperty,
        mainWidth: scaledVisualPx(PARENT_DRAW_WIDTH),
        underlayWidth: scaledVisualPx(PARENT_UNDERLAY_WIDTH),
        zIndex: 100,
        underlayStrength: 0
      });
      drawEntities[1].polyline.width = widthProperty;
      parentRevealEntities.push(...drawEntities);
    }
    if (parentDrawSegments.length > 0) {
      const penSvg = `<svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><path d="M8 30.8 13.4 18l12.8-12.8 8.6 8.6L22 26.6 8 30.8Z" fill="#F5F8FA" stroke="#021018" stroke-width="2" stroke-linejoin="round"/><path d="m13.4 18 8.6 8.6" stroke="#2D9CDB" stroke-width="3"/><circle cx="13" cy="26.8" r="3.2" fill="#2D9CDB" stroke="#021018" stroke-width="1.5"/></svg>`;
      parentPenPositionProperty = new Cesium.ConstantPositionProperty(parentDrawSegments[0].positions[0]);
      parentPenColorProperty = new Cesium.ConstantProperty(Cesium.Color.WHITE.withAlpha(0));
      parentPenEntity = viewer.entities.add({
        id: `parent-pen-${region.id}`,
        position: parentPenPositionProperty,
        billboard: {
          image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(penSvg)}`,
          width: scaledVisualPx(34),
          height: scaledVisualPx(34),
          color: parentPenColorProperty,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(scaledVisualPx(8), scaledVisualPx(-5)),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
    }

    removeEntityList(childBoundaryEntities);
    removeEntityList(childSelectionEntities);
    removeEntityList(childLabelEntities);
    childBoundaryColorProperties = [];
    childBoundaryColorPropertiesById = new Map();
    childSelectionEntitiesById = new Map();
    childSelectionColorPropertiesById = new Map();
    childLabelEntitiesById = new Map();
    childLabelColorPropertiesById = new Map();
    childLabelScalePropertiesById = new Map();
    childLabelPositionsById = new Map();
    const childBoundaryRingsById = new Map();
    for (const feature of childGeometry.features || []) {
      const featureId = String(feature.properties?.id ?? feature.properties?.adcode ?? childBoundaryEntities.length);
      for (const ring of outerRings(feature.geometry)) {
        const positions = groundPositions(ring);
        if (positions.length < 2) continue;
        const colorProperty = new Cesium.ConstantProperty(CHILD_BOUNDARY.withAlpha(BOUNDARY_PREWARM_ALPHA));
        childBoundaryColorProperties.push(colorProperty);
        const featureBoundaryProperties = childBoundaryColorPropertiesById.get(featureId) || [];
        featureBoundaryProperties.push(colorProperty);
        childBoundaryColorPropertiesById.set(featureId, featureBoundaryProperties);
        const rings = childBoundaryRingsById.get(featureId) || [];
        rings.push(positions);
        childBoundaryRingsById.set(featureId, rings);
        childBoundaryEntities.push(...addGroundedBoundary({
          id: `child-boundary-${featureId}-${childBoundaryEntities.length}`,
          positions,
          mainColorProperty: colorProperty,
          mainWidth: scaledVisualPx(supplementalChildIds.has(featureId) ? SUPPLEMENTAL_BOUNDARY_WIDTH : CHILD_BOUNDARY_WIDTH),
          underlayWidth: scaledVisualPx(CHILD_UNDERLAY_WIDTH),
          zIndex: CHILD_BOUNDARY_Z_INDEX
        }));
      }
      const labelPoint = feature.properties?.labelPoint;
      if (supplementalChildIds.has(featureId) && !touredChildIds.has(featureId)) continue;
      if (!Array.isArray(labelPoint) || labelPoint.length < 2) continue;
      const fill = new Cesium.ConstantProperty(Cesium.Color.WHITE.withAlpha(0));
      const outline = new Cesium.ConstantProperty(CHILD_LABEL_OUTLINE.withAlpha(0));
      const scale = new Cesium.ConstantProperty(0.9);
      const position = Cesium.Cartesian3.fromDegrees(Number(labelPoint[0]), Number(labelPoint[1]));
      childLabelColorPropertiesById.set(featureId, [fill, outline]);
      childLabelScalePropertiesById.set(featureId, scale);
      childLabelPositionsById.set(featureId, position);
      const configuredStop = (region?.tourStops || []).find((stop) => String(stop.id) === featureId);
      const labelEntity = viewer.entities.add({
        id: `child-label-${featureId}`,
        show: false,
        position,
        label: {
          text: String(configuredStop?.name ?? feature.properties?.name ?? featureId),
          font: `600 ${scaledTypographyPx(CHILD_LABEL_FONT_SIZE)}px "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif`,
          fillColor: fill,
          outlineColor: outline,
          scale,
          outlineWidth: Math.max(1.5, scaledVisualPx(CHILD_LABEL_OUTLINE_WIDTH)),
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          showBackground: false,
          scaleByDistance: labelScaleByDistance(),
          translucencyByDistance: labelTranslucencyByDistance(),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
      childLabelEntities.push(labelEntity);
      childLabelEntitiesById.set(featureId, labelEntity);
    }

    for (const [featureId, rings] of childBoundaryRingsById.entries()) {
      const colorProperties = [];
      const selectionEntities = [];
      for (const positions of rings) {
        const colorProperty = new Cesium.CallbackProperty((_time, result) => {
          const strength = tourHighlightStrength(tourStateAt(presentationTime), tourReturnStateAt(presentationTime), featureId);
          const overlay = stableOverlayState(strength, 0.99, BOUNDARY_PREWARM_ALPHA);
          const color = Cesium.Color.clone(SELECTED_BOUNDARY, result || new Cesium.Color());
          color.alpha = overlay.alpha;
          return color;
        }, false);
        colorProperties.push(colorProperty);
        const entities = addGroundedBoundary({
          id: `child-selection-${featureId}-${childSelectionEntities.length}`,
          positions,
          mainColorProperty: colorProperty,
          mainWidth: scaledVisualPx(SELECTED_BOUNDARY_WIDTH),
          underlayWidth: scaledVisualPx(SELECTED_UNDERLAY_WIDTH),
          zIndex: SELECTED_BOUNDARY_Z_INDEX
        });
        entities[0].show = true;
        entities[1].show = true;
        childSelectionEntities.push(...entities);
        selectionEntities.push(...entities);
      }
      childSelectionEntitiesById.set(featureId, selectionEntities);
      childSelectionColorPropertiesById.set(featureId, colorProperties);
    }

    if (parentTopicLabelEntity) viewer.entities.remove(parentTopicLabelEntity);
    const parentFill = new Cesium.ConstantProperty(PARENT_LABEL_FILL.withAlpha(0));
    const parentOutline = new Cesium.ConstantProperty(PARENT_LABEL_OUTLINE.withAlpha(0));
    parentTopicLabelPositionProperty = new Cesium.ConstantPositionProperty(
      Cesium.Cartesian3.fromDegrees(region.labelPoint[0], region.labelPoint[1])
    );
    parentTopicLabelScaleProperty = new Cesium.ConstantProperty(1);
    parentTopicLabelPixelOffsetProperty = new Cesium.ConstantProperty(new Cesium.Cartesian2(0, scaledVisualPx(-18)));
    parentTopicLabelProperties = [parentFill, parentOutline];
    parentTopicLabelEntity = viewer.entities.add({
      id: `parent-topic-label-${region.id}`,
      position: parentTopicLabelPositionProperty,
      label: {
        text: region.name,
        font: `600 ${scaledTypographyPx(PARENT_LABEL_FONT_SIZE)}px "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif`,
        fillColor: parentFill,
        outlineColor: parentOutline,
        // Cesium label outlines are screen-space pixels. Parent and child
        // names share one restrained black edge so both stay readable over
        // satellite imagery without looking heavy in the Studio preview.
        outlineWidth: Math.max(1.25, scaledVisualPx(LABEL_OUTLINE_WIDTH)),
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: false,
        scale: parentTopicLabelScaleProperty,
        scaleByDistance: labelScaleByDistance(),
        translucencyByDistance: labelTranslucencyByDistance(),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        pixelOffset: parentTopicLabelPixelOffsetProperty,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
  }

  function tourStateAt(time) {
    const stops = Array.isArray(region?.tourStops) ? region.tourStops : [];
    if (!childTour || stops.length === 0 || time < Number(stops[0].start)) return null;
    let index = 0;
    for (let candidate = 1; candidate < stops.length; candidate += 1) {
      if (time >= Number(stops[candidate].start)) index = candidate;
      else break;
    }
    const current = stops[index];
    const previous = index > 0 ? stops[index - 1] : null;
    const next = index + 1 < stops.length ? stops[index + 1] : null;
    const flightDuration = Math.max(0.001, Number(current.flightDuration) || 0.001);
    const rawProgress = clamp((time - Number(current.start)) / flightDuration, 0, 1);
    const progress = smootherStep(rawProgress);
    return { index, current, previous, next, flightDuration, rawProgress, progress };
  }

  function tourReturnStateAt(time) {
    const stops = Array.isArray(region?.tourStops) ? region.tourStops : [];
    if (!childTour || stops.length === 0) return null;
    const last = stops.at(-1);
    const fallbackStart = Number(last.end ?? (Number(last.start) + Number(last.flightDuration)));
    const configuredStart = Number(region?.tourReturnStart ?? region?.tourOutroStart);
    const start = Number.isFinite(configuredStart) ? Math.max(configuredStart, fallbackStart) : fallbackStart;
    if (!Number.isFinite(start) || time < start) return null;
    const configuredDuration = Number(region?.tourReturnDurationSeconds ?? region?.tourReturnDuration);
    const duration = clamp(
      Number.isFinite(configuredDuration) ? configuredDuration : TOUR_RETURN_DURATION_SECONDS,
      TOUR_RETURN_MIN_SECONDS,
      TOUR_RETURN_MAX_SECONDS
    );
    const rawProgress = clamp((time - start) / duration, 0, 1);
    return { start, duration, rawProgress, progress: smootherStep(rawProgress), locked: rawProgress >= 1, last };
  }

  function updateParentTopicLayers(time) {
    const revealStart = parentRevealTimingOverride?.start ?? PARENT_REVEAL_START;
    const revealDuration = parentRevealTimingOverride?.duration ?? PARENT_REVEAL_DURATION;
    const reveal = rangeProgress(time, revealStart, revealDuration);
    const parentSettled = reveal >= 0.999;
    const stops = Array.isArray(region?.tourStops) ? region.tourStops : [];
    const tour = tourStateAt(time);
    const returnState = tourReturnStateAt(time);
    const firstTourStart = stops.length > 0 ? Number(stops[0].start) : Number.POSITIVE_INFINITY;
    // Completed styling starts at its final low-energy value. It must never
    // continue brightening after the brush reaches the end of the boundary.
    const parentOverviewStrength = parentSettled
      ? (editorParentPreviewHold ? 1 : 1 - rangeProgress(time, firstTourStart, 0.45))
      : 0;
    // The parent outline remains as quiet blue hierarchy context throughout
    // the village tour. Only its high-energy overview treatment fades out.
    const parentContextStrength = Math.max(
      parentOverviewStrength,
      // The closing overview reuses the exact settled opening treatment. Its
      // line width, color and opacity therefore remain visually identical
      // while the camera returns to the same overview framing.
      returnState ? PARENT_OVERVIEW_BOUNDARY_STRENGTH : 0,
      // Once the parent trace has settled, retain it independently of the
      // first stop timestamp. Adding/subtracting the opening offset can put
      // the first preview frame a fraction below that timestamp.
      parentSettled && childTour ? TOUR_PARENT_BOUNDARY_STRENGTH : 0
    );
    // Do not swap the completed stroke to a second polyline. Even when both
    // entities use the same color, Cesium can commit the material update one
    // frame after the canvas trace is cleared, which reads as a brief blink.
    // The reveal segments therefore become the persistent parent boundary;
    // their alpha changes only when the parent recedes during the child tour.
    const persistentRevealStrength = parentSettled ? parentContextStrength : 1;
    // Hand the pen over to the Cesium segments without ever cutting before they
    // are painted. Two facts decide the shape of this: Cesium can apply a
    // polyline material update one frame *after* the property is written, and the
    // canvas trace disappears the instant its strength reaches 0. Switching both
    // on at the settle frame therefore left exactly one frame with neither layer
    // drawn - the flash the operator reported at the end of the opening trace
    // (measured 6533 -> 0 -> 6171 boundary pixels across t=5.433/5.467/5.500, and
    // reproduced against the capture path). So the Cesium layer comes up to full
    // *at* the settle (it has a frame to commit under the still-visible canvas)
    // and the canvas only cuts BOUNDARY_HANDOFF_HOLD_SECONDS later. Both layers
    // draw the same near-opaque line, so the overlap changes nothing visible
    // (0.96 over 0.96 ≈ 0.998); a cross-fade dims the line instead and was worse.
    const settledFor = time - (revealStart + revealDuration);
    const canvasShare = editorParentPreviewHold || !parentSettled
      || settledFor < BOUNDARY_HANDOFF_HOLD_SECONDS ? 1 : 0;
    const boundaryCanvasStrength = persistentRevealStrength * canvasShare;
    const cesiumRevealStrength = parentSettled ? persistentRevealStrength : 0;
    const parentBoundaryZIndex = returnState
      ? RETURN_PARENT_BOUNDARY_Z_INDEX
      : TOUR_PARENT_BOUNDARY_Z_INDEX;
    for (let index = 0; index < parentStableBoundaryEntities.length; index += 2) {
      // The parent draw hands off directly to one blue grounded line. Keeping
      // the dark underlay enabled on this exact frame can render one pass
      // before the blue line and read as a brief black flash.
      setNumberProperty(parentStableBoundaryEntities[index].polyline.zIndex, parentBoundaryZIndex);
      setNumberProperty(parentStableBoundaryEntities[index + 1].polyline.zIndex, parentBoundaryZIndex + 1);
    }
    for (const property of parentStableBoundaryColorProperties) {
      // This complete-ring primitive exists only to keep Cesium's terrain
      // batch warm. Making it visible before the segmented trace settles leaks
      // the full administrative boundary into the cloud-descent shot. The
      // segmented draw entities below remain visible after tracing and are the
      // single visible parent-boundary layer for the rest of the timeline.
      setColorProperty(property, PARENT_BOUNDARY.withAlpha(BOUNDARY_PREWARM_ALPHA));
    }
    for (let segmentIndex = 0; segmentIndex < parentDrawSegments.length; segmentIndex += 1) {
      const segment = parentDrawSegments[segmentIndex];
      const duration = Math.max(0.0001, segment.endProgress - segment.startProgress);
      const localReveal = clamp((reveal - segment.startProgress) / duration, 0, 1);
      const segmentAlpha = localReveal > 0.001 && cesiumRevealStrength > 0.001
        ? 0.96 * cesiumRevealStrength
        : BOUNDARY_PREWARM_ALPHA;
      setColorProperty(segment.colorProperty, PARENT_BOUNDARY.withAlpha(segmentAlpha));
      setNumberProperty(segment.widthProperty, scaledVisualPx(PARENT_DRAW_WIDTH));
    }
    if (parentPenPositionProperty && parentPenColorProperty && parentDrawSegments.length > 0) {
      const active = parentDrawSegments.find((segment) => reveal <= segment.endProgress) || parentDrawSegments.at(-1);
      const duration = Math.max(0.0001, active.endProgress - active.startProgress);
      const localReveal = clamp((reveal - active.startProgress) / duration, 0, 1);
      const position = positionAlongPath(active.positions, localReveal);
      if (position) parentPenPositionProperty.setValue(position);
      setColorProperty(parentPenColorProperty, Cesium.Color.WHITE.withAlpha(reveal > 0.01 && reveal < 0.995 ? 0.78 : 0));
    }
    // Cesium updates its view-projection matrix during render. Retain the
    // requested boundary state here and draw it from postRender so the canvas
    // parent outline uses the exact same camera frame as the ground-clamped
    // child outlines while the camera is moving.
    editorBoundaryPendingReveal = reveal;
    editorBoundaryPendingStrength = boundaryCanvasStrength;
    const childStrength = rangeProgress(time, CHILD_BOUNDARY_START, CHILD_BOUNDARY_DURATION);
    const activeChildId = tour ? String(tour.current.id) : null;
    const stopIndexById = new Map(stops.map((stop, index) => [String(stop.id), index]));
    for (const [id, properties] of childBoundaryColorPropertiesById.entries()) {
      const stopIndex = stopIndexById.get(String(id));
      const isActive = activeChildId !== null && String(id) === activeChildId;
      const isVisited = Boolean(tour && stopIndex !== undefined && stopIndex < tour.index);
      const baseAlpha = isActive
        ? (supplementalChildIds.has(String(id)) ? 0.42 : 0.82) * Math.max(childStrength, tour?.progress ?? 0)
        : isVisited ? (supplementalChildIds.has(String(id)) ? 0.26 : 0.46) : 0;
      const alpha = Math.max(BOUNDARY_PREWARM_ALPHA, baseAlpha * (returnState ? RETURN_CHILD_BOUNDARY_ALPHA_SCALE : 1));
      for (const property of properties) setColorProperty(property, CHILD_BOUNDARY.withAlpha(alpha));
    }
    // Bring the parent name in once the outline is mostly established so the
    // narration, pen motion, and place identity overlap naturally.
    // A translucent glyph reads as a smaller glyph over detailed satellite
    // imagery because only its brightest inner strokes remain visible. Reveal
    // the parent name at its final opacity in one frame so its screen size is
    // perceptually stable throughout the overview.
    const parentLabelReveal = smootherStep(rangeProgress(
      time,
      revealStart + revealDuration * 0.8,
      PARENT_LABEL_FADE_DURATION
    ));
    const overviewParentLabelStrength = parentLabelStrengthAt(
      PARENT_OVERVIEW_LABEL_STRENGTH * parentOverviewStrength * parentLabelReveal
    );
    // The parent *name* is an opening-overview treatment only: it retires with
    // the overview ramp as the first village flight begins and never returns,
    // not through the child tour and not in the closing overview. The parent
    // outline keeps painting underneath as quiet hierarchy context - only the
    // name is subject to this. See `parentNameStrengthAt`.
    const parentLabelStrength = parentNameStrengthAt({
      settled: parentSettled,
      overviewStrength: overviewParentLabelStrength
    });
    if (parentTopicLabelPositionProperty) {
      parentTopicLabelPositionProperty.setValue(Cesium.Cartesian3.fromDegrees(region.labelPoint[0], region.labelPoint[1]));
    }
    if (parentTopicLabelScaleProperty) {
      setNumberProperty(parentTopicLabelScaleProperty, 1);
    }
    if (parentTopicLabelPixelOffsetProperty) {
      parentTopicLabelPixelOffsetProperty.setValue(new Cesium.Cartesian2(
        0,
        scaledVisualPx(-18)
      ));
    }
    for (const property of parentFillProperties) {
      // Constant target: setColorProperty skips the write once the value matches,
      // so the terrain-classified overview fill never churns between frames.
      setColorProperty(property, PARENT_BOUNDARY.withAlpha(PARENT_FILL_ALPHA));
    }
    if (parentTopicLabelProperties.length === 2) {
      setColorProperty(parentTopicLabelProperties[0], PARENT_LABEL_FILL.withAlpha(parentLabelStrength));
      setColorProperty(
        parentTopicLabelProperties[1],
        PARENT_LABEL_OUTLINE.withAlpha(readableLabelOutlineAlpha(parentLabelStrength))
      );
    }

    for (const [id, entities] of childFillEntitiesById.entries()) {
      const strength = tourHighlightStrength(tour, returnState, id);
      const overlay = stableOverlayState(strength, 0.18, 0.025);
      for (const entity of entities) entity.show = overlay.visible;
    }
    for (const id of childSelectionColorPropertiesById.keys()) {
      const strength = tourHighlightStrength(tour, returnState, id);
      const selectionEntities = childSelectionEntitiesById.get(String(id)) || [];
      const overlay = stableOverlayState(strength, 0.99, BOUNDARY_PREWARM_ALPHA);
      for (let index = 0; index < selectionEntities.length; index += 2) {
        selectionEntities[index].show = true;
        selectionEntities[index + 1].show = true;
      }
    }

    // Label pass 1: settle every label's colour and scale, and collect the
    // screen box it will occupy. The avoidance pass below then decides which
    // ones can coexist, so overlap is prevented on every frame - not only while
    // the camera is pulling back, which is where the old return-only pass left
    // neighbouring village names stacked on top of each other.
    const returnLabelScale = returnState ? lerp(1, RETURN_LABEL_SCALE, returnState.progress) : 1;
    const labelStates = new Map();
    const labelCandidates = [];
    for (const [id, properties] of childLabelColorPropertiesById.entries()) {
      const key = String(id);
      const labelEntity = childLabelEntitiesById.get(key);
      const stopIndex = stopIndexById.get(key);
      const stop = stopIndex === undefined ? null : stops[stopIndex];
      const presentation = stop
        ? tourLabelPresentationAt(time, tour, returnState, stop, stopIndex)
        : { visible: false, emphasis: 0, alpha: 0, scale: 0.9 };
      const outlineWidth = returnState
        ? RETURN_CHILD_LABEL_OUTLINE_WIDTH
        : CHILD_LABEL_OUTLINE_WIDTH;
      if (labelEntity?.label?.outlineWidth) {
        setNumberProperty(labelEntity.label.outlineWidth, Math.max(1.5, scaledVisualPx(outlineWidth)));
      }
      const authoredScale = presentation.scale * returnLabelScale;
      const scaleProperty = childLabelScalePropertiesById.get(key);
      if (scaleProperty) setNumberProperty(scaleProperty, authoredScale);
      labelStates.set(key, { entity: labelEntity, presentation });
      if (!presentation.visible || !labelEntity) continue;
      const fill = Cesium.Color.lerp(Cesium.Color.WHITE, SELECTED_BOUNDARY, 0.58 * presentation.emphasis, new Cesium.Color());
      fill.alpha = presentation.alpha;
      setColorProperty(properties[0], fill);
      setColorProperty(
        properties[1],
        CHILD_LABEL_OUTLINE.withAlpha(returnState
          ? Math.min(1, presentation.alpha * RETURN_CHILD_LABEL_OUTLINE_ALPHA_RATIO)
          : readableChildLabelOutlineAlpha(presentation.alpha))
      );
      // Rank: the active stop is always admitted first, then the freshest tour
      // order, so the narrated place name cannot be displaced by context.
      const rank = tour && String(tour.current?.id) === key ? -1 : (stopIndex ?? stops.length);
      const box = childLabelScreenBox(key, authoredScale, rank);
      if (box) labelCandidates.push(box);
    }
    const declutteredLabelIds = labelDistanceOptions.declutter
      ? declutterChildLabels(labelCandidates)
      : new Set(labelCandidates.map((box) => box.id));
    for (const [key, state] of labelStates.entries()) {
      const labelEntity = state.entity;
      if (!labelEntity) continue;
      const visible = state.presentation.visible && declutteredLabelIds.has(key);
      labelEntity.show = visible;
    }
    previousVisibleLabelIds = new Set([...declutteredLabelIds].filter((key) => labelStates.get(key)?.entity?.show));

    // Recede everything outside the narrated area once the parent trace has
    // settled, then hold. The ramp is anchored to the settle moment itself, not
    // to a fixed offset inside the trace: the parentSettled gate below only
    // opens when the trace completes, so a ramp scheduled to begin any earlier
    // would already be part-finished on its first admitted frame and the
    // recession would pop on at a mid-ramp alpha instead of easing up from
    // zero. rangeProgress carries a quintic ease, so the darkening also starts
    // and ends at zero rate rather than snapping in at a constant slope.
    const revealSettle = parentRevealTimingOverride?.settle ?? PARENT_SETTLE_DURATION;
    const focusMaskRampStart = revealStart + revealDuration + revealSettle;
    const focusMaskTarget = focusMaskOptions.enabled && parentSettled
      ? focusMaskOptions.alpha * rangeProgress(time, focusMaskRampStart, focusMaskOptions.fadeSeconds)
      : 0;
    // The mask is a classification surface like the overview fill, so it is
    // written through the same change-detecting setter.
    if (focusMaskResolved) focusMaskResolved.alpha = focusMaskTarget;
    if (focusMaskColorProperty) {
      setColorProperty(focusMaskColorProperty, FOCUS_MASK_COLOR.withAlpha(Math.max(BOUNDARY_PREWARM_ALPHA, focusMaskTarget)));
    }
    updateNamedFeatureLayers();
  }

  async function createRegionOverlay(regionData, geometry, key) {
    const source = await Cesium.GeoJsonDataSource.load(geometry, {
      clampToGround: true,
      fill: Cesium.Color.fromCssColorString("#FFD166").withAlpha(0),
      stroke: Cesium.Color.TRANSPARENT,
      strokeWidth: 0
    });
    viewer.dataSources.add(source);
    const fillProperties = [];
    for (const entity of source.entities.values) {
      if (!entity.polygon) continue;
      const colorProperty = new Cesium.ConstantProperty(Cesium.Color.fromCssColorString("#FFD166").withAlpha(0));
      entity.polygon.material = new Cesium.ColorMaterialProperty(colorProperty);
      entity.polygon.outline = false;
      entity.polygon.classificationType = Cesium.ClassificationType.TERRAIN;
      fillProperties.push(colorProperty);
    }

    const outlineProperties = [];
    const outlineEntities = [];
    for (const feature of geometry.features || []) {
      for (const ring of outerRings(feature.geometry)) {
        const positions = groundPositions(ring);
        if (positions.length < 2) continue;
        const colorProperty = new Cesium.ConstantProperty(Cesium.Color.fromCssColorString("#FFD166").withAlpha(0));
        outlineProperties.push(colorProperty);
        const selected = key === "selected";
        outlineEntities.push(...addGroundedBoundary({
          id: `${key}-outline-${outlineEntities.length}`,
          positions,
          mainColorProperty: colorProperty,
          mainWidth: scaledVisualPx(selected ? SELECTED_BOUNDARY_WIDTH : CHILD_BOUNDARY_WIDTH),
          underlayWidth: scaledVisualPx(selected ? SELECTED_UNDERLAY_WIDTH : CHILD_UNDERLAY_WIDTH),
          zIndex: selected ? 50 : 20
        }));
      }
    }

    const labelFill = new Cesium.ConstantProperty(Cesium.Color.WHITE.withAlpha(0));
    const labelOutline = new Cesium.ConstantProperty(CHILD_LABEL_OUTLINE.withAlpha(0));
    const labelEntity = viewer.entities.add({
      id: `${key}-label-${regionData.id}`,
      position: Cesium.Cartesian3.fromDegrees(regionData.labelPoint[0], regionData.labelPoint[1]),
      label: {
        text: regionData.name,
        font: `500 ${scaledTypographyPx(CHILD_LABEL_FONT_SIZE)}px "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif`,
        fillColor: labelFill,
        outlineColor: labelOutline,
        outlineWidth: Math.max(1.5, scaledVisualPx(CHILD_LABEL_OUTLINE_WIDTH)),
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: false,
        scaleByDistance: labelScaleByDistance(),
        translucencyByDistance: labelTranslucencyByDistance(),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        pixelOffset: new Cesium.Cartesian2(0, -28),
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
    return { source, fillProperties, outlineProperties, outlineEntities, labelEntity, labelProperties: [labelFill, labelOutline] };
  }

  function setOverlayStrength(fillProperties, outlineProperties, labelProperties, strength) {
    const value = clamp(strength, 0, 1);
    const fill = Cesium.Color.fromCssColorString("#FFD166").withAlpha(0.15 * value);
    const outline = Cesium.Color.fromCssColorString("#FFD166").withAlpha(0.98 * value);
    const labelFill = Cesium.Color.WHITE.withAlpha(value);
    const labelOutline = CHILD_LABEL_OUTLINE.withAlpha(readableChildLabelOutlineAlpha(value));
    for (const property of fillProperties) property.setValue(fill);
    for (const property of outlineProperties) property.setValue(outline);
    const labelColors = [labelFill, labelOutline];
    for (let index = 0; index < labelProperties.length; index += 1) labelProperties[index].setValue(labelColors[index]);
  }

  function pendingRenderWork() {
    const surface = viewer?.scene?.globe?._surface;
    const queueCount = [
      surface?._tileLoadQueueHigh,
      surface?._tileLoadQueueMedium
    ].reduce((total, queue) => total + Number(queue?.length || 0), 0);
    return queueCount;
  }

  function activeRenderRequests() {
    return Number(Cesium.RequestScheduler?.statistics?.numberOfActiveRequests || 0);
  }

  function renderedGlobeTileCount() {
    return Number(viewer?.scene?.globe?._surface?._tilesToRender?.length || 0);
  }

  async function waitForRender(timeoutMs = 120000) {
    const started = performance.now();
    const studioPreview = query.has("studioPreview");
    const effectiveTimeoutMs = studioPreview ? Math.min(timeoutMs, 20000) : timeoutMs;
    let stablePasses = 0;
    let stableSince = 0;
    let visiblePasses = 0;
    let visibleSince = 0;
    previewImageryFallback = false;
    while (performance.now() - started < effectiveTimeoutMs) {
      viewer.scene.requestRender();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const now = performance.now();
      // globe.tilesLoaded covers the visible scene. Cesium can keep speculative,
      // offscreen requests active while its low-priority cache is warming, so those
      // requests must not block a deterministic capture of an already settled view.
      // High/medium visible queues still block here; byte-stable screenshots provide
      // the final guard against imagery changing after this readiness gate.
      const settled = viewer.scene.globe.tilesLoaded && pendingRenderWork() === 0;
      const hasVisibleImagery = renderedGlobeTileCount() > 0;
      if (studioPreview && hasVisibleImagery) {
        if (visiblePasses === 0) visibleSince = now;
        visiblePasses += 1;
        if (visiblePasses >= 6 && now - visibleSince >= 180) {
          previewImageryFallback = !settled;
          renderStable = true;
          return;
        }
      } else {
        visiblePasses = 0;
        visibleSince = 0;
      }
      if (settled) {
        if (stablePasses === 0) stableSince = now;
        stablePasses += 1;
        if (stablePasses >= 4 && now - stableSince >= 120) {
          renderStable = true;
          return;
        }
      } else {
        stablePasses = 0;
        stableSince = 0;
      }
    }
    // Studio is interactive: a provider may leave visible requests retrying or
    // briefly report zero render tiles while Cesium swaps levels of detail.
    // Neither condition means the imagery source has failed, and throwing here
    // freezes the preview behind a permanent false-error panel. Let Cesium keep
    // loading in the background; export/capture URLs do not carry studioPreview
    // and retain the strict deterministic readiness gate above.
    if (studioPreview) {
      previewImageryFallback = true;
      renderStable = true;
      viewer.scene.requestRender();
      return;
    }
    renderStable = false;
    throw new Error(`Cesium imagery did not remain settled before timeout (tilesLoaded=${Boolean(viewer?.scene?.globe?.tilesLoaded)}, pendingVisible=${pendingRenderWork()}, activeRequests=${activeRenderRequests()})`);
  }

  function cameraForRegion(regionData) {
    if (!regionData) return cityCamera;
    const profileName = query.get("profile") || (innerHeight > innerWidth ? "portrait" : "landscape");
    const preset = regionData.cameraProfiles?.[profileName] || regionData.cameraPreset;
    if (!preset) return cityCamera;
    if (
      regionData.presentationMode === "parent-topic"
      || regionData.presentationMode === "parent-child-tour"
      || regionData.level === "prefecture"
      || regionData.levelRole === "admin2"
    ) {
      return {
        lon: preset.longitude,
        lat: preset.latitude,
        height: preset.height,
        heading: preset.heading ?? 0,
        pitch: preset.pitch ?? CAMERA_PITCH
      };
    }
    const range = regionData.level === "district"
      ? Math.max(115000, preset.height * 1.22)
      : Math.max(160000, preset.height * 1.5);
    return {
      lon: preset.longitude,
      lat: preset.latitude,
      height: range,
      heading: 0,
      pitch: CAMERA_PITCH
    };
  }

  function isParentRegion(regionData) {
    return Boolean(
      regionData
      && (
        regionData.presentationMode === "parent-topic"
        || regionData.presentationMode === "parent-child-tour"
        || regionData.level === "prefecture"
        || regionData.levelRole === "admin2"
      )
    );
  }

  // ---- child-tour flight origin (pure, test-extractable) --------------------
  // Every village flight is a geodesic interpolation between two cameras. Which
  // camera it leaves from depends on the leg: the first leg leaves the settled
  // parent overview, every later leg leaves the previous village. The overview
  // camera that is actually on screen already carries the child-tour range
  // scale (`descentCameraState()` converges on that same scaled range, and the
  // settled overview returns it verbatim), so resolving the *raw* overview
  // preset here skipped the scale and started the first tour frame on a
  // different range than the frame the viewer had just been watching. For the
  // shipped 乌石镇 portrait preset that is a 29 097 m range / 26 165 m altitude
  // first frame right after a 26 187 m / 23 547 m overview: a 2 617 m altitude
  // discontinuity, 11.1 % of the frame and 10.2 frames of the flight's own
  // motion collapsed into one, before the flight eases back in. The origin has
  // to be the camera that is already on screen.
  function tourFlightOriginCamera(previousStopCamera, parentOverviewCamera) {
    return previousStopCamera || parentOverviewCamera;
  }
  // ---- end child-tour flight origin ----------------------------------------

  function cameraStateAt(time) {
    if (openingDescent && time < openingDescent.seconds) {
      return descentCameraState(time);
    }
    const mapTime = openingDescent ? Math.max(0, time - openingDescent.seconds) : time;
    const fromCamera = cameraForRegion(fromRegion || region);
    const baseSelectedCamera = cameraForRegion(region);
    const selectedCamera = childTour
      ? { ...baseSelectedCamera, height: baseSelectedCamera.height * PARENT_OVERVIEW_CAMERA_HEIGHT_SCALE }
      : baseSelectedCamera;
    // Studio's opening preview may hold longer than the production boundary
    // reveal. Do not let that extended preview clock spill into the first
    // child-tour flight and then snap back to the parent camera on its final
    // frame. The parent overview camera stays locked while only the boundary
    // and label presentation continues.
    if (editorParentPreviewHold) return selectedCamera;
    if (childTour) {
      const profileName = query.get("profile") || (innerHeight > innerWidth ? "portrait" : "landscape");
      const childHeightScale = profileName === "portrait" ? Number(region.portraitChildCameraScale ?? 1) : 1;
      const tourStopCamera = (stop) => {
        const profilePreset = stop?.cameraProfiles?.[profileName];
        const preset = profilePreset || stop?.cameraPreset;
        return {
          lon: Number(preset.longitude),
          lat: Number(preset.latitude),
          height: Number(preset.height) * (profilePreset ? 1 : childHeightScale),
          heading: Number(preset.heading ?? 0),
          pitch: Number(preset.pitch ?? CAMERA_PITCH)
        };
      };
      const returnState = tourReturnStateAt(mapTime);
      if (returnState) {
        // Snap only inside a tiny settling window. This removes residual
        // sub-pixel geodesic/heading drift on the terminal frame while keeping
        // the visible approach continuous.
        if (returnState.rawProgress >= 0.999) return selectedCamera;
        // Keep using the same geodesic interpolation at the end of the return
        // flight. Switching to the overview camera on the first frame where
        // rawProgress reaches 1 caused a visible one-frame jump in the preview
        // (the interpolated state and the lock state can differ slightly due
        // to eased heading/pitch/height calculations and floating point error).
        return geodesicCameraState(tourStopCamera(returnState.last), selectedCamera, returnState.rawProgress);
      }
      const tour = tourStateAt(mapTime);
      if (!tour) return selectedCamera;
      // The first leg must leave the frame the viewer is already looking at
      // (the settled parent overview), not the raw overview preset.
      const previousCamera = tourFlightOriginCamera(
        tour.previous ? tourStopCamera(tour.previous) : null,
        selectedCamera
      );
      return geodesicCameraState(previousCamera, tourStopCamera(tour.current), tour.rawProgress);
    }
    if (parentTopic) return selectedCamera;
    if (isParentRegion(region) || mapTime >= FLIGHT_DURATION || String(fromRegion?.id) === String(region.id)) return selectedCamera;
    return geodesicCameraState(fromCamera, selectedCamera, clamp(mapTime / FLIGHT_DURATION, 0, 1));
  }

  function updateTransitionOverlays(time) {
    const mapTime = openingDescent ? Math.max(0, time - openingDescent.seconds) : time;
    if (parentTopic) {
      updateParentTopicLayers(mapTime);
      return;
    }
    const isParent = isParentRegion(region);
    const sameRegion = String(fromRegion?.id) === String(region.id);
    const fromStrength = isParent || sameRegion ? 0 : 1 - rangeProgress(mapTime, 0, 5.8);
    const selectedStrength = isParent ? 0 : sameRegion ? 1 : rangeProgress(mapTime, 1.2, 6.2);
    setOverlayStrength(fromFillProperties, fromOutlineProperties, fromLabelProperties, fromStrength);
    setOverlayStrength(selectedFillProperties, selectedOutlineProperties, selectedLabelProperties, selectedStrength);
    updateNamedFeatureLayers();
  }

  function updateOverlay(time) {
    const mapTime = openingDescent ? Math.max(0, time - openingDescent.seconds) : time;
    const parentName = parentTopic
      ? region.name
      : String(fromRegion?.id) === String(region.parentId)
        ? fromRegion?.name
        : region.parentName || "上级区域";
    const scenes = [
      [0, 8, parentTopic ? `${region.name}全域定位` : `从${parentName}全域定位${region.name}`],
      [8, 17, region.storyFacts?.population || "人口与聚落分布"],
      [17, 26, region.storyFacts?.economy || "县域经济与产业"],
      [26, 35, region.storyFacts?.history || "历史沿革"],
      [35, 44, region.storyFacts?.culture || "地方文化"],
      [44, timeline.duration + 1, region.storyFacts?.modern || "今日发展" ]
    ];
    const scene = scenes.find(([start, end]) => mapTime >= start && mapTime < end) || scenes.at(-1);
    titleEl.textContent = scene[2];
    const local = Math.min(mapTime - scene[0], scene[1] - mapTime);
    const opacity = clamp(local / 0.7, 0, 1);
    titleEl.style.opacity = String(opacity);
    titleEl.style.transform = `translateY(${Math.round((1 - opacity) * 18)}px)`;
  }

  function updateScene(time) {
    renderStable = false;
    presentationTime = openingDescent ? Math.max(0, time - openingDescent.seconds) : time;
    updateAnnotationVisibility(time);
    const openingActive = Boolean(openingDescent && time < openingDescent.seconds && query.get("atmosphere") !== "0");
    if (viewer) viewer.scene.globe.showGroundAtmosphere = openingActive;
    const camera = cameraStateAt(time);
    const target = Cesium.Cartesian3.fromDegrees(camera.lon, camera.lat, 0);
    viewer.camera.lookAt(target, new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(camera.heading),
      Cesium.Math.toRadians(camera.pitch),
      camera.height
    ));
    updateTransitionOverlays(time);
    updateOverlay(time);
    updateOpeningClouds(time, camera.height);
    viewer.scene.requestRender();
  }

  // Terrain is a per-deployment choice. The ellipsoid keeps the grounded
  // pipeline byte-deterministic and needs no network; a real terrain provider
  // makes clamped boundaries follow ridges and valleys instead of a smooth
  // globe. `?terrain=` overrides the config for a single capture.
  //
  // Accepted values: `ellipsoid`, `world-terrain` / `ion:<assetId>` (Cesium Ion,
  // requires a token), `arcgis` (ArcGIS World Elevation 3D, no token needed),
  // or `url:<quantized-mesh endpoint>`.
  const ARCGIS_WORLD_ELEVATION_URL = "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer";

  async function createTerrainProvider(runtimeConfig) {
    const terrainConfig = runtimeConfig.terrain && typeof runtimeConfig.terrain === "object" ? runtimeConfig.terrain : {};
    const requested = String(query.get("terrain") || terrainConfig.provider || "ellipsoid").trim().toLowerCase();
    const ellipsoid = () => ({ provider: new Cesium.EllipsoidTerrainProvider(), label: "ellipsoid" });
    if (requested === "ellipsoid" || requested === "none" || requested === "flat") return ellipsoid();
    try {
      if (requested === "arcgis" || requested === "arcgis-world-elevation") {
        const provider = await Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(
          String(terrainConfig.arcgisUrl || ARCGIS_WORLD_ELEVATION_URL)
        );
        return { provider, label: "arcgis:world-elevation-3d" };
      }
      if (requested.startsWith("url:")) {
        const provider = await Cesium.CesiumTerrainProvider.fromUrl(requested.slice("url:".length));
        return { provider, label: requested };
      }
      const assetId = requested.startsWith("ion:")
        ? Number(requested.slice("ion:".length))
        : Number(terrainConfig.ionAssetId ?? 1);
      if (!Number.isFinite(assetId)) return ellipsoid();
      if (!Cesium.Ion.defaultAccessToken) {
        // Ion terrain without a token cannot load a single tile. Say so instead
        // of queueing a silently empty terrain request.
        errors.push("terrain-unavailable: cesium ion token missing");
        return ellipsoid();
      }
      const provider = await Cesium.CesiumTerrainProvider.fromIonAssetId(assetId, {
        requestVertexNormals: terrainConfig.requestVertexNormals === true,
        requestWaterMask: terrainConfig.requestWaterMask === true
      });
      return { provider, label: `ion:${assetId}` };
    } catch (error) {
      // A terrain outage must never blank the map: fall back to the ellipsoid,
      // record the reason, and let the diagnostics surface the downgrade.
      errors.push(`terrain-fallback: ${String(error?.message || error)}`);
      return { provider: new Cesium.EllipsoidTerrainProvider(), label: "ellipsoid-after-failure" };
    }
  }

  // ---- Tianditu imagery and per-scene label annotation ---------------------
  /**
   * Wait `frames` rendered frames.
   *
   * The runtime contract bans timers (`setTimeout`) and wall-clock reads so that
   * a seek always produces the same picture; the retry below therefore backs off
   * in frames rather than milliseconds. 12/24/48 frames is roughly 0.2/0.4/0.8 s
   * at 60 Hz — long enough for a per-second quota to refill, short enough that a
   * stalled tile cannot hold a whole frame of the export.
   */
  async function waitFrames(frames) {
    for (let index = 0; index < frames; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
  }

  /**
   * Wrap a provider so a 429/5xx tile is retried instead of left as a hole.
   *
   * 天地图 rate-limits per key. A 30 fps export redraws continuously, and the
   * label layer adds a second tile stream on top of the imagery one; a measured
   * sample run produced 67 throttled label tiles out of 265 (25%). Cesium marks
   * a failed imagery request as failed and does not ask again for that level, so
   * those tiles stay blank for the whole shot — the labels simply are not in the
   * recording, with no error anywhere. Retrying here is what turns a throttled
   * tile back into a label.
   */
  /* 天地图免费 key 的配额按秒计。Cesium 默认每个域名 6 个并发请求，而 cia 层用了
     8 个子域（t0–t7），峰值就是 48 个同时在飞 —— 实测一份 10 秒样张里 237 次请求
     有 124 次被 429 拒。重试能救回一部分，但先要让它别一次挤那么多：把注记瓦片的
     并发压到 4，队列里排队的瓦片等都等，反正抓帧的每帧都在等 waitReady。 */
  const ANNOTATION_TILE_CONCURRENCY = 4;
  let annotationTilesActive = 0;
  const annotationTileQueue = [];
  function acquireAnnotationSlot() {
    if (annotationTilesActive < ANNOTATION_TILE_CONCURRENCY) {
      annotationTilesActive += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => annotationTileQueue.push(resolve));
  }
  function releaseAnnotationSlot() {
    const next = annotationTileQueue.shift();
    if (next) next();
    else annotationTilesActive = Math.max(0, annotationTilesActive - 1);
  }

  function withRetry(provider, label) {
    const request = provider.requestImage.bind(provider);
    provider.requestImage = async (x, y, level, imageRequest) => {
      await acquireAnnotationSlot();
      try {
        return await requestWithRetry(x, y, level, imageRequest);
      } finally {
        releaseAnnotationSlot();
      }
    };
    const requestWithRetry = async (x, y, level, imageRequest) => {
      let lastError;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          const image = await request(x, y, level, imageRequest);
          if (attempt > 0) annotationStats.recovered += 1;
          return image;
        } catch (error) {
          lastError = error;
          annotationStats.retries += 1;
          // 天地图按 key 限速，30 fps 逐帧重绘下 429 是常态而不是故障。退避要比
          // 之前长：0.5/1.5/3 s（约 30/90/180 帧）—— 太短等于没退避，实测样本里
          // 124/237 张瓦片被拒。
          if (attempt < 3) await waitFrames(30 * 3 ** attempt);
        }
      }
      annotationStats.failed += 1;
      /* 不写进 `errors`。`getFrameStatus().ready` 要求 errors 为空，一条 429 就会让
         整帧永远不就绪 —— 抓帧的 waitReady 直接超时，导出卡死。限流是暂时状态，
         它的可观测性由 `annotationTiles` 统计与抓帧结束时的注记校验负责。 */
      throw lastError;
    };
    return provider;
  }

  function tiandituLayerProvider(layer, token, tilePx = 256) {
    return withRetry(new Cesium.UrlTemplateImageryProvider({
      url: "https://t{s}.tianditu.gov.cn/" + layer + "_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=" + layer + "&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=" + encodeURIComponent(token),
      subdomains: ["0", "1", "2", "3", "4", "5", "6", "7"],
      minimumLevel: 1,
      maximumLevel: 18,
      // 服务端返回的图始终是 256 px；这个值声明的是「一张瓦片占多少屏幕像素」，
      // 因此大于 256 等于把注记放大（见 ANNOTATION_TILE_SCALE）。
      tileWidth: tilePx,
      tileHeight: tilePx,
      credit: "© 天地图"
    }), layer);
  }

  function applyAnnotationWindows(value) {
    annotationWindows = Array.isArray(value)
      ? value
        .map((range) => ({
          sceneId: String(range?.sceneId || ""),
          start: Number(range?.start),
          end: Number(range?.end)
        }))
        .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
      : [];
    if (viewer) updateAnnotationVisibility(currentTime);
  }

  function updateAnnotationVisibility(time) {
    if (!annotationLayer || !viewer) return;
    const presentation = openingDescent ? Math.max(0, time - openingDescent.seconds) : time;
    const openingActive = Boolean(openingDescent && time < openingDescent.seconds && query.get("atmosphere") !== "0");
    const visible = !openingActive && annotationWindows.some((range) => presentation + 0.001 >= range.start && presentation <= range.end + 0.001);
    if (annotationLayer.show === visible) return;
    annotationLayer.show = visible;
    viewer.scene.requestRender();
  }

  async function initialize() {
    if (initialized) return;
    if (runtimeErrorEl) runtimeErrorEl.hidden = true;
    const [serverRuntimeConfig, publicImageryConfig] = await Promise.all([
      fetch("/runtime-config.json", { cache: "no-store" })
        .then((response) => response.ok ? response.json() : {})
        .catch(() => ({})),
      fetch("/imagery-config.json", { cache: "no-store" })
        .then((response) => response.ok ? response.json() : {})
        .catch(() => ({}))
    ]);
    runtimeConfig = { ...publicImageryConfig, ...serverRuntimeConfig };
    if (runtimeConfig.token) Cesium.Ion.defaultAccessToken = runtimeConfig.token;
    const imageryMode = query.get("imagery") || runtimeConfig.imageryProvider || "cesium-ion-world-imagery";
    let imageryProvider;
    if (imageryMode === "natural-earth") {
      imageryProvider = await Cesium.TileMapServiceImageryProvider.fromUrl(Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII"));
    } else if (imageryMode === "mapbox-satellite") {
      if (!runtimeConfig.mapboxAccessToken) throw new Error("Mapbox 卫星影像缺少 MAPBOX_ACCESS_TOKEN");
      // Cesium's legacy MapboxImageryProvider hits the retired v4 tiles API.
      // Serve the same raster from the live styles/v1 endpoint instead.
      let styleId = runtimeConfig.mapboxMapId && runtimeConfig.mapboxMapId !== "mapbox.satellite"
        ? String(runtimeConfig.mapboxMapId)
        : "mapbox/satellite-v9";
      if (!styleId.includes("/")) styleId = "mapbox/" + styleId;
      imageryProvider = new Cesium.UrlTemplateImageryProvider({
        url: "https://api.mapbox.com/styles/v1/" + styleId + "/tiles/256/{z}/{x}/{y}?access_token=" + encodeURIComponent(runtimeConfig.mapboxAccessToken),
        maximumLevel: 22,
        credit: "© Mapbox © OpenStreetMap"
      });
    } else if (imageryMode === "esri-world-imagery") {
      imageryProvider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
        runtimeConfig.esriWorldImageryUrl || "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer"
      );
    } else if (imageryMode === "tianditu-imagery") {
      if (!runtimeConfig.tiandituToken) throw new Error("天地图影像缺少 TIANDITU_TOKEN");
      imageryProvider = tiandituLayerProvider("img", runtimeConfig.tiandituToken);
    } else if (imageryMode === "bing-aerial") {
      if (!runtimeConfig.bingMapsKey) throw new Error("必应卫星影像缺少 BING_MAPS_KEY");
      imageryProvider = await Cesium.BingMapsImageryProvider.fromUrl("https://dev.virtualearth.net", {
        key: runtimeConfig.bingMapsKey,
        mapStyle: Cesium.BingMapsStyle.AERIAL
      });
    } else {
      imageryProvider = await Cesium.IonImageryProvider.fromAssetId(Number(runtimeConfig.imageryIonAssetId || 2));
    }
    const baseLayer = new Cesium.ImageryLayer(imageryProvider);
    const visualGrade = resolveVisualGrade(runtimeConfig.visual);
    baseLayer.brightness = visualGrade.imageryBrightness;
    baseLayer.contrast = visualGrade.imageryContrast;
    baseLayer.saturation = visualGrade.imagerySaturation;
    baseLayer.gamma = visualGrade.imageryGamma;
    baseLayer.hue = visualGrade.imageryHue;
    labelDistanceOptions = resolveOptions(runtimeConfig.labelDistance, LABEL_DISTANCE_DEFAULTS);
    focusMaskOptions = resolveOptions(runtimeConfig.focusMask, FOCUS_MASK_DEFAULTS);
    featureOptions = resolveOptions(runtimeConfig.features, FEATURE_DEFAULTS);
    const terrain = await createTerrainProvider(runtimeConfig);
    activeTerrainLabel = terrain.label;
    viewer = new Cesium.Viewer("cesiumContainer", {
      baseLayer,
      terrainProvider: terrain.provider,
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      useBrowserRecommendedResolution: false
    });
    viewer.resolutionScale = 1;
    if (runtimeConfig.tiandituToken) {
      // The label layer is always present but hidden until a scene window asks
      // for it. Keeping one persistent layer avoids rebuilding providers while
      // seeking and makes per-scene toggles cheap and deterministic.
      annotationLayer = new Cesium.ImageryLayer(tiandituLayerProvider("cia", runtimeConfig.tiandituToken, ANNOTATION_TILE_PX));
      annotationLayer.show = false;
      viewer.imageryLayers.add(annotationLayer);
    }
    const studioPreview = query.has("studioPreview");
    viewer.scene.globe.maximumScreenSpaceError = studioPreview ? 1.5 : 1.0;
    viewer.scene.globe.tileCacheSize = 2600;
    viewer.scene.globe.preloadAncestors = !studioPreview;
    viewer.scene.globe.preloadSiblings = !studioPreview;
    viewer.scene.fog.enabled = false;
    viewer.scene.globe.showGroundAtmosphere = false;
    viewer.scene.highDynamicRange = false;
    viewer.scene.postProcessStages.fxaa.enabled = false;
    if (viewer.scene.postProcessStages.bloom) viewer.scene.postProcessStages.bloom.enabled = false;
    viewer.scene.screenSpaceCameraController.enableInputs = false;
    viewer.clock.shouldAnimate = false;
    viewer.scene.postRender.addEventListener(() => {
      drawEditorBoundaryReveal(editorBoundaryPendingReveal, editorBoundaryPendingStrength, true);
    });
    initialized = true;
  }

  async function loadRegion(regionId) {
    await initialize();
    errors.length = 0;
    if (fromBoundarySource) {
      viewer.dataSources.remove(fromBoundarySource, true);
      fromBoundarySource = null;
    }
    if (selectedBoundarySource) {
      viewer.dataSources.remove(selectedBoundarySource, true);
      selectedBoundarySource = null;
    }
    if (parentFillSource) {
      viewer.dataSources.remove(parentFillSource, true);
      parentFillSource = null;
    }
    if (childFillSource) {
      viewer.dataSources.remove(childFillSource, true);
      childFillSource = null;
    }
    removeEntityList(siblingBoundaryEntities);
    removeEntityList(contextParentOutlineEntities);
    removeEntityList(fromOutlineEntities);
    removeEntityList(selectedOutlineEntities);
    removeEntityList(parentRevealEntities);
    removeEntityList(parentStableBoundaryEntities);
    if (parentPenEntity) viewer.entities.remove(parentPenEntity);
    removeEntityList(childBoundaryEntities);
    removeEntityList(childSelectionEntities);
    removeEntityList(childLabelEntities);
    if (fromLabelEntity) viewer.entities.remove(fromLabelEntity);
    if (selectedLabelEntity) viewer.entities.remove(selectedLabelEntity);
    if (parentTopicLabelEntity) viewer.entities.remove(parentTopicLabelEntity);
    if (cloudCollection) {
      viewer.scene.primitives.remove(cloudCollection);
      cloudCollection = null;
    }
    openingClouds = [];
    openingDescent = null;
    fromLabelEntity = null;
    selectedLabelEntity = null;
    parentTopicLabelEntity = null;
    parentTopicLabelPositionProperty = null;
    parentTopicLabelScaleProperty = null;
    parentTopicLabelPixelOffsetProperty = null;
    parentPenEntity = null;
    parentPenPositionProperty = null;
    parentPenColorProperty = null;
    fromFillProperties = [];
    fromOutlineProperties = [];
    fromLabelProperties = [];
    selectedFillProperties = [];
    selectedOutlineProperties = [];
    selectedLabelProperties = [];
    parentFillProperties = [];
    parentRevealRings = [];
    parentRevealColorProperties = [];
    parentDrawSegments = [];
    parentStableBoundaryEntities = [];
    parentStableBoundaryColorProperties = [];
    parentStableUnderlayColorProperties = [];
    childBoundaryColorProperties = [];
    childBoundaryColorPropertiesById = new Map();
    childSelectionEntitiesById = new Map();
    childSelectionColorPropertiesById = new Map();
    childLabelEntitiesById = new Map();
    childLabelColorPropertiesById = new Map();
    childLabelScalePropertiesById = new Map();
    childLabelPositionsById = new Map();
    childFillPropertiesById = new Map();
    childFillEntitiesById = new Map();
    parentTopicLabelProperties = [];
    parentTopic = false;
    childTour = false;
    previousVisibleLabelIds = new Set();
    if (focusMaskEntity) viewer.entities.remove(focusMaskEntity);
    focusMaskEntity = null;
    focusMaskColorProperty = null;
    focusMaskResolved = null;
    removeEntityList(namedFeatureSources);
    for (const entry of namedFeatures) {
      if (entry.labelEntity) viewer.entities.remove(entry.labelEntity);
    }
    namedFeatures = [];
    const [regionResponse, timelineResponse, geometryResponse] = await Promise.all([
      fetch(withDataVersion(`/data/regions/${regionId}.json`)),
      fetch(withDataVersion(`/data/regions/${regionId}.timeline.json`)),
      fetch(withDataVersion(`/data/normalized/${regionId}.geojson`))
    ]);
    if (!regionResponse.ok || !timelineResponse.ok || !geometryResponse.ok) {
      throw new Error(`Missing region assets for ${regionId}`);
    }
    const geometry = await geometryResponse.json();
    // The portrait establishing frame is derived from the geometry parsed just
    // above, and the label ramp is authored against the range that comes out of
    // it, so the framing has to be settled before the ramp is resolved. See the
    // portrait overview framing block for why the stored profile is not trusted.
    region = applyPortraitZoomToLayer(await regionResponse.json(), geometry);
    labelReferenceDistance = resolveLabelReferenceDistance();
    // Export reads the windows frozen beside the region. Studio preview keeps
    // whatever the editor has already posted: its first `set-annotations` can
    // land while this load is still awaiting the region fetch, and wiping it
    // here left the labels dead until the next scene click.
    applyAnnotationWindows(query.has("studioPreview") ? annotationWindows : region.annotationWindows);
    timeline = await timelineResponse.json();
    openingDescent = resolveOpeningDescent(region);
    const parentId = String(region.parentId || region.id);
    const requestedFromId = query.get("from") || parentId;
    childTour = region.presentationMode === "parent-child-tour";
    parentTopic = region.presentationMode === "parent-topic" || childTour;
    if (parentTopic) {
      if (!region.childGeometryPath) throw new Error(`Parent-topic region ${regionId} has no childGeometryPath`);
      const childGeometryResponse = await fetch(withDataVersion(`/${String(region.childGeometryPath).replace(/^\/+/, "")}`));
      if (!childGeometryResponse.ok) throw new Error(`Missing child geometry for ${regionId}`);
      const childGeometry = await childGeometryResponse.json();
      fromRegion = region;
      await buildParentTopicLayers(geometry, childGeometry);
      buildOpeningClouds();
      await seek(0);
      return;
    }

    const parentRegionResponse = await fetch(withDataVersion(`/data/regions/${parentId}.json`));
    const parentRegion = parentRegionResponse.ok ? await parentRegionResponse.json() : null;
    const siblingGeometryPath = parentRegion?.childGeometryPath || `data/raw/${parentId}_full.geojson`;
    const parentGeometryPath = parentRegion?.geometryPath;
    const [cityGeometryResponse, parentGeometryResponse] = await Promise.all([
      fetch(withDataVersion(`/${String(siblingGeometryPath).replace(/^\/+/, "")}`)),
      parentGeometryPath
        ? fetch(withDataVersion(`/${String(parentGeometryPath).replace(/^\/+/, "")}`))
        : Promise.resolve(null)
    ]);
    if (!cityGeometryResponse.ok) throw new Error(`Missing sibling geometry for parent ${parentId}`);
    const cityGeometry = await cityGeometryResponse.json();
    const cityBounds = boundsFromFeatureCollection(cityGeometry);
    const citySpan = Math.max(cityBounds.east - cityBounds.west, cityBounds.north - cityBounds.south);
    cityCamera = {
      lon: (cityBounds.west + cityBounds.east) / 2,
      lat: (cityBounds.south + cityBounds.north) / 2,
      height: Math.max(480000, citySpan * 275000),
      heading: 0,
      pitch: CAMERA_PITCH
    };
    region.parentName = parentRegion?.name || region.parentName || parentId;
    // The animated parent-draw layer is the single source of truth for the
    // opening boundary. Do not pre-create a static context outline here: it
    // bypasses the pen reveal timeline and makes the administrative boundary
    // visible before the brush reaches it.
    if (parentGeometryResponse?.ok) await parentGeometryResponse.json();
    buildSiblingBoundaries(cityGeometry);

    if (String(requestedFromId) === String(regionId)) {
      fromRegion = region;
    } else if (String(requestedFromId) === parentId) {
      fromRegion = parentRegion || { id: parentId, name: region.parentName, level: "prefecture", cameraPreset: cityCamera };
    } else {
      const [fromRegionResponse, fromGeometryResponse] = await Promise.all([
        fetch(withDataVersion(`/data/regions/${requestedFromId}.json`)),
        fetch(withDataVersion(`/data/normalized/${requestedFromId}.geojson`))
      ]);
      if (!fromRegionResponse.ok || !fromGeometryResponse.ok) throw new Error(`Missing previous-region assets for ${requestedFromId}`);
      fromRegion = await fromRegionResponse.json();
      const fromGeometry = await fromGeometryResponse.json();
      const fromOverlay = await createRegionOverlay(fromRegion, fromGeometry, "from");
      fromBoundarySource = fromOverlay.source;
      fromFillProperties = fromOverlay.fillProperties;
      fromOutlineProperties = fromOverlay.outlineProperties;
      fromOutlineEntities = fromOverlay.outlineEntities;
      fromLabelEntity = fromOverlay.labelEntity;
      fromLabelProperties = fromOverlay.labelProperties;
    }

    if (String(regionId) !== "440800") {
      const selectedOverlay = await createRegionOverlay(region, geometry, "selected");
      selectedBoundarySource = selectedOverlay.source;
      selectedFillProperties = selectedOverlay.fillProperties;
      selectedOutlineProperties = selectedOverlay.outlineProperties;
      selectedOutlineEntities = selectedOverlay.outlineEntities;
      selectedLabelEntity = selectedOverlay.labelEntity;
      selectedLabelProperties = selectedOverlay.labelProperties;
    }
    await buildNamedFeatureLayers(region);
    await seek(0);
  }

  async function seek(seconds) {
    if (!region || !timeline) throw new Error("Load a region before seeking");
    // Deterministic capture and exported video always use the production timing.
    parentRevealTimingOverride = null;
    editorParentPreviewHold = false;
    const previousTime = currentTime;
    currentTime = clamp(Number(seconds), 0, timeline.duration);
    updateScene(currentTime);
    await waitForRender();
    if (Math.abs(currentTime - previousTime) > 0.08) {
      updateScene(currentTime);
      await waitForRender();
    }
    statusEl.textContent = JSON.stringify(getFrameStatus(), null, 2);
  }

  function getFrameStatus() {
    const fontsReady = document.fonts.status === "loaded";
    const tilesReady = Boolean(viewer?.scene?.globe?.tilesLoaded);
    const pendingRequests = pendingRenderWork();
    const activeRequests = activeRenderRequests();
    const imageryReady = Boolean(renderStable && (
      (tilesReady && pendingRequests === 0)
      || (query.has("studioPreview") && previewImageryFallback)
    ));
    const ready = Boolean(initialized && region && timeline && imageryReady && fontsReady && errors.length === 0);
    return {
      time: currentTime,
      ready,
      tilesReady,
      imageryReady,
      terrainReady: true,
      fontsReady,
      entitiesReady: parentTopic
        ? Boolean(parentFillSource && parentRevealEntities.length > 0 && childBoundaryEntities.length > 0 && childLabelEntities.length > 0)
        : Boolean(siblingBoundaryEntities.length > 0 && (String(region?.id) === "440800" || (selectedBoundarySource && selectedLabelEntity))),
      pendingRequests,
      activeRequests,
      previewImageryFallback,
      annotationVisible: Boolean(annotationLayer?.show),
      annotationWindowCount: annotationWindows.length,
      errors: [...errors]
    };
  }

  function getDiagnostics() {
    const returnState = tourReturnStateAt(presentationTime);
    const tour = tourStateAt(presentationTime);
    const selectedChildId = returnState?.locked ? null : tour?.current?.id || null;
    const selectedBoundaryColorProperty = selectedChildId
      ? childSelectionColorPropertiesById.get(String(selectedChildId))?.[0]
      : null;
    const selectedBoundaryColor = selectedBoundaryColorProperty?.getValue(viewer?.clock.currentTime);
    const parentBoundaryColor = parentStableBoundaryColorProperties[0]?.getValue(viewer?.clock.currentTime);
    // The prewarmed complete-ring primitive always sits at BOUNDARY_PREWARM_ALPHA,
    // so reporting only that alpha reads as "the parent boundary is invisible"
    // while the segmented trace is fully painted on screen. Sample the layer that
    // is actually visible as well, and say how many segments carry it.
    const parentPaintAlphas = parentDrawSegments.map((segment) => (
      Number(segment.colorProperty.getValue(viewer?.clock.currentTime)?.alpha) || 0
    ));
    const parentPaintAlpha = parentPaintAlphas.length > 0 ? Math.max(...parentPaintAlphas) : 0;
    const parentVisibleSegments = parentPaintAlphas.filter((alpha) => alpha > 0.1).length;
    // The parent *name* is a separate layer from the parent boundary, and QA
    // needs to tell them apart: the boundary is meant to persist as hierarchy
    // context through the whole village tour, while the name is meant to be
    // retired by the first village flight and stay retired - it is an
    // opening-overview treatment, so a non-zero reading here after the tour has
    // started is the regression, not a reading of zero.
    const parentLabelAlpha = parentTopicLabelProperties.length === 2
      ? Number(parentTopicLabelProperties[0].getValue(viewer?.clock.currentTime)?.alpha) || 0
      : 0;
    const hasConfiguredClosingStart = Object.prototype.hasOwnProperty.call(region || {}, "tourClosingNarrationStart");
    const configuredClosingStart = hasConfiguredClosingStart
      ? region?.tourClosingNarrationStart
      : region?.tourOutroStart;
    const hasClosingNarration = configuredClosingStart !== null && Number.isFinite(Number(configuredClosingStart));
    const closingNarration = returnState
      ? closingNarrationStateAt(
          presentationTime,
          returnState.start,
          returnState.duration,
          hasClosingNarration ? Number(configuredClosingStart) : null
        )
      : null;
    const visibleChildLabelIds = [...childLabelEntitiesById.entries()]
      .filter(([, entity]) => entity.show)
      .map(([id]) => id);
    // Boxes for the labels that survived avoidance, in screen pixels. QA reads
    // these to prove the set is non-overlapping at any camera scale without
    // re-deriving the label metrics from a screenshot.
    const visibleLabelBoxes = visibleChildLabelIds
      .map((id) => {
        const authoredScale = Number(childLabelScalePropertiesById.get(String(id))?.getValue(viewer?.clock.currentTime)) || 1;
        const box = childLabelScreenBox(String(id), authoredScale, 0);
        if (!box) return null;
        return {
          id: box.id,
          x: Math.round(box.x),
          y: Math.round(box.y),
          halfWidth: Number(box.halfWidth.toFixed(1)),
          halfHeight: Number(box.halfHeight.toFixed(1)),
          authoredScale: Number(authoredScale.toFixed(3)),
          distanceScale: Number(box.distanceScale.toFixed(3)),
          cameraDistanceMeters: Math.round(box.distance)
        };
      })
      .filter(Boolean);
    let overlappedLabelPairs = 0;
    for (let i = 0; i < visibleLabelBoxes.length; i += 1) {
      for (let j = i + 1; j < visibleLabelBoxes.length; j += 1) {
        const a = visibleLabelBoxes[i];
        const b = visibleLabelBoxes[j];
        if (Math.abs(a.x - b.x) < a.halfWidth + b.halfWidth
          && Math.abs(a.y - b.y) < a.halfHeight + b.halfHeight) overlappedLabelPairs += 1;
      }
    }
    return {
      regionId: region?.id || null,
      fromRegionId: fromRegion?.id || null,
      presentationMode: region?.presentationMode || "child-transition",
      selectedChildId,
      selectedBoundary: selectedBoundaryColorProperty ? {
        color: selectedBoundaryColor?.toCssColorString?.() ?? null,
        underlayWidth: scaledVisualPx(SELECTED_UNDERLAY_WIDTH),
        mainWidth: scaledVisualPx(SELECTED_BOUNDARY_WIDTH),
        underlayZIndex: 150,
        mainZIndex: 151
      } : null,
      parentBoundary: parentBoundaryColor ? {
        color: parentBoundaryColor.toCssColorString?.() ?? null,
        alpha: parentBoundaryColor.alpha,
        mainWidth: scaledVisualPx(PARENT_BOUNDARY_WIDTH),
        visible: parentStableBoundaryEntities.every((entity) => entity.show !== false),
        paintAlpha: parentPaintAlpha,
        visibleSegmentCount: parentVisibleSegments,
        segmentCount: parentDrawSegments.length,
        labelAlpha: parentLabelAlpha,
        paintSource: "segmented-grounded-trace"
      } : null,
      focusMask: focusMaskResolved ? {
        enabled: true,
        alpha: focusMaskResolved.alpha,
        holeCount: focusMaskResolved.holes,
        bounds: focusMaskResolved.bounds,
        frameFootprint: focusMaskResolved.frameFootprint
      } : { enabled: false },
      namedFeatures: namedFeatures.map((entry) => ({
        id: entry.id,
        segmentCount: entry.segments.length,
        revealStart: entry.action ? Number(entry.action.time) || 0 : null,
        alpha: entry.segments.reduce((best, segment) => Math.max(
          best,
          Number(segment.colorProperty.getValue(viewer?.clock.currentTime)?.alpha) || 0
        ), 0),
        labelVisible: Boolean(entry.labelEntity?.show)
      })),
      labelDistance: {
        enabled: labelDistanceOptions.distanceScale === true,
        translucency: labelDistanceOptions.translucency === true,
        declutter: labelDistanceOptions.declutter === true,
        referenceDistanceMeters: Math.round(labelReferenceDistance)
      },
      terrainProvider: activeTerrainLabel,
      tourReturn: returnState ? {
        start: returnState.start,
        duration: returnState.duration,
        progress: returnState.progress,
        locked: returnState.locked,
        silentDuringMovement: region?.tourReturnSilent !== false,
        openingCameraLocked: closingNarration?.openingCameraLocked ?? false,
        closingNarrationStart: hasClosingNarration ? Number(configuredClosingStart) : null,
        closingNarrationAllowed: hasClosingNarration && Boolean(closingNarration?.narrationAllowed)
      } : null,
      visibleChildLabelIds,
      visitedChildLabelIds: visibleChildLabelIds,
      visibleLabelBoxes,
      overlappedLabelPairs,
      boundaryUnitCount: childBoundaryColorPropertiesById.size,
      childFillCount: childFillPropertiesById.size,
      contextChildBoundaryMode: "stable-parent-boundary-after-once-only-draw",
      selectionMaterialMode: "callback-uniform-with-hidden-positive-alpha-rest-state",
      imagery: query.get("imagery") || runtimeConfig.imageryProvider || "cesium-ion-world-imagery",
      annotationVisible: Boolean(annotationLayer?.show),
      annotationWindowCount: annotationWindows.length,
      annotationTiles: { ...annotationStats },
      timelineDuration: timeline?.duration || null,
      presentationTime,
      openingDescent: openingDescent ? {
        enabled: true,
        seconds: openingDescent.seconds,
        active: currentTime < openingDescent.seconds,
        cloudDeckHeightMeters: openingDescent.cloudDeckHeightMeters,
        cloudsEnabled: openingDescent.cloudsEnabled,
        cloudsActive: Boolean(cloudCollection?.show)
      } : null,
      camera: viewer ? {
        longitude: Cesium.Math.toDegrees(viewer.camera.positionCartographic.longitude),
        latitude: Cesium.Math.toDegrees(viewer.camera.positionCartographic.latitude),
        height: viewer.camera.positionCartographic.height
      } : null,
      frameStatus: getFrameStatus(),
      // Runtime errors were only visible as a blank map before. Surface them so
      // a missing feature file or a terrain downgrade is diagnosable from QA.
      errors: errors.slice(0, 24),
      userAgent: navigator.userAgent
    };
  }

  function cancelPreviewAnimation() {
    if (previewAnimationFrame !== null) cancelAnimationFrame(previewAnimationFrame);
    previewAnimationFrame = null;
  }

  // Offset past the opening descent at which the editor replay parks its final
  // frame. See `settledOverviewHoldSeconds` for why the recession fade has to be
  // part of it: parking on the trace settle alone left the editor preview
  // undimmed outside the region while the exported video is dimmed there.
  function editorSettledHoldOffset() {
    return settledOverviewHoldSeconds(PARENT_SETTLE_TIME, focusMaskOptions.fadeSeconds, focusMaskOptions.enabled);
  }

  function playOpeningPreview(overrides = {}) {
    if (!region || !timeline) return false;
    cancelPreviewAnimation();
    applyAnnotationWindows(overrides.annotationWindows);
    const baseOpening = openingDescent ?? {
      ...OPENING_DESCENT_DEFAULTS,
      cloudsEnabled: true
    };
    openingDescent = {
      ...baseOpening,
      seconds: clamp(Number(overrides.descentSeconds ?? overrides.seconds ?? baseOpening.seconds), 2, 16),
      startHeightMeters: Math.max(800000, Number(overrides.startHeightMeters ?? baseOpening.startHeightMeters)),
      startPitchDegrees: clamp(Number(overrides.startPitchDegrees ?? baseOpening.startPitchDegrees), -90, -30),
      cloudDeckHeightMeters: Math.max(20000, Number(overrides.cloudDeckHeightMeters ?? baseOpening.cloudDeckHeightMeters)),
      cloudsEnabled: overrides.clouds !== false && baseOpening.cloudsEnabled !== false,
      cloudAlphaPeak: clamp(Number(overrides.cloudAlphaPeak ?? baseOpening.cloudAlphaPeak), 0, 1)
    };
    // Clear the previously settled editor frame before asynchronous cloud
    // construction can paint. This prevents a completed boundary flashing at
    // high altitude and then disappearing when the opening clock starts.
    currentTime = 0;
    parentRevealTimingOverride = null;
    editorParentPreviewHold = false;
    updateScene(0);
    buildOpeningClouds();
    const editorFastPreview = overrides.editorFastPreview === true;
    const skipDescent = editorFastPreview && overrides.skipDescent !== false;
    editorParentPreviewHold = editorFastPreview;
    parentRevealTimingOverride = editorFastPreview ? {
      start: clamp(Number(overrides.revealDelaySeconds ?? 0.08), 0, 0.5),
      duration: clamp(Number(overrides.revealSeconds ?? 1.4), 0.8, 2.2),
      settle: clamp(Number(overrides.settleSeconds ?? 0.22), 0.12, 0.5)
    } : null;
    const revealStart = parentRevealTimingOverride?.start ?? PARENT_REVEAL_START;
    const revealDuration = parentRevealTimingOverride?.duration ?? PARENT_REVEAL_DURATION;
    const settleDuration = parentRevealTimingOverride?.settle ?? PARENT_SETTLE_DURATION;
    const mapDuration = revealStart + revealDuration + settleDuration;
    const orbitHoldSeconds = editorFastPreview ? clamp(Number(overrides.orbitHoldSeconds ?? 3.4), 2.2, 6) : 0;
    const duration = (skipDescent ? mapDuration : openingDescent.seconds + mapDuration) + orbitHoldSeconds;
    const startedAt = performance.now();
    let openingLabelVisibleNotified = false;
    const labelVisibleAt = (skipDescent ? 0 : openingDescent.seconds) + revealStart + revealDuration + 0.45;
    const tick = (now) => {
      const elapsed = clamp((now - startedAt) / 1000, 0, duration);
      // In the editor the selected overview scene is already at the parent
      // camera, so replay only the pen reveal. Export/capture still begins at
      // the high-altitude globe and follows the complete opening timeline.
      currentTime = skipDescent ? openingDescent.seconds + elapsed : elapsed;
      try {
        updateScene(currentTime);
      } catch (error) {
        const message = `Opening preview: ${String(error?.message || error)}`;
        if (!errors.includes(message)) errors.push(message);
        statusEl.textContent = JSON.stringify(getFrameStatus(), null, 2);
        previewAnimationFrame = null;
        return;
      }
      if (!openingLabelVisibleNotified && elapsed >= labelVisibleAt) {
        openingLabelVisibleNotified = true;
        window.parent?.postMessage({ type: "geo-video-player", event: "opening-label-visible", regionId: region.id }, "*");
      }
      if (elapsed < duration) previewAnimationFrame = requestAnimationFrame(tick);
      else {
        if (editorFastPreview) {
          // Finish on the canonical settled production state. This keeps the
          // editor shortcut from altering capture timing while guaranteeing
          // the completed boundary and label remain visible.
          parentRevealTimingOverride = null;
          currentTime = openingDescent.seconds + editorSettledHoldOffset();
          updateScene(currentTime);
        }
        previewAnimationFrame = null;
        window.parent?.postMessage({ type: "geo-video-player", event: "opening-preview-complete", regionId: region.id }, "*");
      }
    };
    currentTime = skipDescent ? openingDescent.seconds : 0;
    try {
      updateScene(currentTime);
    } catch (error) {
      const message = `Opening preview: ${String(error?.message || error)}`;
      if (!errors.includes(message)) errors.push(message);
      statusEl.textContent = JSON.stringify(getFrameStatus(), null, 2);
      return false;
    }
    previewAnimationFrame = requestAnimationFrame(tick);
    return true;
  }

  // Installs the child-tour context (stops, return timing, `childTour`) without
  // moving the clock. Studio posts this *before* a preview so the editor renders
  // the parent overview on the same camera the export uses: a materialised
  // export region is `parent-child-tour`, which is what applies
  // PARENT_OVERVIEW_CAMERA_HEIGHT_SCALE to the overview camera. Without it the
  // editor parks the opening frame on the raw preset range and the first village
  // flight then appears to jump to a different scale.
  function configureStudioTour(payload = {}) {
    if (!region || !timeline || !Array.isArray(payload.tourStops)) return false;
    editorParentPreviewHold = false;
    parentRevealTimingOverride = null;
    cancelPreviewAnimation();
    applyAnnotationWindows(payload.annotationWindows);
    region.tourStops = payload.tourStops;
    applyTourStopLabelNames(region.tourStops);
    region.presentationMode = "parent-child-tour";
    region.tourReturnStart = Number(payload.tourStops.at(-1)?.end || 0);
    region.tourReturnDurationSeconds = clamp(Number(payload.returnDuration || TOUR_RETURN_DURATION_SECONDS), TOUR_RETURN_MIN_SECONDS, TOUR_RETURN_MAX_SECONDS);
    region.tourReturnSilent = true;
    childTour = true;
    parentTopic = true;
    timeline.duration = Math.max(Number(timeline.duration) || 0, Number(payload.time) || 0);
    return true;
  }

  function applyTourStopLabelNames(stops = []) {
    for (const stop of stops) {
      const entity = childLabelEntitiesById.get(String(stop.id));
      const name = String(stop.name || "").trim();
      if (!entity?.label || !name) continue;
      if (typeof entity.label.text?.setValue === "function") entity.label.text.setValue(name);
      else entity.label.text = name;
    }
  }

  async function showStudioTourFrame(payload = {}) {
    if (!configureStudioTour(payload)) return false;
    // Studio tour timestamps are relative to the post-opening presentation.
    // Include the opening descent here just as playback does; otherwise a
    // directly selected village lands several seconds early and the parent
    // boundary appears to draw in after the child region is already visible.
    const openingSeconds = openingDescent ? openingDescent.seconds : 0;
    await seek(openingSeconds + Math.max(0, Number(payload.time) || 0));
    return true;
  }

  function playStudioTourSegment(payload = {}) {
    if (!configureStudioTour(payload)) return false;
    const targetId = String(payload.targetId || "");
    const stop = region.tourStops.find((item) => String(item.id) === targetId);
    if (!stop) return false;
    const openingSeconds = openingDescent ? openingDescent.seconds : 0;
    const segmentStart = openingSeconds + Number(stop.start || 0);
    const segmentEnd = Math.max(segmentStart + 0.1, openingSeconds + Number(stop.end || 0));
    timeline.duration = Math.max(Number(timeline.duration) || 0, segmentEnd);
    const startedAt = performance.now();
    let flightCompleteSent = false;
    const notifyFlightComplete = () => {
      if (flightCompleteSent) return;
      flightCompleteSent = true;
      window.parent?.postMessage({ type: "geo-video-player", event: "tour-flight-complete", regionId: region.id, childId: stop.id }, "*");
    };
    currentTime = segmentStart;
    updateScene(currentTime);
    const tick = (now) => {
      currentTime = Math.min(segmentEnd, segmentStart + (now - startedAt) / 1000);
      updateScene(currentTime);
      if (currentTime + 0.001 >= segmentStart + Number(stop.flightDuration || 0)) notifyFlightComplete();
      if (currentTime < segmentEnd) previewAnimationFrame = requestAnimationFrame(tick);
      else {
        notifyFlightComplete();
        previewAnimationFrame = null;
        window.parent?.postMessage({ type: "geo-video-player", event: "tour-segment-complete", regionId: region.id, childId: stop.id }, "*");
      }
    };
    previewAnimationFrame = requestAnimationFrame(tick);
    return true;
  }

  function playStudioTourOutro(payload = {}) {
    if (!configureStudioTour(payload)) return false;
    const last = region.tourStops.at(-1);
    if (!last) return false;
    const openingSeconds = openingDescent ? openingDescent.seconds : 0;
    const segmentStart = openingSeconds + Number(last.end || 0);
    const returnDuration = Number(region.tourReturnDurationSeconds || TOUR_RETURN_DURATION_SECONDS);
    const segmentDuration = Math.max(returnDuration, Number(payload.segmentDuration) || returnDuration);
    const segmentEnd = segmentStart + segmentDuration;
    timeline.duration = Math.max(Number(timeline.duration) || 0, segmentEnd);
    const startedAt = performance.now();
    currentTime = segmentStart;
    updateScene(currentTime);
    const tick = (now) => {
      currentTime = Math.min(segmentEnd, segmentStart + (now - startedAt) / 1000);
      updateScene(currentTime);
      if (currentTime < segmentEnd) previewAnimationFrame = requestAnimationFrame(tick);
      else {
        previewAnimationFrame = null;
        window.parent?.postMessage({ type: "geo-video-player", event: "tour-outro-complete", regionId: region.id }, "*");
      }
    };
    previewAnimationFrame = requestAnimationFrame(tick);
    return true;
  }

  /**
   * Play an arbitrary slice of the film's timeline, continuously.
   *
   * Child villages already had `playStudioTourSegment`, which flies a tour stop
   * and then holds. Everything else — the overview scenes, 结尾补充 — had no
   * motion at all: the editor showed a single establishing frame and only the
   * narration played, so pressing ▶ on an overview looked like a slideshow.
   * This drives `updateScene` from the frame clock instead of seeking once, so
   * the camera follows the same path the export records.
   *
   * `flightSeconds` exists so the editor can reveal a scene's photo at the
   * moment the camera settles, exactly as `tour-flight-complete` does for a
   * village flight. It is optional: overview scenes have no flight to wait for.
   */
  function playTimelineRange(range = {}) {
    if (!timeline || !region) return false;
    cancelPreviewAnimation();
    const openingSeconds = openingDescent ? openingDescent.seconds : 0;
    const start = Math.max(0, openingSeconds + (Number(range.start) || 0));
    const end = Math.max(start + 0.2, openingSeconds + (Number(range.end) || Number(timeline.duration) || 0));
    const flightSeconds = Number(range.flightSeconds) || 0;
    const flightAt = flightSeconds > 0 ? start + flightSeconds : null;
    let flightCompleteSent = false;
    const notifyFlightComplete = () => {
      if (flightCompleteSent || flightAt === null) return;
      flightCompleteSent = true;
      window.parent?.postMessage({ type: "geo-video-player", event: "tour-flight-complete", regionId: region.id, childId: range.childId ?? null }, "*");
    };
    currentTime = start;
    updateScene(currentTime);
    const startedAt = performance.now();
    const tick = (now) => {
      currentTime = Math.min(end, start + (now - startedAt) / 1000);
      updateScene(currentTime);
      if (flightAt !== null && currentTime + 0.001 >= flightAt) notifyFlightComplete();
      if (currentTime < end) previewAnimationFrame = requestAnimationFrame(tick);
      else {
        notifyFlightComplete();
        previewAnimationFrame = null;
        window.parent?.postMessage({ type: "geo-video-player", event: "scene-range-complete", regionId: region.id, sceneId: range.sceneId ?? null }, "*");
      }
    };
    previewAnimationFrame = requestAnimationFrame(tick);
    return true;
  }

  /** Stop whatever preview playback is running, leaving the frame where it is. */
  function stopTimelinePlayback() {
    cancelPreviewAnimation();
    return true;
  }

  async function dispose() {
    cancelPreviewAnimation();
    if (viewer && !viewer.isDestroyed()) viewer.destroy();
    viewer = null;
    annotationLayer = null;
    annotationWindows = [];
    initialized = false;
  }

  window.addEventListener("error", (event) => errors.push(String(event.error?.message || event.message)));
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason?.message || event.reason)));
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.type !== "geo-video-studio") return;
    let sender;
    try { sender = new URL(event.origin); } catch { return; }
    if (!["127.0.0.1", "localhost"].includes(sender.hostname)) return;
    if (event.data.action === "prepare-tour") configureStudioTour(event.data.preview || {});
    if (event.data.action === "play-opening") playOpeningPreview(event.data.opening || {});
    // The editor drives the labels from the SELECTED scene's toggle, not from the
    // film clock: its preview parks on a single establishing frame that usually
    // sits outside every scene window. See `previewAnnotationWindows()`.
    if (event.data.action === "set-annotations") applyAnnotationWindows(event.data.annotationWindows);
    if (event.data.action === "show-tour-frame") void showStudioTourFrame(event.data.preview || {});
    if (event.data.action === "play-tour-segment") playStudioTourSegment(event.data.preview || {});
    // Continuous playback of any scene's slice — the editor's ▶ uses this for
    // scenes that have no tour flight (overview, 结尾补充).
    if (event.data.action === "play-scene-range") playTimelineRange(event.data.range || {});
    if (event.data.action === "stop-scene-playback") stopTimelinePlayback();
    if (event.data.action === "update-tour-labels") applyTourStopLabelNames(event.data.labels || []);
    if (event.data.action === "play-tour-outro") playStudioTourOutro(event.data.preview || {});
  });

  window.geoVideo = { initialize, loadRegion, seek, playOpeningPreview, prepareStudioTour: configureStudioTour, showStudioTourFrame, playStudioTourSegment, playStudioTourOutro, playTimelineRange, stopTimelinePlayback, setAnnotationWindows: applyAnnotationWindows, renderFrame: async (time) => { await seek(time); return getFrameStatus(); }, getFrameStatus, getDiagnostics, dispose };

  const autoRegion = query.get("region");
  if (autoRegion) loadRegion(autoRegion).catch((error) => {
    const message = String(error?.message || error);
    if (!errors.includes(message)) errors.push(message);
    statusEl.textContent = JSON.stringify(getFrameStatus(), null, 2);
    if (runtimeErrorEl) {
      runtimeErrorEl.textContent = `影像源加载失败：${message}`;
      runtimeErrorEl.hidden = false;
    }
  });
})();
