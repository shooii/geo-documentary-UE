# Boundary and clean presentation

## Grounded administrative boundary contract

Administrative boundaries must be visually and geometrically attached to the map surface.

- Create longitude/latitude positions without altitude arguments.
- Set boundary polylines to `clampToGround: true`.
- Use terrain-classified or ground-clamped polygon fills and never set polygon `height`, `extrudedHeight`, or per-position altitude.
- Never use an altitude offset as a z-fighting workaround. Resolve separation with a grounded two-pass line: dark underlay first, semantic main line second, using adjacent `zIndex` values.
- Parent: 7 px underlay + 3.5 px clear lake-blue `#2D9CDB` main line. Keep the overview fill transparent when a changing terrain-classified fill causes ground-batch rebuilds or line loss; the outline alone is the preferred stable hierarchy signal. The token remains configurable, but lake blue is the premium default and must stay distinct from selected gold.
- Direct child/context: 4 px underlay + 2 px cool-white `#E8F0F5` main line.
- Selected: 4 px gold `#FFD166` main line with fill near 0.15–0.18. If a separate selected dark underlay renders above or obscures the gold ground line on a target GPU, hide that selected underlay and preserve the gold main line; context and parent boundaries may retain their stable two-pass treatment.
- Give the selected-child grounded line pair a higher `zIndex` than both the parent and context-child pairs. This preserves gold selection on edges shared with the parent perimeter without using altitude or extrusion.
- Supplemental management unit: 1.5 px dim main line, low priority, normally unlabeled.
- Clamp label anchors to the ground. Do not place labels or permanent marker points hundreds of metres above the region.

Use a stable, non-glowing, non-pulsing settled style. Do not use extrusion, repeated trace animations, glow materials, blinking outlines, alternating fills, or transition masks that resemble boundary flashing. Recommended selected-fill opacity is `0.10–0.18`, preserving satellite texture.

Prevent black, blank, or white transition flashes by keeping the context main line continuously visible after its reveal. Hide the selected overlay whenever its alpha is zero, keep its dark underlay disabled when it can obscure shared edges, and update only the current and outgoing selection properties. Suppress redundant color writes that can rebuild ground primitives. Never fade a black underlay before its colored main line.

For the parent-introduction sequence, also keep the parent and child underlay entities hidden during the pen draw and child-boundary fade. Enable only stable underlays after the complete child main-line group has settled. This explicit visibility gate avoids one-frame WebGL ordering differences between the two grounded passes.

Keep child main-line entities hidden and their material alpha at zero while their computed fade strength is still near transparent; a useful gate is roughly `0.30` normalized strength. Updating an almost transparent grounded child material can depth-mask the already drawn parent outline even when the entity is hidden or its color is visually absent. Start both visibility and nonzero semantic color from the first perceptible state instead.

## Multipart fill integrity

Cesium `GeoJsonDataSource` creates one polygon entity for each polygon inside a GeoJSON `MultiPolygon`. Multiple entities can therefore share the same administrative feature ID.

- Store selected-fill properties as `Map<featureId, ColorProperty[]>`, not `Map<featureId, ColorProperty>`.
- Append every polygon entity's color property to the feature array. Never overwrite an earlier property when another entity has the same stable ID.
- During fly-in, hold, and previous-to-current crossfade, apply the same selection strength to every property in both the current and previous feature arrays.
- Compare the source `Polygon`/`MultiPolygon` part count with the number of retained Cesium fill properties. A correct outline or label does not prove that every polygon part is filled.
- Include a real multipart administrative feature in regression tests. Inspect the principal polygon and detached islands, enclaves, tidal parcels, or other secondary parts separately.

## Parent-first hierarchy reveal

For a parent-topic series, load the parent boundary and complete immediate-child boundary dataset once per video.

1. Start from a fully settled parent overview with child boundaries and all child labels hidden.
2. Keep the camera completely fixed while revealing the parent outline once over about 3.0–3.4 seconds. Partition the grounded outer rings into roughly 56 length-weighted segments and reveal them sequentially with a small moving pen-nib marker.
3. After the parent is legible, fade the complete reliable boundary-unit set in together over about 1.1–1.35 seconds.
4. Keep the parent, sibling boundaries, and camera stable after the reveal.
5. For MultiPolygon parents, reveal principal outer rings concurrently with duration normalized by ring length.
6. Remove the pen marker immediately after the reveal and keep the settled parent line continuously visible.

For a multi-child master, place a parent-topic introduction before all child videos. Cover the parent location, hierarchy, physical framework, people, economy or livelihoods, history, culture, and the editorial route through its children.

## Direct child transitions

- Start each later child segment from the preceding child's exact final camera and highlight state.
- Travel along a WGS84 ellipsoid geodesic using quintic smoother-step position progress and one continuous low-amplitude height arc.
- Adapt flight duration to ground distance, normally within 3.2–5.4 seconds for compact township/village tours.
- Before the first child flight, keep every child and supplemental-unit label hidden. Reveal a child label only on its first visit.
- Keep all visited child labels visible thereafter. The current child uses full emphasis; previously visited children use a quieter but readable style; only unvisited and untoured supplemental-unit labels remain hidden.
- Update one persistent label collection in place. Never remove and recreate all labels at a handoff, because collection churn can cause one-frame disappearance or flashing.
- Keep the new selection unchanged after the roughly 0.9-second settle/hold. Do not orbit, pan, or zoom during the narration hold.
- After the last toured child, use one continuous 3.8–5.0 second return to the exact parent overview while retaining all visited labels. Keep this return silent by default; if a closing locality sentence is needed, begin it only after the camera locks.

## Complete boundary set versus tour set

- Store every reliable polygon unit in `boundaryUnitIds`, including statutory children, verified forest farms, enclaves, islands, and multipart management areas.
- Store narrated destinations separately in `tourChildIds`. A supplemental management unit may remain visible without receiving a flight or label.
- Preserve every multipart polygon and interior ring. Never reduce a feature to its largest polygon.
- Simplify a valid shared-edge coverage in one operation with coverage-preserving simplification. If coverage validation fails, keep the unsimplified geometry; never simplify each administrative polygon independently.

## Clean-broadcast mode

When the user requests no visible source or AI wording:

- Remove editorial source cards, source-note scenes, AI badges, reconstruction labels, and generation-failure messages from the visible composition.
- Remove the lower-left chapter title and upper-right fact card by default. Keep the satellite map, grounded boundaries, selected-region label, exact top title `地理图说·{hierarchicalTopicName}`, cue-synchronized features and photos, and single-line subtitles.
- Keep legally required imagery/provider copyright attribution through the native map credit surface. Do not add a duplicate custom line when native attribution is sufficient.
- Do not use generated imagery without disclosure. Use the Cesium map, verified feature layers, or verified real photographs.
- Keep citations, boundary disclaimers, licenses, and factual classifications in external build reports.
- Keep implementation limits and missing-data discussion out of narration and visible editorial cards. Report them externally instead.

## Precise real-photo evidence

For concrete history and culture narration, use a precise real local photograph from an official institution, museum/archive, Wikimedia Commons, or another source with explicit reusable licensing.

1. Verify the correct region and subject.
2. Prefer original resolution; reject thumbnails, watermarks, unclear locality, and unattributed reposts.
3. Record title, creator, source URL, license, access date, region, subject, and crop in `assets/source/photo-manifest.json`.
4. Store attribution outside the visible frame in clean-broadcast mode when the license permits.
5. If licensing is unclear, keep the map-led scene.

Internet image search is discovery only; it is not permission to reuse an arbitrary result.
