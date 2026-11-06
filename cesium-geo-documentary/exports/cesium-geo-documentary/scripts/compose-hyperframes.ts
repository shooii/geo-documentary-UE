import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import YAML from "yaml";
import { buildSingleLineCues, timelineValues, type SingleLineCueOverride, type SubtitleCue as Cue } from "../../../../packages/content-engine/subtitles.js";
import { generateCoverAsset, resolveCoverDefinition } from "./cover.js";

interface RegionContent {
  name: string;
  title?: string;
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
  path: string;
  start: number;
  end: number;
  label: string;
  fit?: "cover" | "contain";
  sourceType?: "verified-real" | "generated-illustrative";
}
interface ResolvedVisualClip extends VisualClip { src: string }
interface ResolvedCover {
  src: string;
  imagePath: string;
  introSeconds: number;
  hierarchicalTitle: string;
}

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
  mkdir(resolve(mediaDir, "images"), { recursive: true }),
  mkdir(resolve(mediaDir, "music"), { recursive: true }),
  mkdir(compositionDir, { recursive: true })
]);
await copyFile(resolve(root, "node_modules/gsap/dist/gsap.min.js"), resolve(mediaDir, "gsap.min.js"));

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function compositionHtml(regionId: string, prefix: string, displayCues: Cue[], audioDuration: number, timelineDuration: number, visuals: ResolvedVisualClip[], cover: ResolvedCover): string {
  const content = master[regionId];
  if (!content) throw new Error(`Unknown region ${regionId}`);
  const offset = cover.introSeconds;
  const compositionDuration = timelineDuration + offset;
  const coverFadeSeconds = Math.min(0.46, Math.max(0.28, offset * 0.22));
  const coverFadeStart = Math.max(0, offset - coverFadeSeconds);
  const isPortrait = profile.height > profile.width;
  const isSquare = profile.height === profile.width;
  const captionClips = displayCues.map((cue, index) => {
    const timeline = timelineValues(cue.start + offset, cue.end + offset);
    return `<div id="caption-${index}" class="clip subtitle" data-start="${timeline.start}" data-duration="${timeline.duration}" data-track-index="5"><span id="caption-inner-${index}" class="subtitle-inner">${escapeHtml(cue.text)}</span></div>`;
  }).join("\n");
  const visualClips = visuals.map((visual, index) => {
    const clipDuration = Math.max(0.1, visual.end - visual.start);
    const sourceClass = visual.sourceType === "generated-illustrative" ? "visual-generated" : "visual-real";
    return `<figure id="visual-${visual.id}" class="clip visual ${sourceClass}" data-start="${(visual.start + offset).toFixed(3)}" data-duration="${clipDuration.toFixed(3)}" data-track-index="${20 + index}"><div class="visual-bg" data-layout-allow-overflow style="background-image:url('${prefix}/images/${visual.src}')"></div><img class="visual-main fit-${visual.fit ?? "cover"}" src="${prefix}/images/${visual.src}" alt="${escapeHtml(visual.label)}"><figcaption>${escapeHtml(visual.label)}</figcaption></figure>`;
  }).join("\n");
  const topbarText = cover.hierarchicalTitle.replace(/\s*·\s*/g, "·");
  const mapRefinement = regionId === "440904"
    ? `tl.to("#map",{scale:1.15,transformOrigin:"50% 0%",duration:.6,ease:"power2.out"},${(offset + 7.4).toFixed(3)});`
    : regionId === "440981"
      ? `gsap.set("#map",{scale:1.15,transformOrigin:"50% 0%"});tl.to("#map",{scale:1,duration:.8,ease:"power2.inOut"},${(offset + 0.8).toFixed(3)});`
    : "";
  const musicDuration = 50;
  const musicOverlap = 0.75;
  const musicStep = musicDuration - musicOverlap;
  const musicClipCount = timelineDuration <= musicDuration
    ? 1
    : Math.ceil((timelineDuration - musicDuration) / musicStep) + 1;
  const musicClips = Array.from({ length: musicClipCount }, (_, index) => {
    const localStart = index * musicStep;
    const start = offset + localStart;
    const clipDuration = Math.min(50, timelineDuration - localStart);
    return `<audio id="music-bed-${index}" class="clip" src="${prefix}/music/ambient-map-bed.wav" data-start="${start}" data-duration="${clipDuration}" data-track-index="${70 + index}" data-volume="0.2"></audio>`;
  }).join("\n");
  return `<!doctype html>
<html lang="zh-CN" data-composition-variables='[]'>
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(content.name)}地理图说</title>
  <script src="${prefix}/gsap.min.js"></script>
  <style>
    *{box-sizing:border-box}html,body{margin:0;background:#081017;overflow:hidden;font-family:"GeoSans",sans-serif;color:#f4f7f9}
    #root{position:relative;width:${profile.width}px;height:${profile.height}px;overflow:hidden;background:#081017}
    @font-face{font-family:"GeoSans";src:local("Noto Sans SC"),local("Source Han Sans SC"),local("Microsoft YaHei")}@font-face{font-family:"GeoNumber";src:local("Roboto Flex"),local("Roboto"),local("Arial")} .clip{position:absolute}.map{inset:0;width:100%;height:100%;object-fit:cover}.shade{inset:0;background:linear-gradient(180deg,rgba(4,10,15,.12),transparent 24%,rgba(4,10,15,.16))}.cover{inset:0;width:100%;height:100%;object-fit:cover;background:#06101a}
    .topbar{left:${profile.safe_margin}px;top:${profile.safe_margin}px;display:flex;align-items:center;gap:12px;padding:${isPortrait ? 10 : 8}px ${isPortrait ? 18 : 16}px ${isPortrait ? 10 : 8}px ${isPortrait ? 10 : 8}px;border:1px solid rgba(103,213,209,.36);border-radius:999px;background:rgba(4,14,21,.66);font-size:${isPortrait ? 32 : 30}px;font-weight:600;letter-spacing:.08em;color:#dbe7ea;text-shadow:0 2px 10px rgba(0,0,0,.9);backdrop-filter:blur(14px)}.brand-mark{display:block;width:${isPortrait ? 44 : 40}px;height:${isPortrait ? 44 : 40}px;flex:0 0 auto}
    .visual{left:${isPortrait ? profile.safe_margin : Math.round(profile.width * .52)}px;top:${isPortrait ? 278 : 156}px;width:${isPortrait ? profile.width - profile.safe_margin * 2 : Math.round(profile.width * .43)}px;height:${isPortrait ? 780 : 560}px;margin:0;overflow:hidden;border:1px solid rgba(215,235,237,.32);border-radius:${isPortrait ? 28 : 24}px;background:#07151d;box-shadow:0 24px 80px rgba(0,0,0,.46);isolation:isolate}.visual-bg,.visual-main{position:absolute;inset:0;width:100%;height:100%}.visual-bg{z-index:0;background-size:cover;background-position:center;filter:blur(34px) saturate(.82) brightness(.56);transform:scale(1.13)}.visual-main{z-index:1}.visual-main.fit-cover{object-fit:cover}.visual-main.fit-contain{object-fit:contain;padding:${isPortrait ? 18 : 14}px}.visual:after{content:"";position:absolute;z-index:2;inset:0;background:linear-gradient(180deg,transparent 55%,rgba(2,9,14,.76) 100%);pointer-events:none}.visual figcaption{position:absolute;z-index:3;left:${isPortrait ? 28 : 24}px;right:${isPortrait ? 28 : 24}px;bottom:${isPortrait ? 24 : 20}px;font-size:${isPortrait ? 30 : 25}px;font-weight:650;line-height:1.25;letter-spacing:.03em;color:#f4f7f9;text-shadow:0 2px 10px rgba(0,0,0,.9)}
    .subtitle{left:50%;bottom:${isPortrait ? 118 : 72}px;transform:translateX(-50%);max-width:${isPortrait ? 900 : isSquare ? 920 : 1180}px;font-size:${isPortrait ? 44 : isSquare ? 40 : 42}px;line-height:1.38;text-align:center;font-weight:650;letter-spacing:0;text-shadow:0 2px 8px rgba(0,0,0,.96);white-space:nowrap}.subtitle-inner{display:block;padding:10px 22px;border-radius:10px;background:rgba(4,10,15,.72)}
    .provider-credit{right:${Math.max(18, Math.round(profile.safe_margin / 3))}px;bottom:18px;padding:5px 9px;border-radius:6px;background:rgba(4,10,15,.58);font-size:${isPortrait ? 15 : 13}px;letter-spacing:.02em;color:rgba(244,247,249,.78);text-shadow:0 1px 4px #000;white-space:nowrap}
  </style>
</head>
<body>
<main id="root" data-composition-id="${regionId}-${profileName}" data-start="0" data-width="${profile.width}" data-height="${profile.height}" data-duration="${compositionDuration.toFixed(3)}" data-fps="30">
  <video id="map" class="clip map" src="${prefix}/maps/${regionId}-map-${profileName}.mp4" muted playsinline preload="auto" data-start="${offset.toFixed(3)}" data-duration="${timelineDuration.toFixed(3)}" data-track-index="0"></video>
  <div id="shade" class="clip shade" data-start="${offset.toFixed(3)}" data-duration="${timelineDuration.toFixed(3)}" data-track-index="1"></div>
  <div id="topbar" class="clip topbar" data-start="${offset.toFixed(3)}" data-duration="${timelineDuration.toFixed(3)}" data-track-index="10"><img class="brand-mark" src="${prefix}/images/geo-documentary-mark.png" alt="">${topbarText}</div>
  ${imageryAttribution ? `<div id="provider-credit" class="clip provider-credit" data-start="${offset.toFixed(3)}" data-duration="${timelineDuration.toFixed(3)}" data-track-index="11">${escapeHtml(imageryAttribution)}</div>` : ""}
  ${visualClips}
  ${captionClips}
  <audio id="narration-audio" class="clip" src="${prefix}/audio/${regionId}-narration.wav" data-start="${offset.toFixed(3)}" data-duration="${audioDuration.toFixed(3)}" data-track-index="6" data-volume="1"></audio>
  ${musicClips}
  <img id="cover" class="clip cover" src="${prefix}/images/${cover.src}" alt="${escapeHtml(cover.hierarchicalTitle)}视频封面" data-start="0" data-duration="${offset.toFixed(3)}" data-track-index="100">
</main>
<script>
  const tl=gsap.timeline({paused:true});
  gsap.set([".subtitle-inner",".visual"],{opacity:0});
  tl.fromTo("#cover",{opacity:1},{opacity:0,duration:${coverFadeSeconds.toFixed(3)},ease:"power2.inOut"},${coverFadeStart.toFixed(3)}).set("#cover",{opacity:0},${offset.toFixed(3)});
  ${mapRefinement}
  ${visuals.map((visual) => { const start = visual.start + offset; const end = visual.end + offset; const fadeOutAt = Math.max(start + 0.45, end - 0.35); return `tl.fromTo("#visual-${visual.id}",{opacity:0,y:34,scale:1.025},{opacity:1,y:0,scale:1,duration:.42,ease:"power2.out"},${start.toFixed(3)}).to("#visual-${visual.id}",{opacity:0,y:-18,duration:.32,ease:"power2.in"},${fadeOutAt.toFixed(3)}).set("#visual-${visual.id}",{opacity:0},${end.toFixed(3)});`; }).join("\n")}
  ${displayCues.map((cue, index) => { const timing = timelineValues(cue.start + offset, cue.end + offset); const cueEnd = Number(timing.start) + Number(timing.duration); const fadeOutAt = Math.max(Number(timing.start) + 0.08, cueEnd - 0.14); return `tl.fromTo("#caption-inner-${index}",{opacity:0,y:8},{opacity:1,y:0,duration:.12},${timing.start}).to("#caption-inner-${index}",{opacity:0,duration:.12},${fadeOutAt.toFixed(3)}).set("#caption-inner-${index}",{opacity:0},${cueEnd.toFixed(3)});`; }).join("\n")}
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

async function writeOffsetCaptions(regionId: string, displayCues: Cue[], offset: number, hierarchicalTitle: string): Promise<void> {
  const shifted = displayCues.map((cue) => ({ ...cue, start: cue.start + offset, end: cue.end + offset }));
  const srt = shifted.map((cue, index) => `${index + 1}\n${captionStamp(cue.start, true)} --> ${captionStamp(cue.end, true)}\n${cue.text}`).join("\n\n") + "\n";
  const vtt = `WEBVTT\n\n${shifted.map((cue) => `${captionStamp(cue.start, false)} --> ${captionStamp(cue.end, false)}\n${cue.text}`).join("\n\n")}\n`;
  const captionBase = resolve(compositor, `captions/${regionId}-${profileName}-with-cover`);
  const deliverableBase = resolve(root, `renders/final/${safeDeliverableStem(hierarchicalTitle)}`);
  await mkdir(resolve(root, "renders/final"), { recursive: true });
  await Promise.all([
    writeFile(`${captionBase}.srt`, srt, "utf8"),
    writeFile(`${captionBase}.vtt`, vtt, "utf8"),
    writeFile(`${captionBase}.json`, JSON.stringify({ regionId, profile: profileName, coverIntroSeconds: offset, cues: shifted }, null, 2), "utf8"),
    writeFile(`${deliverableBase}.srt`, srt, "utf8"),
    writeFile(`${deliverableBase}.vtt`, vtt, "utf8")
  ]);
}

for (const id of ids) {
  const mapSource = resolve(root, `renders/intermediate/${id}-map-${profileName}.mp4`);
  if (!existsSync(mapSource)) throw new Error(`Missing map video ${mapSource}; run capture first`);
  const audioSource = resolve(root, `assets/audio/${id}/narration.wav`);
  const musicSource = resolve(root, "assets/music/ambient-map-bed.wav");
  const logoSource = resolve(root, "design/assets/geo-documentary-mark.png");
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
  const visualManifestPath = resolve(root, `content/visuals/${id}.json`);
  const visualManifest = existsSync(visualManifestPath)
    ? JSON.parse(await readFile(visualManifestPath, "utf8")) as { clips?: VisualClip[] }
    : { clips: [] };
  const visuals: ResolvedVisualClip[] = [];
  for (const visual of visualManifest.clips ?? []) {
    const source = resolve(root, visual.path);
    if (!existsSync(source)) throw new Error(`Missing visual source ${visual.path}`);
    const src = `${id}-${visual.id}${extname(source).toLowerCase()}`;
    await copyFile(source, resolve(mediaDir, `images/${src}`));
    visuals.push({ ...visual, src });
  }
  await Promise.all([
    copyFile(mapSource, resolve(mediaDir, `maps/${id}-map-${profileName}.mp4`)),
    copyFile(audioSource, resolve(mediaDir, `audio/${id}-narration.wav`)),
    copyFile(musicSource, resolve(mediaDir, "music/ambient-map-bed.wav")),
    copyFile(logoSource, resolve(mediaDir, "images/geo-documentary-mark.png")),
    copyFile(coverImagePath, resolve(mediaDir, `images/${coverSrc}`))
  ]);
  const captionData = JSON.parse(await readFile(resolve(compositor, `captions/${id}.json`), "utf8")) as { cues: Cue[]; protectedPhrases?: string[] };
  const durationData = JSON.parse(await readFile(resolve(root, `assets/audio/${id}/duration.json`), "utf8")) as { durationSeconds: number };
  const timelineData = JSON.parse(await readFile(resolve(root, `data/regions/${id}.timeline.json`), "utf8")) as { duration: number };
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
  const html = compositionHtml(id, "media", displayCues, durationData.durationSeconds, timelineData.duration, visuals, cover);
  await Promise.all([
    writeFile(resolve(compositionDir, `${id}-${profileName}.html`), html, "utf8"),
    writeOffsetCaptions(id, displayCues, cover.introSeconds, cover.hierarchicalTitle),
    writeFile(resolve(compositionDir, `${id}-${profileName}.json`), JSON.stringify({
      regionId: id,
      profile: profileName,
      timelineDuration: timelineData.duration,
      coverIntroSeconds: cover.introSeconds,
      compositionDuration: timelineData.duration + cover.introSeconds,
      coverImagePath: cover.imagePath,
      hierarchicalTitle: cover.hierarchicalTitle
    }, null, 2), "utf8")
  ]);
  if (id === (requested ?? "440802")) await writeFile(resolve(compositor, "index.html"), html, "utf8");
  process.stdout.write(`COMPOSITION_READY ${id} ${profileName} cover=${cover.introSeconds.toFixed(3)}s total=${(timelineData.duration + cover.introSeconds).toFixed(3)}s\n`);
}
