# Cesium camera rules

- Drive every camera value from composition time; never use realtime duration, randomness, or frame-history accumulation.
- Define explicit longitude, latitude, height/range, heading, pitch, roll, phase timing, and easing.
- Keep labels and region geometry in frame for every requested aspect ratio. Recalculate portrait and square framing; do not crop a landscape capture.
- Avoid terrain intersections, globe-edge wedges, extreme pitch, rapid rotation, and motion during dense subtitles.
- Prefer a low-oblique pitch around `-62°` to `-66°` for administrative explainers.

## World-to-region opening descent

- When the opening-descent contract is enabled, frame 0 is the deterministic high-altitude globe state over the region center, not the parent overview. The cover always precedes it in the composition; the descent itself is one continuous camera flight inside the map capture.
- Define the start explicitly: height at least `800,000 m` (the premium default is about `2,200,000 m`), pitch between `-90°` and `-30°`, heading `0`, and longitude/latitude exactly on the region overview center. Start pitch should place any globe limb at the upper composition edge so limb dithering never affects the main frame.
- Interpolate height and pitch deterministically with a quintic profile that decelerates on arrival (the runtime applies `smootherStep` with a gentle sub-linear height exponent). Longitude and latitude stay fixed on the region center; never drift, rotate, or swing the target during the descent.
- Run the descent for 6–16 seconds (the premium default is 10 seconds) and land exactly on the parent overview camera: same longitude, latitude, height/range, heading, pitch, and roll as the following parent-reveal hold.
- Add one Cesium cloud deck (built-in `CloudCollection`) across the descent corridor. Clouds fade in gently from the high-altitude view, reach peak alpha near the deck altitude, and clear completely before the overview hold. The camera passes through the deck exactly once; there is no cloud residue below the deck and none in any later frame.
- The parent boundary reveal, child fade-in, labels, tour flights, and return all start from the descent end. The runtime treats all of those times as relative to the descent end (`presentationTime = max(0, videoTime - openingSeconds)`); narration, captions, and subtitles get the identical offset in the composition.
- Never cut, fade, restart, or crossfade the camera at the end of the descent; the same capture continues into the fixed parent overview, so the boundary pen-draw begins with zero camera velocity.
- For a re-render that changes the opening, recapture the whole map video in one run. Do not splice a separately warmed opening segment onto a previously captured video: tile LOD selection depends on cache history, and a join between two runs can pop the imagery sharpness even when the camera state is identical.

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
