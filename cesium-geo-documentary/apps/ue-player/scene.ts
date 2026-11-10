import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fitRegionProfiles, renderLayers } from './viewport.js';
import { interiorLabelPoint, triangulateFeature } from './boundary-style.js';

export function within(root: string, relative: string): string {
  const base = resolve(root), path = resolve(base, relative);
  if (path !== base && !path.startsWith(base + sep)) throw new Error('Path outside workspace');
  return path;
}

/** [west, south, east, north] over every coordinate of the given features. */
export function boundsOf(features: any[]): [number, number, number, number] {
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (value: any) => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      box[0] = Math.min(box[0], value[0]); box[1] = Math.min(box[1], value[1]);
      box[2] = Math.max(box[2], value[0]); box[3] = Math.max(box[3], value[1]);
      return;
    }
    for (const item of value) walk(item);
  };
  for (const feature of features) walk((feature?.geometry || feature)?.coordinates);
  return box.every(Number.isFinite) ? box : [0, 0, 0, 0];
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
  // `derivedGeometryPath` wins when present: it is the outline dissolved out of the child
  // administrative units (dissolve-admin-units.py), which is the shape the project wants
  // to draw instead of whatever the source dataset happened to ship.
  const geometry = await json(region.derivedGeometryPath || region.geometryPath || `data/normalized/${regionId}.geojson`);
  const children = region.childGeometryPath ? await json(region.childGeometryPath) : { features: [] };
  const timeline = await json(`data/regions/${regionId}.timeline.json`);
  const parent = region.parentId ? await json(`data/regions/${region.parentId}.json`) : null;
  const layers = [
    ...(geometry.features || []).map((feature: any) => ({ ...feature, parent: true })),
    ...(children.features || []).map((feature: any) => ({ ...feature, parent: false }))
  ];
  const framed=fitRegionProfiles(region.derivedGeometryPath ? { ...region, bbox: boundsOf(geometry.features || [geometry]) } : region, geometry);
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
  let context = null;
  // The context layer is the parent county. `derivedGeometryPath` is the outline that
  // was dissolved out of the child administrative units (see dissolve-admin-units.py);
  // when it exists we draw that instead of the prefecture file, whose county rings carry
  // the maritime limit and put a translucent sheet over open water.
  const contextPath = parent?.derivedGeometryPath || parent?.geometryPath;
  if (parent && contextPath) {
    const parentGeometry = await json(contextPath);
    const parentFeatures = (parentGeometry.features || [parentGeometry]).map((feature: any) => ({ ...feature, parent: true }));
    // A derived ring is smaller than the official one (no sea), so the county framing has
    // to be recomputed from the ring we actually draw, not from the stored bbox.
    const derived = Boolean(parent.derivedGeometryPath);
    const parentFrame = derived ? fitRegionProfiles({ ...parent, bbox: boundsOf(parentFeatures) }, parentGeometry) : parent;
    const parentRange = Number(parentFrame.cameraPreset?.height || parent.cameraPreset?.height || 100000);
    const parentRendered = renderLayers(parentFeatures, parentRange).map(feature => ({
      ...feature,
      triangulations: triangulateFeature(feature)
    }));
    context = {
      id: parent.id,
      name: parent.name,
      center: parentFrame.center,
      labelPoint: interiorLabelPoint(parentGeometry, parentFrame.labelPoint),
      bbox: parentFrame.bbox,
      cameraPreset: parentFrame.cameraPreset,
      cameraProfiles: parentFrame.cameraProfiles,
      layers: parentRendered
    };
  }
  return { version: 1, region: { ...framed, labelPoint }, timeline, layers: rendered, context };
}
