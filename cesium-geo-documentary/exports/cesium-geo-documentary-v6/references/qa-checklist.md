# QA checklist

## Data and facts

- Geometry valid, EPSG:4326, stable IDs, cited source.
- Changeable facts include year; uncertain claims use qualified language.
- AI images are labelled and recorded in the manifest.
- Every region includes population, economy, history, and culture. Population states year and population type; economy states year and a verified figure or industry structure.
- The coverage manifest contains every required immediate child exactly once, or records an explicit sourced exclusion policy.
- Every named river, mountain, lake, bay, island, road, port, settlement, historical site, performance, custom, or craft has a matching evidence ID when visual evidence is required.
- Every history/culture photo is verified for exact locality, exact subject, reusable license, and sufficient original resolution.

## Visual

- No blank tile, black block, unresolved rectangular LOD tile, dark tile seam, boundary loss, clipping, overflow, or missing font. Inspect frame 0 and representative fly-in frames, not only the final held camera.
- Formal satellite samples resolve roads, shorelines, urban blocks, and ground texture at representative zooms; no demo or non-satellite fallback is present.
- Imagery attribution matches the provider used in the captured frames.
- The parent boundary is the first administrative geometry revealed. Child boundaries remain hidden until the parent outline is legible, then fade in once as a restrained group.
- After the introduction reveal, all sibling boundaries remain stable; line opacity/width/visibility do not flash or repeatedly animate.
- The selected region receives one translucent fill fade and remains highlighted while the camera flies to it.
- A multi-child master begins with a parent-topic introduction before any immediate-child segment.
- Each child segment begins from the preceding child's exact final camera and highlight, then completes one continuous eased Cesium flight without a hard cut or endpoint crossfade.
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
- Concatenated subtitle text equals the source narration cue text.
- Master duration matches the sum of ordered segments, stream-copy mode is recorded, and every join is checked for decode, black-frame, and silence anomalies.

## Engineering

- Typecheck and tests pass.
- HyperFrames lint/runtime/layout/contrast have zero errors.
- Capture reports show all expected frames, readiness, and zero console errors.
- Draft and final delivery validators pass the complete matrix.
- Build report and `.build-state` files reflect real results and limitations.
