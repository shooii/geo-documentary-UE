import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

interface ManifestAsset {
  assetId: string;
  regionId: string;
  purpose: string;
  prompt: string;
  outputPath: string;
  status: string;
  [key: string]: unknown;
}

const root = resolve(process.cwd());
const manifestPath = resolve(root, "assets/generated/imagegen-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { assets: ManifestAsset[]; [key: string]: unknown };
const regionMaster = JSON.parse(await readFile(resolve(root, "content/regions.zh-CN.json"), "utf8")) as Record<string, { name: string }>;
const finalDir = resolve(root, "assets/generated/images");
const thumbDir = resolve(root, "assets/generated/thumbnails");
const manualRejections: Record<string, string> = {
  "440811": "Generated scene depicts a large stratovolcano eruption, inconsistent with a low-relief maar formation explanation",
  "440882": "Generated architecture contains unreadable pseudo-text on vertical inscriptions"
};
await mkdir(finalDir, { recursive: true });
await mkdir(thumbDir, { recursive: true });

for (const asset of manifest.assets) {
  const source = resolve(root, `tmp/imagegen/${asset.assetId}.jpeg`);
  const output = resolve(root, asset.outputPath);
  const thumbnail = resolve(thumbDir, `${asset.assetId}.jpg`);
  const rejection = manualRejections[asset.regionId];
  if (existsSync(source) && !rejection) {
    await sharp(source)
      .resize(1280, 720, { fit: "cover", position: "centre" })
      .png({ compressionLevel: 8 })
      .toFile(output);
    await sharp(output).resize(480, 270, { fit: "cover" }).jpeg({ quality: 78 }).toFile(thumbnail);
    asset.status = "generated";
    asset.model = "gpt-image-2";
    asset.quality = "low";
    asset.relay = true;
    asset.hedges = 3;
    asset.finalSize = "1280x720";
    asset.thumbnailPath = `assets/generated/thumbnails/${asset.assetId}.jpg`;
  } else {
    const regionName = regionMaster[asset.regionId]?.name ?? asset.regionId;
    const statusLine = rejection ? "ImageGen 画面未通过事实/文字 QA · 使用地图画面替代" : "ImageGen 未完成 · 使用 Cesium 地图画面替代";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#081017"/><stop offset="1" stop-color="#172531"/></linearGradient></defs>
      <rect width="1280" height="720" fill="url(#g)"/>
      <path d="M0 540 C260 460 420 620 700 520 S1060 420 1280 510 L1280 720 L0 720 Z" fill="#4AA8FF" opacity=".16"/>
      <circle cx="1060" cy="150" r="120" fill="none" stroke="#FFD166" stroke-width="3" opacity=".55"/>
      <text x="80" y="280" fill="#F4F7F9" font-size="72" font-family="Microsoft YaHei, sans-serif" font-weight="700">${regionName}</text>
      <text x="82" y="360" fill="#B8C5CE" font-size="34" font-family="Microsoft YaHei, sans-serif">${statusLine}</text>
      <text x="82" y="620" fill="#FFB703" font-size="24" font-family="Microsoft YaHei, sans-serif">非历史影像 · 不作事实材料</text>
    </svg>`;
    await sharp(Buffer.from(svg)).png().toFile(output);
    await sharp(output).resize(480, 270).jpeg({ quality: 78 }).toFile(thumbnail);
    asset.status = rejection ? "placeholder-qa-rejected" : "placeholder-generation-failed";
    asset.failure = rejection ?? "Two three-request relay waves timed out without a valid image";
    asset.finalSize = "1280x720";
    asset.thumbnailPath = `assets/generated/thumbnails/${asset.assetId}.jpg`;
  }
}

manifest.processedAt = "2026-07-26";
await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
process.stdout.write(`Processed ${manifest.assets.length} image assets\n`);
