// Geometry/frustum fit ported verbatim from the Cesium reference runtime.
// No Cesium or browser dependency: both render paths use the same projection model.
const CAMERA_PITCH = -64;

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

export { portraitOverviewFrustumTangents, portraitOverviewScreenFractions, portraitOverviewRange, portraitOverviewExtent, portraitOverviewProjectedBox, portraitOverviewTarget, applyPortraitZoomToLayer };
