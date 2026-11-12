import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mapParagraphsToCues, parseSrt, stableNarrationTextHash } from "../../.agents/skills/cesium-geo-documentary/scripts/narration-timing.js";
import { isXfyunVoice } from "../xfyun-tts/index.js";
import type { VideoProject } from "../project-schema/index.js";

type Content = { narration: string[]; voiceId?: string; voiceRate?: string; pronunciations?: Array<{term: string; spokenForm?: string}>; tourOrder?: string[]; tourIntroSentences?: number; tourReturnSeconds?: number; outroParagraphIndex?: number };
const files = ["narration.mp3", "narration-edge.srt", "duration.json"] as const;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function inputText(content: Content): string {
  let text = content.narration.map(p => p.trim().replace(/\s+/g, " ")).filter(Boolean).join("\n\n");
  for (const record of content.pronunciations ?? []) if (record.term && record.spokenForm && record.term !== record.spokenForm) text = text.replaceAll(record.term, record.spokenForm);
  return `${text}\n`;
}
function signature(content: Content): string {
  return digest(JSON.stringify({ narration: content.narration, pronunciations: content.pronunciations ?? [], voiceId: content.voiceId, voiceRate: content.voiceRate, tourOrder: content.tourOrder ?? [], tourIntroSentences: content.tourIntroSentences, tourReturnSeconds: content.tourReturnSeconds, outroParagraphIndex: content.outroParagraphIndex }));
}
function projectContent(project: VideoProject, base: Content): Content {
  const spoken = project.scenes.filter(s => s.section !== "cover");
  const nonempty = spoken.filter(s => (s.narration ?? "").normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "").length > 0);
  const index = nonempty.findIndex(s => s.section === "outro");
  const count = (s: string) => s.split(/\n+/).flatMap(line => line.split(/[。！？；;…]+/)).map(part => part.replace(/[」』"'“”‘’）)\]】》〉,，、：:\s]+$/u, "").trim()).filter(Boolean).length;
  const rate = Math.round((project.voice.speed - 1) * 100);
  return { narration: spoken.map(s => s.narration), pronunciations: base.pronunciations ?? [], voiceId: project.voice.voiceId, voiceRate: `${rate >= 0 ? "+" : ""}${rate}%`, tourOrder: project.scenes.filter(s => s.section === "child").map(s => s.childId!), tourIntroSentences: project.scenes.filter(s => s.section === "overview").reduce((n, s) => n + count(s.narration), 0), tourReturnSeconds: project.template.tourReturnSeconds, ...(index >= 0 ? { outroParagraphIndex: index } : base.outroParagraphIndex !== undefined ? { outroParagraphIndex: base.outroParagraphIndex } : {}) };
}
async function validate(dir: string, content: Content, ffprobe: string): Promise<boolean> {
  try {
    const [mp3, srt, raw] = await Promise.all(files.map(name => readFile(join(dir, name))));
    if (!mp3 || !srt || !raw || mp3.length < 1024) return false;
    const meta = JSON.parse(raw.toString()) as Record<string, any>;
    const voice = content.voiceId ?? "zh-CN-YunyangNeural";
    const parsedRate = Number.parseInt(String(content.voiceRate ?? "-4%").replace("%", ""), 10);
    const rateValue = Number.isFinite(parsedRate) ? Math.max(-100, Math.min(100, parsedRate)) : 0;
    const rate = `${rateValue >= 0 ? "+" : ""}${rateValue}%`;
    if (meta.provider !== (isXfyunVoice(voice) ? "xfyun-tts" : "edge-tts") || meta.voiceId !== voice || meta.rate !== rate || meta.narrationTextHash !== stableNarrationTextHash(inputText(content)) || meta.formalReleaseReady !== true || meta.sampleRate !== 48000 || meta.loudnessTargetLufs !== -16 || !Number.isFinite(meta.durationSeconds) || meta.durationSeconds <= 0 || Number(meta.studioTiming?.insertedSeconds ?? 0) !== 0) return false;
    const pause = meta.outroPause;
    if ((content.tourOrder?.length ?? 0) > 0) {
      if (!pause?.applied || pause.mode !== "parent-child-tour" || pause.requestedSeconds !== (content.tourReturnSeconds ?? 4.4) || pause.insertedSeconds !== pause.requestedSeconds) return false;
    } else if (pause) return false;
    const cues = parseSrt(srt.toString());
    if (!cues.length || cues.some(c => c.start < 0 || c.end <= c.start || c.end > meta.durationSeconds + 0.2)) return false;
    const mappings = mapParagraphsToCues(content.narration, cues);
    if ((content.tourOrder?.length ?? 0) > 0) {
      const mapping = (content.outroParagraphIndex !== undefined ? mappings[content.outroParagraphIndex] : undefined) ?? mappings.at(-1);
      if (!mapping || pause.outroCueIndex !== mapping.startIndex || pause.hasClosingNarration !== true || !Number.isFinite(pause.rawOutroNarrationStartSeconds)) return false;
      const previous = cues[mapping.startIndex - 1];
      const outro = cues[mapping.startIndex];
      if (!previous || !outro || !Number.isFinite(pause.insertionAtSeconds) || !Number.isFinite(pause.lastChildNarrationEndSeconds) || !Number.isFinite(pause.outroNarrationStartSeconds) || !Number.isFinite(pause.returnWindowSeconds) || Math.abs(pause.insertionAtSeconds - previous.end) > 0.01 || Math.abs(pause.lastChildNarrationEndSeconds - previous.end) > 0.01 || outro.start - previous.end < pause.requestedSeconds - 0.01 || Math.abs(pause.outroNarrationStartSeconds - outro.start) > 0.01 || Math.abs(pause.returnWindowSeconds - (outro.start - previous.end)) > 0.01 || Math.abs(pause.rawOutroNarrationStartSeconds + pause.insertedSeconds - outro.start) > 0.01) return false;
    }
    const probe = spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", join(dir, "narration.mp3")], { encoding: "utf8", windowsHide: true, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    const duration = Number(probe.stdout?.trim());
    return probe.status === 0 && Number.isFinite(duration) && Math.abs(duration - meta.durationSeconds) < 0.25;
  } catch { return false; }
}

export async function stageNarrationCache(root: string, sandbox: string, jobRoot: string, project: VideoProject): Promise<void> {
  const target = join(sandbox, "assets", "audio", project.regionId);
  const master = JSON.parse(await readFile(join(sandbox, "content", "regions.zh-CN.json"), "utf8"));
  const base = (master[project.regionId] ?? {}) as Content;
  const content = projectContent(project, base);
  await rm(join(target, "narration-cache.json"), { force: true });
  if (project.scenes.some(scene => (scene.timing?.preHoldSeconds ?? 0) > 0 || (scene.timing?.postHoldSeconds ?? 0) > 0)) return;
  const ffprobe = process.platform === "win32" ? join(root, "node_modules", "ffprobe-static", "bin", "win32", "x64", "ffprobe.exe") : join(root, "node_modules", "ffprobe-static", "bin", process.platform, process.arch, "ffprobe");
  const jobsRoot = join(root, "workspace", "jobs");
  const entries = await readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
  const candidates: string[] = [target];
  const ordered = await Promise.all(entries.filter(e => e.isDirectory()).map(async entry => ({ name: entry.name, modified: (await stat(join(jobsRoot, entry.name, "audio", "duration.json")).catch(() => null))?.mtimeMs ?? 0 })));
  for (const entry of ordered.sort((a, b) => b.modified - a.modified)) {
    const job = join(jobsRoot, entry.name);
    if (resolve(job) === resolve(jobRoot)) continue;
    try {
      const snapshot = JSON.parse(await readFile(join(job, "project.snapshot.json"), "utf8")) as VideoProject;
      if (snapshot.regionId === project.regionId && signature(projectContent(snapshot, base)) === signature(content)) candidates.push(join(job, "audio"));
    } catch { /* 缺失或损坏的快照不能证明来源。 */ }
  }
  candidates.push(join(root, "assets", "audio", project.regionId));
  await mkdir(target, { recursive: true });
  for (const candidate of candidates) {
    if (!await validate(candidate, content, ffprobe)) continue;
    if (candidate !== target) for (const file of files) await copyFile(join(candidate, file), join(target, file));
    const hashes = Object.fromEntries(await Promise.all(files.map(async name => [name, digest(await readFile(join(target, name)))])));
    const sourceJobId = candidates.indexOf(candidate) > 0 && candidate !== candidates.at(-1) ? candidate.split(/[\\/]/).at(-2) : null;
    await writeFile(join(target, "narration-cache.json"), JSON.stringify({ signature: signature(content), hashes, sourceJobId, sourcePath: candidate }));
    process.stdout.write(`NARRATION_CACHE_HIT ${project.regionId} ${sourceJobId ?? candidate}\n`);
    return;
  }
}

export async function canReuseFinalNarration(dir: string, content: Content): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(dir, "narration-cache.json"), "utf8"));
    if (marker.signature !== signature(content)) return false;
    for (const file of files) if (marker.hashes?.[file] !== digest(await readFile(join(dir, file)))) return false;
    return true;
  } catch { return false; }
}
