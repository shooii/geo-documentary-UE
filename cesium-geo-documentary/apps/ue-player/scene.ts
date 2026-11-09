import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fitRegionProfiles, renderLayers } from './viewport.js';
import { interiorLabelPoint, triangulateFeature } from './boundary-style.js';

export function within(root: string, relative: string): string {
  const base = resolve(root), path = resolve(base, relative);
  if (path !== base && !path.startsWith(base + sep)) throw new Error('Path outside workspace');
  return path;
}
export async function loadScene(root: string, regionId: string, boundary: string | null) {
  if (!/^[\w-]+$/.test(regionId) || (boundary && !/^[\w-]+$/.test(boundary))) throw new Error('Invalid scene identifier');
  async function json(relative: string): Promise<any> {
    if (boundary) {
      try { return JSON.parse(await readFile(within(root, `workspace/projects/${boundary}.boundary/${relative}`), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return JSON.parse(await readFile(within(root, relative), 'utf8'));
  }
  const region = await json(`data/regions/${regionId}.json`);
  const geometry = await json(region.geometryPath || `data/normalized/${regionId}.geojson`);
  const children = region.childGeometryPath ? await json(region.childGeometryPath) : { features: [] };
  const timeline = await json(`data/regions/${regionId}.timeline.json`);
  const layers = [
    ...(geometry.features || []).map((feature: any) => ({ ...feature, parent: true })),
    ...(children.features || []).map((feature: any) => ({ ...feature, parent: false }))
  ];
  const framed=fitRegionProfiles(region,geometry);
  const range=Math.min(...Object.values(framed.cameraProfiles || {}).map((p:any)=>Number(p.height)).filter(Number.isFinite),Number(region.cameraPreset?.height || 30000));
  const rendered = renderLayers(layers, range).map(feature => {
    const triangulations = triangulateFeature(feature);
    const properties = feature.parent ? feature.properties : {
      ...feature.properties,
      labelPoint: interiorLabelPoint(feature.geometry, feature.properties?.labelPoint)
    };
    return { ...feature, properties, triangulations };
  });
  const parentGeometries = geometry.features
    ? geometry.features.map((feature: any) => feature.geometry)
    : geometry;
  const labelPoint = interiorLabelPoint(parentGeometries, framed.labelPoint);
  return { version: 1, region: { ...framed, labelPoint }, timeline, layers: rendered };
}
