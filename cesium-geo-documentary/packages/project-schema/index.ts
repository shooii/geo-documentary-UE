export type OutputProfile = "portrait" | "landscape" | "square";
export type SceneType = "cover" | "map-overview" | "region-focus" | "image-card" | "fact-card" | "outro";
/**
 * How a scene picture meets the frame.
 *
 * `cover` / `contain` / `fill` describe how the picture sits *inside the card*
 * (portrait: 952x780, inset from the edges, bordered and rounded). `fullscreen`
 * drops the card entirely and lets the picture own the whole frame, cropped like
 * `cover` - the difference is the layout, not the object-fit.
 */
export type AssetFit = "cover" | "contain" | "fill" | "fullscreen";
export type AssetAnimation = "still" | "push-in" | "pull-out" | "pan-left" | "pan-right";

export interface StudioAsset {
  id: string;
  name: string;
  /** Repository-relative path or /workspace-assets URL. */
  path: string;
  type: "image" | "video" | "audio";
  sourceType?: "verified-real" | "user-provided" | "generated-illustrative" | "amap-poi";
  sourceUrl?: string;
  verifiedReal?: boolean;
  prohibitedContent?: boolean;
  alt?: string;
  /** regionId is the library boundary. projectId records origin; childId narrows POI matching. */
  scope?: { projectId?: string; regionId?: string; childId?: string };
  poi?: {
    provider: "amap";
    poiId: string;
    poiName: string;
    poiType: string;
    poiTypeCode: string;
    childId: string;
    childName: string;
    photoIndex: number;
    photoTitle: string;
    location?: [number, number];
    retrievedAt: string;
  };
}

export interface AssetPlacement {
  assetId: string;
  fit: AssetFit;
  crop: { x: number; y: number; width: number; height: number };
  focalPoint: { x: number; y: number };
  scale: number;
  offsetX: number;
  offsetY: number;
  animation: AssetAnimation;
  leadSeconds: number;
  tailSeconds: number;
  minimumDisplaySeconds: number;
  requiredKeywords: string[];
  alt: string;
  /** Explicit per-image export selection. Undefined preserves legacy first-N behavior. */
  includeInRender?: boolean;
}

export interface SceneTiming {
  /** Measured from the current TTS/SRT and never edited directly. */
  actualNarrationSeconds: number;
  /** Real silence inserted before the scene narration. */
  preHoldSeconds: number;
  /** Real silence inserted after the scene narration. */
  postHoldSeconds: number;
  /** Minimum time for a bound visual; used by the compositor. */
  minimumVisualSeconds: number;
  /** Preferred map hold; camera flight is clamped so this hold is retained when possible. */
  mapHoldSeconds: number;
}

export const DEFAULT_IMAGERY_PROVIDER = "cesium-ion-world-imagery";

export interface MapView {
  longitudeOffset: number;
  latitudeOffset: number;
  zoom: number;
  headingOffset: number;
  pitchOffset: number;
}

export interface StudioScene {
  id: string;
  type: SceneType;
  title: string;
  narration: string;
  /** Semantic-preserving display text. Newlines control subtitle chunks. */
  subtitle: string;
  /** Backwards-compatible measured duration. The UI treats this as read-only. */
  duration: number;
  assetIds: string[];
  placements?: AssetPlacement[];
  /**
   * Legacy first-N selection, retained only so older revisions still parse.
   * Inert: the film shows a picture only when its placement is marked
   * `includeInRender === true`, so an unmarked scene ships no picture at all.
   */
  assetDisplayCount?: number;
  timing?: SceneTiming;
  section?: "cover" | "overview" | "child" | "outro-lead" | "outro";
  childId?: string;
  childName?: string;
  /** Tianditu imagery labels for this scene only. Project-level imagery remains the base layer. */
  imageryAnnotation?: boolean;
  mapView?: MapView;
  camera?: {
    longitude: number;
    latitude: number;
    height: number;
    heading: number;
    pitch: number;
    roll?: number;
    transition: "fly" | "ease" | "cut";
  };
}

export interface CoverManifest {
  province: string;
  city: string;
  county: string;
  town: string;
  topic: string;
  subtitle: string;
  administrativeLabel: string;
  titlePosition: "lower-third" | "center";
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  strokeColor: string;
  shadowColor: string;
  backgroundPath?: string;
  backgroundMode: "unified-globe" | "map-state" | "image";
  overlayOpacity: number;
  introSeconds: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  safeMargin: number;
  contentMeta: string;
}

export interface VideoProject {
  schemaVersion: 2;
  id: string;
  name: string;
  regionId: string;
  /** Human-readable region name, backfilled for list display only. */
  regionName?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  template: {
    id: "xinliao-town-tour-v1";
    lockedOpening: true;
    openingDescentSeconds: number;
    openingStartHeightMeters: number;
    openingStartPitchDegrees: number;
    cloudDeckHeightMeters: number;
    cloudAlphaPeak: number;
    tourReturnSeconds: number;
  };
  cover: CoverManifest;
  output: {
    profile: OutputProfile;
    width: number;
    height: number;
    fps: number;
    quality: "draft" | "standard" | "high";
  };
  imagery: {
    provider: "mapbox-satellite" | "esri-world-imagery" | "tianditu-imagery" | "bing-aerial" | "cesium-ion-world-imagery";
  };
  style: {
    theme: string;
    primaryColor: string;
    boundaryColor: string;
    fontFamily: string;
    subtitleSafeMargin: number;
    subtitleMaxLines: number;
  };
  voice: {
    enabled: boolean;
    voiceId: string;
    speed: number;
    volume: number;
  };
  music?: { assetId: string; volume: number };
  poiImport?: {
    enabled: true;
    provider: "amap";
    typeCodes: string[];
    keyword: string;
    importedAt: string;
    totalPois: number;
    totalPhotos: number;
    children: Array<{ childId: string; childName: string; poiCount: number; photoCount: number; error?: string }>;
  };
  copyGeneration?: {
    provider: "deepseek";
    model: string;
    generatedAt: string;
    sceneCount: number;
  };
  assets: StudioAsset[];
  scenes: StudioScene[];
}

export function outputSize(profile: OutputProfile): { width: number; height: number } {
  if (profile === "portrait") return { width: 1080, height: 1920 };
  if (profile === "square") return { width: 1080, height: 1080 };
  return { width: 1920, height: 1080 };
}

export function normalizeSemanticText(value: string): string {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

function finiteRange(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
}

export function validateVideoProject(value: unknown): asserts value is VideoProject {
  if (!value || typeof value !== "object") throw new Error("Project must be an object");
  const project = value as Partial<VideoProject>;
  if (project.schemaVersion !== 2) throw new Error("Project must use schemaVersion 2");
  if (!project.id || !/^[a-zA-Z0-9_-]+$/.test(project.id)) throw new Error("Invalid project id");
  if (!project.name?.trim()) throw new Error("Project name is required");
  if (!project.regionId || !/^\d{6,12}$/.test(project.regionId)) throw new Error("Invalid region id");
  if (!project.cover || !project.template || !project.output || !project.imagery || !project.style || !project.voice) throw new Error("Project configuration is incomplete");
  if (!["mapbox-satellite", "esri-world-imagery", "tianditu-imagery", "bing-aerial", "cesium-ion-world-imagery"].includes(project.imagery.provider)) {
    throw new Error("Invalid satellite imagery provider");
  }
  finiteRange(project.cover.introSeconds, 0.25, 10, "Cover duration");
  finiteRange(project.cover.fadeInSeconds, 0, 3, "Cover fade in");
  finiteRange(project.cover.fadeOutSeconds, 0, 3, "Cover fade out");
  finiteRange(project.cover.overlayOpacity, 0, 1, "Cover overlay opacity");
  if (!Array.isArray(project.assets) || !Array.isArray(project.scenes) || project.scenes.length === 0) throw new Error("At least one scene is required");
  const assetIds = new Set(project.assets.map((asset) => asset.id));
  if (assetIds.size !== project.assets.length) throw new Error("Asset ids must be unique");
  if (project.assets.some((asset) => asset.prohibitedContent)) throw new Error("Government meetings, inspections and conference photos are prohibited");
  const sceneIds = new Set<string>();
  for (const scene of project.scenes) {
    if (!scene.id || !scene.type || sceneIds.has(scene.id)) throw new Error(`Invalid or duplicate scene id: ${scene.id}`);
    sceneIds.add(scene.id);
    const sectionTypes: Record<string, SceneType[]> = {
      cover: ["cover"],
      overview: ["map-overview", "image-card", "fact-card"],
      child: ["region-focus"],
      // The outro lead-in reuses the overview vocabulary: it is ordinary narrated
      // content that happens to sit between the last child tour and the pull-back,
      // so it carries the same titles, cards and imagery as the opening block.
      "outro-lead": ["map-overview", "image-card", "fact-card"],
      outro: ["outro"]
    };
    if (!scene.section || !sectionTypes[scene.section]?.includes(scene.type)) {
      throw new Error(`Scene ${scene.id} uses ${scene.type} outside its locked ${scene.section ?? "missing"} section`);
    }
    finiteRange(Number(scene.duration), 0, 600, `Duration for ${scene.id}`);
    if (scene.section !== "cover" && !scene.narration.trim()) throw new Error(`Narration is required for ${scene.id}`);
    if (scene.section !== "cover" && normalizeSemanticText(scene.subtitle) !== normalizeSemanticText(scene.narration)) {
      throw new Error(`${scene.title}的字幕只能调整标点和断句，不能改变配音语义`);
    }
    const timing = scene.timing;
    if (timing) {
      finiteRange(timing.preHoldSeconds, 0, 20, `Pre-hold for ${scene.id}`);
      finiteRange(timing.postHoldSeconds, 0, 20, `Post-hold for ${scene.id}`);
      finiteRange(timing.minimumVisualSeconds, 0.1, 120, `Minimum visual duration for ${scene.id}`);
      finiteRange(timing.mapHoldSeconds, 0, 120, `Map hold for ${scene.id}`);
    }
    if (scene.imageryAnnotation !== undefined && typeof scene.imageryAnnotation !== "boolean") {
      throw new Error(`Imagery annotation selection for ${scene.id} must be a boolean`);
    }
    if (scene.mapView !== undefined) {
      const view = scene.mapView;
      if (!view || typeof view !== "object" || scene.section === "cover") throw new Error(`Invalid map view for ${scene.id}`);
      finiteRange(view.longitudeOffset, -180, 180, `Longitude offset for ${scene.id}`);
      finiteRange(view.latitudeOffset, -85, 85, `Latitude offset for ${scene.id}`);
      finiteRange(view.zoom, .25, 4, `Map zoom for ${scene.id}`);
      finiteRange(view.headingOffset, -180, 180, `Heading offset for ${scene.id}`);
      finiteRange(view.pitchOffset, -60, 60, `Pitch offset for ${scene.id}`);
    }
    if (scene.section === "child") {
      if (!scene.childId || !scene.childName) throw new Error(`Child scene ${scene.id} is missing administrative metadata`);
    }
    for (const placement of scene.placements ?? []) {
      if (!assetIds.has(placement.assetId)) throw new Error(`Scene ${scene.id} references missing asset ${placement.assetId}`);
      finiteRange(placement.leadSeconds, 0, 0.75, `Asset lead for ${scene.id}`);
      finiteRange(placement.tailSeconds, 0, 0.75, `Asset tail for ${scene.id}`);
      finiteRange(placement.minimumDisplaySeconds, 0.1, 120, `Asset minimum duration for ${scene.id}`);
      if (placement.includeInRender !== undefined && typeof placement.includeInRender !== "boolean") {
        throw new Error(`Asset render selection for ${scene.id} must be a boolean`);
      }
    }
    if (scene.assetDisplayCount !== undefined) {
      finiteRange(scene.assetDisplayCount, 1, 100, `Asset display count for ${scene.id}`);
      if (!Number.isInteger(scene.assetDisplayCount)) throw new Error(`Asset display count for ${scene.id} must be an integer`);
    }
  }
  const scenes = project.scenes as StudioScene[];
  if (scenes.filter((scene) => scene.section === "cover").length !== 1) throw new Error("模板必须且只能包含一个封面");
  if (scenes.filter((scene) => scene.section === "outro").length !== 1) throw new Error("模板必须且只能包含一个拉回结尾");
  // The cover stays locked to the front. The tape may END on the pull-back itself
  // or on 结尾补充 scenes that follow it, so the last row is one of those two — but
  // never anything else, which is what keeps a stray overview/child from trailing
  // the ending.
  if (scenes[0]?.section !== "cover" || (scenes.at(-1)?.section !== "outro" && scenes.at(-1)?.section !== "outro-lead")) {
    throw new Error("封面位置与结尾位置由视频生成技能锁定");
  }
  // 结尾补充 is the *closing block after the pull-back*: the camera returns to the
  // parent region first, then these scenes play as the final shots. Everything else
  // keeps the cover→overview→child→outro ordering, so the rank map only has to put
  // the newcomer after the outro.
  const sectionRank = { cover: 0, overview: 1, child: 2, outro: 3, "outro-lead": 4 } as const;
  if (scenes.some((scene, index) => index > 0 && sectionRank[scene.section!] < sectionRank[scenes[index - 1]!.section!])) {
    throw new Error("场景顺序必须保持封面、总体介绍、行政区巡游、拉回结尾、结尾补充");
  }
  if (scenes.some((scene, index) => scene.section === "outro-lead" && scenes.slice(0, index).every((earlier) => earlier.section !== "outro"))) {
    throw new Error("结尾补充必须排在拉回上级区域结尾之后");
  }
}
