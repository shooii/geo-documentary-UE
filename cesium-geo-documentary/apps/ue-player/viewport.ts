import { portraitOverviewExtent } from './framing.js';
import { fitBoundaryCamera, isAutomaticCamera } from '../../packages/geo-camera/index.js';
export const outputSizes = { portrait:[1080,1920], landscape:[1920,1080], square:[1080,1080] } as const;

export function fitRegionProfiles(region:any, geometry:unknown) {
  const extent=portraitOverviewExtent(region.bbox,geometry);
  if(!extent)return region;
  const profiles={...region.cameraProfiles};
  for(const [name,[width,height]] of Object.entries(outputSizes)) {
    const preset=profiles[name] || region.cameraPreset;
    if(!preset)continue;
    const points=extent.points.map(p=>[extent.longitude+p.east/(111320*Math.cos(extent.latitude*Math.PI/180)),extent.latitude+p.north/110570] as const);
    // 已有自动镜头一旦被用户编辑，也与显式 custom 一样保留。
    if(preset.framing && !isAutomaticCamera(preset))continue;
    profiles[name]=fitBoundaryCamera({...preset,heading:Number(preset.heading??0),pitch:Number(preset.pitch??-64)},region.bbox,width/height,points);
  }
  return {...region,cameraProfiles:profiles};
}

// Ramer-Douglas-Peucker in local ground metres. Original geometry stays intact
// for bounds/fitting; only the render copy is reduced to a sub-pixel tolerance.
export function simplifyRing(ring:number[][], toleranceMeters:number):number[][] {
  if(ring.length<4)return ring;
  const latitude=ring.reduce((sum,p)=>sum+p[1]!,0)/ring.length;
  const sx=111320*Math.cos(latitude*Math.PI/180),sy=110570;
  const keep=new Uint8Array(ring.length);keep[0]=keep[ring.length-1]=1;
  const stack:[number,number][]=[[0,ring.length-1]],limit=toleranceMeters*toleranceMeters;
  while(stack.length){
    const [a,b]=stack.pop()!;const A=ring[a]!,B=ring[b]!;
    const dx=(B[0]!-A[0]!)*sx,dy=(B[1]!-A[1]!)*sy,length=dx*dx+dy*dy;
    let far=-1,best=limit;
    for(let i=a+1;i<b;i++){
      const p=ring[i]!,px=(p[0]!-A[0]!)*sx,py=(p[1]!-A[1]!)*sy;
      const t=length?Math.max(0,Math.min(1,(px*dx+py*dy)/length)):0;
      const distance=(px-t*dx)**2+(py-t*dy)**2;
      if(distance>best){best=distance;far=i;}
    }
    if(far>=0){keep[far]=1;stack.push([a,far],[far,b]);}
  }
  const result=ring.filter((_,i)=>keep[i]);return result.length>=4?result:ring;
}
export function renderLayers(layers:any[], range:number) {
  const tolerance=Math.max(.25,Math.min(8,range*.000035));
  return layers.map(feature=>{
    const geometry=feature.geometry;if(!geometry)return feature;
    const polygon=(rings:number[][][])=>rings.map(ring=>simplifyRing(ring,tolerance));
    return {...feature,geometry:{...geometry,coordinates:geometry.type==='Polygon'?polygon(geometry.coordinates):geometry.type==='MultiPolygon'?geometry.coordinates.map(polygon):geometry.coordinates}};
  });
}
