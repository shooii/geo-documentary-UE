/**
 * The child tour order a project should use, given where its villages sit.
 *
 * Sibling administrative divisions share boundaries, and a tour that steps
 * from one village into the next door one reads as a journey instead of a
 * search. Editors can already drag scenes into any order they like; this
 * answers the question they cannot answer by eye — which order is continuous.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildChildAdjacency,
  childBoundariesFromGeoJson,
  planTouchingRoute,
  restrictAdjacency,
  type PlannedBreak,
  type Position,
  type RouteStrategy
} from "../../packages/geo-utils/child-adjacency.js";
import type { VideoProject } from "../../packages/project-schema/index.js";

interface RegionRecord {
  name?: string;
  childGeometryPath?: string;
  childRegions?: Array<{ id: string; name?: string; labelPoint?: [number, number] }>;
}

export interface TourRouteSuggestion {
  regionId: string;
  regionName: string;
  /** The order to use, as child ids in visit order. */
  childIds: string[];
  /** How the plan was reached — `kept` means nothing needed changing. */
  strategy: RouteStrategy;
  /** Stops that had to move for the neighbour rule to hold. */
  editedStops: number;
  /** True when continuous adjacency required starting somewhere else. */
  startMoved: boolean;
  startId: string | undefined;
  /** Flights that cannot land next door, with the distance they cross. */
  breaks: PlannedBreak[];
  touchingBefore: number;
  touchingAfter: number;
  flights: number;
  changeNeeded: boolean;
}

/**
 * Plan a fully touching tour over the child scenes this project actually has.
 *
 * The project's own order is the starting point, so an order that already
 * works is returned untouched and an order that nearly works is nudged by as
 * little as possible rather than replaced.
 */
export async function suggestTourRoute(root: string, project: VideoProject): Promise<TourRouteSuggestion> {
  const regionId = String(project.regionId ?? "");
  if (!regionId) throw new Error("该方案没有关联的行政区，无法按边界接壤关系排序");
  const regionPath = resolve(root, `data/regions/${regionId}.json`);
  if (!existsSync(regionPath)) throw new Error(`缺少 ${regionId} 的行政区数据`);
  const region = JSON.parse(await readFile(regionPath, "utf8")) as RegionRecord;

  const geometryPath = resolve(root, region.childGeometryPath ?? `data/normalized/${regionId}-children.geojson`);
  if (!existsSync(geometryPath)) throw new Error(`${region.name ?? regionId} 缺少下级边界几何，无法判断接壤关系`);
  const geoJson = JSON.parse(await readFile(geometryPath, "utf8"));
  const full = buildChildAdjacency(childBoundariesFromGeoJson(geoJson));
  if (!full.ids.length) throw new Error(`${region.name ?? regionId} 的下级边界为空`);

  const currentOrder = project.scenes
    .filter((scene) => scene.section === "child" && scene.childId)
    .map((scene) => String(scene.childId));
  if (currentOrder.length < 2) throw new Error("至少需要两个下级行政区场景才能排序");
  const unknown = currentOrder.filter((id) => !full.neighbours.has(id));
  if (unknown.length) throw new Error(`方案的村级场景不在边界数据中：${unknown.join("、")}`);

  // A project may keep only some children; the route is planned over those.
  const scoped = currentOrder.length === full.ids.length ? full : restrictAdjacency(full, currentOrder);
  const points = new Map<string, Position>();
  for (const child of region.childRegions ?? []) {
    if (child.labelPoint) points.set(String(child.id), child.labelPoint);
  }

  const plan = planTouchingRoute(scoped, {
    points,
    preferOrder: currentOrder,
    startId: currentOrder[0]!,
    // The first village is where the film opens and where the narration starts,
    // so the neighbour rule may rearrange the rest of the visit but never the
    // opening stop. Without this the planner traded the opening away whenever
    // that was the cheapest way to keep every flight next door.
    pinOpening: true,
    timeBudgetMs: 4_000
  });

  const touching = (a: string, b: string): boolean => scoped.neighbours.get(a)?.has(b) ?? false;
  let touchingBefore = 0;
  for (let index = 1; index < currentOrder.length; index += 1) {
    if (touching(currentOrder[index - 1]!, currentOrder[index]!)) touchingBefore += 1;
  }

  return {
    regionId,
    regionName: region.name ?? regionId,
    childIds: plan.order,
    strategy: plan.strategy,
    editedStops: plan.editedStops,
    startMoved: plan.startMoved,
    startId: plan.order[0],
    breaks: plan.breaks,
    touchingBefore,
    touchingAfter: plan.touchingFlights,
    flights: Math.max(0, plan.order.length - 1),
    changeNeeded: currentOrder.join(",") !== plan.order.join(",")
  };
}
