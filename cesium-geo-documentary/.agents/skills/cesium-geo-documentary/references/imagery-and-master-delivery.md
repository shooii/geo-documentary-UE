# Imagery and master delivery

## Formal satellite imagery contract

- Use a licensed or otherwise authorized satellite/aerial imagery service and record its provider, URL template or asset ID, access date, maximum level, and attribution.
- Treat Natural Earth, OpenStreetMap, low-resolution overview layers, cached screenshots, and AI-generated maps as draft fallbacks only. Never use them for formal satellite output.
- Keep the satellite layer when terrain is unavailable. Use the ellipsoid and disclose that terrain is not real; do not replace the satellite layer with a demo basemap.
- Terrain is a per-deployment switch, never an implicit default, because real elevation changes framing fill and can destabilise ground-clamped geometry between frames. The runtime resolves it from `imagery-config.json` `terrain.provider` (overridable with `terrain_provider` in `config/project.yaml`, or a `?terrain=` query parameter for a single capture). Accepted values: `ellipsoid` (shipped default), `arcgis` (ArcGIS World Elevation 3D, no token), `world-terrain` / `ion:<assetId>` (needs `CESIUM_ION_TOKEN`), and `url:<quantized-mesh endpoint>`. An unreachable or token-less provider must fall back to the ellipsoid and record `terrain-unavailable` / `terrain-fallback` in the diagnostics — never blank the map.
- Disable visual effects that soften formal clean capture, including unnecessary FXAA, blur, excessive vignette, and opaque region fills. Keep labels and boundaries readable without hiding ground texture.
- Grade the base layer only to unify tone, never to stylize it: satellite imagery stays the visual subject, so the adjustment is mainly luminance (so the cool-white and gold line hierarchy keeps a predictable contrast over bright or cloudy mosaics) plus a gentle saturation trim. Never blur, never hide texture, never mask the mosaic. Production values live in `apps/cesium-player/public/imagery-config.json` under `visual`; set every key to its neutral value (`1`) when a formal capture must ship unmodified imagery.
- Use a formal-capture screen-space error small enough to prevent coarse ancestor imagery from appearing during camera motion; about `1.0` is a strong 1080p starting point and remains sharper than Cesium's default. Size the tile cache above the largest observed visible high-priority set so close coastal or fragmented views do not churn or overflow the cache.
- Before accepting a close selected-region camera, inspect the provider mosaic itself. If clouds, acquisition-date blocks, or ocean colour rectangles appear, widen the fixed camera to the nearest clean scale while keeping the complete selected boundary readable. Prefer a clean contextual view over a closer but visibly stitched one.
- For a small district whose only remaining provider seam is confined to an outer edge, allow one modest centre-biased crop/scale of the fully resolved endpoint before composition. Keep the complete selected boundary visible, preserve aspect ratio, and reject any crop that enlarges soft imagery or removes required context.
- Use separate bounded browser caches for parallel capture groups. Wait for consecutive double-RAF readiness with visible tiles loaded and the high/medium visible tile queues at zero; record global active and speculative low-priority offscreen requests without blocking a byte-stable frame. Prewarm and screenshot-stabilize the shared first frame. Allow a longer first-frame timeout for high-resolution tiles.
- Preserve imagery attribution in every composition and final frame where the provider license requires it. Prefer the captured native map attribution and remove duplicate custom credit strips; never remove the last legally required attribution surface.

## Sharpness QA

Inspect lossless frames at the location, boundary, physical-geography, and culture timestamps for every representative camera scale. Confirm roads, shorelines, urban blocks, river edges, and terrain texture are resolved rather than enlarged from a low-resolution source.

Reject formal capture when any sample contains blank tiles, blurred overview tiles at a close zoom, unresolved tile seams, stale fallback imagery, or missing attribution. Provider mosaic color differences are acceptable only when tiles are fully resolved and the report documents them.

## Map cache invalidation

- The captured map video is cached by render-spec `cacheSignature`, so a signature that fails to change when the rasteriser changes means the export silently re-encodes the *old* footage. Two camera fixes (the focus-mask frame footprint and the child-tour flight origin) shipped without bumping the hand-maintained version constant, and every already-cached region kept matching.
- `mapRendererSignature()` hashes the sources that decide what a frame looks like — `runtime.js`, the player HTML and imagery config, `tour-presentation.js`, `capture-frames.ts`, `build-cesium-scenes.ts` — and Studio passes it to `buildRenderSpec`. Editing any of them invalidates every cached map video automatically; nobody has to remember a bump. `MAP_RENDERER_CACHE_VERSION` survives only as the fallback for callers that cannot supply a signature, so bump it only for changes that live in configuration.
- Consequence to expect: changing the camera or layer code re-captures the map for every region, including ones that already had a cache hit. That is the correct trade — a cache hit that hides a shipped fix is a correctness bug, not a speed feature.

## Batch and master modes

Support three explicit delivery modes:

- `single`: one region and profile.
- `batch`: individually validated region videos.
- `master`: batch videos plus one ordered long video.

For `master`, obtain the requested region order from configuration or the user and write it into the build report. Never sort by filename when an editorial order is provided.

1. Validate every segment before concatenation.
2. Compare video codec, profile, level, pixel format, resolution, frame rate, time base, color metadata, and audio codec/sample layout.
3. Use the FFmpeg concat demuxer with `-c copy` when streams are compatible. This avoids another lossy encode of satellite detail.
4. If streams differ, stop by default. Re-render segments consistently or perform one explicitly reported high-quality normalization encode only when authorized by the workflow.
5. Validate the master duration against the sum of segments, verify H.264/AAC streams, scan for black and silence events, and inspect frames around every join.
6. Extract a master cover and write JSON/Markdown reports containing the order, segment hashes or sizes, concat mode, probe data, QA events, and limitations.

Use `scripts/build-master-video.ts` for deterministic stream-copy delivery.
