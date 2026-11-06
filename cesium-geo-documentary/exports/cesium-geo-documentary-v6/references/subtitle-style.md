# Subtitle style

- Default to no more than two lines. When the user requests single-line subtitles, render exactly one line per cue and never emit `<br>`.
- Recommended single-line maximum: landscape 26 Chinese characters, portrait 14, square 18. Split longer narration into consecutive cues rather than shrinking text excessively.
- Preserve all narration text; split a long sentence into consecutive timed cues instead of truncating it.
- Prefer punctuation boundaries and keep proper nouns intact.
- Derive split timing from word timestamps when available; otherwise divide the parent cue proportionally and round through shared millisecond boundaries.
- Use a high-contrast outline or translucent dark background.
- Keep subtitles inside the profile safe zone and away from important map labels.
- In single-line mode, validate every rendered subtitle clip has exactly one line and no leading punctuation.

Regenerate captions after any narration change. Validate concatenated composition caption text against the source cue text.
