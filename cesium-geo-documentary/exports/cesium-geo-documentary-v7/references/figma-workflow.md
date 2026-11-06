# Figma workflow

Load `figma-use` before any Figma write. Load `figma-generate-design` for complete screens or multi-section templates, and load `figma-create-new-file` before creating a file.

Create variables before components. Use Auto Layout, named components, variants, and bound tokens for title cards, labels, fact cards, timelines, culture cards, subtitles, source notes, AI reconstruction badges, transitions, and end cards. Include landscape and portrait variants.

Return changed node IDs and inspect screenshots after each step.

If no target Figma file is available, do not block production. Write `DESIGN.md`, `tokens.json`, `components-spec.md`, `figma-node-map.json`, and `figma-import-plan.md`, marking node IDs as pending connection.
