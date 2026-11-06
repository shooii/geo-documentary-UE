# QA checklist

## Data and facts

- Geometry valid, EPSG:4326, stable IDs, cited source.
- SHP input includes `.shp`, `.shx`, `.dbf`, and `.prj`; `.cpg` is recorded when present. Source CRS, DBF encoding, source files, field mapping, and name corrections appear in the import report.
- No feature name contains replacement glyphs, mojibake, or Unicode private-use characters.
- Parent geometry is identified as independently sourced or derived from a child-feature dissolve.
- Changeable facts include year; uncertain claims use qualified language.
- AI images are labelled and recorded in the manifest.
- Every region includes population, economy, history, and culture. Population states year and population type; economy states year and a verified figure or industry structure.
- Applicable scripts also cover customs, language/dialect, characteristic food or produce, ecology, and contemporary development, while distinguishing target-local facts from county/region context. Township/subdistrict research checks notable local middle schools and omits them when identity, relevance, or imagery is unverified.
- The coverage manifest contains every required immediate child exactly once, or records an explicit sourced exclusion policy.
- `boundaryUnitIds` contains every reliable displayed unit, including verified forest farms, enclaves, islands, and multipart management areas; `tourChildIds` separately contains the narrated destinations. Supplemental units are not dropped merely because they are not toured.
- Shared-edge simplification is coverage-preserving. Raw/output coverage validity, point/part counts, overlap, union holes, and parent-outline difference are recorded; adjacent polygons are never simplified independently.
- Every included direct child has a narration cue, selected fill/highlight interval, Cesium camera arrival, and fixed-camera hold. Overview labels alone do not pass narration coverage.
- Every named river, mountain, lake, bay, island, road, port, settlement, historical site, performance, custom, or craft has a matching evidence ID when visual evidence is required.
- Every history/culture/school/food photo is verified for exact locality, exact subject, documented reuse status, and sufficient original resolution. A food photo matches the exact named dish/product; no similar substitute passes.
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
- Parent is deep wine red `#8B1E1E`, selected child is gold, and context children are cool white; parent and selected states are visibly distinct but coordinated.
- The parent pen marker and all boundary segments are grounded. The pen draws once, disappears after the reveal, and never leaves a floating residual marker.
- During the parent draw and child fade-in, near-transparent child main lines do not depth-mask the parent, and parent/child underlay entities remain hidden until the complete semantic main-line group is stable; inspect 0.0, 0.35, 1.0, 1.8, 2.6, 3.15, 3.55, 3.7, 4.2, 4.7, and 4.9 seconds for parent-line loss, black flashes, or a visible underlay pop.
- Inspect at least two frames immediately before and after every child handoff. Context boundaries remain present with no black, blank, or white flash; a zero-alpha selected overlay is hidden and no redundant material rebuild causes a one-frame loss.
- The parent overview camera is byte-for-byte stable throughout parent-boundary and child-boundary reveal timestamps.
- No parent overview terrain-classified fill transition hides or interrupts the parent or child line layers; prefer a transparent parent fill when Cesium ground-batch rebuilding is visible.
- The selected region receives one translucent fill fade and remains highlighted while the camera flies to it.
- The selected gold outline remains visible on every edge, including edges shared with the deep-wine `#8B1E1E` parent perimeter; its grounded `zIndex` is higher than the parent and context-child pairs.
- Every selected `MultiPolygon` region fills all component polygons with the same opacity and timing. Inspect the principal polygon and every detached part; a gold outline or label alone does not pass this check.
- A multi-child master begins with a parent-topic introduction before any immediate-child segment.
- The child-tour order matches the coverage manifest exactly: no missing child, duplicate child, or unannounced child.
- Each child segment begins from the preceding child's exact final camera and highlight, then completes one continuous eased Cesium flight without a hard cut or endpoint crossfade.
- Formal region flights use ellipsoid-geodesic position interpolation, quintic smoother-step velocity, and one continuous low-amplitude height arc. Flight duration responds to ground distance and remains within the configured 3.2–5.4 second compact-tour range.
- The outgoing label becomes fully hidden before the incoming label appears; at most one child label is visible in every rendered frame, and the selected label remains stable after arrival.
- Frame 0 and the complete parent overview show zero child/supplemental labels. Each toured segment shows only the current child label; supplemental units remain unlabeled unless explicitly narrated.
- After each child fly-in completes, the camera remains fixed and low-oblique through its narration. After the final child only, one 3.8–5.0 second continuous return reaches the exact first-map-frame parent camera, fades the selection/label, retains the settled hierarchy context, locks, and only then begins the closing narration.
- Every join uses the same preceding selected-region camera, highlight, label, boundary style, and top bar on both sides.
- Single-line mode has exactly one line per subtitle cue, no `<br>`, no leading punctuation, and no overflow.
- Single-line subtitle splitting has no one- to three-character machine-like tail fragments when the sentence can be rebalanced within the profile limit.
- Numbers, classifiers, and units remain in the same cue: never split `43210` from `人`, a decimal from `万亩`, a year number from `年`, or a monetary value from `亿元`. Keep the wider measurement phrase together whenever it fits the profile hard maximum.
- Chinese-number measurements and fixed labels also remain intact: reject `三万四千二百四十七 / 人`, `户籍人 / 口`, `地区生产总 / 值`, and similar visually mechanical breaks.
- Every protected topic name, child place name, school, exact food/product, dialect, institution, historical term, and compound word that fits the hard maximum remains wholly inside one cue; reject character-level breaks such as `革命老 / 区`, `水产养 / 殖`, or `道 / 路`.
- Typical portrait subtitle cues target about 9–12 visible characters and use 13–14 only for an indivisible phrase. Soft punctuation may be omitted at cue boundaries; no cue begins with punctuation or consists only of punctuation.
- Clean-broadcast output contains no editorial source cards, failure wording, or pipeline limitations. Local food, schools, people, customs, buildings, and scenery always use verified-real imagery or no photo. Generated visuals are limited to abstract non-local systems, visibly labelled `示意`, with external provenance.
- No duplicate custom imagery-provider credit strip is present when the captured native map attribution already satisfies the provider requirement.
- Minimal clean-broadcast mode contains no lower-left chapter title and no upper-right fact card. The top bar and single-line subtitles stay in safe areas.
- The top title is exactly `地理图说·{hierarchicalTopicName}` and includes the immediate parent where required: township/subdistrict → county+township, county/district → prefecture+county. The production cover matches it.
- The top title uses the headset-globe mascot rather than a decorative horizontal line or map-pin silhouette, and contains no spaces around `·`.
- Reusable Logo and cover masters contain no stale or fixed locality, country, administrative level, topic-specific satellite image, or regional example. Topic data appears only on production instances.
- The portrait cover exposes replaceable topic, hierarchy path, subtitle, series metadata, and hero visual fields; its default hero remains location-neutral.
- The production cover PNG exists and is embedded as the first 1.8–2.0 seconds of the final video. Map video, narration, music, photos, captions, SRT, and VTT share the same cover offset.
- On the portrait cover, visible brand artwork begins at or below the 64 px top safe line and the footer keeps at least 120 px bottom clearance.
- Narrated rivers and mountains follow verified geometry, use correct labels, and remain readable without covering boundaries or subtitles.
- History/culture/school/food photos match the narrated locality and exact subject. Douyin or other social-video frames have original URL, uploader, timestamp, verification, and reuse status recorded. Photo placement does not cover selected geography, feature labels, title, or subtitles.
- A township production contains verified-real evidence cards for the strongest available history, economy/development, culture/custom, and middle-school subjects. An unavailable exact food image is omitted rather than replaced with a generic product or generated local-looking image.
- Portrait and square are independently framed and laid out.
- Portrait 1080×1920 is reviewed as the primary social profile when requested; the parent boundary fills roughly 62%–75% of the safe composition without clipping, while evidence cards, title, subtitle, and platform UI safety zones remain separated.

## Media

- Correct duration, resolution, 30fps, H.264 video, AAC audio.
- No black event lasting at least `0.2 s` at `pix_th=0.02`, and no silence event lasting at least `1.0 s` below `-50 dB`, except the intentionally silent embedded-cover interval plus at most `0.3 s` tolerance.
- Narration remains intelligible over the music bed.
- Formal narration uses the approved premium voice, natural paragraph pauses, about `-16 LUFS` integrated loudness, and a safe true peak. Music volume stays near `0.18–0.22`.
- Narration evokes familiarity through verified concrete local detail without directly saying `想家`、`回家`, instructing emotion, or using deliberate tear-jerking language.
- Census wording is direct (`第七次人口普查，……人口为……人`) and does not contain `口径下`. `圩` has a pronunciation record as `xū`; dialect names match verified local usage.
- Narration contains no production limitations, missing-boundary discussion, unavailable-roaming wording, artificial source lead-ins such as `教育局公开报道里`, or unsupported stock details such as school bells.
- Formal-release metadata records `formalReleaseReady: true`; Windows SAPI output never passes final QA.
- Concatenated subtitle semantic text equals the source narration cue text after normalizing optional punctuation; every spoken word, number, classifier, and unit remains present and ordered.
- Master duration matches the sum of ordered segments, stream-copy mode is recorded, and every join is checked for decode, black-frame, and silence anomalies.

## Engineering

- Typecheck and tests pass.
- Static runtime tests reject boundary altitude offsets, `clampToGround: false`, polygon height/extrusion, linear longitude/latitude flight interpolation, and parent-reveal camera zoom.
- Runtime tests verify that repeated Cesium entities for one `MultiPolygon` feature are accumulated into a fill-property array and updated together rather than overwriting the principal polygon.
- HyperFrames lint/runtime/layout/contrast have zero errors.
- Capture reports show all expected frames, readiness, and zero console errors.
- Long multi-child captures preserve the browser disk cache but reset Cesium in-memory state at flight starts, at no-more-than-about-0.5-second internal intervals when queue growth is observed, and at flight-end output frames. Static reuse begins on the first output frame strictly later than a fractional endpoint and never seeks that frame backward to the exact endpoint; regression samples on both sides remain visually continuous.
- Draft and final delivery validators pass the complete matrix.
- Build report and `.build-state` files reflect real results and limitations.
- A topic switch stops old-topic research/rendering, uses a new output namespace, and does not overwrite earlier final videos.
