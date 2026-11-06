# Subtitle style

- Preserve Arabic digits exactly as written in canonical narration. Years, dates, population, area, distance, money, percentages, yields, and counts must remain forms such as `2024年`、`3.7万人`、`22公里` and `17亿元`; never convert them to Chinese-number words for display.

- Default to no more than two lines. When the user requests single-line subtitles, render exactly one line per cue and never emit `<br>`.
- Hard single-line maximum: landscape 26 Chinese characters, portrait 14, square 18. Prefer balanced working lengths of roughly 18–22, 9–12, and 13–16 respectively; use the full maximum only when a complete phrase requires it.
- Preserve all narration text; split a long sentence into consecutive timed cues instead of truncating it.
- Prefer complete spoken phrases over raw character counts. Keep proper nouns intact and treat Arabic or Chinese number/classifier/unit expressions as indivisible tokens, including `43210人`, `三万四千二百四十七人`, `79.52万人`, `3.2万亩`, `二零二五年`, `179.19千米`, and `七点六二亿元`.
- Build `subtitleProtectedPhrases` for every topic from the hierarchical title, parent name, direct-child names, verified schools, exact foods or products, dialect names, institutions, historical terms, and recurring lexical compounds. Load the lexicon in both subtitle generation and composition. Each protected phrase that fits the hard limit must appear wholly within one cue; never split a two-character word merely to balance lengths.
- Keep fixed statistical and administrative labels intact, including `常住人口`、`户籍人口`、`城镇人口`、`地区生产总值`、`农林牧渔业总产值`、`行政村` and `自然村`. Never produce fragments such as `户籍人 / 口` or `生产总 / 值`.
- Never end one cue with the number and begin the next cue with `人`, `户`, `亩`, `年`, `元`, `公里`, or another unit. When the full measurement phrase fits the hard maximum, keep useful prefixes such as `常住人口`、`面积`、`海岸线`、`有`、`约有` with the value as well.
- Treat punctuation as secondary to speech meaning. Prefer punctuation boundaries when natural, but remove a comma, semicolon, colon, or enumeration comma at a cue edge instead of showing a lone mark or forcing an incomplete phrase. Validation may normalize optional punctuation, but must preserve every spoken word, number, classifier, and unit.
- Derive split timing from word timestamps when available; otherwise divide the parent cue proportionally and round through shared millisecond boundaries.
- Use a high-contrast outline or translucent dark background.
- Use `Noto Sans SC` first, with Source Han Sans SC and Microsoft YaHei only as fallbacks. Use Roboto Flex for Latin letters and numbers when separate styling is available.
- Formal subtitle sizes: landscape 42 px, portrait 44 px, square 40 px. Use a 10 px background radius, compact 10 px vertical padding, and no glow.
- Keep subtitles inside the profile safe zone and away from important map labels.
- In single-line mode, validate every rendered subtitle clip has exactly one line and no leading punctuation.
- Rebalance short tail fragments after semantic splitting. In portrait mode, avoid one- to three-character orphan cues such as `业` or `人`; redistribute the final two chunks so each normally contains at least four visible characters while remaining within the 14-character hard limit.
- Treat length checks as necessary but not sufficient. Read every final cue sequence aloud and reject technically valid splits that attach the first word of a new phrase to the previous cue, such as `也是餐桌滋味，清蒸 / 烤制……`, or separate a verb from its completion.
- When automatic splitting still sounds mechanical, write a profile-specific reviewed override at `content/subtitle-overrides/{regionId}-{profile}.json`. Store source-cue indices and complete `chunks`; allow punctuation to be omitted, but require normalized concatenated text to equal the spoken source and every chunk to stay within the profile maximum. Keep this as a reusable escape hatch, not as permission to alter narration words.
- Omit terminal punctuation from clean single-line portrait cues. Retain only internal punctuation that materially improves a list or clause.

Regenerate captions after any narration change. Validate concatenated composition caption text against the source cue after normalizing optional punctuation; exact spoken semantic text must remain unchanged.
