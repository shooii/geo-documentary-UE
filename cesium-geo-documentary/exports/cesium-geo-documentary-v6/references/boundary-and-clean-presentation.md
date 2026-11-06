# Boundary and clean presentation

## Persistent administrative context

For a parent-topic series, load the parent boundary and complete immediate-child boundary dataset once per video.

- Begin with child boundaries hidden. Draw the parent outer boundary once over roughly 1.5–2.5 seconds using a deterministic cumulative-distance trim, short leading highlight, or equivalent refined GIS reveal. Settle the completed parent outline into a stable line.
- After the parent outline is fully legible, fade the complete child-boundary set in together over roughly 0.8–1.4 seconds. A subtle geographic-order stagger is allowed only when it reads as one group and does not resemble flashing.
- Use a stable, non-glowing, non-pulsing settled style. Parent outlines should remain visually stronger than child boundaries during the introduction.
- Render boundary polylines slightly above the ellipsoid or terrain to avoid depth flicker and z-fighting.
- Start the series from a parent-area overview that contains all siblings. Start each later child segment from the preceding child's exact final camera and highlight state, then fly directly to the new child.
- Give compact contiguous urban districts a clean contextual endpoint camera that still moves visibly away from the preceding region.
- Keep the base sibling boundaries identical and constant. During each opening flight, fade the preceding selected-boundary overlay and translucent fill out while fading the new selection in. Keep the new selection unchanged after arrival. Recommended fill opacity is `0.10–0.18` so satellite texture remains visible.
- Do not use repeated trace animations, glow materials, blinking outlines, alternating fills, or transition masks that resemble boundary flashing.
- For MultiPolygon parents, reveal principal outer rings concurrently with duration normalized by ring length. Do not delay islands until after narration has moved on.

For a multi-child master, place a 35–60 second parent-topic introduction before all child videos. Cover the parent area's location, geographic hierarchy, physical framework, population, economy or livelihoods, history, culture, and the editorial route through its children.

Use this default scene order for a 45–60 second child-region video:

1. `0–8s`: inherit the preceding region camera and highlight, then make one long eased Cesium flight to the selected region while the highlight handoff occurs.
2. `8–50s`: hold one fixed low-oblique selected-region camera while the narration covers population, economy, history, culture, and contemporary development.
3. At the segment boundary, keep the selected camera and highlight fully unchanged; the following child segment begins from that same state.

## Clean-broadcast mode

When the user requests no visible source or AI wording:

- Remove editorial source cards, source-note scenes, AI badges, reconstruction labels, and generation-failure messages from the visible composition.
- Remove the lower-left chapter title and upper-right fact card by default. Keep the satellite map, boundaries, selected-region label, exact top title `地理图说·{topicName}`, cue-synchronized features and photos, and single-line subtitles.
- Keep legally required imagery/provider copyright attribution through the native map credit surface. If the native captured credit is sufficient, do not add a duplicate custom credit line in the composition.
- Do not use generated imagery without disclosure. Disable it and use the Cesium map, verified feature layers, or verified real photographs.
- Keep citations, boundary disclaimers, asset licenses, and factual classifications in external JSON/Markdown build reports.

## Precise real-photo evidence

For concrete history and culture narration, search for a precise real local photograph from an official institution, museum/archive, Wikimedia Commons, or another source with explicit reusable licensing. Treat this as planned visual evidence rather than a decorative fallback.

1. Verify that the photograph depicts the correct region and subject.
2. Prefer the original-resolution file; reject thumbnails, watermarked images, unclear locality, and unattributed reposts.
3. Record title, creator, source URL, license, access date, region, subject, and crop in `assets/source/photo-manifest.json`.
4. Store attribution outside the visible frame in clean-broadcast mode, subject to the license's attribution requirements.
5. If licensing is unclear, do not download or use the image; keep the map-led scene.

Internet image search is discovery only. It is not permission to reuse an arbitrary result.
