# Cesium camera rules

- Drive every camera value from composition time; never use realtime duration.
- Define explicit start/end longitude, latitude, height, heading, pitch, roll, and easing.
- Keep labels and region geometry in frame for every requested aspect ratio.
- Recalculate framing for portrait and square; do not crop a landscape capture.
- Avoid terrain intersections, extreme pitch, rapid rotation, and motion during dense subtitles.
- For a series at any supported geographic level, create a parent-topic introduction before the first immediate-child segment.
- During the parent introduction, hold the parent overview while the parent outline draws once and the full child set fades in afterward. Do not move the camera during the boundary hierarchy reveal.
- End the parent introduction on its stable overview. End every child segment on that child's fixed selected-region camera and full highlight.
- Start the next segment on the exact preceding camera and highlight state, then fly directly to the next child region during the opening 8 seconds. Fade the preceding highlight out while the new translucent fill, outline, and label fade in.
- After arrival, hold longitude, latitude, range, heading, pitch, and roll completely fixed through the population, economy, history, culture, and closing sections. Do not orbit, pan, rotate, zoom, drift, or return to the parent overview.
- Prefer a low oblique pitch around `-62°` to `-66°` for administrative explainers; keep heading fixed unless a geographic obstruction requires a documented exception. Reject a lower pitch when flight frames expose dark globe-edge wedges, clip the selected boundary, or make the viewer feel tilted.
- Use a wider fixed range for small urban districts and peninsula-tip counties when the closest imagery level exposes clouds or acquisition mosaics. Keep the whole selected boundary and enough parent context in frame rather than maximizing zoom.
- Give compact contiguous urban districts their own clean, context-preserving endpoint camera; do not keep them on the prefecture overview merely to avoid implementing a flight.
- Keep the arrival camera and selected overlay unchanged through the final frame. The following segment must reproduce that frame before beginning its flight.
- When the licensed imagery provider shows unresolved rectangular seams during motion, prewarm denser flight samples, widen the affected endpoint, or slow the flight. Do not substitute an endpoint crossfade, hard cut, blur, or lower-resolution basemap when the requested treatment is a continuous Cesium flight.
- After the one-time parent-first introduction reveal, keep all sibling boundaries visible and stable through the remaining timeline. Avoid repeated boundary trace, glow, pulse, blink, or repeated reveal animation.
- Allow cue-synchronized river, mountain, lake, bay, island, ridge, route, and settlement overlays while the main camera is fixed. These overlays must not trigger camera drift or obscure the selected boundary.
- Use camera motion only for editorially necessary arrival, departure, or parent-to-child transitions. Avoid continuous movement that can cause dizziness.
- Ensure the same timestamp returns the same camera state.

Recommended series actions: `showParentOverview`, `revealParentBoundary`, `fadeInChildBoundaries`, `inheritPreviousRegion`, `flyToRegion`, `crossFadeRegionHighlights`, `revealNamedFeature`, and `holdRegionCamera`.
