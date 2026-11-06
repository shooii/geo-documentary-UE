# Social video and identity

## Primary portrait profile

- Default requested social delivery to 1080×1920, 30 fps, H.264/AAC, unless the user names another master format.
- Pass the active profile into the Cesium runtime and support `cameraProfiles.portrait` plus `portraitChildCameraScale` in region metadata.
- Frame the complete parent boundary to occupy roughly 62%–75% of the safe composition without clipping. Preserve enough surrounding coast, river, terrain, or settlement context to explain location.
- Keep the title inside a 64 px top safe margin and subtitles at least 118 px above the bottom. Review against 视频号、抖音、快手 UI overlays.

## Identity

- Use `design/assets/geo-documentary-mark.png` as the canonical Logo. It is a location-neutral pale-blue/mint globe mascot wearing a deep-teal headset microphone and holding a cartography pencil and map board inside a cream/mint circular badge. Preserve transparent edges and readability at 40–48 px.
- Replace decorative horizontal title rules with the Logo. Keep a restrained dark translucent capsule with a thin teal border.
- Use the exact title `地理图说·{hierarchicalTopicName}` with no spaces around the middle dot. A township/subdistrict title includes its county; a county/district title includes its prefecture/city. Mirror the same hierarchy on the production cover. Use Noto Sans SC/思源黑体 for Chinese and Roboto Flex for Latin letters/numbers.

## Universal cover master

- Keep one reusable `1080×1920` Figma component named `Video Cover / Portrait` with a location-neutral default state.
- Use generic editable fields: `地区名称`, `层级路径`, a concise content subtitle, series index, and issue label. Expose the hero map/image as an `INSTANCE_SWAP` property whenever possible.
- Never put a current project locality, administrative level, verified photo, or satellite image into the main component defaults. Create a production instance and replace fields there.
- Default to an editable abstract globe/graticule/topographic visual. Replace it with a verified map, satellite image, or locality image only for the production instance.
- Keep the topic name large enough to remain legible in social-platform thumbnails, while the brand lockup, hierarchy path, title, supporting line, and footer remain inside platform-safe areas.
- Keep visible brand artwork at least 64 px from the top and the cover footer at least 120 px from the bottom of a 1080×1920 canvas.
- Export the production instance to `renders/final/covers/` and embed it as the first 1.8–2.0 seconds of the final composition. Shift every timed media track and caption deliverable by the same offset.

## Evidence cards

- Keep one dominant card visible at a time. In portrait, use the full safe width, a rounded 28 px container, and a height near 780 px.
- Use a blurred/darkened background field behind a contained foreground for low-resolution or non-matching aspect images. Use cover mode for strong portrait or landscape images that crop safely.
- Label verified real images as `实景资料` when context needs clarification. Do not generate documentary local food, school, people, custom, building, or scenery cards. Abstract non-local systems may use a precise `示意` label only when editorially necessary.
- Do not cover the top title, bottom subtitle, current selected-region label, or the geographic feature being discussed.

## Motion review

- Sample the parent draw at 0.0, 0.35, 1.0, 1.8, 2.6, and 3.35 seconds; sample child fade at 3.15–4.9 seconds.
- Sample each child flight at start, 25%, midpoint, 75%, arrival, and hold. Confirm geodesic speed and the single height arc remain smooth with no sudden acceleration, apex plateau, or late zoom dive.
- Re-run non-linear seek tests after prewarming; frame 0 after a later seek must match a clean initial load.
