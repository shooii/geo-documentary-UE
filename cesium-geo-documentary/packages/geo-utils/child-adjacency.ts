/**
 * Spatial adjacency between sibling administrative divisions, and the tour
 * order that follows it.
 *
 * A child tour flies from village to village. The order used to be whatever
 * order the source shapefile happened to list its features in, so the camera
 * criss-crossed the township and every other flight jumped over the region
 * instead of stepping next door. Measured on 乌石镇 (25 villages, 50 real
 * touching edges), only 11 of the 24 flights were between villages that share
 * a boundary.
 *
 * This module answers two questions for a region:
 *   1. which children actually touch (`buildChildAdjacency`)
 *   2. in what order can the camera visit all of them while always stepping
 *      into a neighbour (`planTouchingRoute`)
 */

export type Position = readonly [number, number];
export type Ring = ReadonlyArray<Position>;

export interface ChildBoundary {
  id: string;
  name?: string;
  /** GeoJSON polygon rings in lon/lat. Holes are irrelevant for adjacency. */
  rings: ReadonlyArray<Ring>;
}

const METERS_PER_DEGREE_LATITUDE = 111_320;

/**
 * Distance below which two boundaries are the same line.
 *
 * The source data makes this a clean call rather than a judgement: across
 * 乌石镇, 覃斗镇, 西连镇 and 附城镇, every genuine shared boundary measures
 * `0.00 m`, and the smallest gap between children that do *not* touch is
 * `12.05 m` (most are 22 m or more). There is nothing in between to tune, so
 * one metre separates the two populations with an order of magnitude of slack
 * on the far side.
 */
export const TOUCHING_TOLERANCE_METERS = 1;

export interface AdjacencyOptions {
  toleranceMeters?: number;
  /** Grid size for the broad phase. Smaller is slower and finds more pairs. */
  cellMeters?: number;
}

export interface ChildAdjacency {
  ids: string[];
  /** Child id -> ids it shares a boundary with. */
  neighbours: Map<string, Set<string>>;
  /** `${a}|${b}` (ids sorted) -> closest approach in metres. */
  gaps: Map<string, number>;
  touchingPairCount: number;
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

function distancePointToSegment(point: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
}

function distanceBetweenSegments(a: Position, b: Position, c: Position, d: Position): number {
  return Math.min(
    distancePointToSegment(a, c, d),
    distancePointToSegment(b, c, d),
    distancePointToSegment(c, a, b),
    distancePointToSegment(d, a, b)
  );
}

/**
 * Which children share a boundary, and how far apart the rest are.
 *
 * Boundaries are projected onto a local plane (longitude scaled by the cosine
 * of the region's latitude) so plain Euclidean distances are accurate to well
 * under a metre at township scale, then bucketed into a grid so only children
 * with segments in the same cell are compared segment by segment.
 */
export function buildChildAdjacency(
  children: ReadonlyArray<ChildBoundary>,
  options: AdjacencyOptions = {}
): ChildAdjacency {
  const tolerance = options.toleranceMeters ?? TOUCHING_TOLERANCE_METERS;
  const cell = options.cellMeters ?? 200;
  const ids = children.map((child) => child.id);
  const neighbours = new Map(ids.map((id) => [id, new Set<string>()]));
  const gaps = new Map<string, number>();
  if (!children.length) return { ids, neighbours, gaps, touchingPairCount: 0 };

  const latitude = children[0]?.rings[0]?.[0]?.[1] ?? 0;
  const scaleX = METERS_PER_DEGREE_LATITUDE * Math.cos((latitude * Math.PI) / 180);
  const scaleY = METERS_PER_DEGREE_LATITUDE;
  const project = ([longitude, pointLatitude]: Position): Position =>
    [longitude * scaleX, pointLatitude * scaleY];

  // Every boundary segment, flattened, in a local metric frame.
  const segmentOwner: number[] = [];
  const segmentFrom: Position[] = [];
  const segmentTo: Position[] = [];
  const boundsByChild: Array<[number, number, number, number]> = [];
  children.forEach((child, index) => {
    let west = Infinity; let south = Infinity; let east = -Infinity; let north = -Infinity;
    for (const ring of child.rings) {
      for (let point = 1; point < ring.length; point += 1) {
        const from = ring[point - 1];
        const to = ring[point];
        if (!from || !to) continue;
        const a = project(from);
        const b = project(to);
        if (a[0] === b[0] && a[1] === b[1]) continue;
        segmentOwner.push(index);
        segmentFrom.push(a);
        segmentTo.push(b);
        west = Math.min(west, a[0], b[0]); east = Math.max(east, a[0], b[0]);
        south = Math.min(south, a[1], b[1]); north = Math.max(north, a[1], b[1]);
      }
    }
    boundsByChild.push([west, south, east, north]);
  });

  // Grid the *segments*, not the children. Comparing whole child boundaries
  // against each other costs one full segment sweep per candidate pair, which
  // on a 57-village region is minutes; bucketing segments means only the
  // segments that actually share a cell are ever compared. Each segment's box
  // is padded by the tolerance, because two boundaries that touch can still sit
  // on opposite sides of a cell edge.
  const cells = new Map<string, number[]>();
  for (let index = 0; index < segmentFrom.length; index += 1) {
    const a = segmentFrom[index]!;
    const b = segmentTo[index]!;
    const fromX = Math.floor((Math.min(a[0], b[0]) - tolerance) / cell);
    const toX = Math.floor((Math.max(a[0], b[0]) + tolerance) / cell);
    const fromY = Math.floor((Math.min(a[1], b[1]) - tolerance) / cell);
    const toY = Math.floor((Math.max(a[1], b[1]) + tolerance) / cell);
    for (let x = fromX; x <= toX; x += 1) {
      for (let y = fromY; y <= toY; y += 1) {
        const key = `${x},${y}`;
        const bucket = cells.get(key);
        if (bucket) bucket.push(index);
        else cells.set(key, [index]);
      }
    }
  }

  // Two children whose bounding boxes are further apart than the tolerance
  // cannot contain a touching segment pair, whatever the grid says.
  const boxesApart = (first: number, second: number): boolean => {
    const a = boundsByChild[first];
    const b = boundsByChild[second];
    if (!a || !b || !Number.isFinite(a[0]) || !Number.isFinite(b[0])) return true;
    const dx = Math.max(0, Math.max(a[0] - b[2], b[0] - a[2]));
    const dy = Math.max(0, Math.max(a[1] - b[3], b[1] - a[3]));
    return Math.hypot(dx, dy) > tolerance;
  };

  let touchingPairCount = 0;
  const settled = new Set<string>();
  for (const bucket of cells.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      const first = bucket[i]!;
      const ownerA = segmentOwner[first]!;
      for (let j = i + 1; j < bucket.length; j += 1) {
        const second = bucket[j]!;
        const ownerB = segmentOwner[second]!;
        if (ownerA === ownerB) continue;
        const idA = ids[ownerA]!;
        const idB = ids[ownerB]!;
        const key = pairKey(idA, idB);
        if (settled.has(key)) continue;
        if (boxesApart(ownerA, ownerB)) continue;
        const distance = distanceBetweenSegments(
          segmentFrom[first]!, segmentTo[first]!, segmentFrom[second]!, segmentTo[second]!
        );
        if (distance > tolerance) continue;
        settled.add(key);
        gaps.set(key, distance);
        neighbours.get(idA)?.add(idB);
        neighbours.get(idB)?.add(idA);
        touchingPairCount += 1;
      }
    }
  }

  return { ids, neighbours, gaps, touchingPairCount };
}

/**
 * Narrow an adjacency to a subset of children.
 *
 * A Studio project may deliberately drop child scenes, so the tour has to be
 * planned over the children the project actually contains. Restricting keeps
 * every edge whose two ends survive, and reports the same gaps so a route that
 * has to hop can still name the distance it crosses.
 */
export function restrictAdjacency(adjacency: ChildAdjacency, keep: ReadonlyArray<string>): ChildAdjacency {
  const allowed = new Set(keep.filter((id) => adjacency.neighbours.has(id)));
  const ids = adjacency.ids.filter((id) => allowed.has(id));
  const neighbours = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const id of ids) {
    for (const other of adjacency.neighbours.get(id) ?? []) {
      if (allowed.has(other)) neighbours.get(id)?.add(other);
    }
  }
  const gaps = new Map<string, number>();
  for (const [key, gap] of adjacency.gaps) {
    const [a, b] = key.split("|");
    if (a && b && allowed.has(a) && allowed.has(b)) gaps.set(key, gap);
  }
  return { ids, neighbours, gaps, touchingPairCount: gaps.size };
}

export interface RouteRepair {
  order: string[];
  /** 1 = one stop moved, 2 = two stops swapped. */
  edits: number;
}

/**
 * Keep an existing order and nudge it until every flight lands next door.
 *
 * A global search answers "what is a good order?" but a project already has an
 * order — written narration, chosen opening village, a layout the editor is
 * happy with — and rewriting all of it to gain one flight is not an
 * improvement. This instead looks for the *smallest* change that removes the
 * remaining hops: move one stop, then swap two, searching near the current
 * position of each stop first so near-identical arrangements are found before
 * drastic ones.
 */
export function repairTouchingOrder(
  adjacency: ChildAdjacency,
  current: ReadonlyArray<string>,
  options: { opening?: string; allowOpeningToMove?: boolean } = {}
): RouteRepair | null {
  const order = [...current];
  const touches = (a: string, b: string): boolean => adjacency.neighbours.get(a)?.has(b) ?? false;
  const joined = (candidate: ReadonlyArray<string>): boolean => {
    for (let index = 1; index < candidate.length; index += 1) {
      if (!touches(candidate[index - 1]!, candidate[index]!)) return false;
    }
    return true;
  };
  if (joined(order)) return { order, edits: 0 };

  const opening = options.opening ?? order[0]!;
  // The opening stop is the most visible editorial choice in the tour, so a
  // repair keeps it unless the caller explicitly allows otherwise. Callers
  // reach for the relaxed pass only after a full re-plan from the same opening
  // has already failed.
  for (const pinOpening of options.allowOpeningToMove ? [true, false] : [true]) {
    for (let span = 1; span < order.length; span += 1) {
      for (let from = 0; from < order.length; from += 1) {
        const id = order[from]!;
        if (pinOpening && id === opening) continue;
        for (const to of [from - span, from + span]) {
          if (to < 0 || to >= order.length) continue;
          if (pinOpening && to === 0) continue;
          const candidate = [...order];
          candidate.splice(from, 1);
          candidate.splice(to, 0, id);
          if (joined(candidate)) return { order: candidate, edits: 1 };
        }
      }
    }

    for (let span = 1; span < order.length; span += 1) {
      for (let i = 0; i + span < order.length; i += 1) {
        const j = i + span;
        if (pinOpening && (order[i] === opening || order[j] === opening)) continue;
        const candidate = [...order];
        const left = candidate[i]!;
        candidate[i] = candidate[j]!;
        candidate[j] = left;
        if (joined(candidate)) return { order: candidate, edits: 2 };
      }
    }
  }

  return null;
}

export interface RouteStop {
  id: string;
}

/**
 * A flight between two children that do not share a boundary. Only produced
 * for regions with an enclave, an island, or a gap in the source data, and
 * always reported so the hop is a stated fact rather than a hidden one.
 */
export interface PlannedBreak {
  from: string;
  to: string;
  /** Straight-line distance between the two label points, in metres. */
  travelMeters: number;
}

/**
 * How the plan was produced, which decides how much of an existing project it
 * disturbs: `kept` and `repaired` leave the written order recognisable, while
 * `searched` and `hopped` are new arrangements.
 */
export type RouteStrategy = "kept" | "repaired" | "searched" | "hopped";

export interface TourRoutePlan {
  order: string[];
  /** Flights that are not boundary-to-boundary, with the gap they cross. */
  breaks: PlannedBreak[];
  /** Straight-line travel between consecutive label points, in metres. */
  travelMeters: number;
  touchingFlights: number;
  /** True when every flight lands in a village that shares a boundary. */
  complete: boolean;
  strategy: RouteStrategy;
  /** Stops that had to be moved to satisfy the neighbour rule (0 when kept). */
  editedStops: number;
  /** The start that was asked for, if any. */
  requestedStartId?: string;
  /** True when adjacency could not be kept from the requested start. */
  startMoved: boolean;
}

export interface PlanRouteOptions {
  /** Keep the current first stop when possible. */
  startId?: string;
  /**
   * Never move the opening stop, even when no fully touching walk can begin
   * there. The first village is an editorial anchor — the film opens on it and
   * the written narration introduces it — so a caller that wants the neighbour
   * rule to rearrange only the *rest* of the visit sets this. The walk then
   * proceeds from that stop as far as adjacency allows and reports every hop it
   * had to take, instead of quietly opening somewhere else.
   */
  pinOpening?: boolean;
  /** Label points in lon/lat, used to pick the shortest of equally legal routes. */
  points?: Map<string, Position>;
  timeBudgetMs?: number;
  /**
   * An order that already exists — written narration, a chosen opening village,
   * an arrangement the editor is happy with. When supplied it is adjusted by
   * the smallest change that satisfies the neighbour rule, and a global search
   * only runs if no such adjustment exists.
   */
  preferOrder?: ReadonlyArray<string>;
}

function travelBetween(points: Map<string, Position>, from: string, to: string): number {
  const a = points.get(from);
  const b = points.get(to);
  if (!a || !b) return 0;
  const latitude = ((a[1] + b[1]) / 2) * Math.PI / 180;
  const dx = (b[0] - a[0]) * METERS_PER_DEGREE_LATITUDE * Math.cos(latitude);
  const dy = (b[1] - a[1]) * METERS_PER_DEGREE_LATITUDE;
  return Math.hypot(dx, dy);
}

const totalTravel = (points: Map<string, Position>, order: ReadonlyArray<string>): number => {
  let sum = 0;
  for (let index = 1; index < order.length; index += 1) {
    sum += travelBetween(points, order[index - 1]!, order[index]!);
  }
  return sum;
};

const touching = (adjacency: ChildAdjacency, a: string, b: string): boolean =>
  adjacency.neighbours.get(a)?.has(b) ?? false;

/**
 * A visit order in which every flight lands next door.
 *
 * Four answers are tried in order of how little they disturb the editor's own
 * arrangement, and the first that works wins:
 *
 *   1. the order already works, or moving one or two stops makes it work, with
 *      the opening stop untouched (`kept` / `repaired`)
 *   2. a new walk searched *from* the opening stop (`searched`)
 *   3. moving one or two stops, this time allowing the opening to move — still
 *      a repair, and much closer to what was written than a fresh plan
 *      (`repaired`, `startMoved`)
 *   4. a new walk from any stop the touching graph lets a walk begin at
 *      (`searched`, `startMoved`)
 *
 * and only when none of those is fully touching does it hop (`hopped`).
 *
 * `pinOpening` cuts that ladder short: stages 3 and 4 are the only ones that can
 * move the opening, so with it on they are skipped and the walk simply starts at
 * the pinned stop and hops where adjacency runs out. The first village then
 * stays first no matter what the boundary graph allows.
 *
 * The search itself is Warnsdorff-ordered depth-first with backtracking: at
 * each step it tries the unvisited neighbour with the fewest remaining onward
 * options first, which is what keeps a tail village from being stranded with no
 * legal step left. On a real township this is the difference between "greedy
 * walks into a corner" and a complete route — 乌石镇's 25 villages admit a fully
 * touching order, and this finds one from 19 of the 25 possible openings.
 *
 * Once a complete route exists, 2-opt trims its total length without ever
 * breaking adjacency: reversing a span only rewires its two ends, so the
 * candidate is legal exactly when those two new joins still touch. It never
 * reverses a span that includes the opening, because that stop was chosen, not
 * computed.
 */
export function planTouchingRoute(
  adjacency: ChildAdjacency,
  options: PlanRouteOptions = {}
): TourRoutePlan {
  const points = options.points ?? new Map<string, Position>();
  const timeBudgetMs = options.timeBudgetMs ?? 4_000;
  const ids = adjacency.ids;
  if (ids.length < 2) {
    return {
      order: [...ids], breaks: [], travelMeters: 0, touchingFlights: 0, complete: true,
      strategy: "kept", editedStops: 0, startMoved: false
    };
  }

  const degree = (id: string): number => adjacency.neighbours.get(id)?.size ?? 0;
  const deadline = Date.now() + timeBudgetMs;
  /** Per-start slice of the budget; reassigned before each candidate start. */
  let searchDeadline = deadline;
  let completeRoute: string[] | null = null;

  // An existing order is adjusted rather than replaced, and if it already
  // satisfies the neighbour rule it is returned untouched — the cheapest and
  // least disruptive answer is usually "leave the arrangement alone".
  const usablePreference = options.preferOrder
    && options.preferOrder.length === ids.length
    && new Set(options.preferOrder).size === ids.length
    && options.preferOrder.every((id) => adjacency.neighbours.has(id))
    ? options.preferOrder
    : undefined;
  // The opening stop is whatever the caller asked for, defaulting to the one
  // the existing order already begins with.
  const desiredStart = options.startId ?? usablePreference?.[0];
  const requested = desiredStart && adjacency.neighbours.has(desiredStart) ? desiredStart : undefined;
  const opening = usablePreference?.[0];
  // A pinned opening may not be replaced by anything below, including a repair
  // that happens to start the order at a different village.
  const pinnedStart = options.pinOpening === true ? (requested ?? opening) : undefined;
  const anchor = requested ?? opening;
  // A repair keeps `opening` at index 0, so it can only be used for a pinned
  // start when that start *is* the order's own first stop.
  const repairApplies = Boolean(usablePreference && opening)
    && (!pinnedStart || !anchor || anchor === opening);
  if (usablePreference && opening && repairApplies) {
    const repaired = repairTouchingOrder(adjacency, usablePreference, { opening });
    if (repaired) {
      return {
        order: repaired.order,
        breaks: [],
        travelMeters: totalTravel(points, repaired.order),
        touchingFlights: repaired.order.length - 1,
        complete: true,
        strategy: repaired.edits === 0 ? "kept" : "repaired",
        editedStops: repaired.edits,
        ...(requested ? { requestedStartId: requested } : {}),
        startMoved: Boolean(requested) && repaired.order[0] !== requested
      };
    }
  }

  // Endpoints of the touching graph are the natural place to start a walk, and
  // they are few. Trying several low-degree starts keeps the search honest for
  // regions whose graph has no leaves (e.g. one closed ring of villages).
  const automaticStarts: string[] = (() => {
    const ordered = [...ids].sort((a, b) => degree(a) - degree(b) || a.localeCompare(b));
    const lowest = ordered[0];
    if (lowest === undefined) return [];
    return ordered.slice(0, Math.max(1, Math.min(ordered.length, degree(lowest) <= 2 ? 12 : 4)));
  })();
  // The caller's opening is tried first and on its own, so a fully touching
  // route that still starts where the editor asked for one is always found
  // before any alternative is considered. The low-degree starts below are only
  // reached once the opening has been given up on.
  const budgetPerStart = Math.max(
    750,
    Math.floor(timeBudgetMs / Math.max(1, automaticStarts.length + (anchor ? 1 : 0)))
  );

  // Pruning: from here on the walk may only step next door, so the unvisited
  // children must still form one connected piece reachable from where we
  // stand. The moment they don't, no continuation can reach them all and the
  // whole subtree is dead. This is what makes the search finish instead of
  // wandering through permutations for the whole budget.
  const reachable = (from: string, visited: Set<string>): boolean => {
    let unvisited = 0;
    for (const id of ids) if (!visited.has(id)) unvisited += 1;
    if (unvisited === 0) return true;
    const seen = new Set<string>([from]);
    const stack = [from];
    while (stack.length) {
      const node = stack.pop()!;
      for (const neighbour of adjacency.neighbours.get(node) ?? []) {
        if (visited.has(neighbour) || seen.has(neighbour)) continue;
        seen.add(neighbour);
        stack.push(neighbour);
      }
    }
    return seen.size - 1 === unvisited;
  };

  const search = (path: string[], visited: Set<string>): boolean => {
    if (path.length === ids.length) return true;
    if (Date.now() > searchDeadline) return false;
    const current = path[path.length - 1]!;
    const options_ = [...(adjacency.neighbours.get(current) ?? [])]
      .filter((id) => !visited.has(id))
      .map((id) => ({ id, onward: [...(adjacency.neighbours.get(id) ?? [])].filter((other) => !visited.has(other)).length }))
      .sort((a, b) =>
        a.onward - b.onward
        || travelBetween(points, current, a.id) - travelBetween(points, current, b.id)
        || a.id.localeCompare(b.id));
    for (const candidate of options_) {
      visited.add(candidate.id);
      path.push(candidate.id);
      if (reachable(candidate.id, visited) && search(path, visited)) return true;
      path.pop();
      visited.delete(candidate.id);
    }
    return false;
  };

  const searchFrom = (start: string): string[] | null => {
    searchDeadline = Date.now() + budgetPerStart;
    const path = [start];
    return search(path, new Set(path)) ? path : null;
  };

  // Stage 1 — a fully touching walk that still opens where the editor wanted.
  if (anchor) completeRoute = searchFrom(anchor);

  // Stage 2 — that opening admits no such walk. Changing it while moving as few
  // stops as possible is still a repair of the editor's arrangement, and is far
  // less disruptive than re-planning the whole visit from a village they did
  // not choose. This runs before stage 3 on purpose: a route that starts
  // somewhere else entirely is a new arrangement, and a one-stop edit that
  // happens to move the opening is not. Pinned openings skip it: this stage
  // exists to move the opening, which is exactly what may not happen.
  if (!completeRoute && !pinnedStart && usablePreference && opening) {
    const relaxed = repairTouchingOrder(adjacency, usablePreference, { opening, allowOpeningToMove: true });
    if (relaxed) {
      return {
        order: relaxed.order,
        breaks: [],
        travelMeters: totalTravel(points, relaxed.order),
        touchingFlights: relaxed.order.length - 1,
        complete: true,
        strategy: "repaired",
        editedStops: relaxed.edits,
        ...(requested ? { requestedStartId: requested } : {}),
        startMoved: relaxed.order[0] !== anchor
      };
    }
  }

  // Stage 3 — no small adjustment exists either, so the visit is planned from
  // scratch, opening wherever the touching graph actually allows a walk to
  // begin. This is the only stage that discards the written order, and the one
  // that replaces the opening, so a pinned opening rules it out.
  if (!completeRoute && !pinnedStart) {
    for (const start of automaticStarts) {
      if (Date.now() > deadline) break;
      const path = searchFrom(start);
      if (path) { completeRoute = path; break; }
    }
  }

  // Stage 4 — no fully touching walk exists from the opening at all. The greedy
  // fallback below steps next door until it strands itself and only then jumps,
  // which on a real township costs one jump more than the geography requires:
  // pinned to 城月村, 城月镇 needs exactly one jump but greedy takes two. So the
  // fewest jumps are searched from 1 upwards. The bound that makes it finish is
  // the number of components the unvisited villages fall into — a jump enters
  // exactly one of them, so any surplus over the remaining budget is dead.
  const componentsOf = (pending: ReadonlyArray<string>): string[][] => {
    const left = new Set(pending);
    const found: string[][] = [];
    for (const seed of pending) {
      if (!left.has(seed)) continue;
      const group: string[] = [];
      const stack = [seed];
      left.delete(seed);
      while (stack.length) {
        const node = stack.pop()!;
        group.push(node);
        for (const next of adjacency.neighbours.get(node) ?? []) {
          if (!left.has(next)) continue;
          left.delete(next);
          stack.push(next);
        }
      }
      found.push(group);
    }
    return found;
  };

  const searchWithHops = (
    start: string,
    maxHops: number
  ): { path: string[]; hops: Array<[string, string]> } | null => {
    const path = [start];
    const visited = new Set(path);
    const hops: Array<[string, string]> = [];
    const walk = (): boolean => {
      if (path.length === ids.length) return true;
      if (Date.now() > searchDeadline) return false;
      const current = path[path.length - 1]!;
      const pending = ids.filter((id) => !visited.has(id));
      const groups = componentsOf(pending);
      if (groups.length) {
        const enterable = groups.filter((group) => group.some((id) => touching(adjacency, current, id))).length;
        if (hops.length + groups.length - Math.min(1, enterable) > maxHops) return false;
      }
      const onward = (id: string): number =>
        [...(adjacency.neighbours.get(id) ?? [])].filter((other) => !visited.has(other)).length;
      // Next-door villages are tried first, in Warnsdorff order; a jump is only
      // considered once the touching edges run out or the hop budget allows it.
      const candidates = pending
        .map((id) => ({ id, hop: !touching(adjacency, current, id) }))
        .filter((candidate) => !candidate.hop || hops.length < maxHops);
      candidates.sort((a, b) =>
        Number(a.hop) - Number(b.hop)
        || onward(a.id) - onward(b.id)
        || travelBetween(points, current, a.id) - travelBetween(points, current, b.id)
        || a.id.localeCompare(b.id));
      for (const candidate of candidates) {
        if (candidate.hop) hops.push([current, candidate.id]);
        visited.add(candidate.id);
        path.push(candidate.id);
        if (walk()) return true;
        path.pop();
        visited.delete(candidate.id);
        if (candidate.hop) hops.pop();
      }
      return false;
    };
    return walk() ? { path: [...path], hops: [...hops] } : null;
  };

  let hoppedRoute: { path: string[]; hops: Array<[string, string]> } | null = null;
  if (!completeRoute && anchor) {
    for (let budget = 1; budget <= 3 && !hoppedRoute; budget += 1) {
      if (Date.now() > deadline) break;
      searchDeadline = Math.min(deadline, Date.now() + Math.max(600, Math.floor(timeBudgetMs / 4)));
      hoppedRoute = searchWithHops(anchor, budget);
    }
  }

  let order: string[];
  let breaks: PlannedBreak[];
  let strategy: RouteStrategy;
  // Only repairing moves stops; a searched or hopped route is a new arrangement
  // rather than an edit of the old one.
  const editedStops = 0;
  if (completeRoute) {
    order = completeRoute;
    breaks = [];
    strategy = "searched";
  } else if (hoppedRoute) {
    // Fewer jumps than the greedy walk would take, from the same opening.
    order = hoppedRoute.path;
    breaks = hoppedRoute.hops.map(([from, to]) => ({
      from,
      to,
      travelMeters: travelBetween(points, from, to)
    }));
    strategy = "hopped";
  } else {
    // No fully touching order exists (an enclave, an island, or a child whose
    // neighbours are all already visited). Walk as far as adjacency allows and
    // hop to the nearest unvisited child, recording every hop so the gap is
    // never silent.
    order = [];
    breaks = [];
    strategy = "hopped";
    const visited = new Set<string>();
    // A pinned opening starts the walk even when no fully touching route can
    // begin there; that is the whole point of pinning it.
    let current = anchor ?? [...ids].sort((a, b) => degree(a) - degree(b))[0]!;
    order.push(current);
    visited.add(current);
    while (visited.size < ids.length) {
      const onward = [...(adjacency.neighbours.get(current) ?? [])].filter((id) => !visited.has(id));
      let next: string;
      if (onward.length) {
        next = onward.sort((a, b) =>
          [...(adjacency.neighbours.get(a) ?? [])].filter((id) => !visited.has(id)).length
          - [...(adjacency.neighbours.get(b) ?? [])].filter((id) => !visited.has(id)).length
          || travelBetween(points, current, a) - travelBetween(points, current, b))[0]!;
      } else {
        next = [...ids].filter((id) => !visited.has(id))
          .sort((a, b) => travelBetween(points, current, a) - travelBetween(points, current, b))[0]!;
        breaks.push({ from: current, to: next, travelMeters: travelBetween(points, current, next) });
      }
      order.push(next);
      visited.add(next);
      current = next;
    }
  }

  // 2-opt: reversal preserves every internal join, so only the two new end
  // joins can break adjacency. Reject any move that would. Only a searched
  // route is trimmed this way — a repaired one is deliberately left close to
  // what the editor wrote, and shortening it would undo that.
  //
  // `i` starts at 1 because a span containing index 0 would move the opening
  // stop. That is not a length judgement: the opening is an editorial choice,
  // the walk above was searched *from* that stop precisely to honour it, and
  // silently flipping it away for a shorter route both loses the choice and
  // makes the plan report an opening the search never chose.
  if (strategy === "searched" && order.length > 3) {
    const stopAt = Date.now() + Math.max(500, Math.floor(timeBudgetMs / 2));
    let improved = true;
    while (improved && Date.now() < stopAt) {
      improved = false;
      for (let i = 1; i < order.length - 1; i += 1) {
        for (let j = i + 1; j < order.length; j += 1) {
          const before = order[i - 1];
          const after = order[j + 1];
          if (before && !touching(adjacency, before, order[j]!)) continue;
          if (after && !touching(adjacency, order[i]!, after)) continue;
          const currentSpan = (before ? travelBetween(points, before, order[i]!) : 0)
            + (after ? travelBetween(points, order[j]!, after) : 0);
          const reversedSpan = (before ? travelBetween(points, before, order[j]!) : 0)
            + (after ? travelBetween(points, order[i]!, after) : 0);
          if (reversedSpan + 1e-6 < currentSpan) {
            const span = order.slice(i, j + 1).reverse();
            order = [...order.slice(0, i), ...span, ...order.slice(j + 1)];
            improved = true;
          }
        }
      }
    }
  }

  return {
    order,
    breaks,
    travelMeters: totalTravel(points, order),
    touchingFlights: order.length - 1 - breaks.length,
    complete: breaks.length === 0,
    strategy,
    editedStops,
    ...(requested ? { requestedStartId: requested } : {}),
    startMoved: Boolean(requested) && order[0] !== requested
  };
}

/** GeoJSON shape accepted by `childBoundariesFromGeoJson`. */
export interface ChildGeoJson {
  features: ReadonlyArray<{
    properties?: { id?: unknown; name?: unknown } | null;
    geometry?: { type?: string; coordinates?: unknown } | null;
  }>;
}

export function childBoundariesFromGeoJson(geoJson: ChildGeoJson): ChildBoundary[] {
  const boundaries: ChildBoundary[] = [];
  for (const feature of geoJson.features) {
    const id = feature.properties?.id;
    const geometry = feature.geometry;
    if (id === undefined || id === null || !geometry?.coordinates) continue;
    const type = geometry.type ?? "Polygon";
    const raw = geometry.coordinates as unknown;
    const polygons = type === "MultiPolygon"
      ? (raw as Position[][][])
      : [raw as Position[][]];
    const rings: Ring[] = [];
    for (const polygon of polygons) for (const ring of polygon) rings.push(ring);
    const name = feature.properties?.name;
    boundaries.push({
      id: String(id),
      rings,
      ...(typeof name === "string" ? { name } : {})
    });
  }
  return boundaries;
}
