# Architecture

| Layer | Responsibility |
| --- | --- |
| Data | Raw boundaries, normalized geometry, region records, sources |
| Content | Claims, narration, pronunciation, storyboard |
| Design | Tokens, component specifications, Figma mapping/import plan |
| Cesium | Imagery, boundaries, labels, camera, deterministic seek |
| Playwright | Browser readiness, fixed-time frame capture, diagnostics |
| Audio | TTS, measured duration, sentence/word timing |
| HyperFrames | Tracks, overlays, captions, transitions, audio mix |
| FFmpeg | Intermediate encoding, probing, black/silence validation |

HTML compositions are the final timeline source of truth. Cesium must not own subtitles, narration, or editorial cards. Keep generated imagery out of geographic truth layers.

The browser runtime must expose `initialize`, `loadRegion`, `seek`, `renderFrame`, `getFrameStatus`, `getDiagnostics`, and `dispose` through `window.geoVideo`.
