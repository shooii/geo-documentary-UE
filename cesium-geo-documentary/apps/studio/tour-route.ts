/**
 * The child tour order a project should use, given where its villages sit.
 *
 * Sibling administrative divisions share boundaries, and a tour that steps
 * from one village into the next door one reads as a journey instead of a
 * search. Editors can already drag scenes into any order they like; this
 * answers the question they cannot answer by eye — which order is continuous.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildChildAdjacency,
  childBoundariesFromGeoJson,
  planTouchingRoute,
  restrictAdjacency,
  travelBetween,
  type PlannedBreak,
  type Position,
  type RouteStrategy
} from "../../packages/geo-utils/child-adjacency.js";
import type { VideoProject } from "../../packages/project-schema/index.js";
import { boundarySnapshotDir, BOUNDARY_SNAPSHOT_MANIFEST, BOUNDARY_SNAPSHOT_VERSION, resolveWorkspacePath, type BoundarySnapshotManifest } from "./boundary-snapshot.js";

async function routeDataRoot(root: string, project: VideoProject): Promise<string> {
  const frozenRoot = boundarySnapshotDir(root, project.id);
  if (!existsSync(frozenRoot)) return root;
  try {
    const manifest = JSON.parse(await readFile(resolve(frozenRoot, BOUNDARY_SNAPSHOT_MANIFEST), "utf8")) as BoundarySnapshotManifest;
    if (manifest.version !== BOUNDARY_SNAPSHOT_VERSION || manifest.projectId !== project.id || manifest.regionId !== project.regionId || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error("冻结清单身份不一致");
    const hash = createHash("sha256");
    const paths = new Set<string>();
    for (const entry of manifest.files) {
      const path = typeof entry.path === "string" ? resolveWorkspacePath(frozenRoot, entry.path) : null;
      if (!path || paths.has(entry.path)) throw new Error("冻结清单路径无效或重复");
      paths.add(entry.path);
    }
    // 与快照写入端使用相同的默认字典序和摘要格式。
    for (const relative of [...paths].sort()) {
      const bytes = await readFile(resolveWorkspacePath(frozenRoot, relative)!);
      if (bytes.length !== manifest.files.find(entry => entry.path === relative)!.bytes) throw new Error("冻结文件大小不一致");
      hash.update(relative); hash.update(bytes);
    }
    if (`sha256:${hash.digest("hex")}` !== manifest.digest) throw new Error("冻结摘要不一致");
    const regionRelative = `data/regions/${project.regionId}.json`;
    if (!paths.has(regionRelative)) throw new Error("冻结清单缺少行政区记录");
    const region = JSON.parse(await readFile(resolveWorkspacePath(frozenRoot, regionRelative)!, "utf8")) as RegionRecord;
    if (!paths.has(region.childGeometryPath ?? `data/normalized/${project.regionId}-children.geojson`)) throw new Error("冻结清单缺少下级边界");
    return frozenRoot;
  } catch (error) {
    throw new Error(`边界冻结快照损坏，拒绝回退到实时数据：${error instanceof Error ? error.message : "无法读取"}`);
  }
}

export interface TourRouteLeg {
  from: string;
  to: string;
  status: "touching" | "hop" | "unknown";
  travelMeters?: number;
}

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
  legs: TourRouteLeg[];
  unknownFlights: number;
  /** 所有实际航段均已确认接壤时才为 true。 */
  complete: boolean;
  changeNeeded: boolean;
  /** Child ids the project narrates but the child geometry has no polygon for. */
  unplacedIds?: string[];
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
  const currentOrder = project.scenes
    .filter((scene) => scene.section === "child" && scene.childId)
    .map((scene) => String(scene.childId));
  if (currentOrder.length < 2) throw new Error("至少需要两个下级行政区场景才能排序");
  if (new Set(currentOrder).size !== currentOrder.length) throw new Error("巡游 childId 重复，无法安全重排");
  const dataRoot = await routeDataRoot(root, project);
  const regionRelative = `data/regions/${regionId}.json`;
  const regionPath = resolveWorkspacePath(dataRoot, regionRelative);
  if (!regionPath) throw new Error("行政区路径无效");
  if (!existsSync(regionPath)) throw new Error(`缺少 ${regionId} 的行政区数据`);
  const region = JSON.parse(await readFile(regionPath, "utf8")) as RegionRecord;

  const geometryRelative = region.childGeometryPath ?? `data/normalized/${regionId}-children.geojson`;
  const geometryPath = resolveWorkspacePath(dataRoot, geometryRelative);
  if (!geometryPath) throw new Error("下级边界路径无效");
  if (!existsSync(geometryPath)) throw new Error(`${region.name ?? regionId} 缺少下级边界几何，无法判断接壤关系`);
  const geoJson = JSON.parse(await readFile(geometryPath, "utf8"));
  const full = buildChildAdjacency(childBoundariesFromGeoJson(geoJson));

  /* Villages with no entry in the boundary geometry cannot be judged for
     adjacency, but that is a data gap, not a reason to refuse the whole plan.
     龙门镇 440882112220 (宝蓄村) is exactly this case: it is a real village in the
     narration and in the 2017 roster, yet the normalised child geometry has no
     polygon for it. Refusing outright made the button unusable on any scheme
     containing it, so the geometry-backed villages are planned and the rest keep
     the slot they already occupy. */
  const known = currentOrder.filter((id) => full.neighbours.has(id));
  const unplacedIds = currentOrder.filter((id) => !full.neighbours.has(id));

  // A project may keep only some children; the route is planned over those.
  const scoped = known.length === full.ids.length ? full : restrictAdjacency(full, known);
  const points = new Map<string, Position>();
  for (const child of region.childRegions ?? []) {
    if (child.labelPoint) points.set(String(child.id), child.labelPoint);
  }

  const plan = planTouchingRoute(scoped, {
    points,
    preferOrder: known,
    startId: known[0]!,
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

  /* Put the geometry-less villages back where they already were. They are
     dropped from `plan.order` because the planner only reasons about villages
     it can see; dropping them from the returned order as well would make the
     caller's count check fail and silently discard a valid rearrangement. Each
     one goes back at its original index, so a scheme's editorial placement
     survives the re-plan. */
  const mergedOrder = [...plan.order];
  for (const [index, id] of currentOrder.entries()) {
    if (!unplacedIds.includes(id)) continue;
    mergedOrder.splice(Math.min(index, mergedOrder.length), 0, id);
  }

  const legs: TourRouteLeg[] = mergedOrder.slice(1).map((to, index) => {
    const from = mergedOrder[index]!;
    if (!scoped.neighbours.has(from) || !scoped.neighbours.has(to)) {
      return { from, to, status: "unknown" };
    }
    if (touching(from, to)) return { from, to, status: "touching" };
    return { from, to, status: "hop", travelMeters: travelBetween(points, from, to) };
  });
  const breaks: PlannedBreak[] = legs
    .filter((leg) => leg.status === "hop")
    .map((leg) => ({ from: leg.from, to: leg.to, travelMeters: leg.travelMeters! }));
  const touchingAfter = legs.filter((leg) => leg.status === "touching").length;
  const unknownFlights = legs.filter((leg) => leg.status === "unknown").length;

  return {
    regionId,
    regionName: region.name ?? regionId,
    childIds: mergedOrder,
    strategy: plan.strategy,
    editedStops: plan.editedStops,
    startMoved: plan.startMoved,
    startId: mergedOrder[0],
    breaks,
    touchingBefore,
    touchingAfter,
    flights: legs.length,
    legs,
    unknownFlights,
    complete: touchingAfter === legs.length,
    // The unplaced villages keep their slots, so their flights are unchanged and
    // must not by themselves make this look like a change.
    changeNeeded: currentOrder.join(",") !== mergedOrder.join(","),
    ...(unplacedIds.length ? { unplacedIds } : {})
  };
}
