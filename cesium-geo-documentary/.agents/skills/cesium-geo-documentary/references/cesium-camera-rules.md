# Cesium camera rules

- Drive every camera value from composition time; never use realtime duration, randomness, or frame-history accumulation.
- Define explicit longitude, latitude, height/range, heading, pitch, roll, phase timing, and easing.
- Keep labels and region geometry in frame for every requested aspect ratio. Recalculate portrait and square framing; do not crop a landscape capture.
- Avoid terrain intersections, globe-edge wedges, extreme pitch, rapid rotation, and motion during dense subtitles.
- Prefer a low-oblique pitch around `-62°` to `-66°` for administrative explainers.

## World-to-region opening descent

- When the opening-descent contract is enabled, frame 0 is the deterministic high-altitude globe state over the region center, not the parent overview. The cover always precedes it in the composition; the descent itself is one continuous camera flight inside the map capture.
- Define the start explicitly: height between `800,000 m` and about `1,200,000 m` (the fast-opening default is about `900,000 m`), pitch between `-90°` and `-30°`, heading `0`, and longitude/latitude exactly on the region overview center. Start pitch should place any globe limb at the upper composition edge so limb dithering never affects the main frame.
- Interpolate height and pitch deterministically with a quintic profile that decelerates on arrival (the runtime applies `smootherStep` with a gentle sub-linear height exponent). Longitude and latitude stay fixed on the region center; never drift, rotate, or swing the target during the descent.
- Run the descent for 2–5 seconds (the fast-opening default is about 2.5–3.5 seconds) and land exactly on the parent overview camera: same longitude, latitude, height/range, heading, pitch, and roll as the following parent-reveal hold. The production cover (about 1.4–1.8 seconds) plus the descent must finish within five seconds total.
- Add one dense Cesium cloud deck (built-in `CloudCollection`) across the descent corridor. Spread at least two dozen overlapping clouds across a multi-degree field and vary size, aspect ratio, altitude, brightness, and volumetric `slice` deterministically. Avoid a handful of oversized billboard clouds with `slice: -1`, because they read as fuzzy dots instead of a cloud bank. Build opacity from the high-altitude view, peak at the crossing, and use a short deterministic mist veil to sell the near-camera passage; fade both the volume clouds and veil to exactly zero before the overview hold. The camera passes through the deck exactly once, with no residue in later frames.
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

- Start from the exact preceding final camera and highlight state. For the first leg of a child tour that camera is the settled parent overview **as rendered** — including the child-tour range scale (`PARENT_OVERVIEW_CAMERA_HEIGHT_SCALE`). Resolving the raw overview preset for that leg starts the tour on a range the viewer never saw and snaps the first frame outward. Measured on the shipped 乌石镇 portrait project: the settled overview sits at a 26 187 m range / 23 547 m camera altitude, and the raw preset resolution put the first tour frame at 29 097 m / 26 165 m. That is a 2 617 m altitude discontinuity — 11.1 % of the frame, 10.2 frames of the flight's own motion packed into a single frame (its largest legitimate step is ~255 m/frame), popping the visible ground width by ×1.111. Leaving from the on-screen overview instead makes the step 0.3 m.
- The editor must install the child-tour context *before* it previews anything (`prepare-tour`). An export materialises the region as `parent-child-tour`, which is what applies the overview scale; the editor's region stays `parent-topic` until a tour payload arrives, so without the early configuration the editor parks its opening frame on the raw preset range and the first village flight reads as the same jump.
- Interpolate geographic position with `Cesium.EllipsoidGeodesic`; never linearly interpolate longitude and latitude for formal region transitions.- Use quintic smoother-step progress for the geodesic and one continuous sinusoidal height arc. Do not use a flat cruise plateau followed by a late dive.
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

## Tour timestamps are presentation-relative

- The player owns the opening-descent offset. `showStudioTourFrame` seeks to `openingDescent.seconds + payload.time`, and the capture run seeks to the absolute `openingSeconds + stop.start` — both mean the descent is counted once, by the player, and the caller supplies the post-opening time.
- Studio must therefore post a **bare** `start` / `end`. It used to add the render spec's `descentSeconds` on top, so the player received `descent + start` and then subtracted only the descent the loaded region actually carries. An export materialises the descent from `project.template.openingDescentSeconds` (`materializeProject`), but 乌石镇 and 西连镇 ship regions with no `openingDescent` block at all, so the editor landed 3 s into the first village flight while the export sat on its first frame. Measured against the shipped 乌石镇 portrait project with the real stops: the export frame and the old editor frame differ by the full 3 s of flight motion, while the bare `start` matches the export frame.
- Any code that turns a scene into a player time belongs on this contract. A caller that genuinely needs the absolute page clock must add the *region's* descent — never the render spec's, and never both.

## Closing parent return

- Start only after the final child hold and narration are complete.
- Fly from the exact final child camera to the exact opening parent overview with the same ellipsoid-geodesic and quintic motion contract, normally in 3.8–5.0 seconds.
- Fade the selected fill, outline, and current label during the return while keeping the complete context-boundary set stable.
- Lock the parent camera exactly on arrival and hold it through the closing narration. Do not cut, reset, or begin the closing line before the return state is visually established.

Recommended actions: `showParentOverview`, `revealParentBoundary`, `fadeInChildBoundaries`, `inheritPreviousRegion`, `flyToRegion`, `crossFadeRegionHighlights`, `revealNamedFeature`, and `holdRegionCamera`.
