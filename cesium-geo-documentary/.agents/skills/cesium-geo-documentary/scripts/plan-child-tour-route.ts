/**
 * Plan a child tour that always steps into a neighbouring village.
 *
 * The tour order used to be whatever order the source boundary file listed its
 * features in, so the camera criss-crossed the township. On 乌石镇 only 11 of
 * the 24 flights were between villages that actually share a boundary.
 *
 * This reads the region's child boundaries, works out which children touch,
 * and searches for a visit order whose every flight lands next door. Comparing
 * the current order against the planned one is the default; `--apply` writes
 * the plan into the region content (tour order plus its narration slots) and,
 * with `--project`, into the Studio project's child scene order.
 *
 * The first village is pinned: it is the film's opening shot and the subject of
 * its first narration paragraph, so only the stops after it are rearranged. When
 * no fully touching walk can begin there the route hops where it must and says
 * so; `--allow-start-move` gives the opening up (the old behaviour) and is meant
 * for one-off comparisons only.
 *
 * Usage:
 *   node --import tsx .agents/skills/cesium-geo-documentary/scripts/plan-child-tour-route.ts \
 *     --region 440882115 [--project project-mu3m4jat] [--start 440882115208] \
 *     [--allow-start-move] [--apply]
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildChildAdjacency,
  childBoundariesFromGeoJson,
  planTouchingRoute,
  restrictAdjacency,
  type ChildAdjacency,
  type Position
} from "../../../../packages/geo-utils/child-adjacency.js";

const root = resolve(process.cwd());
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const regionId = flag("region");
if (!regionId) throw new Error("--region is required");
const projectId = flag("project");
const requestedStart = flag("start");
const apply = has("apply");
const toleranceMeters = Number(flag("tolerance") ?? 1);
const timeBudgetMs = Number(flag("budget") ?? 4_000);
const studioBase = flag("studio") ?? "http://127.0.0.1:4180";
// The opening village is pinned unless the caller explicitly gives it up.
const pinnedOpening = !has("allow-start-move");

interface RegionRecord {
  name: string;
  childGeometryPath?: string;
  childRegions?: Array<{ id: string; name: string; labelPoint?: [number, number] }>;
}
interface StudioScene {
  id: string;
  section?: string;
  childId?: string;
  childName?: string;
  [key: string]: unknown;
}
interface StudioProject {
  id: string;
  name: string;
  regionId?: string;
  revision?: number;
  scenes: StudioScene[];
  [key: string]: unknown;
}
interface RegionContent {
  narration?: string[];
  tourOrder?: string[];
  tourIntroSentences?: number;
  [key: string]: unknown;
}

async function studio<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${studioBase}${path}`, init);
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

const regionPath = resolve(root, `data/regions/${regionId}.json`);
const region = JSON.parse(await readFile(regionPath, "utf8")) as RegionRecord;
const geometryPath = resolve(root, region.childGeometryPath ?? `data/normalized/${regionId}-children.geojson`);
const geoJson = JSON.parse(await readFile(geometryPath, "utf8"));
const children = childBoundariesFromGeoJson(geoJson);
if (!children.length) throw new Error(`${region.name} has no child boundaries at ${geometryPath}`);

const contentPath = resolve(root, "content/regions.zh-CN.json");
const master = JSON.parse(await readFile(contentPath, "utf8")) as Record<string, RegionContent>;
const content = master[regionId];

const adjacency = buildChildAdjacency(children, { toleranceMeters });
const nameById = new Map<string, string>();
for (const child of children) if (child.name) nameById.set(child.id, child.name);
for (const child of region.childRegions ?? []) if (child.name) nameById.set(String(child.id), child.name);
const label = (id: string): string => nameById.get(id) ?? id;
const points = new Map<string, Position>();
for (const child of region.childRegions ?? []) {
  if (child.labelPoint) points.set(String(child.id), child.labelPoint);
}

let project: StudioProject | null = null;
if (projectId) {
  project = await studio<StudioProject>(`/api/projects/${projectId}`);
  if (project.regionId && String(project.regionId) !== regionId) {
    throw new Error(`Project ${projectId} is ${project.regionId}, not ${regionId}`);
  }
}

const projectChildScenes = (project?.scenes ?? []).filter((scene) => scene.section === "child" && scene.childId);
const currentOrder = (project ? projectChildScenes.map((scene) => String(scene.childId)) : content?.tourOrder ?? []).map(String);
if (!currentOrder.length) throw new Error(`No current child order available for ${region.name}`);

const geometryIds = new Set(children.map((child) => child.id));
const withoutGeometry = currentOrder.filter((id) => !geometryIds.has(id));
if (withoutGeometry.length) {
  throw new Error(`${region.name} order contains children with no boundary geometry: ${withoutGeometry.join(", ")}`);
}

// A project may deliberately keep only some children, so plan over the ones it
// actually contains and keep the current first stop as the preferred opening.
const scoped: ChildAdjacency = currentOrder.length === adjacency.ids.length
  ? adjacency
  : restrictAdjacency(adjacency, currentOrder);
const beforeOrder = currentOrder.filter((id) => scoped.neighbours.has(id));
const startId = requestedStart && scoped.neighbours.has(requestedStart) ? requestedStart : beforeOrder[0];

const plan = planTouchingRoute(scoped, {
  points,
  preferOrder: beforeOrder,
  ...(startId ? { startId } : {}),
  // The first village is the film's opening shot and its first narration
  // paragraph, so the neighbour rule rearranges only what follows it. When no
  // fully touching walk can begin there the route walks as far as adjacency
  // allows and reports the hops, instead of silently opening elsewhere.
  // `--allow-start-move` restores the old trade-off for a one-off comparison.
  pinOpening: !has("allow-start-move"),
  timeBudgetMs
});

const touching = (a: string, b: string): boolean => scoped.neighbours.get(a)?.has(b) ?? false;
const countTouching = (order: ReadonlyArray<string>): number => {
  let total = 0;
  for (let index = 1; index < order.length; index += 1) if (touching(order[index - 1]!, order[index]!)) total += 1;
  return total;
};
const beforeTouching = countTouching(beforeOrder);
const flights = Math.max(0, plan.order.length - 1);

// Chinese glyphs occupy two columns; pad on display width so the table lines up.
const width = (text: string): number => [...text].reduce((sum, char) => sum + (/[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(char) ? 2 : 1), 0);
const pad = (text: string, columns: number): string => text + " ".repeat(Math.max(0, columns - width(text)));

const lines: string[] = [];
lines.push(`${region.name} · ${geometryPath.replace(`${root}\\`, "").replaceAll("\\", "/")}`);
lines.push(`${children.length} children, ${adjacency.touchingPairCount} shared boundaries (tolerance ${toleranceMeters} m)`);
lines.push("");
lines.push(`   #  ${pad("current order", 26)}  ${pad("planned order", 26)}  flight`);
lines.push(`  ---  ${"-".repeat(26)}  ${"-".repeat(26)}  ------`);
for (let index = 0; index < Math.max(beforeOrder.length, plan.order.length); index += 1) {
  const beforeId = beforeOrder[index];
  const afterId = plan.order[index];
  const previous = plan.order[index - 1];
  const flight = index === 0 || !afterId || !previous ? "" : touching(previous, afterId) ? "touches" : "HOPS";
  lines.push(`  ${String(index + 1).padStart(3)}  ${pad(beforeId ? label(beforeId) : "", 26)}  ${pad(afterId ? label(afterId) : "", 26)}  ${flight}`);
}
lines.push("");
lines.push(`flights that land next door:  before ${beforeTouching}/${Math.max(0, beforeOrder.length - 1)}   after ${plan.touchingFlights}/${flights}`);
for (let index = 1; index < beforeOrder.length; index += 1) {
  const from = beforeOrder[index - 1]!;
  const to = beforeOrder[index]!;
  if (!touching(from, to)) lines.push(`  current hop at ${index}: ${label(from)} -> ${label(to)}`);
}
if (plan.strategy === "repaired") {
  lines.push(`  fixed by moving ${plan.editedStops} stop(s); the rest of the order is unchanged`);
} else if (plan.strategy === "kept") {
  lines.push(`  the current order already satisfies the neighbour rule`);
} else if (plan.strategy === "searched") {
  lines.push(
    plan.startMoved
      ? "  no small adjustment exists, so the order was planned from scratch"
      : `  no small adjustment exists, so the order was re-planned from the same opening (${label(plan.order[0]!)})`
  );
} else if (plan.strategy === "hopped") {
  lines.push("  no fully touching order exists, so the walk steps next door wherever it can");
  lines.push("  and crosses each remaining gap in as few hops as it can find");
}
if (plan.breaks.length) {
  lines.push("");
  lines.push("flights with no shared boundary to follow:");
  for (const item of plan.breaks) {
    lines.push(`  ${label(item.from)} -> ${label(item.to)}  (${(item.travelMeters / 1000).toFixed(1)} km apart)`);
  }
}
if (plan.startMoved) {
  lines.push("");
  const away = `no fully touching route starts at ${label(plan.requestedStartId!)}`;
  lines.push(
    plan.strategy === "repaired"
      ? `opening stop moved: ${away}, and moving ${plan.editedStops} stop(s) covers it; starting from ${label(plan.order[0]!)}`
      : `opening stop moved: ${away}; starting from ${label(plan.order[0]!)}`
  );
} else if (pinnedOpening && !plan.complete) {
  lines.push("");
  lines.push(`opening pinned: the first village stays ${label(plan.order[0]!)}`);
  lines.push(`  no fully touching route starts there, so ${plan.breaks.length} flight(s) hop instead;`);
  lines.push("  pass --allow-start-move to trade the opening away for a continuous route.");
}
process.stdout.write(`${lines.join("\n")}\n`);

const report = {
  regionId,
  regionName: region.name,
  projectId: projectId ?? null,
  toleranceMeters,
  childCount: children.length,
  touchingPairCount: adjacency.touchingPairCount,
  before: { order: beforeOrder, touchingFlights: beforeTouching, flights: Math.max(0, beforeOrder.length - 1) },
  after: { order: plan.order, touchingFlights: plan.touchingFlights, flights },
  strategy: plan.strategy,
  editedStops: plan.editedStops,
  breaks: plan.breaks,
  pinnedOpening,
  startMoved: plan.startMoved,
  requestedStartId: plan.requestedStartId ?? null,
  applied: apply
};
const reportPath = resolve(root, flag("json") ?? `renders/diagnostics/tour-route-${regionId}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

if (!apply) {
  process.stdout.write(`\nreport ${reportPath}\n(dry run — pass --apply to write the planned order)\n`);
} else {
  // The region content and the studio project are separate records of the same
  // order and drift apart; each is written only if it is the one still behind.
  const target = plan.order.join(",");
  const projectBehind = Boolean(project) && projectChildScenes.map((scene) => String(scene.childId)).join(",") !== target;
  const contentOrder = content ? (content.tourOrder ?? []).map(String) : null;
  const contentBehind = contentOrder !== null && contentOrder.join(",") !== target;
  if (!projectBehind && !contentBehind) {
    process.stdout.write(`\nreport ${reportPath}\nnothing to change: the current order already steps next door at every flight\n`);
  } else {
    if (content && contentBehind) {
      // Narration slots line up one-to-one with the *content* order, which is
      // not necessarily the project's order. Reordering one without the other
      // would attach each village's paragraph to the wrong village, so the
      // content is only touched when its own slots can be checked and moved
      // together. Opening and closing slots never move.
      const previous = contentOrder ?? [];
      const narration = content.narration ?? [];
      const introCount = content.tourIntroSentences
        ?? Math.max(0, narration.length - previous.length - 1);
      const childSlots = narration.slice(introCount, introCount + previous.length);
      const coversPlan = previous.length === plan.order.length
        && new Set(previous).size === previous.length
        && plan.order.every((id) => previous.includes(id));
      const aligned = coversPlan
        && childSlots.length === previous.length
        && previous.every((id, index) => {
          const text = childSlots[index] ?? "";
          return text === "" || text.includes(label(id));
        });
      if (aligned) {
        const byChild = new Map(previous.map((id, index) => [id, childSlots[index] ?? ""]));
        content.tourOrder = plan.order;
        content.narration = [
          ...narration.slice(0, introCount),
          ...plan.order.map((id) => byChild.get(id) ?? ""),
          ...narration.slice(introCount + previous.length)
        ];
        const temporary = `${contentPath}.plan.tmp`;
        await writeFile(temporary, `${JSON.stringify(master, null, 2)}\n`, "utf8");
        await rename(temporary, contentPath);
        process.stdout.write("\nregion content updated: tourOrder + narration slots\n");
      } else {
        process.stdout.write(
          "\n! region content left untouched: its narration slots could not be matched to its own tour\n"
          + "  order, so rewriting one without the other would detach the paragraphs from their villages.\n"
          + "  A new project built from this region will keep the old order until that is repaired.\n"
        );
      }
    }

    if (project && projectBehind) {
      const firstChild = project.scenes.findIndex((scene) => scene.section === "child");
      const lastChild = project.scenes.reduce((last, scene, index) => (scene.section === "child" ? index : last), -1);
      const sceneByChild = new Map(projectChildScenes.map((scene) => [String(scene.childId), scene]));
      const ordered = plan.order.map((id) => sceneByChild.get(id)).filter((scene): scene is StudioScene => Boolean(scene));
      if (ordered.length !== projectChildScenes.length) {
        throw new Error(`Refusing to rewrite scenes: planned ${ordered.length} children, project has ${projectChildScenes.length}`);
      }
      const next: StudioProject = {
        ...project,
        scenes: [...project.scenes.slice(0, firstChild), ...ordered, ...project.scenes.slice(lastChild + 1)]
      };
      const saved = await studio<StudioProject>(`/api/projects/${project.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next)
      });
      process.stdout.write(`project updated: ${saved.id} revision ${saved.revision ?? "?"}\n`);
    }
    process.stdout.write(`report ${reportPath}\n`);
  }
}
