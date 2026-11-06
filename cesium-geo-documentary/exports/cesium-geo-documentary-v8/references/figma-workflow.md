# Figma workflow

Load `figma-use` before every Figma write. Load `figma-generate-design` for complete screens or multi-section templates, `figma-generate-library` for variables/components, and `figma-create-new-file` before creating a file.

The connected premium design source is:

- file: `地理图说 Premium Map System`
- file key: `3o7fht8p72Aog2YnRzph5n`
- URL: `https://www.figma.com/design/3o7fht8p72Aog2YnRzph5n`
- workspace: `xu yaoting's team`

Create or update variables before components. Reuse the existing Primitives, Color, Geometry, and Motion collections and the component sets mapped in `design/figma-node-map.json`:

- Map Title
- Region Label
- Subtitle
- Boundary State

Keep the five boundary variants: Parent, Context, Selected, Previous, Supplemental. Their documentation must explicitly prohibit altitude offsets, extrusion, glow, pulse, and repeated tracing.

Use Auto Layout, named layers, variants, component properties, and bound semantic variables. Load every required font before creating or changing text. Return every created or mutated node ID, work incrementally, and inspect metadata plus screenshots after meaningful changes.

Figma OPACITY float variables use `0–100`. Web/Cesium opacity uses `0–1`; divide by 100 during implementation. When binding paints, use the resolved RGBA value as the fallback paint before attaching the semantic color variable.

Keep `design/tokens.json`, `design/DESIGN.md`, `design/figma-node-map.json`, and the Figma file synchronized. If Figma is unavailable, preserve production progress with those files and clearly mark node IDs as pending rather than inventing IDs.
