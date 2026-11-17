import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { captureBoundarySnapshot } from "../apps/studio/boundary-snapshot.js";
import { suggestTourRoute } from "../apps/studio/tour-route.js";
import type { VideoProject } from "../packages/project-schema/index.js";

const regionId = "990000001";
const geometryRelative = `data/normalized/${regionId}-children.geojson`;
const geometry = (positions: Record<string, number>) => ({
  type: "FeatureCollection",
  features: Object.entries(positions).map(([id, x]) => ({
    type: "Feature", properties: { id },
    geometry: { type: "Polygon", coordinates: [[[x, 0], [x + 0.01, 0], [x + 0.01, 0.01], [x, 0.01], [x, 0]]] }
  }))
});
const project = (order: string[]) => ({
  id: "route-p2", regionId,
  scenes: order.map((id) => ({ id: `child-${id}`, section: "child", childId: id, childName: id }))
}) as unknown as VideoProject;

async function fixture(t: { after: (fn: () => Promise<void>) => void }, positions = { a: 0, b: 0.01, c: 0.02 }) {
  const root = await mkdtemp(join(tmpdir(), "route-p2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "data/regions"), { recursive: true });
  await mkdir(join(root, "data/normalized"), { recursive: true });
  await writeFile(join(root, `data/regions/${regionId}.json`), JSON.stringify({
    name: "冻结测试镇", childGeometryPath: geometryRelative,
    childRegions: Object.entries(positions).map(([id, x]) => ({ id, labelPoint: [x + 0.005, 0.005] }))
  }));
  await writeFile(join(root, geometryRelative), JSON.stringify(geometry(positions)));
  return root;
}

test("P2：旧方案的记录、边界和距离点均读取冻结副本", async (t) => {
  const root = await fixture(t);
  await captureBoundarySnapshot(root, "route-p2", regionId);
  await writeFile(join(root, `data/regions/${regionId}.json`), JSON.stringify({ name: "已更新镇", childGeometryPath: "data/normalized/new.geojson" }));
  await writeFile(join(root, "data/normalized/new.geojson"), JSON.stringify(geometry({ a: 0, b: 1, c: 2 })));
  await writeFile(join(root, geometryRelative), JSON.stringify(geometry({ a: 0, b: 1, c: 2 })));
  const result = await suggestTourRoute(root, project(["a", "c", "b"]));
  assert.equal(result.regionName, "冻结测试镇");
  assert.deepEqual(result.childIds, ["a", "b", "c"]);
  assert.equal(result.touchingAfter, 2);
  assert.equal(result.complete, true);
  assert.deepEqual(result.breaks, []);
  const live = await suggestTourRoute(root, { ...project(["a", "b", "c"]), id: "new-project" });
  assert.equal(live.regionName, "已更新镇");
  assert.equal(live.breaks.length, 2);
});

test("P2：未知边界插回中段后按实际航段统计", async (t) => {
  const root = await fixture(t);
  const result = await suggestTourRoute(root, project(["a", "ghost", "c", "b"]));
  assert.deepEqual(result.childIds, ["a", "ghost", "b", "c"]);
  assert.deepEqual(result.legs.map((leg) => [leg.from, leg.to, leg.status]), [
    ["a", "ghost", "unknown"], ["ghost", "b", "unknown"], ["b", "c", "touching"]
  ]);
  assert.equal(result.touchingAfter, 1);
  assert.equal(result.unknownFlights, 2);
  assert.equal(result.complete, false);
  assert.equal(result.touchingAfter + result.breaks.length + result.unknownFlights, result.flights);
});

test("P2：未知站点切断已知跨接后不保留虚构的跨接报告", async (t) => {
  const root = await fixture(t, { a: 0, b: 1, c: 1.01 });
  const result = await suggestTourRoute(root, project(["a", "ghost", "b", "c"]));
  assert.deepEqual(result.childIds, ["a", "ghost", "b", "c"]);
  assert.equal(result.changeNeeded, false);
  assert.deepEqual(result.breaks, []);
  assert.equal(result.unknownFlights, 2);
  assert.equal(result.touchingAfter, 1);
});

test("P2：固定首站和多个未知站点原编辑位置，已知跨接保留真实距离", async (t) => {
  const root = await fixture(t, { a: 0, b: 1, c: 2 });
  const result = await suggestTourRoute(root, project(["ghost", "a", "b", "phantom", "c"]));
  assert.equal(result.childIds[0], "ghost");
  assert.equal(result.childIds[3], "phantom");
  assert.equal(result.startMoved, false);
  assert.equal(result.startId, "ghost");
  assert.equal(result.breaks.length, 1);
  assert.equal(result.breaks[0]!.from, "a");
  assert.equal(result.breaks[0]!.to, "b");
  assert.ok(result.breaks[0]!.travelMeters > 100_000);
  assert.equal(result.unknownFlights, 3);
  assert.equal(result.touchingAfter + result.breaks.length + result.unknownFlights, result.flights);
});

test("P2：全部未知或仅一个已知时按原顺序准确报告", async (t) => {
  const root = await fixture(t);
  for (const order of [["ghost", "phantom"], ["ghost", "a", "phantom"]]) {
    const result = await suggestTourRoute(root, project(order));
    assert.deepEqual(result.childIds, order);
    assert.equal(result.strategy, "kept");
    assert.equal(result.editedStops, 0);
    assert.equal(result.changeNeeded, false);
    assert.equal(result.complete, false);
    assert.equal(result.unknownFlights, order.length - 1);
    assert.equal(result.touchingAfter, 0);
    assert.deepEqual(result.breaks, []);
  }
});

test("P2：重复childId明确拒绝", async (t) => {
  const root = await fixture(t);
  await assert.rejects(suggestTourRoute(root, project(["a", "b", "a"])), /childId.*重复/);
});

test("P2：冻结清单损坏或文件缺失不回退实时数据", async (t) => {
  const root = await fixture(t);
  const manifestPath = join(root, "workspace/projects/route-p2.boundary/snapshot.json");
  for (const damage of ["invalid-json", "identity", "missing-file", "same-size-content", "missing-entry"]) {
    await captureBoundarySnapshot(root, "route-p2", regionId);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (damage === "invalid-json") await writeFile(manifestPath, "{");
    if (damage === "identity") await writeFile(manifestPath, JSON.stringify({ ...manifest, regionId: "other" }));
    if (damage === "missing-file") await rm(join(root, "workspace/projects/route-p2.boundary", geometryRelative));
    if (damage === "same-size-content") {
      const path = join(root, "workspace/projects/route-p2.boundary", geometryRelative);
      await writeFile(path, (await readFile(path, "utf8")).replace('"a"', '"z"'));
    }
    if (damage === "missing-entry") await writeFile(manifestPath, JSON.stringify({ ...manifest, files: [] }));
    await assert.rejects(suggestTourRoute(root, project(["a", "b"])), /冻结快照损坏.*拒绝回退/, damage);
  }
});

test("P2：实际航段报告不逐段调用规划器", async () => {
  const source = await readFile(new URL("../apps/studio/tour-route.ts", import.meta.url), "utf8");
  assert.equal((source.match(/planTouchingRoute\(/g) ?? []).length, 1);
  assert.ok(source.includes('travelBetween(points, from, to)'));
});

test("P2：UI拒绝重复childId且不请求重排", async () => {
  const source = await readFile(new URL("../apps/studio/public/studio.js", import.meta.url), "utf8");
  const functionSource = source.slice(source.indexOf("async function planTourRoute()"), source.indexOf("function bindSceneSorting()"));
  const messages: string[] = [];
  await runInNewContext(`${functionSource}\nplanTourRoute()`, {
    state: { project: project(["a", "a"]) }, saveBeforeAction: async () => true,
    $: () => ({}), toast: (message: string) => messages.push(message),
    api: async () => { throw new Error("不应请求API"); }
  });
  assert.ok(messages[0]!.includes("childId 重复"));
});

test("P2：无需重排时UI仍分别报告跨接与未知边界", async () => {
  const source = await readFile(new URL("../apps/studio/public/studio.js", import.meta.url), "utf8");
  const functionSource = source.slice(source.indexOf("async function planTourRoute()"), source.indexOf("function bindSceneSorting()"));
  for (const details of [
    { touchingAfter: 0, flights: 1, unknownFlights: 0, breaks: [{ from: "a", to: "b", travelMeters: 1 }], expected: "需跨接" },
    { touchingAfter: 0, flights: 1, unknownFlights: 1, breaks: [], expected: "缺少边界" },
    { touchingAfter: 1, flights: 1, unknownFlights: 0, breaks: [], expected: "已经全部接壤" }
  ]) {
    const messages: string[] = [];
    const button = { textContent: "按接壤重排", disabled: false };
    const context = {
      state: { project: project(["a", "b"]) },
      saveBeforeAction: async () => true,
      $: () => button,
      api: async () => ({ changeNeeded: false, ...details }),
      toast: (message: string) => messages.push(message)
    };
    await runInNewContext(`${functionSource}\nplanTourRoute()`, context);
    assert.equal(messages.length, 1);
    assert.ok(messages[0]!.includes(details.expected));
    if (details.touchingAfter !== details.flights) assert.ok(!messages[0]!.includes("全部接壤"));
    assert.equal(button.disabled, false);
  }
});
