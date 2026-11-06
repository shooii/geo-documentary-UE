# Workflow

## Stages

1. `INIT`: create project structure and configuration.
2. `ENVIRONMENT_CHECKED`: verify Node, Python, Chrome, Cesium, HyperFrames, FFmpeg, and tokens.
3. `DATA_VALIDATED`: inventory GeoJSON or complete SHP sidecars, record source CRS/encoding, normalize EPSG:4326 parent/child and narrated-feature geometry, resolve geographic levels, write the coverage manifest, and write quality reports.
4. `RESEARCH_READY`: create cited claims, exact feature evidence, and photo-search requirements per region.
5. `SCRIPT_READY`: create narration and pronunciation data.
6. `STORYBOARD_READY`: map sentences to scenes, overlays, sources, and accessibility notes.
7. `DESIGN_READY`: prepare the location-neutral Figma master, a topic-specific production instance, synchronized tokens, and the exportable portrait cover.
8. `IMAGE_ASSETS_READY`: verify, license, crop, and manifest exact real photos; generate and label reconstructions only when explicitly allowed.
9. `CESIUM_READY`: build seekable scene timelines.
10. `VOICE_READY`: generate measured narration audio.
11. `TIMING_MAPPED`: create sentence- and word-level captions.
12. `FRAMES_RENDERED`: capture all frames for each profile after the formal imagery contract passes.
13. `COMPOSITION_READY`: generate standalone HyperFrames compositions with the production cover embedded and every timed track/caption offset consistently.
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
- Rebuild the complete map video in one run after enabling, disabling, or tuning the world-to-region opening (descent duration, start height/pitch, cloud deck, atmosphere). Never splice a newly warmed opening onto a previously captured video; tile LOD selection depends on cache history and the join can pop sharpness.
- Rebuild only the master after changing region order when all validated segment files are unchanged.
- Preserve diagnostics and failed artifacts for the build report.

## Legacy town upgrade checklist

Use this checklist when a previous town output must be restyled to match the latest approved town film:

1. Identify the newest validated reference MP4; compare its title, cover duration, composition metadata, caption mode, visual-evidence timing mode, and QA report with the target.
2. Update only the target region's source-of-truth content. Keep its own verified facts, boundary units, village order, photos, and citations.
3. Migrate the title to `地理乡土情·{县}{镇}`, convert concrete values to Arabic digits, and rewrite any production-facing closing line.
4. Count actual provider sentence cues before the first child and set `tourIntroSentences` to that count. Confirm the final child cue and optional outro cue exist before inserting the silent return.
5. Regenerate script, research, formal voice, captions, cover, and publishing output in dependency order.
6. Delete or rebuild stale subtitle overrides after any narration or cue-boundary change.
7. Recapture the complete map track when opening, title-era runtime behavior, boundary persistence, or camera behavior changed; do not splice in the old map track.
8. Rebuild the composition, render high quality with `scripts/render-profile.ps1`, run final QA, and only then create the Chinese-titled delivery copy.
