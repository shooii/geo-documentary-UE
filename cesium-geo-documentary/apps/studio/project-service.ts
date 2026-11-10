import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildRenderSpec, mapScenesToCues, parseSrt, updateProjectMeasuredDurations, type RenderSpec, type TimedCue } from "../../packages/render-spec/index.js";
import { mediaKindForPath } from "../../packages/content-engine/media.js";
import { DEFAULT_IMAGERY_PROVIDER, outputSize, type AssetFit, type AssetPlacement, type StudioAsset, type StudioScene, type VideoProject } from "../../packages/project-schema/index.js";
import { portraitChildCameraPreset, type GeoBounds } from "../../packages/geo-camera/index.js";
import { snapshotFile } from "./boundary-snapshot.js";
import { readFileResilient, readJsonResilient } from "./fs-resilience.js";

interface RegionContent {
  name?: string;
  title?: string;
  narration?: string[];
  tourOrder?: string[];
  voiceId?: string;
  voiceRate?: string;
  subtitleLeadSeconds?: number;
  generated?: boolean;
  province?: string;
  city?: string;
  county?: string;
  town?: string;
}

interface RegionData {
  id?: string;
  name?: string;
  parentId?: string;
  geometryPath?: string;
  childGeometryPath?: string;
  childIds?: string[];
  tourChildIds?: string[];
  supplementalUnits?: Array<{ id: string; includedInTour?: boolean }>;
  childRegions?: Array<{
    id: string;
    name: string;
    bbox?: GeoBounds;
    cameraPreset?: StudioScene["camera"];
    cameraProfiles?: { portrait?: StudioScene["camera"] };
  }>;
  openingDescent?: {
    enabled?: boolean;
    seconds?: number;
    startHeightMeters?: number;
    startPitchDegrees?: number;
    cloudDeckHeightMeters?: number;
    cloudAlphaPeak?: number;
  };
}

interface LegacyVisual {
  id: string;
  path: string;
  label: string;
  fit?: AssetFit;
  sourceType?: "verified-real" | "generated-illustrative";
  sourceUrl?: string;
  narrationCueIndex?: number;
  narrationCueEndIndex?: number;
  requiredKeywords?: string[];
  leadSeconds?: number;
  tailSeconds?: number;
}

async function json<T>(path: string): Promise<T> {
  return readJsonResilient<T>(path);
}

export async function readMaster(root: string): Promise<Record<string, RegionContent>> {
  return json(join(root, "content", "regions.zh-CN.json"));
}

export async function readRegions(root: string): Promise<Array<{ id: string; name: string; narration: string[]; supportsTour: boolean }>> {
  const master = await readMaster(root);
  const regions: Array<{ id: string; name: string; narration: string[]; supportsTour: boolean }> = [];
  // Keep descriptors bounded. Promise.all over a large national catalog can
  // exhaust Windows' process file-handle limit during browser refresh.
  for (const [id, item] of Object.entries(master)) {
    const path = join(root, "data", "regions", `${id}.json`);
    const data = existsSync(path) ? await json<RegionData>(path) : {};
    regions.push({ id, name: item.name ?? id, narration: item.narration ?? [], supportsTour: Boolean(data.childRegions?.length) });
  }
  return regions;
}

/**
 * Where a region's record is read from.
 *
 * `data/regions/<id>.json` is a workspace-wide singleton, so re-importing a
 * boundary rewrites it in place and every scheme that references the region
 * would silently inherit the new shape, names and framing. A scheme therefore
 * reads its own frozen copy when it has one; the live file stays the fallback
 * for regions that were never snapshotted.
 */
async function regionRecordPath(root: string, regionId: string, projectId?: string): Promise<string> {
  const relative = `data/regions/${regionId}.json`;
  return (await snapshotFile(root, projectId, relative)) ?? join(root, relative);
}

async function regionChain(root: string, regionId: string, projectId?: string): Promise<RegionData[]> {
  const records: RegionData[] = [];
  const visited = new Set<string>();
  let current: string | undefined = regionId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const path = await regionRecordPath(root, current, projectId);
    if (!existsSync(path)) break;
    const record = await json<RegionData>(path);
    records.unshift(record);
    current = record.parentId;
  }
  return records;
}

export async function readCanonicalCues(root: string, regionId: string): Promise<TimedCue[]> {
  const candidates = [
    join(root, "assets", "audio", regionId, "narration-edge.srt"),
    join(root, "apps", "video-compositor", "captions", `${regionId}.srt`)
  ];
  const path = candidates.find(existsSync);
  if (!path) throw new Error(`Missing narration SRT for ${regionId}`);
  return parseSrt(await readFileResilient(path, "utf8"));
}

function estimatedProjectCues(project: VideoProject): TimedCue[] {
  let cursor = 0;
  return project.scenes.filter((scene) => scene.section !== "cover").map((scene, index) => {
    const duration = Math.max(2, [...scene.narration].length / 4.1);
    const cue = { index, start: cursor, end: cursor + duration, text: scene.narration };
    cursor = cue.end;
    return cue;
  });
}

/** Canonical audio is optional while editing, and may describe older text. */
async function previewCues(root: string, project: VideoProject): Promise<TimedCue[]> {
  try {
    const cues = await readCanonicalCues(root, project.regionId);
    mapScenesToCues(project.scenes, cues);
    return cues;
  } catch (error) {
    // Resource/access failures need to remain visible, rather than being
    // disguised as missing audio. Missing or malformed/stale SRT is recoverable.
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code && code !== "ENOENT") throw error;
    return estimatedProjectCues(project);
  }
}

function rateToSpeed(value = "0%"): number {
  const percent = Number(value.replace("%", ""));
  return Number.isFinite(percent) ? Math.round((1 + percent / 100) * 1000) / 1000 : 1;
}

function placement(visual: LegacyVisual): AssetPlacement {
  return {
    assetId: visual.id,
    fit: visual.fit ?? "cover",
    crop: { x: 0, y: 0, width: 1, height: 1 },
    focalPoint: { x: 0.5, y: 0.5 },
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    // A manifest clip may be a video now; animating a moving image on top of a
    // playing one reads as a bug, so only stills get the push-in.
    animation: mediaKindForPath(visual.path) === "video" ? "still" : "push-in",
    leadSeconds: visual.leadSeconds ?? 0.25,
    tailSeconds: visual.tailSeconds ?? 0.2,
    minimumDisplaySeconds: 2,
    requiredKeywords: visual.requiredKeywords ?? [],
    alt: visual.label
  };
}

/**
 * The geometry half of the render cache key.
 *
 * Reads through the scheme's snapshot when it has one, so re-importing a region
 * no longer invalidates the map video of a scheme that was authored against the
 * previous boundary — that scheme's geometry did not change, only the live file
 * did. Cache invalidation for a scheme now tracks its own frozen inputs.
 */
export async function geometrySignature(root: string, regionId: string, projectId?: string): Promise<string> {
  const regionPath = await regionRecordPath(root, regionId, projectId);
  const region = await json<RegionData>(regionPath);
  const hash = createHash("sha256");
  hash.update(await readFileResilient(regionPath));
  for (const relative of [region.geometryPath, region.childGeometryPath].filter((value): value is string => Boolean(value))) {
    const path = (await snapshotFile(root, projectId, relative)) ?? join(root, relative);
    if (existsSync(path)) hash.update(await readFileResilient(path));
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Hash the sources that decide what a captured Cesium frame looks like.
 *
 * The map video is cached by render-spec signature, so the signature has to
 * change whenever the rasteriser changes — otherwise a camera or layer fix
 * ships, the cache still matches, and the export re-encodes the old footage.
 * A hand-maintained version constant cannot be trusted for that: two camera
 * fixes (the focus-mask frame footprint and the child-tour flight origin) both
 * shipped without a bump. Hashing the actual files removes the class of bug.
 */
export const RENDERED_MAP_SOURCES = [
  "apps/ue-player/presentation.ts",
  "apps/ue-player/client.ts",
  "apps/ue-player/scene.ts",
  "apps/ue-player/imagery.ts",
  "apps/ue-player/framing.js",
  "apps/ue-player/viewport.ts",
  "apps/ue-player/opening.ts",
  "apps/ue-player/boundary-style.ts",
  "unreal/assets/cloud-deck.png",
  "unreal/assets/cloud-pass.png",
  "apps/ue-player/capture.ts",
  "unreal/GeoDocumentary/Source/GeoDocumentary/GeoMap.cpp",
  "unreal/GeoDocumentary/Source/GeoDocumentary/GeoMap.h",
  "unreal/GeoDocumentary/Config/DefaultEngine.ini",
  "apps/cesium-player/public/runtime.js",
  "apps/cesium-player/public/index.html",
  "apps/cesium-player/public/imagery-config.json",
  "apps/cesium-player/public/tour-presentation.js",
  ".agents/skills/cesium-geo-documentary/scripts/capture-frames.ts",
  ".agents/skills/cesium-geo-documentary/scripts/build-cesium-scenes.ts"
];

export async function mapRendererSignature(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const relative of RENDERED_MAP_SOURCES) {
    const path = join(root, relative);
    hash.update(relative);
    hash.update(existsSync(path) ? await readFileResilient(path) : Buffer.from("(absent)"));
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Build the canonical scene list for a region.
 *
 * `options.projectId` selects which boundary the scenes are derived from: an
 * existing scheme passes its own id so its framing, child names and camera
 * presets come from its frozen snapshot; a brand-new scheme passes nothing and
 * takes the newest data, which is exactly the moment a snapshot is captured.
 */
export async function makeProject(root: string, regionId?: string, options: { projectId?: string | undefined } = {}): Promise<VideoProject> {
  const master = await readMaster(root);
  const selectedId = regionId ?? (master["440825112"] ? "440825112" : Object.keys(master)[0]);
  const selectedContent = selectedId ? master[selectedId] : undefined;
  const selected = selectedId && selectedContent
    ? { id: selectedId, name: selectedContent.name ?? selectedId, narration: selectedContent.narration ?? [] }
    : undefined;
  if (regionId && !selected) throw new Error(`${regionId} 已在全国边界目录中选择，但尚未生成可制作的内容项目`);
  if (!selected) throw new Error("No region data available");
  const content = master[selected.id]!;
  const regionPath = await regionRecordPath(root, selected.id, options.projectId);
  const data = await json<RegionData>(regionPath);
  const children = data.childRegions ?? [];
  if (!children.length) throw new Error(`${selected.name}没有可用的直接下级行政区边界，暂不能使用新寮镇巡游模板`);
  const childMap = new Map(children.map((child) => [String(child.id), child]));
  // The narrated tour follows `tourChildIds`; `childRegions` additionally holds
  // supplemental management units (forest farms, fish-fry farms, ...) that stay
  // on the boundary layer for context but never receive a flight or a line of
  // narration. Validating tourOrder against every childRegion made 440882102
  // and 440823114 un-buildable, so the narrated tour set is the unit of truth
  // here, matching the subset rule in scripts/build-child-tour.ts.
  const requestedTourIds = (data.tourChildIds ?? data.childIds ?? children.map((child) => child.id)).map(String);
  const tourIds = new Set(requestedTourIds.filter((id) => childMap.has(id)));
  if (!tourIds.size) throw new Error(`${selected.name}没有可用于巡游的下级行政区`);
  const editorialOrder = (content.tourOrder ?? [...tourIds]).map(String);
  const supplementalCount = Math.max(0, children.length - tourIds.size);
  const supplementalNote = supplementalCount ? `，另有 ${supplementalCount} 个只显示、不出镜的补充单元` : "";
  if (!editorialOrder.length
    || new Set(editorialOrder).size !== editorialOrder.length
    || editorialOrder.some((id) => !tourIds.has(id))) {
    throw new Error(`${selected.name}的 tourOrder 与可巡游下级行政区不一致：需要 ${tourIds.size} 个互不重复的下级行政区${supplementalNote}`);
  }
  const orderedChildren = editorialOrder
    .map((id) => childMap.get(String(id)))
    .filter((child): child is NonNullable<typeof child> => Boolean(child));
  if (orderedChildren.length !== editorialOrder.length) throw new Error(`${selected.name}的下级行政区顺序不完整`);
  const chain = await regionChain(root, selected.id, options.projectId);
  const names = chain.map((record) => record.name ?? "").filter(Boolean);
  const townName = content.town ?? names.at(-1) ?? selected.name;
  const countyName = content.county ?? names.at(-2) ?? "";
  const cityName = content.city ?? names.at(-3) ?? names.at(0) ?? "";
  const overviewCount = Math.max(1, (content.narration?.length ?? 0) - orderedChildren.length - 1);
  const scenes: StudioScene[] = [{
    id: "cover", type: "cover", section: "cover", title: townName, narration: "", subtitle: "", duration: 1.6, assetIds: [], placements: [],
    timing: { actualNarrationSeconds: 0, preHoldSeconds: 0, postHoldSeconds: 0, minimumVisualSeconds: 1.6, mapHoldSeconds: 0 }
  }];
  for (const [index, narration] of (content.narration ?? []).entries()) {
    const childIndex = index - overviewCount;
    const child = childIndex >= 0 && childIndex < orderedChildren.length ? orderedChildren[childIndex] : undefined;
    const section: "overview" | "child" | "outro" = index < overviewCount ? "overview" : child ? "child" : "outro";
    const duration = Math.max(2, [...narration].length / 4);
    scenes.push({
      id: child ? `child-${child.id}` : section === "outro" ? "outro" : `overview-${index + 1}`,
      type: child ? "region-focus" : section === "outro" ? "outro" : index === 0 ? "map-overview" : "image-card",
      section,
      ...(child ? {
        childId: child.id,
        childName: child.name,
        ...(child.cameraPreset ? {
          camera: {
            ...portraitChildCameraPreset(child.cameraProfiles?.portrait ?? child.cameraPreset, child.bbox),
            transition: "fly" as const
          }
        } : {})
      } : {}),
      title: child?.name ?? (section === "outro" ? `${selected.name}·结尾` : index === 0 ? `${selected.name}·总体介绍` : `总体介绍 ${index + 1}`),
      narration,
      subtitle: narration,
      duration,
      assetIds: [],
      placements: [],
      timing: { actualNarrationSeconds: duration, preHoldSeconds: 0, postHoldSeconds: 0, minimumVisualSeconds: Math.max(2, duration), mapHoldSeconds: child ? 2 : 0 }
    });
  }
  const now = new Date().toISOString();
  const opening = data.openingDescent ?? {};
  const size = outputSize("portrait");
  let project: VideoProject = {
    schemaVersion: 2,
    // Rebuilding an existing scheme's baseline reuses its id, so every lookup
    // keyed by the project — its boundary snapshot in particular — resolves to
    // the same place as the scheme itself.
    id: options.projectId ?? `project-${Date.now().toString(36)}`,
    name: `${selected.name}地理图说`,
    regionId: selected.id,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    template: {
      id: "xinliao-town-tour-v1", lockedOpening: true,
      openingDescentSeconds: opening.enabled === false ? 0 : Number(opening.seconds ?? 3),
      openingStartHeightMeters: Number(opening.startHeightMeters ?? 900000),
      openingStartPitchDegrees: Number(opening.startPitchDegrees ?? -52),
      cloudDeckHeightMeters: Number(opening.cloudDeckHeightMeters ?? 45000),
      cloudAlphaPeak: Number(opening.cloudAlphaPeak ?? 1),
      tourReturnSeconds: 4.4
    },
    cover: {
      province: content.province ?? "广东省", city: cityName, county: countyName, town: townName, topic: "地理乡土情",
      subtitle: "看见边界，也看见土地上的生活", administrativeLabel: `${countyName}${townName}`,
      titlePosition: "lower-third", fontFamily: "STZhongsong", fontSize: 108, fontWeight: 700,
      color: "#FFF8EA", strokeColor: "#E9B96E", shadowColor: "#000000", backgroundMode: "unified-globe",
      overlayOpacity: 0.82, introSeconds: 1.6, fadeInSeconds: 0, fadeOutSeconds: 0.35, safeMargin: 66,
      contentMeta: "地理 · 人文 · 时代"
    },
    output: { profile: "portrait", ...size, fps: 30, quality: "high" },
    imagery: { provider: DEFAULT_IMAGERY_PROVIDER },
    style: { theme: "midnight-globe", primaryColor: "#48d6c9", boundaryColor: "#ffd166", fontFamily: "Microsoft YaHei", subtitleSafeMargin: 220, subtitleMaxLines: 2 },
    voice: { enabled: true, voiceId: content.voiceId ?? "zh-CN-YunyangNeural", speed: rateToSpeed(content.voiceRate), volume: 1 },
    assets: [], scenes
  };
  const cues = await previewCues(root, project);
  const initialSpec = buildRenderSpec({ project, cues, geometrySignature: await geometrySignature(root, selected.id, options.projectId), rendererSignature: await mapRendererSignature(root) });
  project = updateProjectMeasuredDurations(project, initialSpec);
  const visualPath = join(root, "content", "visuals", `${selected.id}.json`);
  if (existsSync(visualPath)) {
    const manifest = await json<{ clips?: LegacyVisual[] }>(visualPath);
    const rangeByCue = new Map<number, string>();
    for (const range of initialSpec.sceneCueRanges) for (let index = range.cueStartIndex; index <= range.cueEndIndex; index += 1) rangeByCue.set(index, range.sceneId);
    const assets: StudioAsset[] = [];
    for (const visual of manifest.clips ?? []) {
      const asset: StudioAsset = {
        // The kind comes from the file, not from an assumption: legacy manifests
        // that the CLI pipeline wrote carried photos only, but a clip is a clip.
        id: visual.id, name: visual.label, path: visual.path, type: mediaKindForPath(visual.path), sourceType: visual.sourceType ?? "verified-real",
        verifiedReal: visual.sourceType === "verified-real", ...(visual.sourceUrl ? { sourceUrl: visual.sourceUrl } : {}), alt: visual.label
      };
      assets.push(asset);
      const sceneId = rangeByCue.get(Number(visual.narrationCueIndex));
      const scene = project.scenes.find((item) => item.id === sceneId);
      if (scene) {
        scene.assetIds.push(asset.id);
        scene.placements = [...(scene.placements ?? []), placement(visual)];
      }
    }
    project.assets = assets;
  }
  return project;
}

export async function normalizeProject(root: string, input: VideoProject | Record<string, unknown>): Promise<VideoProject> {
  const legacy = input as Partial<VideoProject>;
  // A complete v2 snapshot owns its content and camera framing. Rebuilding it
  // from today's catalog makes a valid save unreadable after a git rollback,
  // a content edit, or an SRT regeneration. Only legacy/incomplete saves need
  // the canonical template; its boundary still comes from the scheme snapshot.
  const selfContained = legacy.schemaVersion === 2
    && legacy.template && legacy.cover && legacy.output && legacy.imagery && legacy.style && legacy.voice
    && Array.isArray(legacy.assets) && Array.isArray(legacy.scenes)
    && legacy.scenes.some((scene) => scene.section === "cover")
    && legacy.scenes.some((scene) => scene.section === "outro");
  const baseline = selfContained
    ? structuredClone(legacy as VideoProject)
    : await makeProject(root, legacy.regionId, { projectId: typeof legacy.id === "string" ? legacy.id : undefined });
  const previousScenes = new Map((legacy.scenes ?? []).map((scene) => [scene.id, scene]));
  const mergedCanonicalScenes = baseline.scenes.map((scene) => {
    const previous = previousScenes.get(scene.id);
    if (!previous) return scene;
    return {
      ...scene, ...previous,
      ...(scene.section === "cover" ? { type: "cover" as const, title: baseline.cover.administrativeLabel, duration: legacy.schemaVersion === 2 ? previous.duration : baseline.cover.introSeconds } : {}),
      placements: previous.placements?.length ? previous.placements : (scene.placements ?? []),
      timing: { ...scene.timing!, ...(previous.timing ?? {}) },
      // Merge on top of the canonical camera action so migrations do not drop
      // stable defaults such as `transition: "fly"`. Omitting that declarative
      // default previously produced a different cache signature even though the
      // Cesium camera path was identical.
      // The scheme's frozen boundary owns canonical framing; retain only the
      // saved motion preference so reopening a scheme never re-fits it to a
      // boundary it was not authored against.
      camera: scene.camera
        ? { ...(previous.camera ?? {}), ...scene.camera, transition: previous.camera?.transition ?? scene.camera.transition }
        : previous.camera
    } as StudioScene;
  });
  const canonicalById = new Map(mergedCanonicalScenes.map((scene) => [scene.id, scene]));
  const orderedScenes: StudioScene[] = [];
  const seenSceneIds = new Set<string>();
  // A schema-v2 scene list is the editor's explicit selection. Do not restore
  // canonical overview or child scenes that the user deleted. Older projects
  // still receive the complete canonical scene set during migration, while the
  // unique cover and outro remain structural requirements for every project.
  const preservesDeletedScenes = legacy.schemaVersion === 2 && Array.isArray(legacy.scenes);
  for (const previous of legacy.scenes ?? []) {
    const canonical = canonicalById.get(previous.id);
    if (canonical) {
      orderedScenes.push(canonical);
      seenSceneIds.add(canonical.id);
    } else if (previous.section === "overview" || previous.section === "outro-lead") {
      orderedScenes.push(previous as StudioScene);
      seenSceneIds.add(previous.id);
    }
  }
  // Kept in step with the schema's own rank map: 结尾补充 plays AFTER the pull-back,
  // so it orders after `outro` rather than before it.
  const sectionRank = { cover: 0, overview: 1, child: 2, outro: 3, "outro-lead": 4 } as const;
  for (const scene of mergedCanonicalScenes) {
    if (seenSceneIds.has(scene.id)) continue;
    if (preservesDeletedScenes && (scene.section === "overview" || scene.section === "outro-lead" || scene.section === "child")) continue;
    const rank = sectionRank[scene.section ?? "overview"];
    const insertAt = orderedScenes.findIndex((item) => sectionRank[item.section ?? "overview"] > rank);
    orderedScenes.splice(insertAt < 0 ? orderedScenes.length : insertAt, 0, scene);
  }
  // Re-sort by rank before handing the scenes back. The loop above preserves the
  // saved order so deliberate within-section reordering survives, but a project
  // written when 结尾补充 sat *before* the pull-back would otherwise keep that order
  // and fail validation. Array.sort is stable, so rows inside one section keep
  // their relative order and only the sections themselves are put back in line.
  orderedScenes.sort((first, second) => sectionRank[first.section ?? "overview"] - sectionRank[second.section ?? "overview"]);
  baseline.scenes = orderedScenes;
  const existingAssets = legacy.assets ?? [];
  const assets = new Map(baseline.assets.map((asset) => [asset.id, asset]));
  for (const asset of existingAssets) assets.set(asset.id, asset);
  return {
    ...baseline,
    ...legacy,
    schemaVersion: 2,
    template: { ...baseline.template, ...(legacy.template ?? {}) },
    cover: { ...baseline.cover, ...(legacy.cover ?? {}), ...(legacy.schemaVersion === 2 ? {} : { introSeconds: baseline.cover.introSeconds }) },
    output: {
      ...baseline.output,
      ...(legacy.output ?? {}),
      // `standard` never had an independent render path. Migrate saved projects
      // to the two user-facing modes instead of keeping a misleading third tier.
      quality: legacy.output?.quality === "draft" ? "draft" : "high"
    },
    imagery: { ...baseline.imagery, ...(legacy.imagery ?? {}) },
    style: { ...baseline.style, ...(legacy.style ?? {}) },
    voice: { ...baseline.voice, ...(legacy.voice ?? {}) },
    assets: [...assets.values()],
    scenes: baseline.scenes
  };
}

/**
 * The measured narration lead from the region timeline, when the skill scripts have
 * written one. Absent on regions whose timeline predates that field, on regions with
 * no child tour, and on every region before the first export — the caller falls back
 * to the rule in `opening-timing.ts`.
 */
async function readTimelineNarrationStart(root: string, regionId: string): Promise<number | undefined> {
  const path = join(root, "data", "regions", `${regionId}.timeline.json`);
  if (!existsSync(path)) return undefined;
  try {
    const timeline = JSON.parse(await readFileResilient(path, "utf8")) as { narrationStartSeconds?: number };
    const value = Number(timeline.narrationStartSeconds);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function buildProjectRenderSpec(root: string, project: VideoProject, cues?: TimedCue[], timing?: { narrationDurationSeconds?: number; timelineDurationSeconds?: number }): Promise<RenderSpec> {
  // Explicit measured cues (including export) stay strict. Estimates are only
  // used when the caller asks for an editor preview without measured audio.
  const resolvedCues = cues ?? await previewCues(root, project);
  return buildRenderSpec({
    project,
    cues: resolvedCues,
    geometrySignature: await geometrySignature(root, project.regionId, project.id),
    rendererSignature: await mapRendererSignature(root),
    // The editor's timecode has to start the narration where the export does; the
    // 0.35 s the child-tour builder waits for the parent boundary pen draw used to be
    // missing here, so every preview ran one pen draw early.
    timelineNarrationStartSeconds: await readTimelineNarrationStart(root, project.regionId),
    ...timing
  });
}
