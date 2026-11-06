# Social video and identity

## Primary portrait profile

- Default requested social delivery to 1080×1920, 30 fps, H.264/AAC, unless the user names another master format.
- Pass the active profile into the Cesium runtime and support `cameraProfiles.portrait` plus `portraitChildCameraScale` in region metadata.
- Frame the complete parent boundary to occupy roughly 62%–75% of the safe composition without clipping. Preserve enough surrounding coast, river, terrain, or settlement context to explain location.
- Do not place a persistent title, brand capsule, logo, or locality label in the upper-left corner of the main program after the cover fades. Keep portrait subtitles at least 220 px above the bottom. Review against 视频号、抖音、快手 UI overlays.

## Identity

- Use `design/generated/midnight-globe-emblem.png` as the canonical cover Logo only. It is a location-neutral deep-navy/gold globe with a cartographer drawing a boundary. Crop it to a circle and preserve the gold rim at 40–48 px.
- Keep brand/title lockups on the cover. The main program is map-first and must not keep a top-left title capsule or Logo overlay.
- Use the exact title `地理乡土情·{hierarchicalTopicName}` with no spaces around the middle dot. A township/subdistrict title includes its county; a county/district title includes its prefecture/city. Mirror the same hierarchy on the production cover. Use Noto Sans SC/思源黑体 for Chinese and Roboto Flex for Latin letters/numbers.

## Universal cover master

- Keep one reusable `1080×1920` Figma component named `Video Cover / Portrait` with a location-neutral default state.
- Use generic editable fields: `地区名称`, a concise Chinese subtitle, `地理 · 人文 · 时代`, and the hero visual. Expose the hero map/image as an `INSTANCE_SWAP` property whenever possible.
- Never put a current project locality, administrative level, verified photo, or satellite image into the main component defaults. Create a production instance and replace fields there.
- Default to the approved location-neutral deep-navy/gold Asia-globe and road-light background. Replace it only when another approved location-neutral master is explicitly selected.
- Keep the topic name large enough to remain legible in social-platform thumbnails, while the brand lockup, title, supporting line, and Chinese content-meta remain inside platform-safe areas. Never show hierarchy-path chips, English copy, issue codes, or aspect-ratio badges.
- Keep visible brand artwork at least 64 px from the top and the cover footer at least 120 px from the bottom of a 1080×1920 canvas.
- Export the production instance to `renders/final/covers/` and embed it as the first 1.4–1.8 seconds of the final composition so the cover plus cloud-penetration descent stays within five seconds. Shift every timed media track and caption deliverable by the same offset.

## Evidence cards

- Keep one dominant card visible at a time. In portrait, use the full safe width, a rounded 28 px container, and a height near 780 px.
- Use a blurred/darkened background field behind a contained foreground for low-resolution or non-matching aspect images. Use cover mode for strong portrait or landscape images that crop safely.
- Label verified real images as `实景资料` when context needs clarification. Do not generate documentary local food, school, people, custom, building, or scenery cards. Abstract non-local systems may use a precise `示意` label only when editorially necessary.
- Do not cover the bottom subtitle, current selected-region label, or the geographic feature being discussed.

## Motion review

- Sample the parent draw at 0.0, 0.35, 1.0, 1.8, 2.6, and 3.35 seconds; sample child fade at 3.15–4.9 seconds.
- Sample each child flight at start, 25%, midpoint, 75%, arrival, and hold. Confirm geodesic speed and the single height arc remain smooth with no sudden acceleration, apex plateau, or late zoom dive.
- Re-run non-linear seek tests after prewarming; frame 0 after a later seek must match a clean initial load.
