# Narrative style

Use a professional, vivid documentary tone without tourism-advertising language. Establish the parent context and selected child location early, then connect physical setting, people, economy or livelihoods, historical sequence, culture, customs, language/dialect, characteristic food or produce, ecology, and contemporary development.

Keep one main idea per sentence and make each map movement, feature overlay, and photograph serve the narration. Avoid unsupported superlatives and encyclopedia-style lists. Include dates where sequence matters and years for changeable statistics.

Make the script interesting through evidence, not jokes. Give each child segment:

- one concrete opening hook tied to location or landscape;
- one geographic cause-and-effect connection, such as a river shaping settlement or a coast shaping industry;
- one memorable, verifiable historical or cultural detail;
- one concise connection to present-day life.

Use restrained wordplay or contrast only when it remains accurate and natural. Avoid forced humor, slogans, breathless praise, generic “人杰地灵”, and strings of scenic adjectives.

Build hometown recognition from specific observation rather than commands to feel emotion. Use verified details such as familiar roads, ferry or market rhythms, dialect phrases, wind over fields or coast, seasonal work, courtyards, kitchens, and exact local foods. Do not insert generic school bells, daily commute lines, or other stock nostalgia details without evidence. Never tell the audience to `想家`、`回家` or announce that the video is meant to make them nostalgic. Avoid deliberate tear-jerking, swelling emotional claims, and sentimental conclusions.

For each region where the data is meaningful, name the population type (`常住人口` or `户籍人口`) and year. Describe the economy with a dated GDP figure when an official value is available; otherwise use a dated, sourced industry or livelihood structure without inventing a number. At village and rural scales, prioritize settlement pattern, land use, water, roads, agriculture, crafts, migration, and services over unavailable macroeconomic indicators.

When using the seventh census, prefer the direct form `第七次人口普查，常住人口为……人`. Omit bureaucratic filler such as `在第七次人口普查口径下`. If the exact census figure cannot be verified, use a different dated official population fact rather than relabelling it as census data.

Separate locality-specific evidence from wider cultural context. For example, if 年例、游神或八音锣鼓 are verified for 徐闻或雷州半岛 but not for the target town, introduce them as the wider regional culture in which the town participates; do not state that a particular village holds the event every year.

For township or subdistrict topics, research notable local middle schools or equivalent secondary schools. Mention a school only when official education or school sources verify its exact name, location, role, and current status. Do not elevate an ordinary or unrelated school merely to fill a category.

Use school imagery literally. A campus gate may be described as a campus gate; an activity group may be described as that documented activity. Call an image a graduation photograph only when the source or visible evidence confirms an actual graduating cohort. If no verified graduation photograph exists, use a verified campus image or omit the image.

Preserve established food names exactly as published by reliable local sources. Never create a new dish name by combining plausible ingredients, and never make a township-specific claim from a generic county food image. If the exact named food and exact image cannot both be verified, omit the food image and keep only the supported broader context.

Never speak about missing polygons, unavailable roaming, AI generation, pipeline constraints, failed research, or data gaps. If a child cannot be shown reliably, omit the unsupported claim or restructure the route; preserve the limitation only in the external coverage/QA report.

Never describe the video-making mechanics in the ending. Avoid `巡游走完`、`镜头回到`、`视角恢复` and similar phrases. Let the map return silently to the parent overview; if a final line is editorially useful, speak it only after the camera locks and make it a concise locality observation.

When narration names a concrete river, mountain, bay, island, road, port, historical site, performance, or craft, write the exact official name and attach a visual-evidence ID in the storyboard. Time the sentence so viewers can read the map label or inspect the photo without rushing.

Create a pronunciation record for uncommon place names, polyphonic characters, ethnic names, and domain terms. Target duration from configured reading speed, then use the measured TTS duration for the final timeline.

Pronounce `圩` as `xū`. Add a pronunciation record for `市圩` and similar compounds, but keep visible subtitles natural and uncluttered unless disambiguation is editorially necessary.

## Formal narration production

- Default Mandarin documentary voice: `zh-CN-YunyangNeural` unless the user approves another premium voice.
- Start around `-4%` rate; keep the normal formal range near `-3%` to `-5%`. Do not speed up narration merely to fit an arbitrary timeline.
- Generate from canonical paragraph-separated narration so sentence punctuation and blank lines create natural pauses.
- Preserve a pronunciation map for place names and technical terms, and keep caption text identical to the canonical narration.
- Normalize the final mono 48 kHz WAV to about `-16 LUFS` integrated loudness with a true-peak target no higher than `-1.5 dBTP`.
- Formal mode must fail if premium/Edge narration fails. Windows SAPI is allowed only with an explicit draft flag and must be recorded as non-release-ready.
- Regenerate the child-tour timings, captions, compositions, and validation reports after any voice, rate, text, or pause change.
