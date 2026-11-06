import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { buildSingleLineCues, timelineValues, type SubtitleCue as Cue } from "../../../../packages/content-engine/subtitles.js";

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

const root = resolve(process.cwd());
const args = process.argv.slice(2);
const valueAfter = (flag: string, fallback?: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const requested = valueAfter("--region");
const profileName = valueAfter("--profile", "landscape")!;
const master = JSON.parse(await readFile(resolve(root, "content/regions.zh-CN.json"), "utf8")) as Record<string, RegionContent>;
const ids = requested ? [requested] : Object.keys(master);
const profiles = YAML.parse(await readFile(resolve(root, "config/render-profiles.yaml"), "utf8")) as { profiles: Record<string, RenderProfile> };
const profile = profiles.profiles[profileName] ?? (() => { throw new Error(`Unknown profile ${profileName}`); })();

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

function compositionHtml(regionId: string, prefix: string, cues: Cue[], audioDuration: number): string {
  const content = master[regionId];
  if (!content) throw new Error(`Unknown region ${regionId}`);
  const displayCues = buildSingleLineCues(cues, profile.subtitle_chars_per_line);
  const isPortrait = profile.height > profile.width;
  const isSquare = profile.height === profile.width;
  const captionClips = displayCues.map((cue, index) => {
    const timeline = timelineValues(cue.start, cue.end);
    return `<div id="caption-${index}" class="clip subtitle" data-start="${timeline.start}" data-duration="${timeline.duration}" data-track-index="5"><span id="caption-inner-${index}" class="subtitle-inner">${escapeHtml(cue.text)}</span></div>`;
  }).join("\n");
  const topbarText = content.title ?? `地理图说·${content.name}`;
  return `<!doctype html>
<html lang="zh-CN" data-composition-variables='[]'>
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(content.name)}地理图说</title>
  <script src="${prefix}/gsap.min.js"></script>
  <style>
    *{box-sizing:border-box}html,body{margin:0;background:#081017;overflow:hidden;font-family:"GeoSans",sans-serif;color:#f4f7f9}
    #root{position:relative;width:${profile.width}px;height:${profile.height}px;overflow:hidden;background:#081017}
    @font-face{font-family:"GeoSans";src:local("Microsoft YaHei")} .clip{position:absolute}.map{inset:0;width:100%;height:100%;object-fit:cover}.shade{inset:0;background:linear-gradient(180deg,rgba(4,10,15,.12),transparent 24%,rgba(4,10,15,.16))}
    .topbar{left:${profile.safe_margin}px;top:${profile.safe_margin}px;display:flex;align-items:center;gap:18px;font-size:${isPortrait ? 27 : 24}px;letter-spacing:.16em;color:#d1dbe1;text-shadow:0 2px 16px #000}.topbar:before{content:"";width:64px;height:3px;background:#ffd166;box-shadow:0 0 16px rgba(255,209,102,.75)}
    .subtitle{left:50%;bottom:${isPortrait ? 118 : 72}px;transform:translateX(-50%);max-width:${isPortrait ? 900 : isSquare ? 920 : 1180}px;font-size:${isPortrait ? 40 : isSquare ? 36 : 38}px;line-height:1.42;text-align:center;font-weight:650;text-shadow:0 2px 8px #000;white-space:nowrap}.subtitle-inner{display:block;padding:12px 24px;border-radius:14px;background:rgba(4,10,15,.72)}
  </style>
</head>
<body>
<main id="root" data-composition-id="${regionId}-${profileName}" data-start="0" data-width="${profile.width}" data-height="${profile.height}" data-duration="50" data-fps="30">
  <video id="map" class="clip map" src="${prefix}/maps/${regionId}-map-${profileName}.mp4" muted playsinline preload="auto" data-start="0" data-duration="50" data-track-index="0"></video>
  <div id="shade" class="clip shade" data-start="0" data-duration="50" data-track-index="1"></div>
  <div id="topbar" class="clip topbar" data-start="0" data-duration="50" data-track-index="10">${topbarText}</div>
  ${captionClips}
  <audio id="narration-audio" class="clip" src="${prefix}/audio/${regionId}-narration.wav" data-start="0" data-duration="${audioDuration.toFixed(3)}" data-track-index="6" data-volume="1"></audio>
  <audio id="music-bed" class="clip" src="${prefix}/music/ambient-map-bed.wav" data-start="0" data-duration="50" data-track-index="7" data-volume="0.5"></audio>
</main>
<script>
  const tl=gsap.timeline({paused:true});
  gsap.set([".subtitle-inner"],{opacity:0});
  ${displayCues.map((cue, index) => { const timing = timelineValues(cue.start, cue.end); const cueEnd = Number(timing.start) + Number(timing.duration); const fadeOutAt = Math.max(Number(timing.start) + 0.08, cueEnd - 0.14); return `tl.fromTo("#caption-inner-${index}",{opacity:0,y:8},{opacity:1,y:0,duration:.12},${timing.start}).to("#caption-inner-${index}",{opacity:0,duration:.12},${fadeOutAt.toFixed(3)}).set("#caption-inner-${index}",{opacity:0},${cueEnd.toFixed(3)});`; }).join("\n")}
  window.__timelines=window.__timelines||{};window.__timelines["${regionId}-${profileName}"]=tl;
</script>
</body></html>`;
}

for (const id of ids) {
  const mapSource = resolve(root, `renders/intermediate/${id}-map-${profileName}.mp4`);
  if (!existsSync(mapSource)) throw new Error(`Missing map video ${mapSource}; run capture first`);
  const audioSource = resolve(root, `assets/audio/${id}/narration.wav`);
  const musicSource = resolve(root, "assets/music/ambient-map-bed.wav");
  await Promise.all([
    copyFile(mapSource, resolve(mediaDir, `maps/${id}-map-${profileName}.mp4`)),
    copyFile(audioSource, resolve(mediaDir, `audio/${id}-narration.wav`)),
    copyFile(musicSource, resolve(mediaDir, "music/ambient-map-bed.wav"))
  ]);
  const captionData = JSON.parse(await readFile(resolve(compositor, `captions/${id}.json`), "utf8")) as { cues: Cue[] };
  const durationData = JSON.parse(await readFile(resolve(root, `assets/audio/${id}/duration.json`), "utf8")) as { durationSeconds: number };
  await writeFile(resolve(compositionDir, `${id}-${profileName}.html`), compositionHtml(id, "media", captionData.cues, durationData.durationSeconds), "utf8");
  if (id === (requested ?? "440802")) await writeFile(resolve(compositor, "index.html"), compositionHtml(id, "media", captionData.cues, durationData.durationSeconds), "utf8");
  process.stdout.write(`COMPOSITION_READY ${id} ${profileName}\n`);
}
