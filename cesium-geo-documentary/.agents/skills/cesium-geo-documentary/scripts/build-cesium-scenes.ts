import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SceneTimelineSchema } from "../../../../packages/timeline-schema/index.js";

interface RegionContent { facts: Record<string, string> }
const root = resolve(process.cwd());
const master = JSON.parse(await readFile(resolve(root, "content/regions.zh-CN.json"), "utf8")) as Record<string, RegionContent>;
const regionFlag = process.argv.indexOf("--region");
const requested = regionFlag >= 0 ? process.argv[regionFlag + 1] : undefined;
const entries = requested ? [[requested, master[requested]]] as const : Object.entries(master);

for (const [regionId, content] of entries) {
  if (!content) throw new Error(`Unknown region ${regionId}`);
  const regionPath = resolve(root, `data/regions/${regionId}.json`);
  const timelinePath = resolve(root, `data/regions/${regionId}.timeline.json`);
  const region = JSON.parse(await readFile(regionPath, "utf8")) as Record<string, unknown>;
  if (region.presentationMode === "parent-child-tour" && Array.isArray(region.tourStops)) {
    region.storyFacts = content.facts;
    await writeFile(regionPath, JSON.stringify(region, null, 2), "utf8");
    continue;
  }
  const topicActions = [
    { id: "population-01", time: 8, duration: 9, type: "showPopulation", target: regionId, easing: "linear" },
    { id: "economy-01", time: 17, duration: 9, type: "showEconomy", target: regionId, easing: "linear" },
    { id: "history-01", time: 26, duration: 9, type: "showHistory", target: regionId, easing: "linear" },
    { id: "culture-01", time: 35, duration: 9, type: "showCulture", target: regionId, easing: "linear" },
    { id: "summary-01", time: 44, duration: 6, type: "showSummary", target: regionId, easing: "linear" }
  ];
  const timeline = region.presentationMode === "parent-topic" ? {
    duration: 50,
    actions: [
      { id: "camera-approach", time: 0, duration: 6, type: "flyToRegion", target: regionId, easing: "cubicInOut" },
      { id: "parent-outline", time: 0.35, duration: 3.0, type: "revealParentBoundary", target: regionId, easing: "sineInOut" },
      { id: "child-boundaries", time: 3.15, duration: 1.35, type: "fadeChildBoundaries", target: regionId, easing: "sineInOut" },
      { id: "selected-fill", time: 3.55, duration: 1.25, type: "fadeSelectedFill", target: regionId, easing: "sineInOut" },
      { id: "camera-hold", time: 6, duration: 44, type: "holdRegionCamera", target: regionId, easing: "linear" },
      ...topicActions
    ]
  } : region.level === "prefecture" || region.levelRole === "admin2" ? {
    duration: 50,
    actions: [
      { id: "overview-01", time: 0, duration: 50, type: "showParentOverview", target: regionId, easing: "linear" },
      ...topicActions
    ]
  } : {
    duration: 50,
    actions: [
      { id: "overview-01", time: 0, duration: 2, type: "showParentOverview", target: String(region.parentId), easing: "linear" },
      { id: "camera-01", time: 0, duration: 8, type: "flyToRegion", target: regionId, easing: "cubicInOut" },
      { id: "fill-01", time: 1.2, duration: 6.2, type: "fadeSelectedFill", target: regionId, easing: "cubicInOut" },
      { id: "hold-01", time: 8, duration: 42, type: "holdRegionCamera", target: regionId, easing: "linear" },
      ...topicActions
    ]
  };
  SceneTimelineSchema.parse(timeline);
  region.storyFacts = content.facts;
  await writeFile(regionPath, JSON.stringify(region, null, 2), "utf8");
  await writeFile(timelinePath, JSON.stringify(timeline, null, 2), "utf8");
}

process.stdout.write(`Validated and enriched ${entries.length} Cesium timelines\n`);
