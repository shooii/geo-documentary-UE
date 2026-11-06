import earcut, { flatten } from 'earcut';
export function triangulateFeature(feature:any) {
  const geometry=feature.geometry;
  const polygons=geometry?.type==='Polygon'?[geometry.coordinates]:geometry?.type==='MultiPolygon'?geometry.coordinates:[];
  return polygons.map((polygon:number[][][])=>{
    const {vertices,holes,dimensions}=flatten(polygon);
    return {vertices,indices:earcut(vertices,holes,dimensions),dimensions};
  });
}
export function boundaryAnimation(mapTime:number,start:number,current:string) {
  const elapsed=mapTime-start;
  const progress=Math.max(0,Math.min(1,elapsed/1.25));
  const end=Math.max(0,Math.min(1,(elapsed-1.1)/.35));
  return {target:current,progress,alpha:elapsed>=0 && elapsed<1.45?1-end*end*(3-2*end):0};
}
