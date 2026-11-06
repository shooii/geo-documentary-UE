# Cesium camera rules

- Drive every camera value from composition time; never use realtime duration, randomness, or frame-history accumulation.
- Define explicit longitude, latitude, height/range, heading, pitch, roll, phase timing, and easing.
- Keep labels and region geometry in frame for every requested aspect ratio. Recalculate portrait and square framing; do not crop a landscape capture.
- Avoid terrain intersections, globe-edge wedges, extreme pitch, rapid rotation, and motion during dense subtitles.
- Prefer a low-oblique pitch around `-62°` to `-66°` for administrative explainers.

## Parent overview

- Create a parent-topic introduction before the first immediate-child segment.
- The parent overview must be fully settled before frame 0.
- Hold longitude, latitude, range, heading, pitch, and roll completely fixed while the parent outline reveals and the child set fades in.
- Do not implement a hidden zoom, dolly, pitch change, or settling drift during the hierarchy reveal.
- End the parent introduction on the identical stable overview state.

## Natural region flight

- Start from the exact preceding final camera and highlight state.
- Interpolate geographic position with `Cesium.EllipsoidGeodesic`; never linearly interpolate longitude and latitude for formal region transitions.
- Use deterministic height phases:
  - lift: progress `0–0.18`, ease from departure height to the apex;
  - cruise: progress `0.18–0.78`, follow the geodesic at the apex;
  - settle: progress `0.78–1`, ease down to the destination height.
- For compact township/village tours, add an apex offset of about 900–5200 metres and adapt duration to ground distance within 2.2–4.5 seconds.
- Interpolate heading by the shortest angular path. Keep pitch changes restrained and documented.
- Fade the preceding highlight and context labels during movement; bring the selected outline, fill, and label to their final stable state on arrival.
- Reserve about 0.65 seconds for the final settle when narration timing permits.

## Arrival lock

- After arrival, hold longitude, latitude, range, heading, pitch, and roll completely fixed through the region narration.
- Do not orbit, pan, rotate, zoom, drift, or return to the parent overview.
- Keep the arrival camera and selected overlay unchanged through the final frame; the next segment must reproduce that frame before moving.
- When licensed imagery shows unresolved rectangular seams, prewarm denser geodesic samples, widen the endpoint, or slow the flight. Do not substitute a hard cut, endpoint crossfade, blur, or lower-resolution basemap.
- Use camera motion only for editorially necessary arrival, departure, or parent-to-child transitions.
- Ensure the same timestamp returns the same camera state.

Recommended actions: `showParentOverview`, `revealParentBoundary`, `fadeInChildBoundaries`, `inheritPreviousRegion`, `flyToRegion`, `crossFadeRegionHighlights`, `revealNamedFeature`, and `holdRegionCamera`.
