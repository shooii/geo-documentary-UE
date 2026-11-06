# Workflow

## Stages

1. `INIT`: create project structure and configuration.
2. `ENVIRONMENT_CHECKED`: verify Node, Python, Chrome, Cesium, HyperFrames, FFmpeg, and tokens.
3. `DATA_VALIDATED`: inventory GeoJSON or complete SHP sidecars, record source CRS/encoding, normalize EPSG:4326 parent/child and narrated-feature geometry, resolve geographic levels, write the coverage manifest, and write quality reports.
4. `RESEARCH_READY`: create cited claims, exact feature evidence, and photo-search requirements per region.
5. `SCRIPT_READY`: create narration and pronunciation data.
6. `STORYBOARD_READY`: map sentences to scenes, overlays, sources, and accessibility notes.
7. `DESIGN_READY`: prepare Figma output or documented fallback tokens.
8. `IMAGE_ASSETS_READY`: verify, license, crop, and manifest exact real photos; generate and label reconstructions only when explicitly allowed.
9. `CESIUM_READY`: build seekable scene timelines.
10. `VOICE_READY`: generate measured narration audio.
11. `TIMING_MAPPED`: create sentence- and word-level captions.
12. `FRAMES_RENDERED`: capture all frames for each profile after the formal imagery contract passes.
13. `COMPOSITION_READY`: generate standalone HyperFrames compositions.
14. `SEGMENTS_VALIDATED`: pass code, browser, layout, visual, sharpness, and segment media validation.
15. `MASTER_READY`: when requested, concatenate segments in the configured order without re-encoding and validate joins.
16. `QA_PASSED`: pass the complete requested delivery matrix.
17. `DELIVERED`: write final reports and outputs.

Write `.build-state/<stage>.json` after each successful stage. Never mark a later stage complete when a required earlier artifact is absent.

## Resume rules

- Validate existing artifacts before reusing them.
- Rerun only the failed region/profile when inputs are unchanged.
- Rebuild all downstream stages after changing narration text, audio timing, boundary geometry, or a design profile.
- Rebuild formal frames after changing imagery provider, tile quality settings, camera scale, cache policy, or clean-capture effects.
- Rebuild only the master after changing region order when all validated segment files are unchanged.
- Preserve diagnostics and failed artifacts for the build report.
