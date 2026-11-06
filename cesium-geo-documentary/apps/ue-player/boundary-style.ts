import earcut, { flatten } from 'earcut';
export function triangulateFeature(feature:any) {
  const geometry=feature.geometry;
  const polygons=geometry?.type==='Polygon'?[geometry.coordinates]:geometry?.type==='MultiPolygon'?geometry.coordinates:[];
  return polygons.map((polygon:number[][][])=>{
    const {vertices,holes,dimensions}=flatten(polygon);
    return {vertices,indices:earcut(vertices,holes,dimensions),dimensions};
  });
}

export function interiorLabelPoint(triangles: ReturnType<typeof triangulateFeature>, preferred: unknown) {
  const point = Array.isArray(preferred) && Number.isFinite(preferred[0]) && Number.isFinite(preferred[1])
    ? [Number(preferred[0]), Number(preferred[1])] as const : undefined;
  let fallback: [number, number] | undefined;
  let bestRadius = 0;
  for (const { vertices, indices, dimensions } of triangles) {
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
        if (u >= 0 && v >= 0 && u + v <= 1) return point;
      }
      // Use the incenter of the roomiest triangle as the fallback. The
      // triangulation already excludes holes and keeps detached islands apart.
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
  return fallback ?? point;
}

export function boundaryAnimation(mapTime:number,start:number,current:string) {
  const elapsed=mapTime-start;
  const progress=Math.max(0,Math.min(1,elapsed/1.25));
  const end=Math.max(0,Math.min(1,(elapsed-1.1)/.35));
  return {target:current,progress,alpha:elapsed>=0 && elapsed<1.45?1-end*end*(3-2*end):0};
}
