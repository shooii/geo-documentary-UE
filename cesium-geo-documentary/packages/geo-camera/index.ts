export type GeoBounds = readonly [west: number, south: number, east: number, north: number];
export interface GeoCameraPreset {
  longitude: number; latitude: number; height: number; heading: number; pitch: number; roll?: number;
}
/** 归一化画幅坐标，原点在左上角；字幕和固定素材窗口只能预先收缩此矩形。 */
export interface CameraSafeFrame { left: number; top: number; right: number; bottom: number }
export interface AutoCameraFraming {
  mode: 'auto'; bounds: GeoBounds; reference: GeoCameraPreset;
  points?: readonly (readonly [number, number])[];
  safeFrame?: CameraSafeFrame;
}
export interface FramedCamera extends GeoCameraPreset { framing?: AutoCameraFraming | { mode: 'custom' } | undefined }
// 成片字幕中心在画面75%，单行上缘约72%；边界止于70%留出间隔。
export const DEFAULT_CAMERA_SAFE_FRAME: CameraSafeFrame = { left: .09, top: .09, right: .91, bottom: .70 };
const sx = (latitude: number) => 111320 * Math.cos(latitude * Math.PI / 180);
const sy = 110570;
function validateBounds(bounds: GeoBounds): GeoBounds {
  const [w,s,e,n] = bounds;
  if (![w,s,e,n].every(Number.isFinite) || e <= w || n <= s || w < -180 || e > 180 || s <= -90 || n >= 90) throw new Error('无效的取景边界');
  return bounds;
}
/** 仅外环参与取景，多块边界全部保留。 */
export function boundaryCameraPoints(geometry: { type?: string; coordinates?: any; geometry?: any; features?: any[] }): Array<readonly [number, number]> {
  if (geometry.type === 'FeatureCollection') return (geometry.features ?? []).flatMap(boundaryCameraPoints);
  if (geometry.type === 'Feature') return geometry.geometry ? boundaryCameraPoints(geometry.geometry) : [];
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.flatMap((polygon: number[][][]) => (polygon[0] ?? []).filter(pair=>Number.isFinite(pair[0]) && Number.isFinite(pair[1])).map(pair=>[pair[0]!,pair[1]!] as const));
}
export function cameraFrustumTangents(aspect = 1080 / 1920) {
  if (!Number.isFinite(aspect) || aspect <= 0) throw new Error('无效的画幅比例');
  const tangent = Math.tan(Math.PI / 6);
  return aspect >= 1 ? { horizontal: tangent, vertical: tangent / aspect } : { horizontal: tangent * aspect, vertical: tangent };
}
/** 按实际长边60°视锥拟合完整边界，height为注视点到相机的斜距。 */
export function fitBoundaryCamera<T extends GeoCameraPreset>(preset: T, bounds: GeoBounds, aspect = 1080 / 1920, points?: readonly (readonly [number, number])[], safe = DEFAULT_CAMERA_SAFE_FRAME): T {
  const [w,s,e,n] = validateBounds(bounds);
  if (![safe.left,safe.top,safe.right,safe.bottom].every(Number.isFinite) || !(safe.left >= 0 && safe.left < .5 && safe.right > .5 && safe.right <= 1 && safe.top >= 0 && safe.top < .5 && safe.bottom > .5 && safe.bottom <= 1)) throw new Error('安全区必须包含画幅中心');
  if (![preset.longitude,preset.latitude,preset.height,preset.heading,preset.pitch,preset.roll ?? 0].every(Number.isFinite) || preset.height <= 0 || preset.pitch >= 0 || preset.pitch < -90) throw new Error('自动取景相机必须为有限数且朝向地面');
  // UE 当前协议不渲染 roll；不能将有滚转的镜头误标为已安全拟合。
  if ((preset.roll ?? 0) % 360 !== 0) throw new Error('自动取景不支持非零 roll，请使用自定义镜头');
  const longitude = (w+e)/2, latitude = (s+n)/2;
  const heading = preset.heading * Math.PI/180, pitch = Math.abs(preset.pitch)*Math.PI/180;
  const sin = Math.sin(pitch), cos = Math.cos(pitch), tangents = cameraFrustumTangents(aspect);
  const source = points?.length ? points : [[w,s],[e,s],[e,n],[w,n]];
  if (!source.every(([lon,lat])=>Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon!) <= 180 && Math.abs(lat!) < 90)) throw new Error('无效的取景顶点');
  const local = source.map(([lon,lat]) => {
    const east = (lon!-longitude)*sx(latitude), north = (lat!-latitude)*sy;
    return { x: east*Math.cos(heading)-north*Math.sin(heading), y: north*Math.cos(heading)+east*Math.sin(heading) };
  });
  const left=2*safe.left-1, right=2*safe.right-1, bottom=1-2*safe.bottom, top=1-2*safe.top;
  const centerX=(left+right)/2, centerY=(top+bottom)/2;
  let tx=0, ty=0, range=1800;
  for(let iteration=0;iteration<100;iteration++) {
    range=1800;
    for(const p of local) {
      const x=p.x-tx,y=p.y-ty;
      range=Math.max(range,x/(tangents.horizontal*(x<0?left:right))-y*cos,y*sin/(tangents.vertical*(y<0?bottom:top))-y*cos);
    }
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    for(const p of local) {
      const depth=range+(p.y-ty)*cos;
      const x=(p.x-tx)/(depth*tangents.horizontal),y=(p.y-ty)*sin/(depth*tangents.vertical);
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
    }
    const dx=(minX+maxX)/2-centerX,dy=(minY+maxY)/2-centerY;
    if(Math.hypot(dx,dy)<1e-7 || iteration===99)break;
    tx+=.65*dx*range*tangents.horizontal;
    if(sin>1e-6)ty+=.65*dy*range*tangents.vertical/sin;
  }
  range=Math.ceil(range);
  if (![tx,ty,range].every(Number.isFinite) || range <= 0) throw new Error('自动取景未得到有限相机');
  for(const p of local) {
    const depth=range+(p.y-ty)*cos;
    const x=(p.x-tx)/(depth*tangents.horizontal),y=(p.y-ty)*sin/(depth*tangents.vertical);
    if (!(depth>0) || ![x,y].every(Number.isFinite) || x<left-1e-7 || x>right+1e-7 || y<bottom-1e-7 || y>top+1e-7) throw new Error('自动取景未收敛到安全区');
  }
  const east=tx*Math.cos(heading)+ty*Math.sin(heading),north=ty*Math.cos(heading)-tx*Math.sin(heading);
  const result={...preset,longitude:longitude+east/sx(latitude),latitude:latitude+north/sy,height:range};
  if (![result.longitude,result.latitude].every(Number.isFinite) || Math.abs(result.longitude)>180 || Math.abs(result.latitude)>=90) throw new Error('自动取景目标超出有效坐标');
  return result;
}
export function portraitChildCameraHeight(bounds: GeoBounds): number {
  return fitBoundaryCamera({longitude:0,latitude:0,height:1800,heading:0,pitch:-64},bounds).height;
}
export function portraitChildCameraPreset<T extends GeoCameraPreset>(preset: T, bounds?: GeoBounds): T {
  return bounds ? fitBoundaryCamera(preset,bounds) : {...preset};
}
export function automaticChildCamera<T extends GeoCameraPreset>(preset:T,bounds?:GeoBounds,points?:readonly (readonly [number,number])[]): T & { framing?: AutoCameraFraming } {
  const camera=bounds ? fitBoundaryCamera(preset,bounds,9/16,points) : {...preset};
  return bounds ? {...camera,framing:{mode:'auto',bounds,...(points?.length?{points}:{}),reference:{longitude:camera.longitude,latitude:camera.latitude,height:camera.height,heading:camera.heading,pitch:camera.pitch,...(camera.roll===undefined?{}:{roll:camera.roll})}}} : camera;
}
/** 旧项目无标记镜头，以及被编辑过的自动镜头，均按用户镜头保留。 */
export function isAutomaticCamera(camera: FramedCamera): camera is FramedCamera & { framing: AutoCameraFraming } {
  const framing=camera.framing;
  return framing?.mode==='auto' && Boolean(framing.reference) && (['longitude','latitude','height','heading','pitch','roll'] as const).every(key=>Number.isFinite(camera[key]??0) && (camera[key]??0)===(framing.reference[key]??0));
}
