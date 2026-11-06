# QA checklist

## Data and facts

- Geometry valid, EPSG:4326, stable IDs, cited source.
- SHP input includes `.shp`, `.shx`, `.dbf`, and `.prj`; `.cpg` is recorded when present. Source CRS, DBF encoding, source files, field mapping, and name corrections appear in the import report.
- No feature name contains replacement glyphs, mojibake, or Unicode private-use characters.
- Parent geometry is identified as independently sourced or derived from a child-feature dissolve.
- Changeable facts include year; uncertain claims use qualified language.
- AI images are labelled and recorded in the manifest.
- Every region includes population, economy, history, and culture. Population states year and population type; economy states year and a verified figure or industry structure.
- The coverage manifest contains every required immediate child exactly once, or records an explicit sourced exclusion policy.
- Every included direct child has a narration cue, selected fill/highlight interval, Cesium camera arrival, and fixed-camera hold. Overview labels alone do not pass narration coverage.
- Every named river, mountain, lake, bay, island, road, port, settlement, historical site, performance, custom, or craft has a matching evidence ID when visual evidence is required.
- Every history/culture photo is verified for exact locality, exact subject, reusable license, and sufficient original resolution.
- Registered or digitized planning-map boundaries pass coverage, control-point residual, topology, and visual overlay QA. Numeric coverage alone never passes the gate.
- No Voronoi, centroid partition, hand-drawn, or visually guessed administrative boundary is present.
- Statutory immediate children are not mixed with functional new areas, development zones, cooperation zones, or enclaves.

## Visual

- No blank tile, black block, unresolved rectangular LOD tile, dark tile seam, boundary loss, clipping, overflow, or missing font. Inspect frame 0 and representative fly-in frames, not only the final held camera.
- Formal satellite samples resolve roads, shorelines, urban blocks, and ground texture at representative zooms; no demo or non-satellite fallback is present.
- Imagery attribution matches the provider used in the captured frames.
- The parent boundary is the first administrative geometry revealed. Child boundaries remain hidden until the parent outline is legible, then fade in once as a restrained group.
- Every administrative polyline uses ground positions, `clampToGround: true`, a dark grounded underlay, and a semantic main line. No boundary position contains an altitude offset.
- Administrative polygon fills have no `height` or `extrudedHeight` and are ground-clamped or terrain-classified.
- Boundary labels are ground-clamped; no permanent floating point marker is used as the selected-region anchor.
- After the introduction reveal, all sibling boundaries remain stable; line opacity/width/visibility do not flash or repeatedly animate.
- The parent overview camera is byte-for-byte stable throughout parent-boundary and child-boundary reveal timestamps.
- The selected region receives one translucent fill fade and remains highlighted while the camera flies to it.
- A multi-child master begins with a parent-topic introduction before any immediate-child segment.
- The child-tour order matches the coverage manifest exactly: no missing child, duplicate child, or unannounced child.
- Each child segment begins from the preceding child's exact final camera and highlight, then completes one continuous eased Cesium flight without a hard cut or endpoint crossfade.
- Formal region flights use ellipsoid-geodesic position interpolation and deterministic lift → cruise → settle height phases. Flight duration responds to ground distance.
- Context labels fade during flight and the selected label remains stable after arrival.
- After each child fly-in completes, the camera remains fixed and low-oblique through the final frame; no chapter-level orbit, rotation, pan, zoom drift, or closing return is present.
- Every join uses the same preceding selected-region camera, highlight, label, boundary style, and top bar on both sides.
- Single-line mode has exactly one line per subtitle cue, no `<br>`, no leading punctuation, and no overflow.
- Clean-broadcast output contains no editorial `来源`, `AI`, reconstruction, or generation-failure wording. Generated imagery is absent in this mode.
- No duplicate custom imagery-provider credit strip is present when the captured native map attribution already satisfies the provider requirement.
- Minimal clean-broadcast mode contains no lower-left chapter title and no upper-right fact card. The top bar and single-line subtitles stay in safe areas.
- The top title is exactly `地理图说·{topicName}` and contains no stale place name or hierarchy suffix.
- Narrated rivers and mountains follow verified geometry, use correct labels, and remain readable without covering boundaries or subtitles.
- History/culture photos match the narrated locality and subject. Photo placement does not cover selected geography, feature labels, title, or subtitles.
- Portrait and square are independently framed and laid out.

## Media

- Correct duration, resolution, 30fps, H.264 video, AAC audio.
- No black-frame or silence events above configured thresholds.
- Narration remains intelligible over the music bed.
- Formal narration uses the approved premium voice, natural paragraph pauses, about `-16 LUFS` integrated loudness, and a safe true peak. Music volume stays near `0.18–0.22`.
- Formal-release metadata records `formalReleaseReady: true`; Windows SAPI output never passes final QA.
- Concatenated subtitle text equals the source narration cue text.
- Master duration matches the sum of ordered segments, stream-copy mode is recorded, and every join is checked for decode, black-frame, and silence anomalies.

## Engineering

- Typecheck and tests pass.
- Static runtime tests reject boundary altitude offsets, `clampToGround: false`, polygon height/extrusion, linear longitude/latitude flight interpolation, and parent-reveal camera zoom.
- HyperFrames lint/runtime/layout/contrast have zero errors.
- Capture reports show all expected frames, readiness, and zero console errors.
- Draft and final delivery validators pass the complete matrix.
- Build report and `.build-state` files reflect real results and limitations.
- A topic switch stops old-topic research/rendering, uses a new output namespace, and does not overwrite earlier final videos.
