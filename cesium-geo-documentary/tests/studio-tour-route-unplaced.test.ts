import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suggestTourRoute } from "../apps/studio/tour-route.js";
import type { VideoProject } from "../packages/project-schema/index.js";

const SIZE = 0.01;
const square = (west: number, south: number) => [[west, south], [west + SIZE, south], [west + SIZE, south + SIZE], [west, south + SIZE], [west, south]];

/**
 * A miniature region whose geometry knows villages a/b/c but not "ghost".
 *
 * This mirrors 雷州市龙门镇 440882112220 (宝蓄村): the village is real, narrated and
 * listed in the roster, yet the normalised child geometry has no polygon for it.
 * Before the fix, `suggestTourRoute` threw "方案的村级场景不在边界数据中" for the
 * whole scheme, so the 按接壤重排 button could not be used at all.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tour-route-"));
  await mkdir(join(root, "data", "regions"), { recursive: true });
  await mkdir(join(root, "data", "normalized"), { recursive: true });
  const children = [
    { id: "b", name: "乙村", west: SIZE, south: 0 },
    { id: "a", name: "甲村", west: 0, south: 0 },
    { id: "c", name: "丙村", west: SIZE * 2, south: 0 }
  ];
  await writeFile(join(root, "data", "regions", "990000001.json"), JSON.stringify({
    id: "990000001",
    name: "测试镇",
    childGeometryPath: "data/normalized/990000001-children.geojson",
    childRegions: children.map((child) => ({ id: child.id, name: child.name, labelPoint: [child.west + SIZE / 2, child.south + SIZE / 2] }))
  }));
  await writeFile(join(root, "data", "normalized", "990000001-children.geojson"), JSON.stringify({
    type: "FeatureCollection",
    features: children.map((child) => ({
      type: "Feature",
      properties: { id: child.id, name: child.name },
      geometry: { type: "Polygon", coordinates: [square(child.west, child.south)] }
    }))
  }));
  return root;
}

function projectWith(order: string[]): VideoProject {
  return {
    regionId: "990000001",
    scenes: order.map((id) => ({ id: `child-${id}`, section: "child", childId: id, childName: id }))
  } as unknown as VideoProject;
}

test("a village missing from the boundary data no longer blocks the whole plan", async () => {
  const root = await fixture();
  // 甲 → 丙 → 乙 is not adjacent (甲|丙 do not touch); the planner should fix it.
  const suggestion = await suggestTourRoute(root, projectWith(["a", "c", "b", "ghost"]));
  assert.equal(suggestion.childIds.length, 4, "every village keeps a slot");
  assert.ok(suggestion.childIds.includes("ghost"), "the geometry-less village must not be dropped");
  assert.deepEqual(suggestion.unplacedIds, ["ghost"]);
  assert.ok(suggestion.touchingAfter >= suggestion.touchingBefore, "planning never reduces adjacency");
});

test("the geometry-less village keeps its editorial position", async () => {
  const root = await fixture();
  const suggestion = await suggestTourRoute(root, projectWith(["a", "ghost", "c", "b"]));
  assert.equal(suggestion.childIds[0], "a", "the pinned opening stop is unchanged");
  assert.equal(suggestion.childIds[1], "ghost", "a village with no polygon stays where the author put it");
  assert.equal(suggestion.childIds.length, 4);
});

test("a scheme with no boundary-backed village still reports a usable error", async () => {
  const root = await fixture();
  await assert.rejects(
    () => suggestTourRoute(root, projectWith(["ghost", "phantom"])),
    /能对上边界数据/
  );
});
