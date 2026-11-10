import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { buildSingleLineCues, timelineValues, type SingleLineCueOverride, type SubtitleCue as Cue } from "../../../../packages/content-engine/subtitles.js";
import { mediaKindForPath } from "../../../../packages/content-engine/media.js";
import { COMPOSITION_TRACKS, musicTrack, visualTrack } from "../../../../packages/content-engine/tracks.js";
import { normalizeAnchorText } from "../../../../packages/content-engine/visual-anchoring.js";
import type { AssetFit } from "../../../../packages/project-schema/index.js";
import { generateCoverAsset, resolveCoverDefinition } from "./cover.js";

interface RegionContent {
  name: string;
  title?: string;
  subtitleLeadSeconds?: number;
  facts: {
    population: string;
    economy: string;
    physical: string;
    history: string;
    culture: string;
    modern: string;
  };
}
interface RenderProfile { width: number; height: number; subtitle_chars_per_line: number; safe_margin: number }
interface VisualClip {
  id: string;
  /** Stable identity for one UI selection, including repeated assets in different scenes. */
  selectionKey?: string;
  path: string;
  label: string;
  /** Shared with the project schema so a new fit mode cannot go unnoticed here. */
  fit?: AssetFit;
  sourceType?: "verified-real" | "user-provided" | "generated-illustrative" | "amap-poi";
  narrationCueIndex?: number;
  narrationCueEndIndex?: number;
  requiredKeywords?: string[];
  leadSeconds?: number;
  tailSeconds?: number;
  start?: number;
  end?: number;
  minimumDisplaySeconds?: number;
  /** Audio-relative floor used when a visual must wait for its map camera flight to lock. */
  notBeforeNarrationSeconds?: number;
  /** Audio-relative hard boundary that prevents a visual entering the next scene. */
  notAfterNarrationSeconds?: number;
  /** Divide one narration-bound scene into a deterministic multi-photo sequence. */
  sequenceIndex?: number;
  sequenceCount?: number;
  crop?: { x: number; y: number; width: number; height: number };
  focalPoint?: { x: number; y: number };
  scale?: number;
  offsetX?: number;
  offsetY?: number;
  animation?: "still" | "push-in" | "pull-out" | "pan-left" | "pan-right";
}
interface ResolvedVisualClip extends VisualClip {
  src: string;
  start: number;
  end: number;
  timingMode: "narration-cue" | "legacy-seconds";
  hasAudio?: boolean;
  cueStart?: number;
  cueEnd?: number;
  cueText?: string;
  /** Set when requiredKeywords did not match the declared cue and the clip was
   *  re-anchored to the measured cue that actually mentions the keyword, or
   *  rendered against its original cue because no cue mentions the keyword. */
  keywordWarnings?: string[];
}
interface ResolvedCover {
  src: string;
  imagePath: string;
  introSeconds: number;
  hierarchicalTitle: string;
}

// The entrance transition lasts 0.42 s. Requiring at least 0.5 s guarantees
// that every selected image reaches a visibly rendered state in the film.
const MINIMUM_RENDERED_VISUAL_SECONDS = 0.5;

const root = resolve(process.cwd());
const args = process.argv.slice(2);
const valueAfter = (flag: string, fallback?: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const requested = valueAfter("--region");
const profileName = valueAfter("--profile", "landscape")!;
const requestedCoverImagePath = valueAfter("--cover-image");
const requestedCoverIntroSeconds = valueAfter("--cover-intro-seconds");
/**
 * Build the composition even when the recorded map does not exist yet, using a
 * black stand-in in its slot.
 *
 * Composition depends on media *existing*, not on what the map recorded: the
 * HTML, subtitle timing and visual windows come from the narration, the timeline
 * and the visual manifest, all of which are ready before the capture. That is
 * what lets the Studio lint a composition before spending ~40 minutes recording
 * it (a single lint error used to surface only at the post-capture preflight).
 * Off by default, so the CLI still fails loudly when the map is missing.
 */
const mapFallbackAllowed = args.includes("--map-fallback");
const master = JSON.parse(await readFile(resolve(root, "content/regions.zh-CN.json"), "utf8")) as Record<string, RegionContent>;
const ids = requested ? [requested] : Object.keys(master);
const profiles = YAML.parse(await readFile(resolve(root, "config/render-profiles.yaml"), "utf8")) as { profiles: Record<string, RenderProfile> };
const profile = profiles.profiles[profileName] ?? (() => { throw new Error(`Unknown profile ${profileName}`); })();
const projectConfig = YAML.parse(await readFile(resolve(root, "config/project.yaml"), "utf8")) as {
  map?: { imagery_provider?: string; imagery_attribution?: string };
};
const imageryAttribution = projectConfig.map?.imagery_provider === "esri-world-imagery"
  ? "Esri World Imagery · Esri, Maxar, Earthstar Geographics and contributors"
  : projectConfig.map?.imagery_attribution ?? "";

const compositor = resolve(root, "apps/video-compositor");
const mediaDir = resolve(compositor, "media");
const compositionDir = resolve(compositor, "compositions");
await Promise.all([
  mkdir(resolve(mediaDir, "maps"), { recursive: true }),
  mkdir(resolve(mediaDir, "audio"), { recursive: true }),
  mkdir(resolve(mediaDir, "fonts"), { recursive: true }),
  mkdir(resolve(mediaDir, "images"), { recursive: true }),
  mkdir(resolve(mediaDir, "music"), { recursive: true }),
  mkdir(compositionDir, { recursive: true })
]);
await copyFile(resolve(root, "node_modules/gsap/dist/gsap.min.js"), resolve(mediaDir, "gsap.min.js"));

function resolveFfprobePath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const staticBinary = (require("ffprobe-static") as { path?: string })?.path;
    if (typeof staticBinary === "string" && existsSync(staticBinary)) {
      return staticBinary;
    }
  } catch {
    // fall through to filesystem lookup
  }
  const binary = resolve(
    root,
    "node_modules",
    "ffprobe-static",
    "bin",
    process.platform === "win32" ? "win32/x64/ffprobe.exe" : "linux/x64/ffprobe"
  );
  if (existsSync(binary)) return binary;
  return null;
}

function probeVideoHasAudio(filePath: string): boolean {
  const ffprobe = resolveFfprobePath();
  if (!ffprobe) return false;
  try {
    const stdout = execFileSync(ffprobe, [
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=codec_type",
      "-of", "json",
      filePath
    ], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, encoding: "utf8" });
    const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }> };
    return Boolean(parsed.streams && parsed.streams.length > 0);
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * Write the black stand-in used by `--map-fallback`.
 *
 * One frame per second is enough: nothing frames it as a motion source during a
 * lint pass, it only has to exist, decode, and be at least as long as the
 * timeline declares (so the duration checks stay quiet). Measured: 400 s at
 * 1080x1920 costs ~1.3 s and 20 KB, against 82 MB / 33.6 minutes for the real
 * recording it stands in for.
 */
async function writeMapFallbackStub(target: string, profile: RenderProfile, durationSeconds: number): Promise<void> {
  const ffmpeg = fileURLToPath(new URL(
    `../../../../node_modules/ffmpeg-static/${process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"}`,
    import.meta.url
  ));
  if (!existsSync(ffmpeg)) throw new Error("缺少 ffmpeg（node_modules/ffmpeg-static），无法生成地图占位视频；请先 pnpm install");
  const seconds = Math.max(1, Math.ceil(durationSeconds));
  await new Promise<void>((resolvePromise, reject) => {
    // stdin stays ignored on purpose: this host cannot start a child whose stdin
    // and stdout are both piped (see the sandbox notes in tests/python-runtime).
    const child = spawn(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `color=c=black:s=${profile.width}x${profile.height}:r=1`,
      "-t", String(seconds),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an",
      target
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolvePromise();
      reject(new Error(`地图占位视频生成失败（ffmpeg exit ${code ?? "null"}）：${stderr.join("").trim().slice(-300) || "无输出"}`));
    });
  });
}

function compositionHtml(regionId: string, prefix: string, displayCues: Cue[], audioDuration: number, timelineDuration: number, narrationStartSeconds: number, openingGateSeconds: number, visuals: ResolvedVisualClip[], cover: ResolvedCover): string {
  const content = master[regionId];
  if (!content) throw new Error(`Unknown region ${regionId}`);
  const offset = cover.introSeconds;
  const narrationOffset = offset + narrationStartSeconds + openingGateSeconds;
  const subtitleLeadSeconds = Math.max(-0.35, Math.min(0.2, Number(content.subtitleLeadSeconds ?? 0)));
  const compositionDuration = timelineDuration + offset;
  const coverFadeSeconds = Math.min(0.46, Math.max(0.28, offset * 0.22));
  const coverFadeStart = Math.max(0, offset - coverFadeSeconds);
  const isPortrait = profile.height > profile.width;
  const isSquare = profile.height === profile.width;
  // Subtitles sit 25% of the frame height above the bottom edge — a deliberate
  // composition choice asked for directly, not a measurement of any platform chrome.
  // We anchor the subtitle's CENTRE to that line (hence the translateY(50%) below) so
  // the alignment holds no matter how many lines a cue wraps to.
  //
  // History: "字幕上移 25%…从屏幕下方到上方起算" (2026-10-12) fixed the number at 25 — the
  // percentage is counted from the bottom edge upward, and it names the line's distance above
  // that edge. An earlier "再往上移 10%" in the same session was read as ten points of frame
  // height and landed at 33; the operator then settled back down to 25. Before all of that,
  // 35.9% was derived by measuring the Douyin collect (★)
  // icon off a real frame (1179x2556, star glyph y 1596→1681, centre 918 px above the
  // bottom edge). That measurement was correct, but alignment to the action rail is no
  // longer what we want. The value before that, 28.82%, came from sampling column x≈470,
  // which is not on the rail at all (the rail sits at x≈1060–1145) — if you ever go back
  // to platform-relative anchoring, re-measure with a gold-pixel column histogram first;
  // never trust a hand-picked column.
  const subtitleBottomPercent = 25;
  const subtitleBottomPx = Math.round(profile.height * (subtitleBottomPercent / 100));
  /* 影像署名是右下角的一条固定文字带（`bottom:18px` + 自身行盒与内边距）。「全屏」
     适配会把素材标签放到画面底边，于是两个文字块叠在一起 —— HyperFrames 的
     layout 审计一旦发现同一个重叠跨多个采样点就升为 error（`content_overlap`），
     2026-10-12 就是这么拦住一次导出的（#provider-credit ↔ #visual-caption-N）。
     署名是许可要求必须可读，所以让全屏标签另占一条区域：抬到署名上方。 */
  const creditFontPx = isPortrait ? 15 : 13;
  const creditTopPx = 18 + Math.round(creditFontPx * 1.2) + 10;
  const fullscreenCaptionBottomPx = imageryAttribution ? creditTopPx + 12 : (isPortrait ? 16 : 14);
  const captionClips = displayCues.map((cue, index) => {
    const timeline = timelineValues(Math.max(offset, cue.start + narrationOffset + subtitleLeadSeconds), Math.max(offset + 0.08, cue.end + narrationOffset + subtitleLeadSeconds));
    // 两层同一段文字：ink 是白的（还没讲到的部分），wash 是高亮色（已经讲到的部分）。
    // 两层排版完全一致，靠 clip-path 从左向右擦除 wash，读起来才像歌词逐字点亮，
    // 而不是整句在结尾"啪"地变色。aria-hidden 让读屏只念一遍。
    const html = escapeHtml(cue.text);
    return `<div id="caption-${index}" class="clip subtitle" data-start="${timeline.start}" data-duration="${timeline.duration}" data-track-index="${COMPOSITION_TRACKS.subtitle}"><span id="caption-inner-${index}" class="subtitle-inner"><span id="caption-wash-${index}" class="subtitle-wash" aria-hidden="true">${html}</span><span class="subtitle-ink">${html}</span></span></div>`;
  }).join("\n");
  const visualClips = visuals.map((visual, index) => {
    const clipDuration = Math.max(0.1, visual.end - visual.start);
    const sourceClass = visual.sourceType === "generated-illustrative" ? "visual-generated" : "visual-real";
    const focal = visual.focalPoint ?? { x: 0.5, y: 0.5 };
    const crop = visual.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    const clipTop = Math.max(0, crop.y) * 100;
    const clipRight = Math.max(0, 1 - crop.x - crop.width) * 100;
    const clipBottom = Math.max(0, 1 - crop.y - crop.height) * 100;
    const clipLeft = Math.max(0, crop.x) * 100;
    const imageStyle = `object-position:${(focal.x * 100).toFixed(2)}% ${(focal.y * 100).toFixed(2)}%;clip-path:inset(${clipTop.toFixed(2)}% ${clipRight.toFixed(2)}% ${clipBottom.toFixed(2)}% ${clipLeft.toFixed(2)}%)`;
    // A single library asset may be scheduled into several time windows
    // (e.g. bound by two scenes), so DOM ids must be unique per clip instance.
    // The asset id stays in data attributes, reports and media filenames.
    //
    // MP4/MOV/M4V/WebM assets play; everything else (including an animated GIF,
    // which Chromium animates inside <img>) is drawn as a picture. A video used
    // to be emitted as `<img src=...mp4>`, which renders nothing at all, so the
    // clip showed an empty box for its whole window. `muted` keeps narration in
    // charge of the soundtrack, and the clip window still governs how long the
    // asset is on screen.
    const kind = mediaKindForPath(visual.src);
    const layout = visual.fit === "fullscreen" ? " visual-fullscreen" : "";
    const startSeconds = (visual.start + offset).toFixed(3);
    const clipSeconds = clipDuration.toFixed(3);
    /* A <video> that carries data-start may not sit inside another timed element.
       hyperframes' `video_nested_in_timed_element` lint rejects exactly that
       ("the framework cannot manage playback of nested media - video will be
       FROZEN in renders"), and the Studio preflight blocks the export on it -
       after the map capture, which is how one export died at 79% naming
       `visual-15`. So for a video the timing lives on the media element itself
       (which then also carries class="clip", exactly like the map video) and the
       <figure> becomes what the lint asks for: a non-timed visual container. The
       card still fades in and out on schedule because the motion timeline below
       drives `#visual-N`'s opacity directly. */
    const figureTiming = kind === "video" ? "" : ` data-start="${startSeconds}" data-duration="${clipSeconds}" data-track-index="${visualTrack(index)}"`;
    const background = kind === "video"
      ? ""
      : `<div class="visual-bg" data-layout-allow-overflow style="background-image:url('${prefix}/images/${visual.src}');background-position:${(focal.x * 100).toFixed(2)}% ${(focal.y * 100).toFixed(2)}%"></div>`;
    const videoAudioAttrs = visual.hasAudio
      ? `data-has-audio="true" data-volume="0.6"`
      : `muted`;
    const main = kind === "video"
      // HyperFrames only takes over a <video>'s playback when the element itself
      // carries data-start (it reports `media_missing_data_start` otherwise), and
      // it must not be nested inside a timed element - so the timing is here and
      // only here, and the video carries the clip class and track like the map.
      ? `<video id="visual-main-${index}" class="clip visual-main fit-${visual.fit ?? "cover"}" style="${imageStyle}" src="${prefix}/images/${visual.src}" ${videoAudioAttrs} loop playsinline preload="auto" data-start="${startSeconds}" data-duration="${clipSeconds}" data-track-index="${visualTrack(index)}"></video>`
      : `<img id="visual-main-${index}" class="visual-main fit-${visual.fit ?? "cover"}" style="${imageStyle}" src="${prefix}/images/${visual.src}" alt="${escapeHtml(visual.label)}">`;
    // 「全屏」适配撤掉卡片本身（见 .visual-fullscreen）：画面占满整帧，字幕与投影
    // 遮罩照旧，只有边框/圆角/内缩没有了。
    return `<figure id="visual-${index}" class="clip visual ${sourceClass} visual-${kind}${layout}" data-visual-id="${visual.id}"${figureTiming}>${background}${main}<figcaption id="visual-caption-${index}">${escapeHtml(visual.label)}</figcaption></figure>`;
  }).join("\n");
  const mapRefinement = regionId === "440904"
    ? `tl.to("#map",{scale:1.15,transformOrigin:"50% 0%",duration:.6,ease:"power2.out"},${(offset + 7.4).toFixed(3)});`
    : regionId === "440981"
      ? `gsap.set("#map",{scale:1.15,transformOrigin:"50% 0%"});tl.to("#map",{scale:1,duration:.8,ease:"power2.inOut"},${(offset + 0.8).toFixed(3)});`
    : "";
  const musicDuration = 50;
  const musicOverlap = 4;
  const musicStep = musicDuration - musicOverlap;
  const musicClipCount = timelineDuration <= musicDuration
    ? 1
    : Math.ceil((timelineDuration - musicDuration) / musicStep) + 1;
  const musicClips = Array.from({ length: musicClipCount }, (_, index) => {
    const localStart = index * musicStep;
    const start = offset + localStart;
    const clipDuration = Math.min(50, compositionDuration - start);
    return `<audio id="music-bed-${index}" class="clip" src="${prefix}/music/ambient-map-bed.wav" data-start="${start}" data-duration="${clipDuration}" data-track-index="${musicTrack(index)}" data-volume="0.2"></audio>`;
  }).join("\n");
  return `<!doctype html>
<html lang="zh-CN" data-composition-variables='[]'>
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(content.name)}地理乡土情</title>
  <script src="${prefix}/gsap.min.js"></script>
  <style>
    *{box-sizing:border-box}html,body{margin:0;background:#081017;overflow:hidden;font-family:"GeoSans",sans-serif;color:#f4f7f9}
    #root{position:relative;width:${profile.width}px;height:${profile.height}px;overflow:hidden;background:#081017}
    @font-face{font-family:"GeoSans";src:local("Noto Sans SC"),local("Source Han Sans SC"),local("Microsoft YaHei")}@font-face{font-family:"GeoNumber";src:local("Roboto Flex"),local("Roboto"),local("Arial")}@font-face{font-family:"STZhongsong";src:local("STZhongsong"),local("华文中宋"),local("Source Han Serif SC"),local("SimSun")} @font-face{font-family:"GeoSubtitle";src:url('media/fonts/NotoSansSC-Medium.woff2') format('woff2');font-weight:500;font-display:block} .clip{position:absolute}.map{z-index:0;inset:0;width:100%;height:100%;object-fit:cover}.shade{z-index:1;inset:0;background:linear-gradient(180deg,rgba(4,10,15,.12),transparent 24%,rgba(4,10,15,.16))}.cover{z-index:100;inset:0;width:100%;height:100%;object-fit:cover;background:#06101a}
    .visual{z-index:20;left:${isPortrait ? profile.safe_margin : Math.round(profile.width * .52)}px;top:${isPortrait ? 278 : 156}px;width:${isPortrait ? profile.width - profile.safe_margin * 2 : Math.round(profile.width * .43)}px;height:${isPortrait ? 780 : 560}px;margin:0;overflow:hidden;border:1px solid rgba(215,235,237,.32);border-radius:${isPortrait ? 28 : 24}px;background:#07151d;box-shadow:0 24px 80px rgba(0,0,0,.46);isolation:isolate}.visual-bg,.visual-main{position:absolute;inset:0;width:100%;height:100%}.visual-bg{z-index:0;background-size:cover;background-position:center;filter:blur(34px) saturate(.82) brightness(.56);transform:scale(1.13)}.visual-main{z-index:1}.visual-main.fit-cover{object-fit:cover}.visual-main.fit-contain{object-fit:contain;padding:${isPortrait ? 18 : 14}px}.visual-main.fit-fill{object-fit:fill}.visual:after{content:"";position:absolute;z-index:2;inset:0;background:linear-gradient(180deg,transparent 55%,rgba(2,9,14,.76) 100%);pointer-events:none}.visual figcaption{position:absolute;z-index:3;left:${isPortrait ? 20 : 18}px;right:${isPortrait ? 20 : 18}px;bottom:${isPortrait ? 16 : 14}px;font-size:${isPortrait ? 30 : 25}px;font-weight:650;line-height:1.25;letter-spacing:.03em;color:#f4f7f9;text-shadow:0 2px 10px rgba(0,0,0,.9)}
.subtitle{z-index:40;left:50%;bottom:${subtitleBottomPx}px;transform:translate(-50%,50%);width:86%;max-width:${isPortrait ? 900 : isSquare ? 920 : 1180}px;font-family:"GeoSubtitle","Source Han Sans SC","Noto Sans SC","Microsoft YaHei",sans-serif;font-size:${isPortrait ? 50 : isSquare ? 44 : 46}px;line-height:1.36;text-align:center;font-weight:500;letter-spacing:.01em;text-shadow:0 2px 10px rgba(0,0,0,.92),0 0 2px rgba(0,0,0,.7);white-space:nowrap}.subtitle-inner{position:relative;display:inline-block;padding:0;border-radius:0;background:none;white-space:nowrap}.subtitle-ink{position:relative;display:inline-block;white-space:nowrap}.subtitle-wash{position:absolute;z-index:1;left:0;top:0;display:inline-block;white-space:nowrap;color:#ffd166;clip-path:inset(0 100% 0 0)}
    .visual figcaption{font-size:${isPortrait ? 42 : isSquare ? 30 : 25}px}
    .visual.visual-fullscreen{left:0;top:0;width:${profile.width}px;height:${profile.height}px;border:0;border-radius:0;box-shadow:none}
    .visual.visual-fullscreen figcaption{bottom:${fullscreenCaptionBottomPx}px}
    .visual-main.fit-fullscreen{object-fit:cover}
    .provider-credit{z-index:60;right:${Math.max(18, Math.round(profile.safe_margin / 3))}px;bottom:18px;padding:5px 9px;border-radius:6px;background:rgba(4,10,15,.58);font-size:${isPortrait ? 15 : 13}px;letter-spacing:.02em;color:rgba(244,247,249,.78);text-shadow:0 1px 4px #000;white-space:nowrap}
  </style>
</head>
<body>
<main id="root" data-composition-id="${regionId}-${profileName}" data-start="0" data-width="${profile.width}" data-height="${profile.height}" data-duration="${compositionDuration.toFixed(3)}" data-fps="30">
  <video id="map" class="clip map" src="${prefix}/maps/${regionId}-map-${profileName}.mp4" muted playsinline preload="auto" data-start="${offset.toFixed(3)}" data-duration="${timelineDuration.toFixed(3)}" data-track-index="${COMPOSITION_TRACKS.map}"></video>
  <div id="shade" class="clip shade" data-start="${offset.toFixed(3)}" data-duration="${timelineDuration.toFixed(3)}" data-track-index="${COMPOSITION_TRACKS.shade}"></div>
  ${imageryAttribution ? `<div id="provider-credit" class="clip provider-credit" data-start="${offset.toFixed(3)}" data-duration="${timelineDuration.toFixed(3)}" data-track-index="${COMPOSITION_TRACKS.imageryCredit}">${escapeHtml(imageryAttribution)}</div>` : ""}
  ${visualClips}
  ${captionClips}
  <audio id="narration-audio" class="clip" src="${prefix}/audio/${regionId}-narration.wav" data-start="${narrationOffset.toFixed(3)}" data-duration="${audioDuration.toFixed(3)}" data-track-index="${COMPOSITION_TRACKS.narration}" data-volume="1"></audio>
  <audio id="boundary-pen-audio" class="clip" src="${prefix}/music/boundary-pen.wav" data-start="${narrationOffset.toFixed(3)}" data-duration="1.150" data-track-index="${COMPOSITION_TRACKS.boundaryPen}" data-volume="0.16"></audio>
  ${musicClips}
  <img id="cover" class="clip cover" src="${prefix}/images/${cover.src}" alt="${escapeHtml(cover.hierarchicalTitle)}视频封面" data-start="0" data-duration="${offset.toFixed(3)}" data-track-index="${COMPOSITION_TRACKS.cover}">
</main>
<script>
  // 字幕只允许一行：量出这一句的实际宽度，放不下就等比缩字号，绝不允许折行。
  // 必须在字体加载完之后量 —— 回退字体（雅黑）和思源黑体的同字宽度不一样，
  // 早量的结果会让长句在成片里又折一次。
  const fitSubtitles = () => {
    document.querySelectorAll(".subtitle").forEach((box) => {
      const inner = box.querySelector(".subtitle-inner");
      if (!inner) return;
      inner.style.fontSize = "";
      const max = box.clientWidth || parseFloat(getComputedStyle(box).width) || 0;
      if (!max) return;
      let size = parseFloat(getComputedStyle(inner).fontSize) || 16;
      const minimum = size * .55;
      for (let guard = 0; guard < 10; guard += 1) {
        const width = inner.getBoundingClientRect().width;
        if (width <= max || size <= minimum) break;
        size = Math.max(minimum, size * Math.min(.98, max / width));
        inner.style.fontSize = size + "px";
      }
    });
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => requestAnimationFrame(fitSubtitles));
  else requestAnimationFrame(fitSubtitles);
  const tl=gsap.timeline({paused:true});
  gsap.set([".subtitle-inner",".visual",".visual figcaption"],{opacity:0});
  tl.fromTo("#cover",{opacity:1},{opacity:0,duration:${coverFadeSeconds.toFixed(3)},ease:"power2.inOut"},${coverFadeStart.toFixed(3)}).set("#cover",{opacity:0},${offset.toFixed(3)});
  ${mapRefinement}
  ${visuals.map((visual, index) => { const start = visual.start + offset; const end = visual.end + offset; return `tl.fromTo("#visual-${index}",{opacity:0,y:34,scale:1.025},{opacity:1,y:0,scale:1,duration:.42,ease:"power2.out"},${start.toFixed(3)}).set("#visual-${index}",{opacity:0},${end.toFixed(3)});`; }).join("\n")}
  ${visuals.map((visual, index) => {
    const start = visual.start + offset;
    const duration = Math.max(0.1, visual.end - visual.start);
    const baseScale = Math.max(0.5, Math.min(3, Number(visual.scale ?? 1)));
    const x = Number(visual.offsetX ?? 0);
    const y = Number(visual.offsetY ?? 0);
    const motion = visual.animation ?? "push-in";
    if (motion === "still") return `gsap.set("#visual-main-${index}",{scale:${baseScale.toFixed(3)},x:${x.toFixed(1)},y:${y.toFixed(1)}});`;
    const fromScale = motion === "pull-out" ? baseScale * 1.07 : baseScale;
    const toScale = motion === "push-in" ? baseScale * 1.07 : baseScale;
    const fromX = motion === "pan-right" ? x - 24 : motion === "pan-left" ? x + 24 : x;
    const toX = motion === "pan-right" ? x + 24 : motion === "pan-left" ? x - 24 : x;
    return `tl.fromTo("#visual-main-${index}",{scale:${fromScale.toFixed(3)},x:${fromX.toFixed(1)},y:${y.toFixed(1)}},{scale:${toScale.toFixed(3)},x:${toX.toFixed(1)},y:${y.toFixed(1)},duration:${duration.toFixed(3)},ease:"none"},${start.toFixed(3)});`;
  }).join("\n")}
  ${visuals.map((visual, index) => { const cueStart = visual.cueStart === undefined ? visual.start + offset : narrationOffset + visual.cueStart; const cueEnd = visual.cueEnd === undefined ? visual.end + offset : narrationOffset + visual.cueEnd; const fadeOutAt = Math.max(cueStart + 0.08, cueEnd - 0.12); return `tl.fromTo("#visual-caption-${index}",{opacity:0},{opacity:1,duration:.1},${cueStart.toFixed(3)}).to("#visual-caption-${index}",{opacity:0,duration:.1},${fadeOutAt.toFixed(3)}).set("#visual-caption-${index}",{opacity:0},${cueEnd.toFixed(3)});`; }).join("\n")}
  ${displayCues.map((cue, index) => { const timing = timelineValues(Math.max(offset, cue.start + narrationOffset + subtitleLeadSeconds), Math.max(offset + 0.08, cue.end + narrationOffset + subtitleLeadSeconds)); const cueEnd = Number(timing.start) + Number(timing.duration); const fadeOutAt = Math.max(Number(timing.start) + 0.08, cueEnd - 0.1); const hardKillAt = Math.min(cueEnd, fadeOutAt + 0.08); const washSeconds = Math.max(.12, fadeOutAt - Number(timing.start) - .04); return `tl.fromTo("#caption-inner-${index}",{opacity:0,y:8},{opacity:1,y:0,duration:.08},${timing.start}).fromTo("#caption-wash-${index}",{clipPath:"inset(0 100% 0 0)"},{clipPath:"inset(0 0% 0 0)",duration:${washSeconds.toFixed(3)},ease:"none"},${(Number(timing.start) + .06).toFixed(3)}).to("#caption-inner-${index}",{opacity:0,duration:.08},${fadeOutAt.toFixed(3)}).set("#caption-inner-${index}",{opacity:0},${hardKillAt.toFixed(3)});`; }).join("\n")}
  window.__timelines=window.__timelines||{};window.__timelines["${regionId}-${profileName}"]=tl;
</script>
</body></html>`;
}

function captionStamp(value: number, comma: boolean): string {
  const milliseconds = Math.max(0, Math.round(value * 1000));
  const hour = Math.floor(milliseconds / 3_600_000);
  const minute = Math.floor((milliseconds % 3_600_000) / 60_000);
  const second = Math.floor((milliseconds % 60_000) / 1000);
  const millisecond = milliseconds % 1000;
  const separator = comma ? "," : ".";
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}:${second.toString().padStart(2, "0")}${separator}${millisecond.toString().padStart(3, "0")}`;
}

function safeDeliverableStem(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").replace(/\s+/g, " ").trim();
}

function normalizeSearchText(value: string): string {
  // Shared with the Studio's readiness report so the two can never disagree
  // about whether a keyword found its sentence.
  return normalizeAnchorText(value);
}

function resolveVisualTiming(
  visual: VisualClip,
  narrationCues: Cue[],
  narrationStartSeconds: number,
  requireCueTiming: boolean
): ResolvedVisualClip {
  const hasCueTiming = visual.narrationCueIndex !== undefined;
  if (hasCueTiming) {
    const first = visual.narrationCueIndex!;
    const last = visual.narrationCueEndIndex ?? first;
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || last >= narrationCues.length) {
      throw new Error(`Visual ${visual.id} has invalid narration cue range ${first}-${last}; narration has ${narrationCues.length} cues`);
    }
    // A visual manifest is rebuilt from the measured narration before compose,
    // so cue indices normally match sentence cues exactly. When a legacy or
    // drifted manifest points at a cue that does not actually mention the
    // visual's required keyword (e.g. overview text was later split into more
    // sentences), self-heal by re-anchoring to the measured cue that mentions
    // it instead of aborting the whole export. Keep the original range only as
    // a last resort (soft render with a diagnostic warning).
    const requiredKeywords = visual.requiredKeywords ?? [];
    const keywordWarnings: string[] = [];
    let adjustedFirst = first;
    let adjustedLast = last;
    let selected = narrationCues.slice(adjustedFirst, adjustedLast + 1);
    const matchedMissing = () => requiredKeywords.filter((keyword) => {
      const needle = normalizeSearchText(keyword);
      return !normalizeSearchText(selected.map((cue) => cue.text).join("")).includes(needle);
    });
    let stillMissing = matchedMissing();
    if (stillMissing.length > 0) {
      // Self-healing must stay inside the scene the visual belongs to. Searching
      // the whole film (the old behaviour) found the keyword in a *neighbouring*
      // scene and moved the window past this scene's boundary, which then died in
      // `hardEnd <= resolvedStart` with "no display window before its scene
      // boundary" and aborted the export (2026-10-23, 吴阳镇 双峰塔). A few cues
      // of slack on each side still covers the case the healing was written for:
      // the scene's overview text was split into more sentences than the manifest
      // recorded.
      const searchFrom = Math.max(0, first - 3);
      const searchTo = Math.min(narrationCues.length - 1, last + 3);
      const hitIndexes = narrationCues
        .map((cue, index) => ({ cue, index }))
        .filter(({ cue, index }) => index >= searchFrom && index <= searchTo)
        .filter(({ cue }) => stillMissing.some((keyword) => normalizeSearchText(cue.text).includes(normalizeSearchText(keyword))))
        .map(({ index }) => index);
      if (hitIndexes.length > 0) {
        const nearest = hitIndexes.reduce((best, index) => (Math.abs(index - first) < Math.abs(best - first) ? index : best), hitIndexes[0]!);
        const delta = nearest - first;
        adjustedFirst = Math.max(0, Math.min(narrationCues.length - 1, first + delta));
        adjustedLast = Math.max(adjustedFirst, Math.min(narrationCues.length - 1, (visual.narrationCueEndIndex ?? first) + delta));
        const hitFirst = Math.min(...hitIndexes);
        const hitLast = Math.max(...hitIndexes);
        adjustedFirst = Math.min(adjustedFirst, hitFirst);
        adjustedLast = Math.max(adjustedLast, hitLast);
        selected = narrationCues.slice(adjustedFirst, adjustedLast + 1);
        stillMissing = matchedMissing();
      }
      if (stillMissing.length > 0) {
        keywordWarnings.push(...stillMissing.map((keyword) =>
          `${keyword} is absent from narration cue ${adjustedFirst}-${adjustedLast}: ${selected.map((cue) => cue.text).join("")}`));
        if (hitIndexes.length === 0) {
          keywordWarnings.push(`Visual ${visual.id} keyword ${stillMissing[0]} appears nowhere in the measured narration; rendering on its declared cue`);
        }
      }
    }
    const cueText = selected.map((cue) => cue.text).join("");
    const leadSeconds = visual.leadSeconds ?? 0.3;
    const tailSeconds = visual.tailSeconds ?? 0.24;
    if (leadSeconds < 0 || leadSeconds > 0.75 || tailSeconds < 0 || tailSeconds > 0.75) {
      throw new Error(`Visual ${visual.id} lead/tail must stay within 0-0.75 seconds`);
    }
    const cueStart = selected[0]!.start;
    const cueEnd = selected[selected.length - 1]!.end;
    const cueDrivenStart = narrationStartSeconds + Math.max(0, cueStart - leadSeconds);
    const notBefore = narrationStartSeconds + Math.max(0, Number(visual.notBeforeNarrationSeconds ?? 0));
    const resolvedStart = Math.max(cueDrivenStart, notBefore);
    const hardEnd = visual.notAfterNarrationSeconds === undefined
      ? Number.POSITIVE_INFINITY
      : narrationStartSeconds + Math.max(0, Number(visual.notAfterNarrationSeconds));
    if (hardEnd <= resolvedStart) {
      throw new Error(`Visual ${visual.id} has no display window before its scene boundary`);
    }
    let sequenceStart = resolvedStart;
    const naturalEnd = Math.min(hardEnd, narrationStartSeconds + cueEnd + tailSeconds);
    let resolvedEnd = Math.min(hardEnd, Math.max(naturalEnd, resolvedStart + Math.max(0.1, Number(visual.minimumDisplaySeconds ?? 0.1))));
    const sequenceCount = Math.max(1, Math.floor(Number(visual.sequenceCount || 1)));
    const sequenceIndex = Math.max(0, Math.min(sequenceCount - 1, Math.floor(Number(visual.sequenceIndex || 0))));
    if (sequenceCount > 1) {
      const sequenceEnd = Math.min(hardEnd, Math.max(sequenceStart + 0.1, naturalEnd));
      const slice = Math.max(0.1, (sequenceEnd - sequenceStart) / sequenceCount);
      sequenceStart += slice * sequenceIndex;
      resolvedEnd = sequenceIndex === sequenceCount - 1 ? sequenceEnd : sequenceStart + slice;
    }
    return {
      ...visual,
      src: "",
      start: sequenceStart,
      end: resolvedEnd,
      timingMode: "narration-cue",
      cueStart,
      cueEnd,
      cueText,
      ...(keywordWarnings.length > 0 ? { keywordWarnings } : {})
    };
  }
  if (requireCueTiming) {
    throw new Error(`Visual ${visual.id} must use narrationCueIndex; bare start/end timing is forbidden by this manifest`);
  }
  if (!Number.isFinite(visual.start) || !Number.isFinite(visual.end) || visual.end! <= visual.start!) {
    throw new Error(`Visual ${visual.id} needs either narrationCueIndex or a valid legacy start/end range`);
  }
  return { ...visual, src: "", start: visual.start!, end: visual.end!, timingMode: "legacy-seconds" };
}

async function writeVisualSyncReport(
  regionId: string,
  visuals: ResolvedVisualClip[],
  coverSeconds: number,
  narrationStartSeconds: number
): Promise<void> {
  const report = visuals.map((visual) => {
    const cueDuration = visual.cueStart === undefined || visual.cueEnd === undefined ? 0 : visual.cueEnd - visual.cueStart;
    const audioRelativeStart = visual.start - narrationStartSeconds;
    const audioRelativeEnd = visual.end - narrationStartSeconds;
    const overlap = cueDuration > 0
      ? Math.max(0, Math.min(audioRelativeEnd, visual.cueEnd!) - Math.max(audioRelativeStart, visual.cueStart!))
      : 0;
    const overlapRatio = cueDuration > 0 ? overlap / cueDuration : null;
    const displayDurationSeconds = visual.end - visual.start;
    const renderedForAtLeastOneFrame = displayDurationSeconds + 1e-6 >= MINIMUM_RENDERED_VISUAL_SECONDS;
    const staysInsideScene = visual.notAfterNarrationSeconds === undefined
      || audioRelativeEnd <= visual.notAfterNarrationSeconds + 1e-6;
    return {
      id: visual.id,
      selectionKey: visual.selectionKey ?? visual.id,
      timingMode: visual.timingMode,
      narrationCueIndex: visual.narrationCueIndex ?? null,
      narrationCueEndIndex: visual.narrationCueEndIndex ?? visual.narrationCueIndex ?? null,
      cueText: visual.cueText ?? null,
      requiredKeywords: visual.requiredKeywords ?? [],
      keywordWarnings: visual.keywordWarnings ?? [],
      audioRelativeCueStart: visual.cueStart ?? null,
      audioRelativeCueEnd: visual.cueEnd ?? null,
      audioRelativeResolvedStart: audioRelativeStart,
      audioRelativeResolvedEnd: audioRelativeEnd,
      mapRelativeResolvedStart: visual.start,
      mapRelativeResolvedEnd: visual.end,
      finalCompositionStart: visual.start + coverSeconds,
      finalCompositionEnd: visual.end + coverSeconds,
      displayDurationSeconds,
      renderedForAtLeastOneFrame,
      staysInsideScene,
      cueCoverageRatio: overlapRatio,
      pass: renderedForAtLeastOneFrame && staysInsideScene
    };
  });
  await mkdir(resolve(root, "renders/diagnostics"), { recursive: true });
  await writeFile(resolve(root, `renders/diagnostics/${regionId}-${profileName}-visual-sync.json`), JSON.stringify({
    regionId,
    profile: profileName,
    timingBasis: "measured narration sentence cues",
    coverIntroSeconds: coverSeconds,
    narrationStartSeconds,
    selectedVisualCount: visuals.length,
    renderedVisualCount: report.filter((item) => item.pass).length,
    pass: report.every((item) => item.pass),
    visuals: report
  }, null, 2), "utf8");
}

function assertEverySelectedVisualIsRenderable(source: VisualClip[], resolved: ResolvedVisualClip[]): void {
  if (resolved.length !== source.length) {
    throw new Error(`Only ${resolved.length}/${source.length} selected visuals reached the compositor`);
  }
  const sourceKeys = source.map((visual, index) => visual.selectionKey ?? `${index}:${visual.id}`);
  const resolvedKeys = resolved.map((visual, index) => visual.selectionKey ?? `${index}:${visual.id}`);
  const missing = sourceKeys.filter((key) => !resolvedKeys.includes(key));
  if (missing.length > 0) throw new Error(`Selected visuals missing from composition: ${missing.join(", ")}`);
  const tooShort = resolved.filter((visual) => visual.end - visual.start + 1e-6 < MINIMUM_RENDERED_VISUAL_SECONDS);
  if (tooShort.length > 0) {
    throw new Error(`Selected visuals have no visible video frame: ${tooShort.map((visual) => visual.selectionKey ?? visual.id).join(", ")}`);
  }
}

async function writeOffsetCaptions(regionId: string, displayCues: Cue[], offset: number, narrationStartSeconds: number, hierarchicalTitle: string, subtitleLeadSeconds = 0): Promise<void> {
  const narrationOffset = offset + narrationStartSeconds;
  const shifted = displayCues.map((cue) => ({
    ...cue,
    start: Math.max(offset, cue.start + narrationOffset + subtitleLeadSeconds),
    end: Math.max(offset + 0.08, cue.end + narrationOffset + subtitleLeadSeconds)
  }));
  const srt = shifted.map((cue, index) => `${index + 1}\n${captionStamp(cue.start, true)} --> ${captionStamp(cue.end, true)}\n${cue.text}`).join("\n\n") + "\n";
  const vtt = `WEBVTT\n\n${shifted.map((cue) => `${captionStamp(cue.start, false)} --> ${captionStamp(cue.end, false)}\n${cue.text}`).join("\n\n")}\n`;
  const captionBase = resolve(compositor, `captions/${regionId}-${profileName}-with-cover`);
  const deliverableBase = resolve(root, `renders/final/${safeDeliverableStem(hierarchicalTitle)}`);
  await mkdir(resolve(root, "renders/final"), { recursive: true });
  await Promise.all([
    writeFile(`${captionBase}.srt`, srt, "utf8"),
    writeFile(`${captionBase}.vtt`, vtt, "utf8"),
    writeFile(`${captionBase}.json`, JSON.stringify({ regionId, profile: profileName, coverIntroSeconds: offset, narrationStartSeconds, cues: shifted }, null, 2), "utf8"),
    writeFile(`${deliverableBase}.srt`, srt, "utf8"),
    writeFile(`${deliverableBase}.vtt`, vtt, "utf8")
  ]);
}

for (const id of ids) {
  const mapSource = resolve(root, `renders/intermediate/${id}-map-${profileName}.mp4`);
  const mapTarget = resolve(mediaDir, `maps/${id}-map-${profileName}.mp4`);
  const mapRecorded = existsSync(mapSource);
  if (!mapRecorded && !mapFallbackAllowed) throw new Error(`Missing map video ${mapSource}; run capture first`);
  const audioSource = resolve(root, `assets/audio/${id}/narration.wav`);
  const musicSource = resolve(root, "assets/music/ambient-map-bed.wav");
  const boundaryPenSource = resolve(root, "assets/music/boundary-pen.wav");
  const logoSource = resolve(root, "design/generated/midnight-globe-emblem.png");
  const coverDefinition = await resolveCoverDefinition(root, id, {
    ...(requestedCoverIntroSeconds ? { coverIntroSeconds: Number(requestedCoverIntroSeconds) } : {})
  });
  const coverImagePath = requestedCoverImagePath
    ? resolve(root, requestedCoverImagePath)
    : await generateCoverAsset(root, coverDefinition);
  if (!existsSync(coverImagePath)) throw new Error(`Missing cover image ${coverImagePath}`);
  const coverSrc = `${id}-cover${extname(coverImagePath).toLowerCase() || ".png"}`;
  const cover: ResolvedCover = {
    src: coverSrc,
    imagePath: coverImagePath,
    introSeconds: coverDefinition.coverIntroSeconds,
    hierarchicalTitle: coverDefinition.hierarchicalTitle
  };
  const timelineData = JSON.parse(await readFile(resolve(root, `data/regions/${id}.timeline.json`), "utf8")) as { duration: number; narrationStartSeconds?: number; openingGateSeconds?: number };
  await Promise.all([
    ...(mapRecorded ? [copyFile(mapSource, mapTarget)] : []),
    copyFile(audioSource, resolve(mediaDir, `audio/${id}-narration.wav`)),
    copyFile(resolve(root, "assets/fonts/NotoSansSC-Medium.woff2"), resolve(mediaDir, "fonts/NotoSansSC-Medium.woff2")),
    copyFile(musicSource, resolve(mediaDir, "music/ambient-map-bed.wav")),
    copyFile(boundaryPenSource, resolve(mediaDir, "music/boundary-pen.wav")),
    copyFile(logoSource, resolve(mediaDir, "images/geo-documentary-mark.png")),
    copyFile(coverImagePath, resolve(mediaDir, `images/${coverSrc}`))
  ]);
  // With --map-fallback the composition is still built when the recording does
  // not exist yet (the Studio lints it before spending ~40 minutes on the map),
  // and the map slot gets a black stand-in so every referenced file exists.
  if (!mapRecorded) {
    await writeMapFallbackStub(mapTarget, profile, timelineData.duration);
    process.stdout.write(`MAP_STUB_USED ${mapTarget}\n`);
  }
  const captionData = JSON.parse(await readFile(resolve(compositor, `captions/${id}.json`), "utf8")) as { cues: Cue[]; protectedPhrases?: string[] };
  const durationData = JSON.parse(await readFile(resolve(root, `assets/audio/${id}/duration.json`), "utf8")) as { durationSeconds: number };
  const narrationStartSeconds = Math.max(0, Number(timelineData.narrationStartSeconds ?? 0));
  // 开场闸门：穿云没结束、金色光束还没落笔之前不出字幕，也不起旁白。一个数同时平移人声、字幕和落笔音，三者不会互相错位。
  const openingGateSeconds = Math.max(0, Number(timelineData.openingGateSeconds ?? 0));
  const visualManifestPath = resolve(root, `content/visuals/${id}.json`);
  const visualManifest = existsSync(visualManifestPath)
    ? JSON.parse(await readFile(visualManifestPath, "utf8")) as { timingMode?: "narration-cue-required" | "legacy-seconds"; clips?: VisualClip[] }
    : { clips: [] };
  const visuals: ResolvedVisualClip[] = [];
  for (const visual of visualManifest.clips ?? []) {
    const source = resolve(root, visual.path);
    if (!existsSync(source)) throw new Error(`Missing visual source ${visual.path}`);
    const src = `${id}-${visual.id}${extname(source).toLowerCase()}`;
    await copyFile(source, resolve(mediaDir, `images/${src}`));
    const isVideo = mediaKindForPath(source) === "video";
    const hasAudio = isVideo ? probeVideoHasAudio(source) : false;
    visuals.push({
      ...resolveVisualTiming(visual, captionData.cues, narrationStartSeconds, visualManifest.timingMode === "narration-cue-required"),
      src,
      hasAudio
    });
  }
  assertEverySelectedVisualIsRenderable(visualManifest.clips ?? [], visuals);
  for (const resolved of visuals) {
    for (const warning of resolved.keywordWarnings ?? []) {
      process.stdout.write(`VISUAL_WARNING ${id} ${resolved.id}: ${warning}\n`);
    }
  }
  const protectedPhrases = captionData.protectedPhrases ?? [];
  const overridePath = resolve(root, `content/subtitle-overrides/${id}-${profileName}.json`);
  const overrideData = existsSync(overridePath)
    ? JSON.parse(await readFile(overridePath, "utf8")) as { cues?: SingleLineCueOverride[] }
    : { cues: [] };
  const displayCues = buildSingleLineCues(
    captionData.cues,
    profile.subtitle_chars_per_line,
    protectedPhrases,
    overrideData.cues ?? []
  );
  const html = compositionHtml(id, "media", displayCues, durationData.durationSeconds, timelineData.duration, narrationStartSeconds, openingGateSeconds, visuals, cover);
  await writeVisualSyncReport(id, visuals, cover.introSeconds, narrationStartSeconds);
  await Promise.all([
    writeFile(resolve(compositionDir, `${id}-${profileName}.html`), html, "utf8"),
    writeOffsetCaptions(id, displayCues, cover.introSeconds, narrationStartSeconds + openingGateSeconds, cover.hierarchicalTitle, Math.max(-0.35, Math.min(0.2, Number(master[id]?.subtitleLeadSeconds ?? 0)))),
    writeFile(resolve(compositionDir, `${id}-${profileName}.json`), JSON.stringify({
      regionId: id,
      profile: profileName,
      timelineDuration: timelineData.duration,
      narrationStartSeconds,
      coverIntroSeconds: cover.introSeconds,
      compositionDuration: timelineData.duration + cover.introSeconds,
      coverImagePath: cover.imagePath,
      hierarchicalTitle: cover.hierarchicalTitle
    }, null, 2), "utf8")
  ]);
  if (id === (requested ?? "440802")) await writeFile(resolve(compositor, "index.html"), html, "utf8");
  process.stdout.write(`COMPOSITION_READY ${id} ${profileName} cover=${cover.introSeconds.toFixed(3)}s total=${(timelineData.duration + cover.introSeconds).toFixed(3)}s\n`);
}
