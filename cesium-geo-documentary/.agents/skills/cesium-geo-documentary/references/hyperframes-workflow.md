# HyperFrames workflow

Use standalone HTML compositions with deterministic GSAP timelines. Keep map video, parent/child boundaries, physical-feature overlays, verified photos, captions, narration, music, source notes, and transitions on separate tracks.

Before rendering:

1. Run `hyperframes lint <project-directory>` and `hyperframes check <project-directory>` against the directory expected by the installed CLI, not an individual `index.html` path. Check representative timestamps including parent-boundary reveal, child-boundary fade-in, direct camera flights, feature reveals, photo overlays, and subtitle changes. When one project stores many historical compositions, distinguish current runtime/layout results from unrelated static warnings and isolate the active production composition for a strict release audit when needed.
2. Inspect generated snapshots for safe areas, overlap, contrast, missing text, photo-subject correctness, and feature-label readability.
3. For a multi-region master, inspect frames immediately before and after every join. End the previous segment and begin the next on the exact same selected-region camera, highlight, label, boundary style, and top bar.
4. In minimal clean-broadcast mode, do not create lower-left chapter titles or upper-right fact cards. Use the exact top title `地理乡土情·{hierarchicalTopicName}` and mirror it on the production cover. Avoid black masks, hard overlay replacement, abrupt map-camera resets, or any transition that makes the output feel like separate slides.
5. Place the production cover at composition time 0 for about 1.2–1.6 seconds and fade it out cleanly. Shorten it when necessary so the first visible boundary-introduction stroke occurs within five seconds of composition time. Shift the map, narration, music, evidence cards, and subtitles by the identical offset. Export offset SRT/VTT with the final video; a sidecar-only cover is incomplete.
   When the world-to-region opening is baked into the map track, narration and captions start after the cover offset **plus** the descent duration (`narrationOffset = coverIntroSeconds + narrationStartSeconds`). The map video and music bed still start at the cover offset so the descent plays with ambience; SRT/VTT, the narration audio, and every subtitle cue share the full offset. The composition must not start narration or subtitles during the descent.
6. Keep the actual Cesium camera flight visible after the cover. If motion samples expose unresolved provider LOD/mosaic seams, fix path prewarming or widen the endpoint and recapture; do not replace the flight with a crossfade or hard cut.
7. Place verified photos by evaluating map negative space at the cue timestamp. Fail layout QA if a photo covers the selected boundary, named river/mountain, title, label, or subtitle. Keep one photo dominant at a time.
8. Bind every new formal photo to measured narration sentence cues with `narrationCueIndex` and `requiredKeywords`. The compositor derives photo timing from the same measured cues used for subtitles and narration, applies `narrationStartSeconds`, then applies the cover offset. Never preserve old photo seconds after regenerating narration or changing voice rate. Require the generated visual-sync report to pass before encoding.
8. Keep river/mountain and other named-feature overlays geographically registered to the map video. Reject free-floating decorative lines that do not follow verified geometry.
9. Start Studio preview and hand the user `http://localhost:<port>/#project/<project>` when review is requested or useful.
10. Render after approval, or proceed directly when the user explicitly requests direct final generation. Direct generation waives the approval pause, not lint, snapshots, or final QA.

Render draft first, validate duration/audio/black frames/silence, then render high quality. Use `scripts/render-profile.ps1` on Windows to provide ASCII FFmpeg/FFprobe paths.

For multi-region master delivery, render every segment with the same profile and encoding settings, validate them, then run `build-master-video.ts`. Prefer stream-copy concatenation so satellite imagery is not compressed again.

Warnings about dense tracks are acceptable only when standalone region compositions are intentional. Any lint, runtime, layout, contrast, or overlapping-clip error must be fixed.
