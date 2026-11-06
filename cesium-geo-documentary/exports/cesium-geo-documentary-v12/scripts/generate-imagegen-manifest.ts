import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface RegionContent { name: string; imagePromptTheme: string }
const root = resolve(process.cwd());
const master = JSON.parse(await readFile(resolve(root, "content/regions.zh-CN.json"), "utf8")) as Record<string, RegionContent>;
const promptDir = resolve(root, "assets/generated/prompts");
await mkdir(promptDir, { recursive: true });
await mkdir(resolve(root, "assets/generated/images"), { recursive: true });

const assets = [];
for (const [regionId, content] of Object.entries(master)) {
  const prompt = [
    `为湛江市${content.name}地理纪录片生成一张16:9电影感编辑插画。`,
    `主题：${content.imagePromptTheme}。`,
    "用途：文化或历史章节画中画素材，不能替代真实地图、行政边界或统计数据。",
    "构图：主要人物或建筑位于画面两侧，中下部保持低视觉密度，为中文字幕安全区留白；使用中远景与环境叙事。",
    "光线：温暖清晨或傍晚侧光，真实材质，低饱和岭南海岸色彩。",
    "风格：高质量中国地理纪录片概念艺术，克制、写实、编辑插画，不做游戏海报。",
    "必须避免：现代错误物件、错误年代服饰、乱码文字、虚构官方标志、行政边界地图、争议领土表达、畸形人物肢体。",
    "画面中不出现任何文字。该素材为艺术化复原，成片必须标记“AI 艺术化复原”，不可作为真实历史照片使用。"
  ].join("\n");
  const asset = {
    assetId: `${regionId}-culture-001`,
    regionId,
    purpose: `${content.name}历史文化章节辅助画面`,
    prompt,
    aspectRatio: "16:9",
    style: "cinematic editorial illustration",
    factualStatus: "artistic-reconstruction",
    usage: "picture-in-picture",
    creditLabel: "AI艺术化复原",
    outputPath: `assets/generated/images/${regionId}-culture-001.png`,
    status: "planned"
  };
  assets.push(asset);
  await writeFile(resolve(promptDir, `${asset.assetId}.txt`), `${prompt}\n`, "utf8");
}

await writeFile(resolve(root, "assets/generated/imagegen-manifest.json"), JSON.stringify({ generatedAt: "2026-07-26", assets }, null, 2), "utf8");
process.stdout.write(`Generated ${assets.length} ImageGen prompts\n`);
