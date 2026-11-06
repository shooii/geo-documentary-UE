# Boundary and clean presentation

## Grounded administrative boundary contract

Administrative boundaries must be visually and geometrically attached to the map surface.

- Create longitude/latitude positions without altitude arguments.
- Set boundary polylines to `clampToGround: true`.
- Use terrain-classified or ground-clamped polygon fills and never set polygon `height`, `extrudedHeight`, or per-position altitude.
- Never use an altitude offset as a z-fighting workaround. Resolve separation with a grounded two-pass line: dark underlay first, semantic main line second, using adjacent `zIndex` values.
- Parent: 7 px underlay + 3.5 px warm-gold main line.
- Direct child/context: 4 px underlay + 2 px cool-neutral main line.
- Selected: 8 px underlay + 4 px warm-gold main line.
- Supplemental management unit: 1.5 px dim main line, low priority, normally unlabeled.
- Clamp label anchors to the ground. Do not place labels or permanent marker points hundreds of metres above the region.

Use a stable, non-glowing, non-pulsing settled style. Do not use extrusion, repeated trace animations, glow materials, blinking outlines, alternating fills, or transition masks that resemble boundary flashing. Recommended selected-fill opacity is `0.10–0.18`, preserving satellite texture.

## Parent-first hierarchy reveal

For a parent-topic series, load the parent boundary and complete immediate-child boundary dataset once per video.

1. Start from a fully settled parent overview with child boundaries hidden.
2. Keep the camera completely fixed while revealing the parent outline once over about 2.2 seconds.
3. After the parent is legible, fade the complete child set in together over about 1.1 seconds.
4. Keep the parent, sibling boundaries, and camera stable after the reveal.
5. For MultiPolygon parents, reveal principal outer rings concurrently with duration normalized by ring length.

For a multi-child master, place a parent-topic introduction before all child videos. Cover the parent location, hierarchy, physical framework, people, economy or livelihoods, history, culture, and the editorial route through its children.

## Direct child transitions

- Start each later child segment from the preceding child's exact final camera and highlight state.
- Travel along a WGS84 ellipsoid geodesic using deterministic lift → cruise → settle phases.
- Adapt flight duration to ground distance, normally within 2.2–4.5 seconds for compact township/village tours.
- Fade context labels during movement; stabilize the selected label after arrival.
- Keep the new selection unchanged after the 0.65-second settle. Do not orbit, pan, or zoom during the narration hold.

## Clean-broadcast mode

When the user requests no visible source or AI wording:

- Remove editorial source cards, source-note scenes, AI badges, reconstruction labels, and generation-failure messages from the visible composition.
- Remove the lower-left chapter title and upper-right fact card by default. Keep the satellite map, grounded boundaries, selected-region label, exact top title `地理图说·{topicName}`, cue-synchronized features and photos, and single-line subtitles.
- Keep legally required imagery/provider copyright attribution through the native map credit surface. Do not add a duplicate custom line when native attribution is sufficient.
- Do not use generated imagery without disclosure. Use the Cesium map, verified feature layers, or verified real photographs.
- Keep citations, boundary disclaimers, licenses, and factual classifications in external build reports.

## Precise real-photo evidence

For concrete history and culture narration, use a precise real local photograph from an official institution, museum/archive, Wikimedia Commons, or another source with explicit reusable licensing.

1. Verify the correct region and subject.
2. Prefer original resolution; reject thumbnails, watermarks, unclear locality, and unattributed reposts.
3. Record title, creator, source URL, license, access date, region, subject, and crop in `assets/source/photo-manifest.json`.
4. Store attribution outside the visible frame in clean-broadcast mode when the license permits.
5. If licensing is unclear, keep the map-led scene.

Internet image search is discovery only; it is not permission to reuse an arbitrary result.
