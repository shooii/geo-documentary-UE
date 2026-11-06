# Thematic visual evidence

## Reject government-work substitutes

An official publisher does not make every photograph editorially useful. Reject meetings, training sessions, inspections, research visits, briefings, signing ceremonies, office scenes, banner-heavy posed groups, and officials lecturing to a room. Do not use a pineapple-training photograph to illustrate pineapples, a food-safety inspection to illustrate a school, a port inspection to illustrate fishing, or a village meeting to illustrate village life.

For agriculture and food, show the crop, field, harvest, product, cooking, market, or eating scene itself. For fishing, show the coast, harbor, boats, landing, catch, fish market, or working waterfront itself. For schools, accept only a clearly verified campus exterior/interior or a photograph whose source or visible evidence confirms a graduating class/cohort. School inspections, official visits, meetings, lectures by visiting departments, awards, teacher-day慰问, and generic activity groups are hard rejects.

## Exact real photographs for history and culture

Treat a real, locality-specific image as required visual evidence when narration names a concrete historical site, artifact, event, performance, custom, craft, food tradition, costume, or festival and a lawful reusable image exists.

Apply the same exactness to child-region and school imagery. When a verified image belongs to a particular village/community, place it inside that child's segment and extend the hold long enough to explain what is actually visible. A school group image is not a graduation photograph unless its source or visual evidence confirms a graduating cohort.

Rank candidates by:

1. exact locality;
2. exact narrated subject;
3. correct period, event, or cultural form;
4. authoritative description and reusable license;
5. original resolution, visual clarity, and useful composition.

Reject generic regional substitutes, search thumbnails, watermarks, unattributed reposts, mismatched performances, and visually attractive images whose locality is uncertain. For example, a 吴川飘色 cue requires verified 吴川飘色 imagery, not generic 广东民俗, 醒狮, or another city's 飘色.

For food, preserve the exact established source name. Reject invented compound names, renamed ingredient combinations, and a similar-looking dish from another locality.

Record region, cue text, subject, title, creator, source URL, license, access date, original dimensions, crop, confidence, and rejection notes in the photo manifest. If no lawful exact image is available, use a verified site/artifact/map-led treatment and document the gap; do not silently substitute AI imagery.

## Photo timing and placement

- Use word-level timings. Begin the photo 0.2–0.4 seconds before the named subject is spoken, keep it through the relevant sentence, and fade it out once.
- Show one dominant photo at a time. Avoid rapid slideshows and unrelated decorative images.
- Evaluate top-left, top-right, mid-left, and mid-right candidates against the selected boundary bbox, labels, highlighted physical features, top title, and subtitle safe zone.
- Choose the lowest-collision negative-space position. In landscape, prefer about 28–34% canvas width and 24–38% height; reduce or relocate it when the map subject occupies that area.
- Keep the map visible. Use a restrained crop, thin border, subtle shadow, and at most a very slow 1–2% scale drift. Do not recreate the removed fact-card layout or cover subtitles.

## Named rivers, mountains, and other features

Create a feature manifest for every narrated physical or human-geography feature. Store stable ID, official name, aliases, type, geometry path, source, CRS, label point, confidence, narration cues, and display style.

- `data/features/{id}.geojson` may be either a single `Feature` (what `fetch-named-feature.mjs` writes, and the right shape when one feature has one stitched geometry) or a `FeatureCollection`. The runtime normalizes both through one list; reading `collection.features` directly silently draws nothing for the single-`Feature` case, which looks identical to a successful fetch.

- Rivers: use verified line or polygon geometry, not only a text label. Show the relevant reach plus enough upstream/downstream context to explain flow. Use a steady blue/cyan line, subtle halo, one-time directional reveal, and a readable label.
- Mountains and ridges: use verified point, ridge, or area geometry appropriate to the claim. Use a restrained earth-tone contour/ridge highlight and label. Do not imply 3D terrain when only an ellipsoid is rendered.
- Lakes, bays, seas, islands, passes, roads, railways, ports, and settlements: choose geometry and symbols that match the real feature type.
- Reveal a feature when its name or role is spoken, hold it for the explanatory sentence, then either retain it as context or fade it once. Never blink, pulse repeatedly, or animate unrelated features.
- Example: when narration says 鉴江流经吴川, draw and label the verified 鉴江 reach through 吴川, keep the 吴川 boundary legible, and avoid placing the 飘色 photo over the river line or label.

## Evidence-to-cue contract

Every storyboard scene must connect `narrationCueIds` to zero or more `featureIds` and `photoAssetIds`. A named concrete feature or cultural subject without mapped visual evidence is a QA warning; it becomes an error when the storyboard marks it as required.

For every new formal photo clip, store `narrationCueIndex`, optional `narrationCueEndIndex`, and `requiredKeywords` in `content/visuals/{regionId}.json`. The indices refer to measured provider sentence cues, not subtitle fragments and not estimated script seconds. Resolve entry 0.2–0.4 seconds before the cue, retain the image through the cue end, and permit no more than 0.75 seconds of tail. A narration, voice, rate, or pause change invalidates the resolved timing. Re-run TTS/caption measurement and composition so narration audio, subtitles, photos, and exported SRT/VTT all derive from the same clock.

Generate `renders/diagnostics/{regionId}-{profile}-visual-sync.json` for release. It must record the bound cue text, keywords, audio-relative cue interval, map-relative resolved interval, final composition interval, coverage ratio, and pass/fail. Missing cue indices, absent keywords, or incomplete cue coverage are hard failures.
