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
- Use quintic smoother-step progress for the geodesic and one continuous sinusoidal height arc. Do not use a flat cruise plateau followed by a late dive.
- For compact township/village tours, add only about 500–2800 metres of apex offset and adapt duration to ground distance within 3.2–5.4 seconds.
- Interpolate heading by the shortest angular path. Keep pitch changes restrained and documented.
- Fade the preceding highlight and context labels during movement; bring the selected outline, fill, and label to their final stable state on arrival.
- Reserve about 0.9 seconds for the final settle/locked hold when narration timing permits.

## Arrival lock

- After arrival, hold longitude, latitude, range, heading, pitch, and roll completely fixed through the region narration.
- Do not orbit, pan, rotate, zoom, or drift during a child's narration hold.
- Keep the arrival camera and selected overlay unchanged until the next child flight begins. After every toured child is complete, allow exactly one editorial closing return to the parent overview.
- When licensed imagery shows unresolved rectangular seams, prewarm denser geodesic samples, widen the endpoint, or slow the flight. Do not substitute a hard cut, endpoint crossfade, blur, or lower-resolution basemap.
- Use camera motion only for editorially necessary arrival, departure, or parent-to-child transitions.
- Ensure the same timestamp returns the same camera state.

## Closing parent return

- Start only after the final child hold and narration are complete.
- Fly from the exact final child camera to the exact opening parent overview with the same ellipsoid-geodesic and quintic motion contract, normally in 3.8–5.0 seconds.
- Fade the selected fill, outline, and current label during the return while keeping the complete context-boundary set stable.
- Lock the parent camera exactly on arrival and hold it through the closing narration. Do not cut, reset, or begin the closing line before the return state is visually established.

Recommended actions: `showParentOverview`, `revealParentBoundary`, `fadeInChildBoundaries`, `inheritPreviousRegion`, `flyToRegion`, `crossFadeRegionHighlights`, `revealNamedFeature`, and `holdRegionCamera`.
