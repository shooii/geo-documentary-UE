# HyperFrames workflow

Use standalone HTML compositions with deterministic GSAP timelines. Keep map video, parent/child boundaries, physical-feature overlays, verified photos, captions, narration, music, source notes, and transitions on separate tracks.

Before rendering:

1. Run lint and check representative timestamps including parent-boundary reveal, child-boundary fade-in, direct camera flights, feature reveals, photo overlays, and subtitle changes.
2. Inspect generated snapshots for safe areas, overlap, contrast, missing text, photo-subject correctness, and feature-label readability.
3. For a multi-region master, inspect frames immediately before and after every join. End the previous segment and begin the next on the exact same selected-region camera, highlight, label, boundary style, and top bar.
4. In minimal clean-broadcast mode, do not create lower-left chapter titles or upper-right fact cards. Use the exact top title `地理图说·{topicName}`. Avoid black masks, hard overlay replacement, abrupt map-camera resets, or any transition that makes the output feel like separate slides.
5. Keep the actual Cesium camera flight visible over the opening 8 seconds. If motion samples expose unresolved provider LOD/mosaic seams, fix path prewarming or widen the endpoint and recapture; do not replace the flight with a crossfade or hard cut.
6. Place verified photos by evaluating map negative space at the cue timestamp. Fail layout QA if a photo covers the selected boundary, named river/mountain, title, label, or subtitle. Keep one photo dominant at a time.
7. Keep river/mountain and other named-feature overlays geographically registered to the map video. Reject free-floating decorative lines that do not follow verified geometry.
8. Start Studio preview and hand the user `http://localhost:<port>/#project/<project>` when review is requested or useful.
9. Render after approval, or proceed directly when the user explicitly requests direct final generation. Direct generation waives the approval pause, not lint, snapshots, or final QA.

Render draft first, validate duration/audio/black frames/silence, then render high quality. Use `scripts/render-profile.ps1` on Windows to provide ASCII FFmpeg/FFprobe paths.

For multi-region master delivery, render every segment with the same profile and encoding settings, validate them, then run `build-master-video.ts`. Prefer stream-copy concatenation so satellite imagery is not compressed again.

Warnings about dense tracks are acceptable only when standalone region compositions are intentional. Any lint, runtime, layout, contrast, or overlapping-clip error must be fixed.
