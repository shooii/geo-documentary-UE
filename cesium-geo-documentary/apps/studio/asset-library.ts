import type { StudioAsset, VideoProject } from "../../packages/project-schema/index.js";

/** Historical asset lists were global. Mere presence in a snapshot is not ownership. */
export class AssetRegionEvidence {
  private projects = new Map<string, Set<string>>();
  private evidence = new Map<string, { used: Set<string>; firstAt: string; firstRegions: Set<string> }>();

  observe(project: Partial<VideoProject>): void {
    if (!project.regionId) return;
    if (project.id) {
      const regions = this.projects.get(project.id) ?? new Set<string>();
      regions.add(project.regionId);
      this.projects.set(project.id, regions);
    }
    const used = new Set((project.scenes ?? []).flatMap(scene => [
      ...(scene.assetIds ?? []), ...(scene.placements ?? []).map(placement => placement.assetId)
    ]));
    for (const asset of project.assets ?? []) {
      if (!asset.path.startsWith("/workspace-assets/")) continue;
      const entry = this.evidence.get(asset.id) ?? { used: new Set<string>(), firstAt: "", firstRegions: new Set<string>() };
      if (used.has(asset.id)) entry.used.add(project.regionId);
      const time = project.updatedAt;
      if (time && (!entry.firstAt || time < entry.firstAt)) {
        entry.firstAt = time;
        entry.firstRegions = new Set([project.regionId]);
      } else if (time && time === entry.firstAt) entry.firstRegions.add(project.regionId);
      this.evidence.set(asset.id, entry);
    }
  }

  resolve(asset: StudioAsset): string | undefined {
    if (asset.scope?.regionId) return asset.scope.regionId;
    if (asset.scope?.projectId) {
      const regions = this.projects.get(asset.scope.projectId);
      return regions?.size === 1 ? [...regions][0] : undefined;
    }
    const entry = this.evidence.get(asset.id);
    if (!entry) return undefined;
    if (entry.used.size) return entry.used.size === 1 ? [...entry.used][0] : undefined;
    return entry.firstRegions.size === 1 ? [...entry.firstRegions][0] : undefined;
  }
}

/** One regional catalog serves the library, scene picker, saves and renders. */
export function withRegionAssetLibrary(project: VideoProject, library: StudioAsset[]): VideoProject {
  const canonical = new Map(library.map(asset => [asset.id, asset]));
  const assets = new Map<string, StudioAsset>();
  for (const stored of project.assets) {
    const asset = stored.path.startsWith("/workspace-assets/") ? canonical.get(stored.id) : stored;
    if (!asset) continue;
    if (asset.scope?.regionId ? asset.scope.regionId !== project.regionId : asset.path.startsWith("/workspace-assets/")) continue;
    assets.set(asset.id, asset);
  }
  for (const asset of library) {
    if (asset.scope?.regionId === project.regionId) assets.set(asset.id, asset);
  }
  const excluded = new Set(project.assets.filter(asset => !assets.has(asset.id)).map(asset => asset.id));
  return {
    ...project,
    assets: [...assets.values()],
    scenes: project.scenes.map(scene => ({
      ...scene,
      assetIds: scene.assetIds.filter(id => !excluded.has(id)),
      ...(scene.placements ? { placements: scene.placements.filter(item => !excluded.has(item.assetId)) } : {})
    }))
  };
}
