# Playwright rendering

Fix Chrome version, viewport, DPR, locale, timezone, color scheme, fonts, animation policy, and a bounded project-local cache key. Open the Cesium page with the requested region/profile and wait for `window.geoVideo`.

For each frame:

1. Calculate `seconds = frame / fps`.
2. Call `window.geoVideo.seek(seconds)`.
3. Require ready, imagery, fonts, entities, stable zero pending requests, and no runtime errors. Require terrain only when the configured terrain provider is real and available; otherwise record the ellipsoid fallback.
4. Capture lossless PNG through CDP or Playwright.
5. Pipe the frame to FFmpeg and save selected regression frames.

Do not accept a single `globe.tilesLoaded` observation or a single animation frame as imagery readiness. Prewarm the parent-boundary reveal, child-boundary fade-in, representative timestamps across each full 0–8 second direct flight, and every cue-synchronized feature layer. Enable ancestor/sibling tile preloading for motion and require the Cesium request scheduler and globe tile queues to remain at zero through consecutive double-RAF render passes. Before frame 0, discard warm-up captures until the initial parent overview or inherited preceding-region PNG is byte-stable after a minimum settling interval. Capture each animated interval frame by frame, then reuse only fully settled fixed-camera states.

On timeout, retry the same frame, save screenshot/runtime/network/console diagnostics, then fail the formal capture. Never skip a formal frame.

For formal satellite output, use longer initial tile timeouts, independent caches for parallel groups, provider attribution, and representative lossless sharpness snapshots. Inspect frame 0 and fly-in samples for unresolved rectangular LOD tiles or dark seams. Fail rather than silently switching to a non-satellite fallback.
