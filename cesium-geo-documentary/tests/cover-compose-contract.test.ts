import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { transformSync } from "esbuild";
import { generateCoverAsset, resolveCoverDefinition } from "../.agents/skills/cesium-geo-documentary/scripts/cover.js";

const root = process.cwd();
const coverSourcePath = resolve(root, ".agents/skills/cesium-geo-documentary/scripts/cover.ts");
const productionRegionId = "440823105";
const backgroundAsset = "design/generated/midnight-globe-cover-background.png";
const emblemAsset = "design/generated/midnight-globe-emblem.png";

function extractCoverOverlaySource(source: string): string {
  const start = source.indexOf("function coverOverlaySvg");
  const end = source.indexOf("export async function generateCoverAsset", start);
  assert.notEqual(start, -1, "coverOverlaySvg must remain present");
  assert.notEqual(end, -1, "generateCoverAsset must follow coverOverlaySvg");
  return source.slice(start, end);
}

test("cover metadata remains globally location-neutral and resolves the production hierarchical title", async () => {
  const definition = await resolveCoverDefinition(root, productionRegionId);
  assert.equal(definition.topic, "遂溪县江洪镇");
  assert.equal(definition.hierarchicalTitle, "地理乡土情·遂溪县江洪镇");
  assert.equal(definition.coverImagePath, "renders/final/covers/地理乡土情·遂溪县江洪镇-cover.png");
  assert.equal(definition.coverIntroSeconds, 1.4);

  const source = await readFile(coverSourcePath, "utf8");
  assert.doesNotMatch(source, /广东省|湛江市|遂溪县|江洪镇|河头镇|和安镇|新寮镇/);
  assert.match(source, /data\/regions\/\$\{regionId\}\.json/);
  assert.match(source, /content\/covers\/\$\{regionId\}\.json/);
  assert.match(source, /const hierarchicalTitle = `地理乡土情·\$\{topic\}`/);
});

test("deep-navy cover SVG exposes only the approved Chinese typography contract", async () => {
  const source = await readFile(coverSourcePath, "utf8");
  const overlaySource = extractCoverOverlaySource(source);

  assert.match(overlaySource, /width="1080" height="1920" viewBox="0 0 1080 1920"/);
  assert.doesNotMatch(overlaySource, /definition\.(?:regionPath|seriesIndex|issue|footerLabel)/);
  assert.doesNotMatch(overlaySource, /GEOGRAPHY|PORTRAIT|9\s*[:：]\s*16/i);
  assert.match(overlaySource, />地理乡土情<\/text>/);
  assert.match(overlaySource, /escapeXml\(definition\.contentMeta\)/);
});

test("cover generator uses the generated globe assets and exports 1080 by 1920 PNG", async () => {
  const directory = await mkdtemp(join(tmpdir(), "geo-cover-"));
  try {
    const definition = await resolveCoverDefinition(root, productionRegionId);
    const output = await generateCoverAsset(root, definition, join(directory, "cover.png"));
    const [metadata, backgroundMetadata, emblemMetadata, sidecarSource, source] = await Promise.all([
      sharp(output).metadata(),
      sharp(resolve(root, backgroundAsset)).metadata(),
      sharp(resolve(root, emblemAsset)).metadata(),
      readFile(`${output}.json`, "utf8"),
      readFile(coverSourcePath, "utf8")
    ]);
    const sidecar = JSON.parse(sidecarSource) as Record<string, unknown>;

    assert.equal(metadata.width, 1080);
    assert.equal(metadata.height, 1920);
    assert.equal(metadata.format, "png");
    assert.equal(backgroundMetadata.format, "png");
    assert.equal(emblemMetadata.format, "png");
    assert.equal(sidecar.width, 1080);
    assert.equal(sidecar.height, 1920);
    assert.equal(sidecar.backgroundAsset, backgroundAsset);
    assert.equal(sidecar.logoAsset, emblemAsset);
    assert.equal(sidecar.hierarchicalTitle, "地理乡土情·遂溪县江洪镇");
    assert.match(source, /resolve\(root, "design\/generated\/midnight-globe-cover-background\.png"\)/);
    assert.match(source, /resolve\(root, "design\/generated\/midnight-globe-emblem\.png"\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("素材淡出与硬隐藏共享同一浮点终点，避免 50ms lint 边界误判", async () => {
  const source = await readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts"), "utf8");
  const motionSource = source.slice(source.indexOf("function entranceMotion("), source.indexOf("function resolveVisualTiming("));
  const { code } = transformSync(motionSource, { loader: "ts" });
  const motion = new Function(`${code}; return entranceMotion;`)() as (index: number, start: number, end: number, entrance?: string) => string;
  for (const entrance of ["fade", "bloom", "wipe", "rise", "blur"]) {
    for (const [start, end] of [[259.36, 270.775], [1, 1.5], [12.3456, 13.0987]]) {
      const output = motion(24, start!, end!, entrance);
      const exit = output.match(/\.to\("#visual-24",\{opacity:0,scale:\.965,duration:([\d.]+),ease:"power2\.in"\},([\d.]+)\)\.set\("#visual-24",\{opacity:0\},([\d.]+)\)/);
      assert.ok(exit, "必须保留淡出后的确定性硬隐藏");
      const fadeEnd = Number(exit[2]) + Number(exit[1]);
      const hardKillAt = Number(exit[3]);
      assert.equal(hardKillAt, fadeEnd);
      for (const boundary of [270.825, fadeEnd - 0.05, fadeEnd + 0.05]) {
        assert.equal(Math.abs(hardKillAt - boundary) <= 0.05, Math.abs(fadeEnd - boundary) <= 0.05);
      }
    }
  }
  assert.ok(Math.abs(270.425 + 0.35 - 270.825) <= 0.05);
  assert.ok(Math.abs(270.775 - 270.825) > 0.05);
});

test("HyperFrames composition offsets every timed layer and emits synchronized captions", async () => {
  const [source, validation] = await Promise.all([
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts"), "utf8"),
    readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/validate-delivery.ts"), "utf8")
  ]);
  assert.match(source, /compositionDuration = timelineDuration \+ offset/);
  assert.match(source, /data-start="\$\{offset\.toFixed\(3\)\}" data-duration="\$\{timelineDuration\.toFixed\(3\)\}"/);
  assert.match(source, /cue\.start \+ narrationOffset/);
  assert.match(source, /visual\.start \+ offset/);
  assert.match(source, /const hardKillAt = Number\(fixed\(exitAt\)\) \+ Number\(fixed\(exitDuration\)\)/);
  assert.match(source, /\.to\("\$\{id\}",\{opacity:0,scale:\.965,duration:\$\{fixed\(exitDuration\)\},ease:"power2\.in"\},\$\{fixed\(exitAt\)\}\)\.set\("\$\{id\}",\{opacity:0\},\$\{hardKillAt\}\);/);
  assert.match(source, /start = offset \+ localStart/);
  assert.match(source, /clipDuration = Math\.min\(50, compositionDuration - start\)/);
  assert.match(source, /writeOffsetCaptions/);
  assert.match(source, /with-cover/);
  assert.match(source, /coverIntroSeconds/);
  assert.match(source, /narrationOffset = offset \+ narrationStartSeconds/);
  assert.match(source, /narrationStartSeconds/);
  assert.match(source, /id="boundary-pen-audio"/);
  assert.match(source, /boundary-pen\.wav/);
  assert.match(validation, /compositionMetadata\.compositionDuration/);
  assert.match(validation, /allowedCoverSilenceSeconds/);
  assert.match(validation, /narrationStartSeconds/);
});
