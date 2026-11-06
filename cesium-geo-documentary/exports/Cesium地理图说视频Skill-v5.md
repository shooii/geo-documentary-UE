---
name: cesium-geo-documentary
description: Build, resume, validate, batch-render, and concatenate deterministic Cesium administrative-region geography documentary videos with a parent-region introduction, persistent sibling boundaries, direct previous-region-to-next-region camera flights, translucent highlight handoffs, fixed low oblique arrival cameras, licensed high-resolution satellite imagery, population/economy/history/culture narration, minimal clean-broadcast overlays, single-line subtitles, seamless camera-continuity joins, Playwright capture, HyperFrames composition, and segment or master MP4 delivery. Use for Cesium GIS explainers, administrative-region video series, clear satellite-map videos, multi-region long videos, or maintenance of a cesium-geo-documentary project.
---

# Cesium Geo Documentary

Produce videos through a resumable, evidence-backed pipeline. Keep facts, Cesium camera state, narration timing, overlays, and rendering separate.

## Run the workflow

1. Inspect available tools, project configuration, `.build-state/`, and existing artifacts.
2. Validate and normalize boundaries before researching or scripting.
3. Build a cited research pack. For a multi-child series, create a parent-region introduction before any child segment. Every parent and child script must cover population with year and population type, economy with year and either GDP or a verified industry structure, history, and representative culture.
4. Generate narration, pronunciation data, and a storyboard whose scenes reference claims.
5. Prepare design tokens and component specifications. Use Figma only when a target file is available; otherwise keep the documented import plan.
6. Select an asset mode after the storyboard is stable. In `clean-broadcast` mode, disable generated imagery rather than hiding its origin; use map-led scenes or licensed real photographs with attribution stored outside the frame. In labelled reconstruction mode, keep explicit AI/artistic-reconstruction labels.
7. Build a seekable Cesium timeline. Start the master with a stable parent-region overview and basic introduction. Chain every later child segment directly from the previous segment's exact final camera and highlight state. Over the opening 8 seconds, use a deterministic eased Cesium camera flight from the previous region to the new selected region while the previous translucent highlight fades out and the new highlight fades in. Keep heading and pitch fixed during the move. Once the camera arrives, hold longitude, latitude, range, heading, pitch, and roll unchanged through the end of the segment; do not pull back to the parent overview. Use a low oblique administrative-map view, typically around `-62°` to `-66°`, while keeping the full selected boundary visible. Never repeatedly trace, blink, pulse, or toggle the base sibling boundaries. Do not replace a requested continuous Cesium flight with endpoint crossfades or hard cuts; prewarm the flight path, widen a problematic endpoint if needed, and fail formal rendering if unresolved imagery seams remain.
8. Generate narration audio, measure its real duration, and create sentence- and word-level captions.
9. Lock the formal imagery provider and quality contract. When the user requests satellite imagery, reject Natural Earth, OpenStreetMap, or other non-satellite/demo basemaps for formal output.
10. Capture Cesium frames with Playwright at fixed viewport, DPR, locale, timezone, and frame time. Pass the preceding region ID into each capture, prewarm representative points across the complete 0–8 second flight, then require consecutive settled render passes, zero Cesium request/tile-queue work, and screenshot-stable endpoint warm-ups; never treat one `tilesLoaded` result or one RAF as sufficient. Reuse the settled arrival frame only after the camera and highlight have reached their final values. Keep legally required provider attribution through the native map credit surface; do not add a second custom credit strip when the captured native credit already satisfies the provider requirement.
11. Compose standalone HyperFrames HTML files for each region and output profile. In the default minimal `clean-broadcast` mode, show only the satellite map, persistent administrative boundaries, selected-region highlight and label, a restrained top bar, and single-line subtitles. Omit the lower-left chapter title, upper-right fact card, editorial source cards, AI labels, reconstruction badges, source-note scenes, and duplicate custom provider strips unless the user explicitly requests them. Split narration into consecutive timed cues that never render `<br>` or a second line. Preserve research and asset attribution in sidecar reports.
12. Run typecheck, tests, HyperFrames lint/check, snapshots, and visual review.
13. Obtain preview approval unless the user explicitly requests direct final rendering. Even when approval is waived, keep automated snapshots and QA mandatory. Render draft first when requested or when layout risk is unresolved, then render high quality.
14. Validate every final segment for duration, resolution, frame rate, audio, black frames, silence, subtitle completeness, and satellite-image sharpness at representative zoom levels.
15. For batch or master delivery, preserve the requested region order, validate stream compatibility, concatenate with FFmpeg stream copy, then validate the complete long video and every join boundary. Re-encode only when stream copy is impossible and report it.
16. Write build reports and stage state files; only then mark delivery complete.

Read [workflow.md](references/workflow.md) for resumable stage details and [qa-checklist.md](references/qa-checklist.md) before rendering. For satellite imagery or multi-region delivery, also read [imagery-and-master-delivery.md](references/imagery-and-master-delivery.md).

## Route specialized work

- For boundary and camera work, read [boundary-schema.md](references/boundary-schema.md) and [cesium-camera-rules.md](references/cesium-camera-rules.md).
- For persistent sibling boundaries, selected-region highlighting, clean-broadcast overlays, and licensed-photo fallback, read [boundary-and-clean-presentation.md](references/boundary-and-clean-presentation.md).
- For research and citations, read [source-policy.md](references/source-policy.md).
- For scripts and captions, read [narrative-style.md](references/narrative-style.md) and [subtitle-style.md](references/subtitle-style.md).
- For Figma, read [figma-workflow.md](references/figma-workflow.md). Load `figma-use` before writes and `figma-generate-design` for composed screens.
- For generated imagery, read [imagegen-workflow.md](references/imagegen-workflow.md).
- For browser capture, read [playwright-rendering.md](references/playwright-rendering.md).
- For composition and rendering, read [hyperframes-workflow.md](references/hyperframes-workflow.md).
- For clear satellite basemaps, imagery attribution, batch ordering, stream-copy concatenation, and master-video QA, read [imagery-and-master-delivery.md](references/imagery-and-master-delivery.md).
- For system boundaries, read [architecture.md](references/architecture.md).

## Use the bundled scripts

Run scripts from the project root. Prefer the CLI wrapper when it covers the task.

```powershell
pnpm geo-video doctor
pnpm geo-video validate-data --region <region-id>
pnpm geo-video capture --region <region-id> --profile landscape --encode
pnpm geo-video compose --region <region-id> --profile landscape
pnpm geo-video master --regions <id-1,id-2,...> --profile landscape --output renders/final/master.mp4
pnpm typecheck
pnpm test
```

Key deterministic scripts:

- `preprocess-boundaries.py` and `validate-geodata.py`: normalize and validate GIS data.
- `build-research-pack.ts`, `generate-script.ts`, and `generate-storyboard.ts`: create cited content artifacts.
- `build-cesium-scenes.ts`: create seekable scene timelines.
- `capture-frames.ts`: perform Playwright frame capture and intermediate encoding.
- `build-smooth-map-video.ts`: legacy endpoint-crossfade utility; do not use it when continuous direct Cesium flights are required.
- `generate-narration.ts` and `generate-subtitles.py`: create measured audio and captions.
- `compose-hyperframes.ts`: create responsive standalone compositions.
- `validate-delivery.ts`: validate draft or final video sets.
- `build-master-video.ts`: verify compatible segment streams, concatenate without re-encoding, extract a cover, and write master-video QA reports.

Use files under `templates/` when starting a new project or adding a region.

## Recover from failures

- Preserve successful stages and rerun only the failed region/profile.
- Do not hide missing tokens, unavailable services, rejected generated images, TTS fallback, or capture timeouts.
- Save diagnostics before aborting a failed frame or render.
- If Cesium Ion is unavailable, use an explicitly documented offline imagery/ellipsoid fallback; never claim terrain was rendered when it was not.
- If a formal satellite provider is unavailable, stop formal capture and preserve diagnostics. Do not silently fall back to Natural Earth, OpenStreetMap, a blurred screenshot, or generated imagery.
- If only terrain is unavailable, keep the licensed satellite layer, use the ellipsoid, and disclose that real terrain was not rendered.
- If Figma is unavailable, deliver tokens, component specifications, node-map placeholders, and an import plan.
- If ImageGen fails or clean-broadcast mode is active, use a map-led scene first. A real-photo fallback is allowed only when locality, resolution, license, and attribution are verified and recorded in the external photo manifest.
- If TTS or transcription fails, record the provider fallback and regenerate dependent subtitle timing.

## Deliver

Provide project and Skill paths, commands, preview URL, outputs, tests, known limitations, and extension guidance. Include MP4 files for every requested profile, SRT/VTT captions, covers, source records, photo/ImageGen manifests when used, and build reports. For batch or complete-series requests, include both validated segment videos and the ordered master video unless the user explicitly asks for segments only.
