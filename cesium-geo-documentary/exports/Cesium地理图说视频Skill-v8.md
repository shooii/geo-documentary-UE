---
name: cesium-geo-documentary
description: Build, resume, validate, batch-render, and concatenate deterministic Cesium geography documentary videos at world, continent, country, province/state, prefecture/city, county/district, township, village, and rural-area scales. Ingest GeoJSON or complete ESRI Shapefile boundary sets, preserve source CRS evidence, and enforce topology and registration QA. Support parent-boundary-first GIS reveals, complete immediate-child coverage, direct previous-region-to-next-region camera flights, fixed low-oblique arrival cameras, licensed satellite imagery, cue-synchronized rivers/mountains and other physical features, verified locality-specific history/culture photographs, professional and engaging narration, the title format `地理图说·{主题}`, single-line subtitles, Playwright capture, HyperFrames composition, and segment or master MP4 delivery. Use for geographic explainers, administrative series, physical-and-human geography stories, clear satellite-map videos, or maintenance of a cesium-geo-documentary project.
---

# Cesium Geo Documentary

Produce videos through a resumable, evidence-backed pipeline. Keep facts, Cesium camera state, narration timing, overlays, and rendering separate.

## Enforce the premium map contract

- Administrative boundaries are always grounded. Build longitude/latitude positions without altitude, use `clampToGround: true`, terrain-classified fills without polygon height, and a dark-underlay + semantic-main-line pair with adjacent `zIndex` values. Never solve z-fighting with vertical offsets.
- Keep the parent camera completely fixed while revealing the parent boundary and child hierarchy.
- Interpolate region travel with `Cesium.EllipsoidGeodesic` and deterministic lift → cruise → settle height phases. Adapt compact-tour flights to ground distance within about 2.2–4.5 seconds, then lock the arrival camera.
- Use Noto Sans SC for map/title/subtitle Chinese, Noto Serif SC for editorial display, Roboto Flex for Latin/numbers, and Roboto Mono for technical labels. Use 8% title tracking without glow.
- Use `zh-CN-YunyangNeural` around `-4%` by default, preserve pronunciation records, normalize formal narration near `-16 LUFS`, and keep music near 0.2. Formal generation must fail instead of silently falling back to Windows SAPI; SAPI is draft-only.
- Keep the connected Figma file, tokens, node map, implementation, and screenshots synchronized. The current design source is `https://www.figma.com/design/3o7fht8p72Aog2YnRzph5n` in `xu yaoting's team`.

## Run the workflow

1. Inspect available tools, project configuration, `.build-state/`, and existing artifacts.
2. Lock the active topic and output namespace. If the user switches region or level, stop all old-topic research and rendering immediately. Reuse only generic technical assets, and never overwrite a historical final video with the new topic.
3. Resolve the topic's geographic role and immediate-child level before research. Support `world → continent → country → admin1 → admin2 → admin3/locality → township/subdistrict → administrative village/community → natural village/settlement or rural area`. Separate statutory immediate children from functional new areas, development zones, cooperation zones, and enclaves before building the coverage manifest. A parent-topic title requires spoken and visual coverage of every verified direct child, not merely displaying all child boundaries. Give each child its own narration cue, selection highlight, camera arrival, and fixed hold; fail coverage QA if any direct child is never introduced.
4. Establish boundary evidence before normalization. Prefer official GIS/WFS/GeoJSON/SHP, then credible public administrative data. Accept ESRI Shapefile only as a complete set with `.shp`, `.shx`, `.dbf`, and `.prj`; read `.cpg` when present, record every sidecar, detect the source CRS, reproject to EPSG:4326, preserve the originals, and fail on unresolved DBF encoding or private-use characters. Never use Voronoi, hand-drawn partitions, or center-point approximations as administrative boundaries.
5. Validate and normalize parent boundaries, child boundaries, and any narrated rivers, lakes, bays, mountains, ridges, coastlines, islands, roads, or settlements before scripting. Run coverage, control-point residual, topology, and visual overlay QA when boundaries are registered or digitized from an official planning map.
6. Build a cited research pack. Create a parent-topic introduction before child segments. Every applicable parent and child script must cover location and physical setting, population with year and population type, economy with year and a verified figure or industry structure, historical sequence, representative culture, and contemporary development. Adapt fields at very small rural scales instead of inventing unavailable GDP or population data.
7. Generate professional but engaging narration, pronunciation data, and a storyboard whose sentences reference claims and visual evidence. Use concrete cause-and-effect, one memorable detail, and restrained wit; avoid tourism copy, forced jokes, unsupported superlatives, and encyclopedia lists.
8. Prepare design tokens and component specifications. Set the visible title to exactly `地理图说·{topicName}` such as `地理图说·亚洲`, `地理图说·中国`, or `地理图说·湛江`; do not append `全域与区县` or another hierarchy suffix. Use Figma only when a target file is available.
9. Build a verified visual-evidence manifest. For every history or culture claim that benefits from imagery, obtain the most specific reusable real photograph, archive image, artifact, site, performance, or craft image available. For example, narration about 吴川飘色 must show a verified image of 吴川飘色 rather than generic folk art. Store attribution externally in clean-broadcast mode. Use generated reconstruction only in explicitly labelled reconstruction mode.
10. Build a seekable parent introduction. Begin with satellite imagery and no child boundaries. Reveal the parent outer boundary once with a refined GIS drawing effect, settle it into a stable line, then fade the complete immediate-child boundary set in as one restrained group. Do not flash, repeatedly trace, or reveal children before the parent outline is legible.
11. Chain later child segments directly from the previous segment's exact final camera and highlight state. Use a deterministic eased Cesium flight while the previous highlight fades out and the new highlight fades in. Keep heading and pitch fixed during the move. Once arrived, hold the low-oblique camera unchanged through that child's narration. For compact village tours, shorten the flight proportionally but never replace it with a hard cut.
12. Synchronize thematic visuals to word-level narration timing. When a named river, mountain, lake, bay, island, pass, road, or settlement is spoken, reveal its verified geometry and label on the map. When history or culture is spoken, show the verified image in the best collision-free negative-space position without covering the selected geography, feature label, top title, or subtitle. Keep one dominant photo at a time and use restrained entry/exit motion.
13. Generate narration audio, measure its real duration, and create sentence- and word-level captions.
14. Lock the formal imagery provider and quality contract. When the user requests satellite imagery, reject Natural Earth, OpenStreetMap, or other non-satellite/demo basemaps for formal output.
15. Capture Cesium frames with Playwright at fixed viewport, DPR, locale, timezone, and frame time. Prewarm parent-boundary reveal, child-boundary fade-in, every 0–8 second camera flight, and every physical-feature layer. Require consecutive settled render passes, zero Cesium request/tile-queue work, and screenshot-stable endpoints.
16. Compose standalone HyperFrames HTML files. In minimal clean-broadcast mode, show the satellite map, hierarchical boundaries, selected-region highlight and label, `地理图说·{topicName}`, cue-synchronized feature layers, verified photos, and single-line subtitles. Omit lower-left chapter titles, upper-right fact cards, source cards, AI labels, and duplicate provider strips unless explicitly requested.
17. Run typecheck, tests, HyperFrames lint/check, coverage-manifest checks, photo/feature evidence checks, snapshots, and visual review. Validate every final segment and every master join.
18. Preserve the requested geographic order, concatenate compatible segments with FFmpeg stream copy, write reports and stage state, and only then mark delivery complete.

Read [workflow.md](references/workflow.md) for resumable stage details and [qa-checklist.md](references/qa-checklist.md) before rendering. For satellite imagery or multi-region delivery, also read [imagery-and-master-delivery.md](references/imagery-and-master-delivery.md).

## Route specialized work

- For boundary evidence, SHP ingestion, official-map registration, and camera work, read [boundary-evidence-and-registration.md](references/boundary-evidence-and-registration.md), [boundary-schema.md](references/boundary-schema.md), and [cesium-camera-rules.md](references/cesium-camera-rules.md).
- For supported geographic levels, child enumeration, title naming, and large-series routing, read [geographic-levels.md](references/geographic-levels.md).
- For persistent sibling boundaries, selected-region highlighting, clean-broadcast overlays, and licensed-photo fallback, read [boundary-and-clean-presentation.md](references/boundary-and-clean-presentation.md).
- For exact history/culture images and narrated rivers, mountains, and other named features, read [thematic-visual-evidence.md](references/thematic-visual-evidence.md).
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
python .agents/skills/cesium-geo-documentary/scripts/import-shapefile.py data/raw/example.shp --region-id <id> --region-name <name> --parent-id <parent-id> --id-field <id-field> --name-field <name-field> --expected-children <count>
pnpm geo-video validate-data --region <region-id>
pnpm geo-video capture --region <region-id> --profile landscape --encode
pnpm geo-video compose --region <region-id> --profile landscape
pnpm geo-video master --regions <id-1,id-2,...> --profile landscape --output renders/final/master.mp4
pnpm typecheck
pnpm test
```

Key deterministic scripts:

- `import-shapefile.py`: ingest a complete polygon SHP set, decode DBF attributes, detect and transform the source CRS, write parent/child GeoJSON, and emit a QA report and coverage manifest.
- `preprocess-boundaries.py` and `validate-geodata.py`: normalize and validate GeoJSON data.
- `build-research-pack.ts`, `generate-script.ts`, and `generate-storyboard.ts`: create cited content artifacts.
- `build-cesium-scenes.ts`: create seekable scene timelines.
- `build-child-tour.ts`: map sentence-level narration timing to complete direct-child camera flights, highlights, fixed holds, and coverage-manifest evidence.
- `capture-frames.ts`: perform Playwright frame capture and intermediate encoding.
- `build-smooth-map-video.ts`: legacy endpoint-crossfade utility; do not use it when continuous direct Cesium flights are required.
- `generate-narration.ts` and `generate-subtitles.py`: create measured audio and captions.
- `build-master-subtitles.py`: offset ordered standalone captions into master SRT/VTT deliverables.
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
- If exact administrative boundaries cannot be acquired or registered reliably, stop the formal video. Do not substitute Voronoi cells, center-point partitions, hand-drawn lines, or visually plausible approximations.
- If only terrain is unavailable, keep the licensed satellite layer, use the ellipsoid, and disclose that real terrain was not rendered.
- If Figma is unavailable, deliver tokens, component specifications, node-map placeholders, and an import plan.
- If ImageGen fails or clean-broadcast mode is active, use the planned verified real photo or a map-led scene. Never replace a required exact culture/history subject with a generic local image. Record locality, subject, resolution, license, and attribution in the external photo manifest.
- If formal premium TTS fails, stop the release build and preserve diagnostics. Windows SAPI may be used only with an explicit draft flag; record it as non-release-ready and regenerate all dependent timing before final delivery.

## Deliver

Provide project and Skill paths, commands, preview URL, outputs, tests, known limitations, and extension guidance. Include MP4 files for every requested profile, SRT/VTT captions, covers, source records, photo/ImageGen manifests when used, and build reports. For batch or complete-series requests, include both validated segment videos and the ordered master video unless the user explicitly asks for segments only.
