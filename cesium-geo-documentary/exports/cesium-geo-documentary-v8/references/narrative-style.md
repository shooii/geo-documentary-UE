# Narrative style

Use a professional, vivid documentary tone without tourism-advertising language. Establish the parent context and selected child location early, then connect physical setting, people, economy or livelihoods, historical sequence, culture, and contemporary development.

Keep one main idea per sentence and make each map movement, feature overlay, and photograph serve the narration. Avoid unsupported superlatives and encyclopedia-style lists. Include dates where sequence matters and years for changeable statistics.

Make the script interesting through evidence, not jokes. Give each child segment:

- one concrete opening hook tied to location or landscape;
- one geographic cause-and-effect connection, such as a river shaping settlement or a coast shaping industry;
- one memorable, verifiable historical or cultural detail;
- one concise connection to present-day life.

Use restrained wordplay or contrast only when it remains accurate and natural. Avoid forced humor, slogans, breathless praise, generic “人杰地灵”, and strings of scenic adjectives.

For each region where the data is meaningful, name the population type (`常住人口` or `户籍人口`) and year. Describe the economy with a dated GDP figure when an official value is available; otherwise use a dated, sourced industry or livelihood structure without inventing a number. At village and rural scales, prioritize settlement pattern, land use, water, roads, agriculture, crafts, migration, and services over unavailable macroeconomic indicators.

When narration names a concrete river, mountain, bay, island, road, port, historical site, performance, or craft, write the exact official name and attach a visual-evidence ID in the storyboard. Time the sentence so viewers can read the map label or inspect the photo without rushing.

Create a pronunciation record for uncommon place names, polyphonic characters, ethnic names, and domain terms. Target duration from configured reading speed, then use the measured TTS duration for the final timeline.

## Formal narration production

- Default Mandarin documentary voice: `zh-CN-YunyangNeural` unless the user approves another premium voice.
- Start around `-4%` rate; keep the normal formal range near `-3%` to `-5%`. Do not speed up narration merely to fit an arbitrary timeline.
- Generate from canonical paragraph-separated narration so sentence punctuation and blank lines create natural pauses.
- Preserve a pronunciation map for place names and technical terms, and keep caption text identical to the canonical narration.
- Normalize the final mono 48 kHz WAV to about `-16 LUFS` integrated loudness with a true-peak target no higher than `-1.5 dBTP`.
- Formal mode must fail if premium/Edge narration fails. Windows SAPI is allowed only with an explicit draft flag and must be recorded as non-release-ready.
- Regenerate the child-tour timings, captions, compositions, and validation reports after any voice, rate, text, or pause change.
