import earcut, { flatten } from 'earcut';
export function triangulateFeature(feature:any) {
  const geometry=feature.geometry;
  const polygons=geometry?.type==='Polygon'?[geometry.coordinates]:geometry?.type==='MultiPolygon'?geometry.coordinates:[];
  return polygons.map((polygon:number[][][])=>{
    const {vertices,holes,dimensions}=flatten(polygon);
    return {vertices,indices:earcut(vertices,holes,dimensions),dimensions};
  });
}

type Ring = number[][];
type Polygon = Ring[];
type Point = [number, number];
type PointResult = { point: Point; distance: number };

function geometryPolygons(input: any): Polygon[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.flatMap(item => geometryPolygons(item));
  if (input.type === 'FeatureCollection' && Array.isArray(input.features)) {
    return input.features.flatMap((feature: any) => geometryPolygons(feature?.geometry ?? feature));
  }
  if (input.type === 'Feature') return geometryPolygons(input.geometry);
  if (input.type === 'Polygon' && Array.isArray(input.coordinates)) return [input.coordinates as Polygon];
  if (input.type === 'MultiPolygon' && Array.isArray(input.coordinates)) return input.coordinates as Polygon[];
  return [];
}

function pointInRing(x: number, y: number, ring: Ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!, yi = ring[i]![1]!;
    const xj = ring[j]![0]!, yj = ring[j]![1]!;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(x: number, y: number, polygon: Polygon) {
  if (!pointInRing(x, y, polygon[0]!)) return false;
  for (let i = 1; i < polygon.length; i++) if (pointInRing(x, y, polygon[i]!)) return false;
  return true;
}

function segmentDistanceSq(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq)) : 0;
  const qx = ax + dx * t, qy = ay + dy * t;
  return (px - qx) ** 2 + (py - qy) ** 2;
}

function signedDistance(x: number, y: number, polygon: Polygon) {
  let nearest = Infinity;
  for (const ring of polygon) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
      nearest = Math.min(nearest, segmentDistanceSq(x, y, a[0]!, a[1]!, b[0]!, b[1]!));
    }
  }
  return pointInPolygon(x, y, polygon) ? Math.sqrt(nearest) : -Math.sqrt(nearest);
}

function poleOfInaccessibility(polygon: Polygon): PointResult | undefined {
  const outer = polygon[0];
  if (!outer || outer.length < 3) return undefined;
  const meanLat = outer.reduce((sum, p) => sum + p[1]!, 0) / outer.length;
  const xScale = Math.max(1e-6, Math.cos(meanLat * Math.PI / 180));
  const local = polygon.map(ring => ring.map(([lon, lat]) => [lon! * xScale, lat!] as [number, number]));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of local[0]!) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const width = maxX - minX, height = maxY - minY;
  if (!(width > 0 && height > 0)) return undefined;
  const step = Math.min(width, height);
  const precision = Math.max(1e-7, step / 2000);
  const cells: { x: number; y: number; h: number; d: number; max: number }[] = [];
  const push = (cell: { x: number; y: number; h: number; d: number; max: number }) => {
    cells.push(cell);
    let i = cells.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (cells[parent]!.max >= cells[i]!.max) break;
      [cells[parent], cells[i]] = [cells[i]!, cells[parent]!];
      i = parent;
    }
  };
  const pop = () => {
    const top = cells[0]!;
    const last = cells.pop()!;
    if (cells.length) {
      cells[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1, right = left + 1;
        let largest = i;
        if (left < cells.length && cells[left]!.max > cells[largest]!.max) largest = left;
        if (right < cells.length && cells[right]!.max > cells[largest]!.max) largest = right;
        if (largest === i) break;
        [cells[i], cells[largest]] = [cells[largest]!, cells[i]!];
        i = largest;
      }
    }
    return top;
  };
  for (let x = minX + step / 2; x < maxX; x += step) {
    for (let y = minY + step / 2; y < maxY; y += step) {
      const d = signedDistance(x, y, local);
      const max = d + step * Math.SQRT1_2;
      if (max > 0) push({ x, y, h: step, d, max });
    }
  }
  let best: { x: number; y: number; d: number } | undefined;
  let iterations = 0;
  while (cells.length && iterations++ < 8000) {
    const cell = pop();
    if (!best || cell.d > best.d) best = { x: cell.x, y: cell.y, d: cell.d };
    if (cell.max - (best?.d ?? -Infinity) <= precision) continue;
    const h = cell.h / 2;
    for (const [dx, dy] of [[-h, -h], [h, -h], [-h, h], [h, h]] as const) {
      const x = cell.x + dx, y = cell.y + dy;
      const d = signedDistance(x, y, local);
      const max = d + h * Math.SQRT1_2;
      if (!best || max > best.d) push({ x, y, h, d, max });
    }
  }
  if (!best || best.d < 0) return undefined;
  return { point: [best.x / xScale, best.y], distance: best.d };
}

export function interiorLabelPoint(input: any, preferred?: unknown): Point | undefined {
  const polygons = geometryPolygons(input);
  if (polygons.length) {
    let best: PointResult | undefined;
    for (const polygon of polygons) {
      const result = poleOfInaccessibility(polygon);
      if (result && (!best || result.distance > best.distance)) best = result;
    }
    if (best) return best.point;
    if (Array.isArray(preferred) && Number.isFinite(preferred[0]) && Number.isFinite(preferred[1]))
      return [Number(preferred[0]), Number(preferred[1])];
  }

  // Compatibility path for callers that still pass triangulations instead of geometry.
  const triangles = Array.isArray(input) ? input as ReturnType<typeof triangulateFeature> : [];
  const point = Array.isArray(preferred) && Number.isFinite(preferred[0]) && Number.isFinite(preferred[1])
    ? [Number(preferred[0]), Number(preferred[1])] as const : undefined;
  let fallback: [number, number] | undefined;
  let bestRadius = 0;
  for (const { vertices, indices, dimensions } of (triangles || []).filter((mesh: any) => !!mesh)) {
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const a = indices[i]! * dimensions, b = indices[i + 1]! * dimensions, c = indices[i + 2]! * dimensions;
      const ax = vertices[a]!, ay = vertices[a + 1]!;
      const bx = vertices[b]! - ax, by = vertices[b + 1]! - ay;
      const cx = vertices[c]! - ax, cy = vertices[c + 1]! - ay;
      const area = bx * cy - by * cx;
      if (!area) continue;
      if (point) {
        const px = point[0] - ax, py = point[1] - ay;
        const u = (px * cy - py * cx) / area, v = (bx * py - by * px) / area;
        if (u >= 0 && v >= 0 && u + v <= 1) return [point[0], point[1]];
      }
      const longitudeScale = Math.cos(ay * Math.PI / 180);
      const wa = Math.hypot((bx - cx) * longitudeScale, by - cy);
      const wb = Math.hypot(cx * longitudeScale, cy);
      const wc = Math.hypot(bx * longitudeScale, by);
      const perimeter = wa + wb + wc;
      const radius = Math.abs(area * longitudeScale) / perimeter;
      if (radius <= bestRadius) continue;
      bestRadius = radius;
      fallback = [ax + (wb * bx + wc * cx) / perimeter, ay + (wb * by + wc * cy) / perimeter];
    }
  }
  return fallback ?? (point ? [point[0], point[1]] : undefined);
}

// The sweep is the entrance: one bright pass the moment the camera lands. A village
// shot then holds for several seconds, and with a single pass the rim went dead for
// the rest of it. After the sweep the same beam keeps orbiting the same rim, dimmer
// and slower, so the boundary of the village being toured is always alive.
const ORBIT_PERIOD=3.4;
export function boundaryAnimation(mapTime:number,start:number,current:string) {
  const elapsed=mapTime-start;
  const progress=Math.max(0,Math.min(1,elapsed/1.25));
  const end=Math.max(0,Math.min(1,(elapsed-1.1)/.35));
  const sweep=elapsed>=0&&elapsed<1.45?1-end*end*(3-2*end):0;
  const orbit=elapsed-1.45;
  // Only a child has a rim worth circling: `current` is empty on the opening shot and
  // once the tour is over, and the beam must not keep running around the town after it.
  if(!current||orbit<0) return {target:current,progress,alpha:sweep};
  // The ring is closed, so wrapping 1 -> 0 puts the head back where it started and the
  // orbit reads as continuous.
  return {target:current,progress:(orbit%ORBIT_PERIOD)/ORBIT_PERIOD,alpha:.62};
}