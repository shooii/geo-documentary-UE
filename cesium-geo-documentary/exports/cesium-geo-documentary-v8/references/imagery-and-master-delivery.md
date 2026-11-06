# Imagery and master delivery

## Formal satellite imagery contract

- Use a licensed or otherwise authorized satellite/aerial imagery service and record its provider, URL template or asset ID, access date, maximum level, and attribution.
- Treat Natural Earth, OpenStreetMap, low-resolution overview layers, cached screenshots, and AI-generated maps as draft fallbacks only. Never use them for formal satellite output.
- Keep the satellite layer when terrain is unavailable. Use the ellipsoid and disclose that terrain is not real; do not replace the satellite layer with a demo basemap.
- Disable visual effects that soften formal clean capture, including unnecessary FXAA, blur, excessive vignette, and opaque region fills. Keep labels and boundaries readable without hiding ground texture.
- Use a formal-capture screen-space error small enough to prevent coarse ancestor imagery from appearing during camera motion, and size the tile cache to retain the prewarmed fly path without eviction.
- Before accepting a close selected-region camera, inspect the provider mosaic itself. If clouds, acquisition-date blocks, or ocean colour rectangles appear, widen the fixed camera to the nearest clean scale while keeping the complete selected boundary readable. Prefer a clean contextual view over a closer but visibly stitched one.
- For a small district whose only remaining provider seam is confined to an outer edge, allow one modest centre-biased crop/scale of the fully resolved endpoint before composition. Keep the complete selected boundary visible, preserve aspect ratio, and reject any crop that enlarges soft imagery or removes required context.
- Use separate bounded browser caches for parallel capture groups. Wait for consecutive double-RAF readiness with the request scheduler and tile queues at zero; prewarm and screenshot-stabilize the shared first frame. Allow a longer first-frame timeout for high-resolution tiles.
- Preserve imagery attribution in every composition and final frame where the provider license requires it. Prefer the captured native map attribution and remove duplicate custom credit strips; never remove the last legally required attribution surface.

## Sharpness QA

Inspect lossless frames at the location, boundary, physical-geography, and culture timestamps for every representative camera scale. Confirm roads, shorelines, urban blocks, river edges, and terrain texture are resolved rather than enlarged from a low-resolution source.

Reject formal capture when any sample contains blank tiles, blurred overview tiles at a close zoom, unresolved tile seams, stale fallback imagery, or missing attribution. Provider mosaic color differences are acceptable only when tiles are fully resolved and the report documents them.

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
