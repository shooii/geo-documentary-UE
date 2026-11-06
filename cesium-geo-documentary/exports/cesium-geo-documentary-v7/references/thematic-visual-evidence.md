# Thematic visual evidence

## Exact real photographs for history and culture

Treat a real, locality-specific image as required visual evidence when narration names a concrete historical site, artifact, event, performance, custom, craft, food tradition, costume, or festival and a lawful reusable image exists.

Rank candidates by:

1. exact locality;
2. exact narrated subject;
3. correct period, event, or cultural form;
4. authoritative description and reusable license;
5. original resolution, visual clarity, and useful composition.

Reject generic regional substitutes, search thumbnails, watermarks, unattributed reposts, mismatched performances, and visually attractive images whose locality is uncertain. For example, a 吴川飘色 cue requires verified 吴川飘色 imagery, not generic 广东民俗, 醒狮, or another city's 飘色.

Record region, cue text, subject, title, creator, source URL, license, access date, original dimensions, crop, confidence, and rejection notes in the photo manifest. If no lawful exact image is available, use a verified site/artifact/map-led treatment and document the gap; do not silently substitute AI imagery.

## Photo timing and placement

- Use word-level timings. Begin the photo 0.2–0.4 seconds before the named subject is spoken, keep it through the relevant sentence, and fade it out once.
- Show one dominant photo at a time. Avoid rapid slideshows and unrelated decorative images.
- Evaluate top-left, top-right, mid-left, and mid-right candidates against the selected boundary bbox, labels, highlighted physical features, top title, and subtitle safe zone.
- Choose the lowest-collision negative-space position. In landscape, prefer about 28–34% canvas width and 24–38% height; reduce or relocate it when the map subject occupies that area.
- Keep the map visible. Use a restrained crop, thin border, subtle shadow, and at most a very slow 1–2% scale drift. Do not recreate the removed fact-card layout or cover subtitles.

## Named rivers, mountains, and other features

Create a feature manifest for every narrated physical or human-geography feature. Store stable ID, official name, aliases, type, geometry path, source, CRS, label point, confidence, narration cues, and display style.

- Rivers: use verified line or polygon geometry, not only a text label. Show the relevant reach plus enough upstream/downstream context to explain flow. Use a steady blue/cyan line, subtle halo, one-time directional reveal, and a readable label.
- Mountains and ridges: use verified point, ridge, or area geometry appropriate to the claim. Use a restrained earth-tone contour/ridge highlight and label. Do not imply 3D terrain when only an ellipsoid is rendered.
- Lakes, bays, seas, islands, passes, roads, railways, ports, and settlements: choose geometry and symbols that match the real feature type.
- Reveal a feature when its name or role is spoken, hold it for the explanatory sentence, then either retain it as context or fade it once. Never blink, pulse repeatedly, or animate unrelated features.
- Example: when narration says 鉴江流经吴川, draw and label the verified 鉴江 reach through 吴川, keep the 吴川 boundary legible, and avoid placing the 飘色 photo over the river line or label.

## Evidence-to-cue contract

Every storyboard scene must connect `narrationCueIds` to zero or more `featureIds` and `photoAssetIds`. A named concrete feature or cultural subject without mapped visual evidence is a QA warning; it becomes an error when the storyboard marks it as required.
