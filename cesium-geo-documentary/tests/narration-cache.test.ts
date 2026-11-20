import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { stageNarrationCache, canReuseFinalNarration } from "../packages/narration-cache/index.js";
import { stableNarrationTextHash } from "../.agents/skills/cesium-geo-documentary/scripts/narration-timing.js";
import type { VideoProject } from "../packages/project-schema/index.js";

const repo = resolve(import.meta.dirname, "..");
const project = { id: "p", regionId: "r", voice: { voiceId: "zh-CN-YunyangNeural", speed: 1 }, template: { tourReturnSeconds: 4.4 }, scenes: [{ section: "overview", narration: "开场。" }, { section: "child", childId: "c", narration: "村庄。" }, { section: "outro", narration: "结尾。" }] } as VideoProject;
const content = { narration: ["开场。", "村庄。", "结尾。"], voiceId: "zh-CN-YunyangNeural", voiceRate: "+0%", tourOrder: ["c"], tourIntroSentences: 1, tourReturnSeconds: 4.4, outroParagraphIndex: 2 };

test("完整历史旁白仅在精确匹配时复用，损坏或修改后拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "narration-cache-"));
  try {
    const sandbox = join(root, "sandbox"), job = join(root, "workspace", "jobs", "old"), audio = join(job, "audio"), target = join(sandbox, "assets", "audio", "r");
    await mkdir(audio, { recursive: true });
    await mkdir(join(sandbox, "content"), { recursive: true });
    await mkdir(join(root, "node_modules", "ffprobe-static", "bin", "win32", "x64"), { recursive: true });
    await copyFile(join(repo, "node_modules", "ffprobe-static", "bin", "win32", "x64", "ffprobe.exe"), join(root, "node_modules", "ffprobe-static", "bin", "win32", "x64", "ffprobe.exe"));
    await writeFile(join(sandbox, "content", "regions.zh-CN.json"), JSON.stringify({ r: {} }));
    await writeFile(join(job, "project.snapshot.json"), JSON.stringify(project));
    const ffmpeg = join(repo, "node_modules", "ffmpeg-static", "ffmpeg.exe");
    const result = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "8", "-c:a", "libmp3lame", join(audio, "narration.mp3")], { stdio: "ignore" });
    assert.equal(result.status, 0);
    await writeFile(join(audio, "narration-edge.srt"), "1\n00:00:00,100 --> 00:00:01,000\n开场。\n\n2\n00:00:01,000 --> 00:00:02,000\n村庄。\n\n3\n00:00:06,400 --> 00:00:07,500\n结尾。\n");
    const mp3Hash = createHash("sha256").update(await readFile(join(audio, "narration.mp3"))).digest("hex");
    const wordTextHash = createHash("sha256").update("开场。\n\n村庄。\n\n结尾。\n", "utf8").digest("hex");
    const shift = { insertionAtSeconds: 2, insertedSeconds: 4.4, appliedBy: "duration.json.outroPause" };
    const wordPayload = {
      regionId: "r", voiceId: content.voiceId, rate: content.voiceRate,
      boundary: "WordBoundary", timingMode: "provider-word-boundaries",
      textHash: wordTextHash, sourceAudioHash: "same-edge-stream", audioHash: mp3Hash,
      timeline: "final-narration", shift,
      words: [
        { start: 0.1, end: 0.6, text: "开场" },
        { start: 1.0, end: 1.8, text: "村庄" },
        { start: 6.4, end: 7.3, text: "结尾" }
      ]
    };
    await writeFile(join(audio, "word-timestamps.json"), JSON.stringify(wordPayload));
    await writeFile(join(audio, "duration.json"), JSON.stringify({ provider: "edge-tts", voiceId: content.voiceId, rate: content.voiceRate, narrationTextHash: stableNarrationTextHash("开场。\n\n村庄。\n\n结尾。\n"), durationSeconds: 8, formalReleaseReady: true, sampleRate: 48000, loudnessTargetLufs: -16, outroPause: { applied: true, mode: "parent-child-tour", requestedSeconds: 4.4, insertedSeconds: 4.4, outroCueIndex: 2, hasClosingNarration: true, rawOutroNarrationStartSeconds: 2, outroNarrationStartSeconds: 6.4, insertionAtSeconds: 2, lastChildNarrationEndSeconds: 2, returnWindowSeconds: 4.4 }, wordTimestamps: { file: "word-timestamps.json", audioHash: mp3Hash, sourceAudioHash: "same-edge-stream", textHash: wordTextHash, boundary: "WordBoundary", wordCount: 3, shift } }));
    await stageNarrationCache(root, sandbox, join(root, "new"), project);
    assert.equal(await canReuseFinalNarration(target, content), true);
    for (const [index, changed] of [
      { ...project, scenes: project.scenes.map((scene, i) => i === 0 ? { ...scene, narration: "修改。" } : scene) },
      { ...project, voice: { ...project.voice, voiceId: "other" } },
      { ...project, voice: { ...project.voice, speed: 1.02 } },
      { ...project, template: { ...project.template, tourReturnSeconds: 5 } }
    ].entries()) {
      const rejected = join(root, `rejected-${index}`);
      await mkdir(join(rejected, "content"), { recursive: true });
      await copyFile(join(sandbox, "content", "regions.zh-CN.json"), join(rejected, "content", "regions.zh-CN.json"));
      await stageNarrationCache(root, rejected, join(root, "new"), changed);
      assert.equal(await canReuseFinalNarration(join(rejected, "assets", "audio", "r"), content), false);
    }
    const before = await readFile(join(target, "narration.mp3"));
    const beforeSrt = await readFile(join(target, "narration-edge.srt"));
    const contentPath = join(root, "content.json");
    await writeFile(contentPath, JSON.stringify({ r: content }));
    const generated = spawnSync(process.execPath, [join(repo, "node_modules", "tsx", "dist", "cli.mjs"), join(repo, ".agents", "skills", "cesium-geo-documentary", "scripts", "generate-narration.ts"), "--region", "r", "--content", contentPath, "--out-dir", target], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(generated.status, 0, generated.stderr);
    assert.match(generated.stdout, /\(cached\)/);
    assert.deepEqual(await readFile(join(target, "narration.mp3")), before);
    assert.deepEqual(await readFile(join(target, "narration-edge.srt")), beforeSrt);
    for (const changed of [{ ...content, narration: ["修改。", ...content.narration.slice(1)] }, { ...content, voiceId: "other" }, { ...content, voiceRate: "+2%" }, { ...content, tourReturnSeconds: 5 }]) assert.equal(await canReuseFinalNarration(target, changed), false);
    const baseline = join(root, "assets", "audio", "r");
    await mkdir(baseline, { recursive: true });
    await writeFile(join(baseline, "narration.mp3"), "bad baseline");
    await stageNarrationCache(root, sandbox, join(root, "new"), project);
    assert.deepEqual(await readFile(join(target, "narration.mp3")), before);
    // 逐词表必须同源且已按 outroPause 位移：缺失 / 独立合成形状 / 音频不符 /
    // 文本不符 / 未位移 / 时间越界，任何一种都不能被当作精确词表复用。
    const wordsPath = join(target, "word-timestamps.json");
    const originalWords = await readFile(wordsPath, "utf8");
    assert.equal(await canReuseFinalNarration(target, content), true);
    await rm(wordsPath);
    assert.equal(await canReuseFinalNarration(target, content), false);
    await writeFile(wordsPath, JSON.stringify({ ...wordPayload, sourceAudioHash: undefined, audioHash: undefined, timeline: undefined, shift: undefined }));
    assert.equal(await canReuseFinalNarration(target, content), false);
    await writeFile(wordsPath, JSON.stringify({ ...wordPayload, audioHash: "stale-audio-hash" }));
    assert.equal(await canReuseFinalNarration(target, content), false);
    await writeFile(wordsPath, JSON.stringify({ ...wordPayload, textHash: createHash("sha256").update("别的稿子").digest("hex") }));
    assert.equal(await canReuseFinalNarration(target, content), false);
    await writeFile(wordsPath, JSON.stringify({ ...wordPayload, shift: { insertionAtSeconds: 0, insertedSeconds: 0, appliedBy: null } }));
    assert.equal(await canReuseFinalNarration(target, content), false);
    await writeFile(wordsPath, JSON.stringify({ ...wordPayload, words: [...wordPayload.words.slice(0, 2), { start: 6.4, end: 20, text: "结尾" }] }));
    assert.equal(await canReuseFinalNarration(target, content), false);
    await writeFile(wordsPath, originalWords);
    assert.equal(await canReuseFinalNarration(target, content), true);
    await writeFile(join(target, "narration-edge.srt"), "damaged");
    assert.equal(await canReuseFinalNarration(target, content), false);
    await rm(join(audio, "duration.json"));
    const sandbox2 = join(root, "sandbox2");
    await mkdir(join(sandbox2, "content"), { recursive: true });
    await copyFile(join(sandbox, "content", "regions.zh-CN.json"), join(sandbox2, "content", "regions.zh-CN.json"));
    await stageNarrationCache(root, sandbox2, join(root, "new"), project);
    await assert.rejects(readFile(join(sandbox2, "assets", "audio", "r", "narration-cache.json")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
