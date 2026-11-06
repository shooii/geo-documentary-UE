import { cloudStateAt } from './opening.js';
import { boundaryAnimation } from './boundary-style.js';
export const actions = new Set(['prepare-tour', 'play-opening', 'set-annotations', 'show-tour-frame', 'play-tour-segment', 'play-scene-range', 'stop-scene-playback', 'update-tour-labels', 'play-tour-outro']);
export const clamp = (x: number) => Math.max(0, Math.min(1, x));
export const smooth = (x: number) => { x = clamp(x); return x*x*x*(x*(x*6-15)+10); };
export function camera(p: any) { return { lon: Number(p.longitude ?? p.lon), lat: Number(p.latitude ?? p.lat), height: Number(p.height), heading: Number(p.heading ?? 0), pitch: Number(p.pitch ?? -64) }; }
export function flight(a: ReturnType<typeof camera>, b: ReturnType<typeof camera>, t: number) {
  const s = smooth(t), rad = Math.PI/180;
  const distance = Math.hypot((a.lon-b.lon)*Math.cos((a.lat+b.lat)*rad/2), a.lat-b.lat)*111195;
  const result = { ...a };
  for (const key of ['lon','lat','height','pitch'] as const) result[key] = a[key]+(b[key]-a[key])*s;
  result.heading = a.heading+(((b.heading-a.heading+540)%360)-180)*s;
  result.height += Math.max(500,Math.min(2800,distance*.08))*Math.pow(Math.sin(Math.PI*s),1.35);
  return result;
}
export function frameAt(scene: any, stops: any[], time: number, profile: string, returnDuration: number, openingOnly = false) {
  const region = scene.region;
  const overview = camera(region.cameraProfiles?.[profile] || region.cameraPreset);
  if (stops.length) overview.height *= .9;
  const opening = region.openingDescent?.enabled === false ? null : region.openingDescent;
  const descent = opening ? Math.max(2,Math.min(16,Number(opening.seconds ?? 3))) : 0;
  const mapTime = Math.max(0,time-descent);
  let pose = overview, current = '', progress = 0, traceStart=.35;
  const visited: string[] = [];
  const stopCamera = (stop: any) => camera(stop.cameraProfiles?.[profile] || stop.cameraPreset);
  if (time < descent) {
    const s = smooth(time/descent), startHeight = Math.max(800000,Number(opening.startHeightMeters ?? 900000));
    const approach = Math.max(.18,Math.min(.38,(startHeight-overview.height)/2600000));
    pose = { ...overview, lon: overview.lon-Math.sin(overview.heading*Math.PI/180)*approach*(1-s), lat: overview.lat-Math.cos(overview.heading*Math.PI/180)*approach*.62*(1-s), height: startHeight+(overview.height-startHeight)*Math.pow(s,.86), pitch: Number(opening.startPitchDegrees ?? -52)+(overview.pitch-Number(opening.startPitchDegrees ?? -52))*s };
  } else if (!openingOnly) {
    for (let i=0;i<stops.length;i++) {
      const stop = stops[i];
      if (mapTime < Number(stop.start)) break;
      progress = smooth((mapTime-stop.start)/Math.max(.001,stop.flightDuration || 3.2));
      current = String(stop.id);
      traceStart=Number(stop.start)+Number(stop.flightDuration || 3.2)*.75;
      pose = flight(i ? stopCamera(stops[i-1]) : overview, stopCamera(stop), (mapTime-stop.start)/Math.max(.001,stop.flightDuration || 3.2));
      if (mapTime >= stop.start+(stop.flightDuration || 3.2)*.55) visited.push(current);
    }
    const last = stops.at(-1);
    if (last && mapTime >= last.end) {
      pose = flight(stopCamera(last), overview, (mapTime-last.end)/returnDuration);
      progress = 1-smooth((mapTime-last.end)/returnDuration);
    }
  }
  const reveal = smooth((mapTime-.35)/2.2);
  return { camera: pose, time, mapTime, current, progress, visited, parentReveal: reveal, childReveal: smooth((mapTime-3.15)/1.35), parentLabel: (!current || openingOnly) && mapTime > 2.89 ? 1 : 0, clouds:cloudStateAt(time,opening,pose.height),trace:boundaryAnimation(mapTime,traceStart,current),focus:current?progress:reveal };
}
