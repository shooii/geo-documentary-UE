# Playwright rendering

Fix Chrome version, viewport, DPR, locale, timezone, color scheme, fonts, animation policy, and a bounded project-local cache key. Open the Cesium page with the requested region/profile and wait for `window.geoVideo`.

For each frame:

1. Calculate `seconds = frame / fps`.
2. Call `window.geoVideo.seek(seconds)`.
3. Require ready, imagery, fonts, entities, stable zero high/medium visible tile-queue work, and no runtime errors. Record global active requests and low-priority offscreen work diagnostically. Require terrain only when the configured terrain provider is real and available; otherwise record the ellipsoid fallback.
4. Capture lossless PNG through CDP or Playwright.
5. Pipe the frame to FFmpeg and save selected regression frames.

Do not accept a single `globe.tilesLoaded` observation or a single animation frame as imagery readiness. Prewarm the parent-boundary reveal, child-boundary fade-in, and every cue-synchronized feature layer. Do not enqueue distant child flights in one startup prewarm. Reload at each sampled or full-capture flight start, retain the browser disk cache, and let that flight's requested frames warm its path incrementally so the Cesium in-memory cache remains bounded. Enable ancestor/sibling tile preloading for motion and require visible tiles plus the high/medium visible tile queues to remain settled through consecutive double-RAF render passes. Cesium may continue speculative low-priority offscreen caching; treat it as non-blocking only after repeated lossless screenshots are byte-identical. Before frame 0, discard warm-up captures until the initial parent overview or inherited preceding-region PNG is byte-stable after a minimum settling interval. Capture each animated interval frame by frame, then reuse only fully settled fixed-camera states.

If a long multi-child tour still accumulates stale in-memory tile queues, reload the same deterministic runtime at each child-flight start, at internal checkpoints no farther apart than about 0.5 seconds, and at the flight-end output frame, while retaining the project-local browser disk cache. For static-frame reuse, choose the first output timestamp strictly later than a fractional flight endpoint. Do not seek the first post-flight frame backward to the exact fractional endpoint: that state boundary can trigger a fresh Cesium visible-set rebuild even though the camera and highlight are already locked. Seek to the requested output timestamp after reload. Verify that frames immediately before and after every reload remain continuous in camera, highlight, labels, and boundary state before accepting the strategy.

For a non-linear seek larger than ordinary frame-to-frame time, apply the scene state a second time after the first settled render. This prevents a one-frame ground-primitive batch gap when visibility or material properties change across a large timestamp jump. Keep ordinary sequential capture single-pass for performance.

On timeout, retry the same frame, save screenshot/runtime/network/console diagnostics, then fail the formal capture. Never skip a formal frame.

For formal satellite output, use longer initial tile timeouts, independent caches for parallel groups, provider attribution, and representative lossless sharpness snapshots. Inspect frame 0 and fly-in samples for unresolved rectangular LOD tiles or dark seams. Fail rather than silently switching to a non-satellite fallback.
