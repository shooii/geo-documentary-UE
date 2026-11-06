import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface RegionContent {
  name: string;
  facts: Record<string, string>;
  narration: string[];
  sources: Array<{ claimId: string }>;
}

const root = resolve(process.cwd());
const master = JSON.parse(await readFile(resolve(root, "content/regions.zh-CN.json"), "utf8")) as Record<string, RegionContent>;
const regionFlag = process.argv.indexOf("--region");
const requested = regionFlag >= 0 ? process.argv[regionFlag + 1] : undefined;
const entries = requested ? [[requested, master[requested]]] as const : Object.entries(master);
const starts = [0, 8, 17, 26, 35, 44];
const durations = [8, 9, 9, 9, 9, 6];
const cameraActions = ["showParentOverview", "holdRegionCamera", "holdRegionCamera", "holdRegionCamera", "holdRegionCamera", "holdRegionCamera"];
const transitionsIn = ["stable-overview", "soft-card-fade", "soft-card-fade", "soft-card-fade", "soft-card-fade", "soft-card-fade"];

await mkdir(resolve(root, "content/storyboards"), { recursive: true });

for (const [regionId, content] of entries) {
  if (!content) throw new Error(`Unknown region ${regionId}`);
  if (content.narration.length !== 6) throw new Error(`Region ${regionId} must have exactly six narration paragraphs`);
  const titles = [`${content.name}全域定位`, "人口与聚落", "经济与产业", "历史沿革", "文化与民俗", "现代发展与总结"];
  const sourceKindByScene = ["location", "population", "economy", "history", "culture", "economy"];
  const scenes = content.narration.map((narration, index) => ({
    sceneId: `${regionId}-scene-${String(index + 1).padStart(2, "0")}`,
    title: titles[index],
    start: starts[index],
    duration: durations[index],
    narrationRef: `script:paragraph-${String(index + 1).padStart(2, "0")}`,
    narration,
    cesium: {
      cameraAction: cameraActions[index],
      regionId,
      layers: ["esri-world-imagery", "ellipsoid-terrain", "all-sibling-boundaries", "selected-region-fill"],
      highlight: { type: "persistent-sibling-lines-selected-fill", colorToken: "colors.boundaryPrimary" }
    },
    overlay: index === 1 ? { figmaComponent: "StatisticCard/Population", title: content.facts.population, body: content.facts.physical } : index === 2 ? { figmaComponent: "StatisticCard/Economy", title: content.facts.economy, body: content.facts.modern } : index === 3 ? { figmaComponent: "GeoFactCard/History", title: content.facts.history, body: narration } : index === 4 ? { figmaComponent: "CultureCard/Text", title: content.facts.culture, body: narration } : null,
    imagegen: { assetId: null, usage: null },
    subtitle: { text: narration, maxLines: 1, maxCharsPerLine: 26 },
    transitionIn: transitionsIn[index],
    transitionOut: index === content.narration.length - 1 ? "stable-map-close" : transitionsIn[index + 1],
    sources: [content.sources.find((source) => source.claimId.includes(`-${sourceKindByScene[index]}-`))?.claimId ?? content.sources[0]?.claimId],
    accessibility: `旁白说明${titles[index]}，地图高亮${content.name}，所有重要文字保持在安全区。`
  }));
  await writeFile(resolve(root, `content/storyboards/${regionId}.json`), JSON.stringify({ regionId, name: content.name, duration: 50, scenes }, null, 2), "utf8");
}

process.stdout.write(`Generated ${entries.length} storyboards\n`);
