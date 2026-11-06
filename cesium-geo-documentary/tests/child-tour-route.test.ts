import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildChildAdjacency,
  childBoundariesFromGeoJson,
  planTouchingRoute,
  restrictAdjacency,
  type ChildBoundary,
  type Position,
  type Ring
} from "../packages/geo-utils/child-adjacency.js";

const SIZE = 0.01; // ≈ 1.1 km
const square = (west: number, south: number): Ring => [
  [west, south],
  [west + SIZE, south],
  [west + SIZE, south + SIZE],
  [west, south + SIZE],
  [west, south]
];
const boundary = (id: string, west: number, south: number): ChildBoundary => ({ id, rings: [square(west, south)] });
const labelPoints = (children: ReadonlyArray<ChildBoundary>): Map<string, Position> =>
  new Map(children.map((child) => [child.id, child.rings[0]![0]!]));

// A row of three touching squares plus one detached square 2.2 km east.
const row: ChildBoundary[] = [
  boundary("a", 0, 0),
  boundary("b", SIZE, 0),
  boundary("c", SIZE * 2, 0),
  boundary("d", SIZE * 5, 0)
];

test("shared boundaries are detected and detached neighbours are not", () => {
  const adjacency = buildChildAdjacency(row);
  assert.equal(adjacency.touchingPairCount, 2);
  assert.deepEqual([...adjacency.neighbours.get("a")!], ["b"]);
  assert.deepEqual([...adjacency.neighbours.get("b")!].sort(), ["a", "c"]);
  assert.deepEqual([...adjacency.neighbours.get("d")!], []);
  assert.equal(adjacency.gaps.get("a|b"), 0);
});

test("adjacency threshold sits at one metre", () => {
  // The source boundary data measures either 0 m or ≥12 m between children, so
  // the threshold has slack on both sides; a half-metre gap is still one line.
  const halfMetre = 0.000005; // ≈ 0.56 m
  const touching = buildChildAdjacency([boundary("a", 0, 0), boundary("b", SIZE + halfMetre, 0)]);
  assert.equal(touching.touchingPairCount, 1);

  const apart = buildChildAdjacency([boundary("a", 0, 0), boundary("b", SIZE + 0.00005, 0)]);
  assert.equal(apart.touchingPairCount, 0, "a 5.5 m gap is not a shared boundary");
});

test("the route steps into a neighbour at every flight it can", () => {
  const adjacency = buildChildAdjacency(row);
  const plan = planTouchingRoute(adjacency, { startId: "a", points: labelPoints(row) });
  assert.deepEqual(plan.order, ["a", "b", "c", "d"]);
  assert.equal(plan.touchingFlights, 2);
  assert.equal(plan.complete, false, "d is detached, so the route cannot be complete");
});

test("a fully touching graph yields a route with no skipped flight", () => {
  const chain = [boundary("a", 0, 0), boundary("b", SIZE, 0), boundary("c", SIZE * 2, 0)];
  const plan = planTouchingRoute(buildChildAdjacency(chain), { startId: "a", points: labelPoints(chain) });
  assert.deepEqual(plan.order, ["a", "b", "c"]);
  assert.deepEqual(plan.breaks, []);
  assert.equal(plan.complete, true);
});

test("a region reachable only by hopping reports the hop", () => {
  const islands = [boundary("a", 0, 0), boundary("b", SIZE, 0), boundary("c", 0.5, 0)];
  const plan = planTouchingRoute(buildChildAdjacency(islands), { startId: "a", points: labelPoints(islands) });
  assert.equal(plan.complete, false);
  assert.equal(plan.breaks.length, 1);
  assert.equal(plan.breaks[0]!.from, "b");
  assert.equal(plan.breaks[0]!.to, "c");
  assert.ok(plan.breaks[0]!.travelMeters > 40_000, "the reported hop carries the distance it crosses");
});

test("the opening stop is kept when a touching route can start there", () => {
  const chain = [boundary("a", 0, 0), boundary("b", SIZE, 0), boundary("c", SIZE * 2, 0)];
  const plan = planTouchingRoute(buildChildAdjacency(chain), { startId: "a", points: labelPoints(chain) });
  assert.equal(plan.order[0], "a");
  assert.equal(plan.complete, true);
  assert.equal(plan.startMoved, false);
  assert.equal(plan.requestedStartId, "a");
});

test("adjacency outranks a familiar opening stop, and moving it is reported", () => {
  // A chain can only be walked from an end. Starting in the middle is legal
  // only by giving up the neighbour rule, so the plan starts elsewhere and
  // says that it did rather than quietly keeping the old first stop.
  const chain = [boundary("a", 0, 0), boundary("b", SIZE, 0), boundary("c", SIZE * 2, 0)];
  const plan = planTouchingRoute(buildChildAdjacency(chain), { startId: "b", points: labelPoints(chain) });
  assert.equal(plan.complete, true, "the neighbour rule wins over the requested start");
  assert.notEqual(plan.order[0], "b");
  assert.equal(plan.startMoved, true);
  assert.equal(plan.requestedStartId, "b");
});

test("with no touching route at all the requested start is kept and hops are listed", () => {
  const scattered = [boundary("a", 0, 0), boundary("b", 0.5, 0), boundary("c", 1.0, 0)];
  const plan = planTouchingRoute(buildChildAdjacency(scattered), { startId: "b", points: labelPoints(scattered) });
  assert.equal(plan.order[0], "b");
  assert.equal(plan.complete, false);
  assert.equal(plan.breaks.length, 2);
});

test("a searched route opens where the caller asked, whenever it can", async () => {
  // Searching *from* the requested opening is the whole point of stage 1, so
  // that stop is the one promise the caller gets. A 2-opt pass once reversed the
  // leading span and carried the opening away with it: 岭峰村 came back as
  // "unreachable" when the walk had in fact found a fully touching route from
  // it, and the plan reported an opening the search never chose. Whatever comes
  // back marked complete must therefore start where it was asked to.
  const root = resolve(import.meta.dirname, "..");
  const geoJson = JSON.parse(
    await readFile(resolve(root, "data/normalized/440882115-children.geojson"), "utf8")
  );
  const region = JSON.parse(await readFile(resolve(root, "data/regions/440882115.json"), "utf8")) as {
    childRegions: Array<{ id: string; labelPoint: [number, number] }>;
  };
  const adjacency = buildChildAdjacency(childBoundariesFromGeoJson(geoJson));
  const points = new Map<string, Position>(region.childRegions.map((child) => [child.id, child.labelPoint]));

  let kept = 0;
  for (const start of adjacency.ids) {
    const plan = planTouchingRoute(adjacency, { points, startId: start });
    if (!plan.complete) continue;
    if (plan.order[0] === start) {
      kept += 1;
      assert.equal(plan.startMoved, false, `${start} opened the route but is reported as moved`);
    } else {
      // Falling back to another opening is legal — some villages genuinely
      // cannot start a fully touching walk — but it must never be silent.
      assert.equal(plan.startMoved, true, `opening moved to ${plan.order[0]} without being reported`);
    }
    assert.equal(plan.requestedStartId, start);
  }
  // 19 of the 25 villages can open a fully touching walk (checked exhaustively).
  // The other 6 fall back to a different opening, so this is a two-sided check
  // rather than "all of them". Before 2-opt was pinned this counted 18: 岭峰村
  // was searched successfully and then flipped away by a prefix reversal.
  assert.equal(kept, 19, `expected 19 workable openings, got ${kept}`);
});

test("an opening that cannot start a walk is moved by repair, not re-planned", () => {
  // Chain a—b—c—d. Only the two ends can open a fully touching walk, so an
  // order opening on b has no such route from where it starts. The editor's
  // order is one move away from correct, and moving the opening is part of that
  // move; inventing a fresh arrangement instead would throw away the written
  // order to fix a single join.
  const chain = [boundary("a", 0, 0), boundary("b", SIZE, 0), boundary("c", SIZE * 2, 0), boundary("d", SIZE * 3, 0)];
  const adjacency = buildChildAdjacency(chain);
  const plan = planTouchingRoute(adjacency, {
    points: labelPoints(chain),
    preferOrder: ["b", "a", "c", "d"],
    startId: "b"
  });
  assert.deepEqual(plan.order, ["a", "b", "c", "d"]);
  assert.equal(plan.strategy, "repaired", "one moved stop is a repair, not a new plan");
  assert.equal(plan.editedStops, 1);
  assert.equal(plan.complete, true);
  assert.equal(plan.startMoved, true, "the opening did have to move, and that is reported");
  assert.equal(plan.requestedStartId, "b");
});

test("2-opt shortens the route without ever breaking adjacency", () => {
  // A 3×3 block of touching squares. Every legal order is fully touching; the
  // shortest one is a lawnmower path rather than a zig-zag across the block.
  const block: ChildBoundary[] = [];
  for (let x = 0; x < 3; x += 1) {
    for (let y = 0; y < 3; y += 1) block.push(boundary(`${x}${y}`, x * SIZE, y * SIZE));
  }
  const adjacency = buildChildAdjacency(block);
  const points = labelPoints(block);
  const plan = planTouchingRoute(adjacency, { startId: "00", points });
  assert.equal(plan.order.length, 9);
  assert.equal(plan.complete, true);
  assert.equal(new Set(plan.order).size, 9);
  for (let index = 1; index < plan.order.length; index += 1) {
    assert.ok(
      adjacency.neighbours.get(plan.order[index - 1]!)?.has(plan.order[index]!),
      `flight ${index} (${plan.order[index - 1]} -> ${plan.order[index]}) skipped the neighbour rule`
    );
  }
  // An ideal lawnmower across a 3×3 block travels 8 km (8 × 1.115 km).
  assert.ok(plan.travelMeters < 9_500, `route should stay short, got ${Math.round(plan.travelMeters)} m`);
});

test("a pinned opening stays first even when no touching walk can start there", () => {
  // Chain a—b—c—d. Only the ends can open a fully touching walk, so an order
  // that must open on b cannot be continuous. The first village is the film's
  // opening shot, so it stays put and the plan states the hop instead of
  // trading the opening away (the unpinned plan returns [a,b,c,d]).
  const chain = [boundary("a", 0, 0), boundary("b", SIZE, 0), boundary("c", SIZE * 2, 0), boundary("d", SIZE * 3, 0)];
  const adjacency = buildChildAdjacency(chain);
  const points = labelPoints(chain);
  const pinned = planTouchingRoute(adjacency, { points, startId: "b", pinOpening: true });
  assert.equal(pinned.order[0], "b", "the first village must remain first");
  assert.equal(pinned.startMoved, false);
  assert.equal(pinned.complete, false, "a middle stop cannot start a continuous walk");
  assert.equal(pinned.breaks.length, 1, "exactly one flight has to hop");
  assert.equal(pinned.order.length, 4, "every village is still visited once");
  assert.equal(new Set(pinned.order).size, 4);

  const unpinned = planTouchingRoute(adjacency, { points, startId: "b" });
  assert.notEqual(unpinned.order[0], "b", "without pinning the opening is traded for continuity");
});

test("pinning changes nothing when the opening can start a touching walk", () => {
  const chain = [boundary("a", 0, 0), boundary("b", SIZE, 0), boundary("c", SIZE * 2, 0)];
  const adjacency = buildChildAdjacency(chain);
  const points = labelPoints(chain);
  const pinned = planTouchingRoute(adjacency, { points, startId: "a", pinOpening: true });
  const unpinned = planTouchingRoute(adjacency, { points, startId: "a" });
  assert.deepEqual(pinned.order, unpinned.order);
  assert.deepEqual(pinned.order, ["a", "b", "c"]);
  assert.equal(pinned.complete, true);
});

test("pinning also holds a small repair in place", () => {
  // The order is one move away from continuous, and that move drags the opening
  // along. Pinned, the opening stays and the route opens from where it was.
  const chain = [boundary("a", 0, 0), boundary("b", SIZE, 0), boundary("c", SIZE * 2, 0), boundary("d", SIZE * 3, 0)];
  const adjacency = buildChildAdjacency(chain);
  const pinned = planTouchingRoute(adjacency, {
    points: labelPoints(chain),
    preferOrder: ["b", "a", "c", "d"],
    startId: "b",
    pinOpening: true
  });
  assert.equal(pinned.order[0], "b");
  assert.equal(pinned.startMoved, false);
});

test("every pinned opening on a real township keeps its first village", async () => {
  const root = resolve(import.meta.dirname, "..");
  const geoJson = JSON.parse(
    await readFile(resolve(root, "data/normalized/440882115-children.geojson"), "utf8")
  );
  const region = JSON.parse(await readFile(resolve(root, "data/regions/440882115.json"), "utf8")) as {
    childRegions: Array<{ id: string; labelPoint: [number, number] }>;
  };
  const adjacency = buildChildAdjacency(childBoundariesFromGeoJson(geoJson));
  const points = new Map<string, Position>(region.childRegions.map((child) => [child.id, child.labelPoint]));
  let hopped = 0;
  for (const start of adjacency.ids) {
    const plan = planTouchingRoute(adjacency, { points, startId: start, pinOpening: true });
    assert.equal(plan.order[0], start, `pinned start ${start} was moved to ${plan.order[0]}`);
    assert.equal(plan.startMoved, false);
    assert.equal(plan.order.length, adjacency.ids.length);
    if (!plan.complete) hopped += 1;
  }
  // 19 of the 25 openings admit a fully touching walk, so pinning costs the
  // other 6 a hop or two — that trade is the point, not a regression.
  assert.equal(hopped, 6, `expected 6 openings to need a hop, got ${hopped}`);
});

test("both route planners pin the opening village", async () => {
  // The pinning lives in the option, so a caller that forgets it silently goes
  // back to trading the opening away. Both entry points are checked here: the
  // Studio button (server-side suggestion) and the CLI script.
  const [studioRoute, cli] = await Promise.all([
    readFile(resolve(import.meta.dirname, "../apps/studio/tour-route.ts"), "utf8"),
    readFile(
      resolve(import.meta.dirname, "../.agents/skills/cesium-geo-documentary/scripts/plan-child-tour-route.ts"),
      "utf8"
    )
  ]);
  assert.match(studioRoute, /startId: currentOrder\[0\]!,[\s\S]{0,600}?pinOpening: true/);
  assert.match(cli, /pinOpening: !has\("allow-start-move"\)/);
});

test("restricting to the children a project kept preserves their edges", () => {
  const adjacency = buildChildAdjacency(row);
  const reduced = restrictAdjacency(adjacency, ["a", "b", "d"]);
  assert.deepEqual(reduced.ids, ["a", "b", "d"]);
  assert.deepEqual([...reduced.neighbours.get("a")!], ["b"]);
  const plan = planTouchingRoute(reduced, { startId: "a", points: labelPoints(row) });
  assert.deepEqual(plan.order, ["a", "b", "d"]);
  assert.equal(plan.breaks.length, 1);
});

test("GeoJSON child boundaries convert without losing rings", () => {
  const boundaries = childBoundariesFromGeoJson({
    features: [
      { properties: { id: "a", name: "甲村" }, geometry: { type: "Polygon", coordinates: [square(0, 0)] } },
      {
        properties: { id: "b", name: "乙村" },
        geometry: { type: "MultiPolygon", coordinates: [[square(SIZE, 0)], [square(SIZE * 3, 0)]] }
      },
      { properties: { id: null }, geometry: { type: "Polygon", coordinates: [square(0, 0)] } },
      { properties: { id: "c" }, geometry: null }
    ]
  });
  assert.deepEqual(boundaries.map((item) => item.id), ["a", "b"]);
  assert.equal(boundaries[1]!.rings.length, 2);
});

test("乌石镇 admits a tour that never skips a neighbour", async () => {
  const root = resolve(import.meta.dirname, "..");
  const geoJson = JSON.parse(
    await readFile(resolve(root, "data/normalized/440882115-children.geojson"), "utf8")
  );
  const region = JSON.parse(await readFile(resolve(root, "data/regions/440882115.json"), "utf8")) as {
    childRegions: Array<{ id: string; labelPoint: [number, number] }>;
  };
  const children = childBoundariesFromGeoJson(geoJson);
  assert.equal(children.length, 25);
  const adjacency = buildChildAdjacency(children);
  // 50 shared boundaries between 25 villages: the region is one connected
  // landmass, which is exactly why a fully touching order is achievable.
  assert.equal(adjacency.touchingPairCount, 50);
  assert.ok(children.every((child) => (adjacency.neighbours.get(child.id)?.size ?? 0) >= 2));

  const points = new Map<string, Position>(region.childRegions.map((child) => [child.id, child.labelPoint]));
  const plan = planTouchingRoute(adjacency, { points, startId: region.childRegions[0]!.id });
  assert.equal(plan.order.length, 25);
  assert.deepEqual(plan.breaks, [], "every flight between two villages must share a boundary");
  assert.equal(plan.complete, true);
  // The shipped 2026-09 order managed only 11 of 24 touching flights.
  assert.equal(plan.touchingFlights, 24);
});
