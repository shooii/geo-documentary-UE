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

Bind Parent to deep wine red `#8B1E1E`, Context to cool white `#E8F0F5`, and Selected to gold `#FFD166`. Parent and Selected must never share the same semantic color. Document the stable-context-line rule that prevents black, blank, or white flashes during selection handoffs.

Replace the Map Title accent line with `design/assets/geo-documentary-mark.png`. The canonical mark is the location-neutral headset-globe mascot derived from the approved reference: pale-blue globe, mint land, deep-teal headset/microphone, cartography pencil, map board, and cream/mint circular badge. Use the mark for both Landscape and Portrait variants and preserve the title format `地理图说·{hierarchicalTopicName}`.

Maintain a location-neutral 1080×1920 cover master. Its reusable defaults must be `地区名称`, `层级路径`, `看见边界，也看见土地上的生活`, and a swappable abstract globe/map visual. Never bake the active locality, administrative level, or a topic-specific satellite image into the main component. Apply real locality content only to a component instance for a specific production.

Export each production instance as PNG and configure it as the first 1.8–2.0 seconds of the final video. A standalone cover file without an embedded opening does not pass delivery QA.

For the connected premium file, treat legacy Logo nodes `50:2` and `50:8` as superseded. Keep the canonical mascot component `72:10`, horizontal lockup `75:2`, abstract cover visual `76:12`, portrait cover `80:2`, semantic boundary variables `VariableID:3:6` through `VariableID:3:8`, and portrait showcase root `51:43` synchronized through `design/figma-node-map.json`. The legacy graticule children under `72:10` may remain hidden for reversibility. The portrait map and evidence image targets are `51:44` and `51:55`; after transferring image hashes, screenshot the full portrait root and audit the target fills before declaring the design complete.

Use Auto Layout, named layers, variants, component properties, and bound semantic variables. Load every required font before creating or changing text. Return every created or mutated node ID, work incrementally, and inspect metadata plus screenshots after meaningful changes.

Figma OPACITY float variables use `0–100`. Web/Cesium opacity uses `0–1`; divide by 100 during implementation. When binding paints, use the resolved RGBA value as the fallback paint before attaching the semantic color variable.

Keep `design/tokens.json`, `design/DESIGN.md`, `design/figma-node-map.json`, and the Figma file synchronized. If Figma is unavailable, preserve production progress with those files and clearly mark node IDs as pending rather than inventing IDs.
