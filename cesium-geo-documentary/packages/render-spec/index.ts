import { createHash } from "node:crypto";
import { buildSingleLineCues, normalizeSubtitleSemantics, splitSingleLineText, type SingleLineCueOverride } from "../content-engine/subtitles.js";
import { normalizeSemanticText, type AssetPlacement, type MapView, type StudioScene, type VideoProject } from "../project-schema/index.js";
import { MINIMUM_RENDERED_VISUAL_SECONDS, planVisualClip, resolveVisualClipWindow } from "./visual-timeline.js";
import { compositionNarrationLeadSeconds } from "./opening-timing.js";

export interface TimedCue {
  index: number;
  start: number;
  end: number;
  text: string;
}

export interface SceneCueRange {
  sceneId: string;
  sceneTextHash: string;
  cueStartIndex: number;
  cueEndIndex: number;
  start: number;
  end: number;
  text: string;
}

export interface RenderSpecAsset extends AssetPlacement {
  id: string;
  name: string;
  path: string;
  sceneId: string;
  cueStartIndex: number;
  cueEndIndex: number;
  sourceType: string;
  verifiedReal: boolean;
  sourceUrl?: string;
  /** Stable order for several photos bound to the same scene. */
  sequenceIndex?: number;
  sequenceCount?: number;
}

export interface RenderSpec {
  schema: "geo-documentary-render-spec";
  version: 1;
  generatedAt: string;
  projectId: string;
  projectRevision: number;
  regionId: string;
  templateVersion: string;
  output: VideoProject["output"];
  imagery: VideoProject["imagery"];
  /** Presentation-relative narration windows whose Tianditu label layer is visible. */
  annotationWindows: Array<{ sceneId: string; start: number; end: number }>;
  mapViewTrack?: Array<{ start: number; view: MapView | null }>;
  cover: VideoProject["cover"];
  opening: {
    descentSeconds: number;
    /**
     * 地图时间线开头到第一句旁白的秒数——成片把旁白、字幕和所有跟随旁白的镜头
     * 都放在这个偏移之后。编辑器用它算时间码，必须与合成器同源，见
     * `opening-timing.ts`。
     */
    narrationLeadSeconds: number;
    startHeightMeters: number;
    startPitchDegrees: number;
    cloudDeckHeightMeters: number;
    cloudAlphaPeak: number;
  };
  voice: VideoProject["voice"];
  scenes: Array<{
    sceneId: string;
    type: StudioScene["type"];
    section: StudioScene["section"];
    title: string;
    narration: string;
    subtitle: string;
    cueRange: SceneCueRange | null;
    timing: NonNullable<StudioScene["timing"]>;
    childId?: string;
    childName?: string;
    imageryAnnotation?: boolean;
    camera?: StudioScene["camera"];
  }>;
  narrationCues: TimedCue[];
  subtitleCues: TimedCue[];
  sceneCueRanges: SceneCueRange[];
  assets: RenderSpecAsset[];
  childTourOrder: string[];
  outro: { action: "pullBackToParent"; target: string; duration: number; text: string };
  narrationDurationSeconds: number;
  timelineDurationSeconds: number;
  totalDurationSeconds: number;
  geometrySignature: string;
  cacheSignature: string;
}

export function parseSrt(source: string): TimedCue[] {
  const stamp = (value: string): number => {
    const match = value.trim().match(/^(\d+):(\d+):(\d+)[,.](\d+)$/);
    if (!match) throw new Error(`Invalid SRT timestamp: ${value}`);
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]!.padEnd(3, "0").slice(0, 3)) / 1000;
  };
  return source.trim().split(/\r?\n\s*\r?\n/).filter(Boolean).map((block, index) => {
    const lines = block.split(/\r?\n/);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) throw new Error(`SRT block ${index + 1} has no timing`);
    const [start, end] = lines[timingIndex]!.split("-->").map(stamp);
    return { index, start: start!, end: end!, text: lines.slice(timingIndex + 1).join("").trim() };
  });
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function mapScenesToCues(scenes: StudioScene[], cues: TimedCue[]): SceneCueRange[] {
  const spokenScenes = scenes.filter((scene) => scene.section !== "cover");
  const mappings: SceneCueRange[] = [];
  let cursor = 0;
  for (const scene of spokenScenes) {
    const target = normalizeSemanticText(scene.narration);
    if (!target) continue;
    let joined = "";
    let end = cursor - 1;
    for (let index = cursor; index < cues.length; index += 1) {
      joined += normalizeSemanticText(cues[index]!.text);
      if (joined === target) { end = index; break; }
      if (!target.startsWith(joined)) break;
    }
    if (end < cursor) {
      throw new Error(`无法按文本稳定映射场景 ${scene.id}；请重新生成配音，或检查旁白是否与 SRT 一致`);
    }
    const selected = cues.slice(cursor, end + 1);
    mappings.push({
      sceneId: scene.id,
      sceneTextHash: sha256(target),
      cueStartIndex: cursor,
      cueEndIndex: end,
      start: selected[0]!.start,
      end: selected.at(-1)!.end,
      text: selected.map((cue) => cue.text).join("")
    });
    cursor = end + 1;
  }
  if (cursor !== cues.length) throw new Error(`仍有 ${cues.length - cursor} 个 TTS cue 未映射到场景`);
  return mappings;
}

function defaultTiming(scene: StudioScene): NonNullable<StudioScene["timing"]> {
  return scene.timing ?? {
    actualNarrationSeconds: Math.max(0, scene.duration),
    preHoldSeconds: 0,
    postHoldSeconds: 0,
    minimumVisualSeconds: Math.max(2, scene.duration),
    mapHoldSeconds: scene.section === "child" ? 2 : 0
  };
}

// 必须与 config/render-profiles.yaml 的 subtitle_chars_per_line 一致——合成器读
// 那份 YAML，这里读这个函数。两边不一致时，按 18 字切好的手动断行会被合成器按
// 15 字拒绝：「Subtitle override for cue 0 exceeds 15 characters」，整条导出在
// 录制前就死掉（2026-11-10 龙门镇）。以 YAML 为准：竖屏 15 / 方形 16 / 横屏 21。
function subtitleMaximum(project: VideoProject): number {
  if (project.output.profile === "portrait") return 15;
  if (project.output.profile === "square") return 16;
  return 21;
}

function subtitleProtectedPhrases(project: VideoProject): string[] {
  return [...new Set([
    project.cover.province,
    project.cover.city,
    project.cover.county,
    project.cover.town,
    project.cover.administrativeLabel,
    ...project.scenes.map((scene) => scene.childName ?? "")
  ].map((value) => value.trim()).filter((value) => value.length >= 2))];
}

export function subtitleOverrideChunks(scene: StudioScene, range: SceneCueRange, cues: TimedCue[]): Array<{ cueIndex: number; chunks: string[] }> {
  const rawChunks = scene.subtitle.split(/\r?\n/).map((chunk) => chunk.trim()).filter(Boolean);
  if (normalizeSemanticText(rawChunks.join("")) !== normalizeSemanticText(scene.narration)) {
    throw new Error(`${scene.title}的字幕断句改变了配音语义`);
  }
  const selected = cues.slice(range.cueStartIndex, range.cueEndIndex + 1);
  if (selected.length === 1) return [{ cueIndex: range.cueStartIndex, chunks: rawChunks.length ? rawChunks : [selected[0]!.text] }];
  const result: Array<{ cueIndex: number; chunks: string[] }> = [];
  let chunkIndex = 0;
  let semanticBuffer = "";
  const outputChunks: string[] = [];
  for (let cueOffset = 0; cueOffset < selected.length; cueOffset += 1) {
    const target = normalizeSemanticText(selected[cueOffset]!.text);
    semanticBuffer = "";
    outputChunks.length = 0;
    while (chunkIndex < rawChunks.length && semanticBuffer.length < target.length) {
      const chunk = rawChunks[chunkIndex++]!;
      semanticBuffer += normalizeSemanticText(chunk);
      outputChunks.push(chunk);
    }
    if (semanticBuffer !== target) return [];
    result.push({ cueIndex: range.cueStartIndex + cueOffset, chunks: [...outputChunks] });
  }
  return result;
}

/**
 * Turn each scene's hand-broken `subtitle` (newlines = intended cue boundaries)
 * into `buildSingleLineCues` overrides.
 *
 * The schema has always promised that "newlines control subtitle chunks", but
 * only the tests read `subtitleOverrideChunks` — the render path divided cues by
 * character count alone, which sliced words and names in half (「一进门满 / 檐」,
 * 「陈兰 / 彬」). Wire it in so an editor's punctuation survives into the film.
 *
 * A manual chunk that is still wider than one line is split again by the usual
 * width rules, so a careless line break cannot make the render throw.
 */
function sceneSubtitleOverrides(
  project: VideoProject,
  ranges: SceneCueRange[],
  cues: TimedCue[],
  maximum: number,
  protectedPhrases: readonly string[]
): SingleLineCueOverride[] {
  const rangeByScene = new Map(ranges.map((range) => [range.sceneId, range]));
  const taken = new Set<number>();
  const overrides: SingleLineCueOverride[] = [];
  for (const scene of project.scenes) {
    if (!scene.subtitle?.includes("\n")) continue;
    const range = rangeByScene.get(scene.id);
    if (!range) continue;
    let mapped: Array<{ cueIndex: number; chunks: string[] }>;
    try {
      mapped = subtitleOverrideChunks(scene, range, cues);
    } catch {
      // Semantic drift or an unmappable multi-cue scene: fall back to width split.
      continue;
    }
    for (const item of mapped) {
      if (taken.has(item.cueIndex)) continue;
      const chunks = item.chunks
        // A hand-authored line that already fits is kept verbatim; only an
        // over-wide line falls back to the width splitter.
        .flatMap((chunk) => ([...chunk.trim()].length <= maximum ? [chunk] : splitSingleLineText(chunk, maximum, protectedPhrases)))
        .map((chunk) => chunk.trim())
        .filter(Boolean);
      if (!chunks.length) continue;
      // Never hand over chunks that would fail buildSingleLineCues' own guard:
      // a scene's subtitle can map onto a cue set that drifted after a TTS
      // regeneration, and a hard failure there would block the whole export.
      const spoken = cues[item.cueIndex]?.text ?? "";
      if (normalizeSubtitleSemantics(chunks.join("")) !== normalizeSubtitleSemantics(spoken)) continue;
      taken.add(item.cueIndex);
      overrides.push({ cueIndex: item.cueIndex, chunks });
    }
  }
  return overrides;
}

export function buildRenderSpec(input: {
  project: VideoProject;
  cues: TimedCue[];
  geometrySignature: string;
  narrationDurationSeconds?: number;
  timelineDurationSeconds?: number;
  generatedAt?: string;
  /**
   * Hash of the sources that actually rasterise the Cesium map. Callers pass it
   * so that editing the camera or layer code invalidates cached map videos
   * automatically; the fallback constant only covers changes that live purely in
   * configuration.
   */
  rendererSignature?: string;
  /**
   * 区域 timeline.json 里实测的旁白起拍偏移。成片用它定位旁白与字幕，预览也用它
   * 算时间码；不传就按"巡游方案 = 下降 + 0.35 s，其它方案 = 0"推算。
   */
  timelineNarrationStartSeconds?: number | undefined;
}): RenderSpec {
  const { project, cues } = input;
  const ranges = mapScenesToCues(project.scenes, cues);
  const rangeByScene = new Map(ranges.map((range) => [range.sceneId, range]));
  const subtitleCues = buildSingleLineCues(
    cues,
    subtitleMaximum(project),
    subtitleProtectedPhrases(project),
    sceneSubtitleOverrides(project, ranges, cues, subtitleMaximum(project), subtitleProtectedPhrases(project))
  )
    .map((cue, index) => ({ index, start: cue.start, end: cue.end, text: cue.text }));
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const assets: RenderSpecAsset[] = [];
  for (const scene of project.scenes) {
    const range = rangeByScene.get(scene.id);
    if (!range) continue;
    const placements = scene.placements ?? [];
    for (const [sequenceIndex, placement] of placements.entries()) {
      const asset = assetsById.get(placement.assetId);
      if (!asset) throw new Error(`Missing asset ${placement.assetId}`);
      assets.push({
        ...placement,
        id: asset.id,
        name: asset.name,
        path: asset.path,
        sceneId: scene.id,
        cueStartIndex: range.cueStartIndex,
        cueEndIndex: range.cueEndIndex,
        sourceType: asset.sourceType ?? "user-provided",
        verifiedReal: Boolean(asset.verifiedReal),
        ...(placements.length > 1 ? { sequenceIndex, sequenceCount: placements.length } : {}),
        ...(asset.sourceUrl ? { sourceUrl: asset.sourceUrl } : {})
      });
    }
  }
  const annotationWindows = project.scenes
    .filter((scene) => scene.imageryAnnotation === true)
    .flatMap((scene) => {
      const range = rangeByScene.get(scene.id);
      return range ? [{ sceneId: scene.id, start: range.start, end: range.end }] : [];
    });
  const mapViewTrack = project.scenes.some(scene => scene.mapView)
    ? ranges.map(range => ({ start: range.start, view: project.scenes.find(scene => scene.id === range.sceneId)?.mapView ?? null }))
    : undefined;
  const narrationDurationSeconds = input.narrationDurationSeconds ?? cues.at(-1)?.end ?? 0;
  const timelineDurationSeconds = input.timelineDurationSeconds ?? Math.ceil(narrationDurationSeconds + project.template.openingDescentSeconds);
  const signatureInput = {
    mapRendererVersion: input.rendererSignature ?? MAP_RENDERER_CACHE_VERSION,
    geometrySignature: input.geometrySignature,
    output: project.output,
    imagery: project.imagery,
    annotations: annotationWindows,
    mapViewTrack,
    opening: project.template,
    tour: project.scenes.filter((scene) => scene.section === "child").map((scene) => ({ id: scene.childId, name: scene.childName, camera: scene.camera, timing: defaultTiming(scene) })),
    outro: project.template.tourReturnSeconds,
    cues: cues.map(({ start, end, text }) => ({ start, end, text })),
  };
  return {
    schema: "geo-documentary-render-spec",
    version: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    projectId: project.id,
    projectRevision: project.revision,
    regionId: project.regionId,
    templateVersion: project.template.id,
    output: project.output,
    imagery: project.imagery,
    annotationWindows,
    ...(mapViewTrack ? { mapViewTrack } : {}),
    cover: project.cover,
    opening: {
      descentSeconds: project.template.openingDescentSeconds,
      narrationLeadSeconds: compositionNarrationLeadSeconds({
        descentSeconds: project.template.openingDescentSeconds,
        hasChildTour: project.scenes.some((scene) => scene.section === "child"),
        timelineNarrationStartSeconds: input.timelineNarrationStartSeconds
      }),
      startHeightMeters: project.template.openingStartHeightMeters,
      startPitchDegrees: project.template.openingStartPitchDegrees,
      cloudDeckHeightMeters: project.template.cloudDeckHeightMeters,
      cloudAlphaPeak: project.template.cloudAlphaPeak
    },
    voice: project.voice,
    scenes: project.scenes.map((scene) => ({
      sceneId: scene.id,
      type: scene.type,
      section: scene.section,
      title: scene.title,
      narration: scene.narration,
      subtitle: scene.subtitle,
      cueRange: rangeByScene.get(scene.id) ?? null,
      timing: defaultTiming(scene),
      ...(scene.childId ? { childId: scene.childId } : {}),
      ...(scene.childName ? { childName: scene.childName } : {}),
      ...(scene.imageryAnnotation ? { imageryAnnotation: true } : {}),
      ...(scene.camera ? { camera: scene.camera } : {})
    })),
    narrationCues: cues,
    subtitleCues,
    sceneCueRanges: ranges,
    assets,
    childTourOrder: project.scenes.filter((scene) => scene.section === "child").map((scene) => scene.childId!),
    outro: { action: "pullBackToParent", target: project.regionId, duration: project.template.tourReturnSeconds, text: project.scenes.find((scene) => scene.section === "outro")?.subtitle ?? "" },
    narrationDurationSeconds,
    timelineDurationSeconds,
    totalDurationSeconds: project.cover.introSeconds + timelineDurationSeconds,
    geometrySignature: input.geometrySignature,
    cacheSignature: sha256(signatureInput)
  };
}

export function updateProjectMeasuredDurations(project: VideoProject, spec: RenderSpec): VideoProject {
  const ranges = new Map(spec.sceneCueRanges.map((range) => [range.sceneId, range]));
  project.scenes = project.scenes.map((scene) => {
    if (scene.section === "cover") return { ...scene, duration: project.cover.introSeconds };
    const range = ranges.get(scene.id);
    if (!range) return scene;
    const actualNarrationSeconds = Math.round((range.end - range.start) * 1000) / 1000;
    const timing = defaultTiming(scene);
    // Re-generating narration can leave a scene much shorter than it was when the
    // operator set "minimum visual seconds". Keeping the stale value hands it to
    // every picture bound afterwards, and a minimum longer than the scene decides
    // the clip's end in the composition — one card asked for 13.5 s inside a
    // 7.24 s scene and painted over the next two, one of which had no picture.
    const configuredMinimum = Number(timing.minimumVisualSeconds ?? actualNarrationSeconds);
    const minimumVisualSeconds = Math.min(configuredMinimum, Math.max(1, actualNarrationSeconds));
    return { ...scene, duration: actualNarrationSeconds, timing: { ...timing, actualNarrationSeconds, minimumVisualSeconds } };
  });
  return project;
}
// Fallback cache version, used only when a caller cannot supply a renderer
// signature. Studio always supplies one derived from the real Cesium sources
// (`mapRendererSignature`), because a hand-maintained constant is exactly the
// thing that goes stale: two camera fixes shipped without bumping this string,
// so exports for every already-cached region silently reused map video captured
// by the old camera. Bump this only for changes that live in configuration
// rather than in the rendering sources.
const MAP_RENDERER_CACHE_VERSION = "parent-boundary-reveal-v4-canvas-capture";

/**
 * Which bound images of a scene enter the film, in film order.
 *
 * Only pictures the operator explicitly marked 用于成片 (`includeInRender ===
 * true`) enter. There used to be a fallback — "a scene with no flags keeps the
 * first `assetDisplayCount ?? 1` pictures" — and it made a scene that looked
 * image-less in the editor ship with a photo in the film: the素材 cards showed
 * no ✓, the operator had never chosen anything, and the export still emitted
 * one picture. The checkbox is now the single source of truth, so "no picture
 * selected" and "no picture in the film" mean the same thing.
 *
 * `sceneAssets` must already be in the scene's placement order —
 * `buildRenderSpec` guarantees that.
 */
export function selectSceneAssetsForRender<T extends { id: string }>(scene: StudioScene, sceneAssets: readonly T[]): T[] {
  const placements = scene.placements ?? [];
  if (!placements.length) return [];
  const assetsById = new Map(sceneAssets.map((asset) => [asset.id, asset]));
  return placements
    .filter((placement) => placement.includeInRender === true)
    .map((placement) => assetsById.get(placement.assetId))
    .filter((asset): asset is T => Boolean(asset));
}

export { clampMinimumDisplaySeconds, OPENING_VISUAL_DELAY_SECONDS, planVisualClip, resolveVisualClipWindow } from "./visual-timeline.js";

export interface VisualTimelineScene {
  id: string;
  title: string;
  section: string;
  /** Presentation-relative narration seconds (0 = the film's first narration cue). */
  startSeconds: number;
  endSeconds: number;
  /** Pictures bound to the scene, whether or not they were marked 用于成片. */
  boundCount: number;
  /** Pictures that enter the film, i.e. marked 用于成片. */
  imageCount: number;
  /** 本场最短图片实际展示秒数；逐图窗口不同时不能用整场旁白均分。 */
  perImageSeconds: number | null;
  /** A map-only scene is supposed to have no picture; an image scene without one is a gap. */
  expectsImages: boolean;
}

export interface VisualTimelineClip {
  id: string;
  sceneId: string;
  label: string;
  startSeconds: number;
  endSeconds: number;
  cueStartSeconds: number;
  cueEndSeconds: number;
  sequenceIndex: number;
  sequenceCount: number;
  configuredMinimumSeconds: number;
  minimumDisplaySeconds: number;
  /** The configured minimum had to be shortened to fit the scene. */
  clamped: boolean;
  /** The scene boundary decided the end, not the cue. */
  truncatedByScene: boolean;
  /** Shorter than the compositor will render. */
  tooShort: boolean;
  /** Runs outside its own scene — must stay 0; a non-zero value is the bug that shipped. */
  overflowsScene: boolean;
}

export interface VisualTimeline {
  schema: "geo-documentary-visual-timeline";
  /** Narration length; ranges are presentation-relative and end here. */
  totalSeconds: number;
  scenes: VisualTimelineScene[];
  clips: VisualTimelineClip[];
  counts: {
    scenes: number;
    scenesWithImages: number;
    /** Image-bearing scenes that ship no picture — the film goes blank here. */
    imageScenesWithoutPictures: number;
    clips: number;
    clamped: number;
    truncated: number;
    tooShort: number;
    overflows: number;
  };
}

function sceneExpectsImages(scene: StudioScene): boolean {
  return scene.type !== "map-overview" && scene.type !== "region-focus" && scene.type !== "outro" && scene.section !== "outro";
}

/**
 * The film's picture track, scene by scene, as the export will lay it out.
 *
 * This is the missing surface between the editor and the rendered film: the
 * editor knows which pictures are marked, the compositor knows where they land,
 * and nobody could see both at once. Everything here is derived from the render
 * spec and the project alone, so the panel can show it before an export starts —
 * and a picture that leaves its scene, a scene that ends up blank, or a scene
 * whose window cannot fit its pictures all become visible without rendering.
 */
export function planVisualTimeline(project: VideoProject, spec: RenderSpec): VisualTimeline {
  const rangeBySceneId = new Map(spec.sceneCueRanges.map((range) => [range.sceneId, range]));
  const openingSceneId = project.scenes.find((scene) => scene.section !== "cover")?.id;
  const scenes: VisualTimelineScene[] = [];
  const clips: VisualTimelineClip[] = [];
  for (const scene of project.scenes) {
    if (scene.section === "cover") continue;
    const range = rangeBySceneId.get(scene.id);
    const bound = spec.assets.filter((asset) => asset.sceneId === scene.id);
    const kept = selectSceneAssetsForRender(scene, bound);
    const startSeconds = range?.start ?? 0;
    const endSeconds = range?.end ?? startSeconds;
    const sceneClipStart = clips.length;
    const timelineScene: VisualTimelineScene = {
      id: scene.id,
      title: scene.title,
      section: scene.section ?? "overview",
      startSeconds,
      endSeconds,
      boundCount: bound.length,
      imageCount: kept.length,
      perImageSeconds: null,
      expectsImages: sceneExpectsImages(scene)
    };
    scenes.push(timelineScene);
    kept.forEach((asset, sequenceIndex) => {
      const plan = planVisualClip({
        scene,
        placement: asset,
        sequenceIndex,
        ...(openingSceneId !== undefined ? { openingSceneId } : {}),
        ...(range ? {
          range,
          cueStartSeconds: spec.narrationCues[asset.cueStartIndex]?.start ?? range.start,
          cueEndSeconds: spec.narrationCues[asset.cueEndIndex]?.end ?? range.end
        } : {})
      });
      const cueStartSeconds = range ? spec.narrationCues[asset.cueStartIndex]?.start ?? range.start : 0;
      const cueEndSeconds = range ? spec.narrationCues[asset.cueEndIndex]?.end ?? range.end : 0;
      const window = resolveVisualClipWindow({
        cueStartSeconds,
        cueEndSeconds,
        leadSeconds: asset.leadSeconds,
        tailSeconds: asset.tailSeconds,
        minimumDisplaySeconds: plan.minimumDisplaySeconds,
        ...(plan.notBeforeNarrationSeconds !== undefined ? { notBeforeNarrationSeconds: plan.notBeforeNarrationSeconds } : {}),
        ...(plan.notAfterNarrationSeconds !== undefined ? { notAfterNarrationSeconds: plan.notAfterNarrationSeconds } : {}),
        sequenceIndex,
        sequenceCount: kept.length
      });
      clips.push({
        id: asset.id,
        sceneId: scene.id,
        label: asset.name,
        startSeconds: window.startSeconds,
        endSeconds: window.endSeconds,
        cueStartSeconds,
        cueEndSeconds,
        sequenceIndex,
        sequenceCount: kept.length,
        configuredMinimumSeconds: plan.configuredMinimumSeconds,
        minimumDisplaySeconds: plan.minimumDisplaySeconds,
        clamped: plan.minimumDisplaySeconds < plan.configuredMinimumSeconds - 1e-6,
        truncatedByScene: window.truncatedByScene,
        tooShort: window.endSeconds - window.startSeconds + 1e-6 < MINIMUM_RENDERED_VISUAL_SECONDS,
        overflowsScene: window.endSeconds > endSeconds + 1e-6
      });
    });
    if (kept.length > 0) {
      timelineScene.perImageSeconds = Math.min(...clips.slice(sceneClipStart).map((clip) => Math.max(0, clip.endSeconds - clip.startSeconds)));
    }
  }
  return {
    schema: "geo-documentary-visual-timeline",
    totalSeconds: spec.narrationDurationSeconds,
    scenes,
    clips,
    counts: {
      scenes: scenes.length,
      scenesWithImages: scenes.filter((scene) => scene.imageCount > 0).length,
      imageScenesWithoutPictures: scenes.filter((scene) => scene.expectsImages && scene.imageCount === 0).length,
      clips: clips.length,
      clamped: clips.filter((clip) => clip.clamped).length,
      truncated: clips.filter((clip) => clip.truncatedByScene).length,
      tooShort: clips.filter((clip) => clip.tooShort).length,
      overflows: clips.filter((clip) => clip.overflowsScene).length
    }
  };
}
