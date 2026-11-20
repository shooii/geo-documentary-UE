import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chunkDoubaoNarration, synthesizeDoubaoNarration } from "../packages/doubao-tts/narration.js";
import { DOUBAO_END_CODE, type DoubaoSynthesizeOptions } from "../packages/doubao-tts/index.js";
import { stageNarrationCache, canReuseFinalNarration } from "../packages/narration-cache/index.js";
import type { VideoProject } from "../packages/project-schema/index.js";

const repo = resolve(import.meta.dirname, "..");
const ffmpeg = join(repo, "node_modules", "ffmpeg-static", "ffmpeg.exe");
const ffprobe = join(repo, "node_modules", "ffprobe-static", "bin", "win32", "x64", "ffprobe.exe");
const fakeKey = "sk-TESTONLY-export";
const credentials = { apiKey: fakeKey };
const voiceId = "doubao:zh_male_jieshuoxiaoming_uranus_bigtts";

/** 用 ffmpeg 生成一段真实可解码的 sine mp3，返回 base64。 */
function sineMp3Base64(seconds: number): string {
  const result = spawnSync(ffmpeg, [
    "-y", "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000`, "-t", String(seconds),
    "-c:a", "libmp3lame", "-b:a", "160k", "-f", "mp3", "pipe:1"
  ], { encoding: "buffer", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout.toString("base64");
}

function mockFetchForChunks(audios: Array<{ base64: string; words: Array<{ word: string; startTime: number; endTime: number }> }>): NonNullable<DoubaoSynthesizeOptions["fetchImpl"]> {
  let call = 0;
  return (async () => {
    const current = audios[Math.min(call, audios.length - 1)]!;
    call += 1;
    const frames = [
      JSON.stringify({ code: 0, message: "OK", data: current.base64, sentence: { text: "", words: current.words } }),
      JSON.stringify({ code: DOUBAO_END_CODE, message: "OK", data: null })
    ].join("\n");
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from(frames, "utf8")); controller.close(); }
    });
    return { ok: true, status: 200, statusText: "OK", headers: new Headers(), body } as Response;
  }) as NonNullable<DoubaoSynthesizeOptions["fetchImpl"]>;
}

function probeDuration(path: string): number {
  const result = spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0);
  return Number(result.stdout.trim());
}

test("分句切块：按句切分，超长句按中文标点二次切且不超单次上限", () => {
  const chunks = chunkDoubaoNarration("第一句。第二句！第三句？");
  assert.deepEqual(chunks.map((c) => c.text), ["第一句。", "第二句！", "第三句？"]);
  assert.deepEqual(chunks.map((c) => c.sentenceIndex), [0, 1, 2]);

  const long = `${"甲".repeat(600)}，${"乙".repeat(600)}，收尾。`;
  const pieces = chunkDoubaoNarration(long, 700);
  assert.ok(pieces.length >= 2);
  for (const piece of pieces) assert.ok([...piece.text].length <= 700, "每块不得超上限");
  assert.ok(pieces.every((piece) => piece.sentenceIndex === 0), "超长句切出的块都归属同一句");
});

test("超长无标点单句按 Unicode 码点硬切：每块<=上限、句号不变、拼接还原原文", () => {
  // 整句 2300 码点且无任何中文标点；split('，') 得到的单个 piece 仍 > 上限，
  // 必须由 pushBounded 按码点硬切，而不是原样交出一个超限块。
  const sentence = `${"汉".repeat(2300)}。`;
  const chunks = chunkDoubaoNarration(sentence, 1000);
  assert.ok(chunks.length >= 3, `应硬切成多块，实际 ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok([...chunk.text].length <= 1000, "每块必须<=1000码点");
    assert.equal(chunk.sentenceIndex, 0, "硬切块仍归属同一句");
  }
  // 码点无损：去掉句末标点前应逐码点还原为原始内容（不丢字、不重复）。
  const restored = chunks.map((c) => c.text).join("").replace(/。$/, "");
  assert.equal(restored, "汉".repeat(2300));

  // 含 emoji（代理对）也按码点而非 UTF16 单元切，不能把代理对切成两半。
  const withEmoji = "😀".repeat(600);
  const emojiChunks = chunkDoubaoNarration(withEmoji, 500);
  assert.ok(emojiChunks.length >= 2);
  for (const chunk of emojiChunks) {
    assert.ok([...chunk.text].length <= 500);
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk.text), "块尾不得是孤立高代理");
    assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk.text), "块首不得是孤立低代理");
  }
  assert.equal(emojiChunks.map((c) => c.text).join(""), withEmoji);
});

test("端到端同源：按真实解码时长累加偏移拼接，落盘 source mp3/SRT/CharacterBoundary 词表", async () => {
  const root = await mkdtemp(join(tmpdir(), "doubao-export-"));
  try {
    // 第一块 1.0s，词只到 0.6s（远早于音频尾）；第二块 1.5s。
    // 若偏移错误地取 last word.end(0.6)，第二块词会落在 ~0.7；正确应落在 ~1.1。
    const audio1 = sineMp3Base64(1.0);
    const audio2 = sineMp3Base64(1.5);
    const fetchImpl = mockFetchForChunks([
      { base64: audio1, words: [{ word: "你", startTime: 0.1, endTime: 0.35 }, { word: "好", startTime: 0.35, endTime: 0.6 }] },
      { base64: audio2, words: [{ word: "世", startTime: 0.1, endTime: 0.7 }, { word: "界", startTime: 0.7, endTime: 1.3 }] }
    ]);
    const sourceMp3 = join(root, "source.mp3");
    const sourceSrt = join(root, "source.srt");
    const sourceWords = join(root, "source-words.json");
    const text = "你好。世界。\n";
    const textHash = createHash("sha256").update(text, "utf8").digest("hex");
    const result = await synthesizeDoubaoNarration({
      credentials, voiceId, speed: 1, text, textHash, rate: "+0%", regionId: "r",
      sourceMp3, sourceSrt, sourceWords, ffmpeg, root, fetchImpl
    });

    assert.equal(result.chunkCount, 2);
    assert.equal(result.wordCount, 4);
    // 拼接后真实时长应≈两块之和，而不是靠 word.end 估算。
    const joined = probeDuration(sourceMp3);
    assert.ok(Math.abs(joined - 2.5) < 0.15, `拼接时长应≈2.5s，实际 ${joined}`);

    const words = JSON.parse(await readFile(sourceWords, "utf8"));
    assert.equal(words.boundary, "CharacterBoundary");
    assert.equal(words.timingMode, "provider-word-boundaries");
    assert.equal(words.textHash, textHash);
    assert.equal(words.sourceAudioHash, createHash("sha256").update(await readFile(sourceMp3)).digest("hex"));
    assert.equal(words.words.length, 4);
    const secondBlockWord = words.words[2];
    assert.ok(secondBlockWord.start >= 0.95, `第二块词起始应按真实块时长(~1.0s)位移，实际 ${secondBlockWord.start}`);
    assert.ok(secondBlockWord.start < 1.3, `第二块词起始不应过度偏移，实际 ${secondBlockWord.start}`);

    const srt = await readFile(sourceSrt, "utf8");
    assert.equal(srt.trim().split(/\n\n/).length, 2, "一句一条 cue");

    // 时间戳与源音频同源自检：所有词都落在真实总时长内、单调。
    for (let i = 1; i < words.words.length; i += 1) {
      assert.ok(words.words[i].start >= words.words[i - 1].start - 0.06, "词时间单调");
      assert.ok(words.words[i].end <= joined + 0.2, "词时间不越界");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("缓存认证：豆包 CharacterBoundary 词表同源通过；跨 provider / 错边界 / 未位移一律拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "doubao-cache-"));
  try {
    const sandbox = join(root, "sandbox"), job = join(root, "workspace", "jobs", "old");
    const audio = join(job, "audio"), target = join(sandbox, "assets", "audio", "r");
    await mkdir(audio, { recursive: true });
    await mkdir(join(sandbox, "content"), { recursive: true });
    await mkdir(join(root, "node_modules", "ffprobe-static", "bin", "win32", "x64"), { recursive: true });
    await copyFile(ffprobe, join(root, "node_modules", "ffprobe-static", "bin", "win32", "x64", "ffprobe.exe"));

    const project = {
      id: "p", regionId: "r", voice: { voiceId, speed: 1 }, template: { tourReturnSeconds: 4.4 },
      scenes: [{ section: "overview", narration: "开场。" }, { section: "outro", narration: "结尾。" }]
    } as VideoProject;
    const content = { narration: ["开场。", "结尾。"], voiceId, voiceRate: "+0%", tourOrder: [], tourIntroSentences: 1, tourReturnSeconds: 4.4, outroParagraphIndex: 1 };

    const result = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "6", "-c:a", "libmp3lame", join(audio, "narration.mp3")], { stdio: "ignore" });
    assert.equal(result.status, 0);
    await writeFile(join(audio, "narration-edge.srt"), "1\n00:00:00,100 --> 00:00:01,000\n开场。\n\n2\n00:00:04,400 --> 00:00:05,000\n结尾。\n");

    const mp3Hash = createHash("sha256").update(await readFile(join(audio, "narration.mp3"))).digest("hex");
    const wordTextHash = createHash("sha256").update("开场。\n\n结尾。\n", "utf8").digest("hex");
    const shift = { insertionAtSeconds: 0, insertedSeconds: 0, appliedBy: null };
    const wordPayload = {
      regionId: "r", voiceId, rate: "+0%",
      boundary: "CharacterBoundary", timingMode: "provider-word-boundaries",
      textHash: wordTextHash, sourceAudioHash: "same-doubao-stream", audioHash: mp3Hash,
      timeline: "final-narration", shift,
      words: [
        { start: 0.1, end: 0.4, text: "开场" },
        { start: 4.4, end: 4.9, text: "结尾" }
      ]
    };
    await writeFile(join(audio, "word-timestamps.json"), JSON.stringify(wordPayload));
    await writeFile(join(sandbox, "content", "regions.zh-CN.json"), JSON.stringify({ r: {} }));
    await writeFile(join(job, "project.snapshot.json"), JSON.stringify(project));
    await writeFile(join(audio, "duration.json"), JSON.stringify({
      provider: "doubao-tts", voiceId, rate: "+0%", narrationTextHash: `sha256:${wordTextHash}`,
      durationSeconds: 6, formalReleaseReady: true, sampleRate: 48000, loudnessTargetLufs: -16,
      wordTimestamps: { file: "word-timestamps.json", audioHash: mp3Hash, sourceAudioHash: "same-doubao-stream", textHash: wordTextHash, boundary: "CharacterBoundary", wordCount: 2, shift }
    }));

    await stageNarrationCache(root, sandbox, join(root, "new"), project);
    assert.equal(await canReuseFinalNarration(target, content), true, "豆包同源词表应可复用");

    // 跨 provider：meta 声明 edge，但词表是 CharacterBoundary —— 拒绝。
    const metaPath = join(target, "duration.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    await writeFile(metaPath, JSON.stringify({ ...meta, provider: "edge-tts" }));
    assert.equal(await canReuseFinalNarration(target, content), false, "edge 不认豆包 CharacterBoundary 词表");
    await writeFile(metaPath, JSON.stringify(meta));

    // 词表边界错配成 WordBoundary —— 豆包 provider 下拒绝。
    const wordsPath = join(target, "word-timestamps.json");
    await writeFile(wordsPath, JSON.stringify({ ...wordPayload, boundary: "WordBoundary" }));
    assert.equal(await canReuseFinalNarration(target, content), false);
    await writeFile(wordsPath, JSON.stringify(wordPayload));

    // 未位移（结尾词停在原始 0.x 秒但 shift 声明 4.4s 插入）—— 通过 meta 位移数据不一致拒绝。
    const shiftedMeta = JSON.parse(await readFile(metaPath, "utf8"));
    shiftedMeta.wordTimestamps.boundary = "CharacterBoundary";
    await writeFile(wordsPath, JSON.stringify({ ...wordPayload, shift: { insertionAtSeconds: 0.5, insertedSeconds: 4.4, appliedBy: "duration.json.outroPause" } }));
    await writeFile(metaPath, JSON.stringify(shiftedMeta));
    assert.equal(await canReuseFinalNarration(target, content), false, "位移元数据与词表不符应拒绝");
    await writeFile(wordsPath, JSON.stringify(wordPayload));
    await writeFile(metaPath, JSON.stringify(meta));
    assert.equal(await canReuseFinalNarration(target, content), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("word 位移回归：豆包 CharacterBoundary 词表按 outroPause 位移后被认证，未位移/错位移拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "doubao-shift-"));
  try {
    const sandbox = join(root, "sandbox"), job = join(root, "workspace", "jobs", "old");
    const audio = join(job, "audio"), target = join(sandbox, "assets", "audio", "r");
    await mkdir(audio, { recursive: true });
    await mkdir(join(sandbox, "content"), { recursive: true });
    await mkdir(join(root, "node_modules", "ffprobe-static", "bin", "win32", "x64"), { recursive: true });
    await copyFile(ffprobe, join(root, "node_modules", "ffprobe-static", "bin", "win32", "x64", "ffprobe.exe"));

    const project = {
      id: "p", regionId: "r", voice: { voiceId, speed: 1 }, template: { tourReturnSeconds: 4.4 },
      scenes: [
        { section: "overview", narration: "开场。" },
        { section: "child", childId: "c", narration: "村庄。" },
        { section: "outro", narration: "结尾。" }
      ]
    } as VideoProject;
    const content = { narration: ["开场。", "村庄。", "结尾。"], voiceId, voiceRate: "+0%", tourOrder: ["c"], tourIntroSentences: 1, tourReturnSeconds: 4.4, outroParagraphIndex: 2 };

    const result = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "8", "-c:a", "libmp3lame", join(audio, "narration.mp3")], { stdio: "ignore" });
    assert.equal(result.status, 0);
    await writeFile(join(audio, "narration-edge.srt"), "1\n00:00:00,100 --> 00:00:01,000\n开场。\n\n2\n00:00:01,000 --> 00:00:02,000\n村庄。\n\n3\n00:00:06,400 --> 00:00:07,500\n结尾。\n");

    const mp3Hash = createHash("sha256").update(await readFile(join(audio, "narration.mp3"))).digest("hex");
    const wordTextHash = createHash("sha256").update("开场。\n\n村庄。\n\n结尾。\n", "utf8").digest("hex");
    const outroPause = { applied: true, mode: "parent-child-tour", requestedSeconds: 4.4, insertedSeconds: 4.4, outroCueIndex: 2, hasClosingNarration: true, rawOutroNarrationStartSeconds: 2, outroNarrationStartSeconds: 6.4, insertionAtSeconds: 2, lastChildNarrationEndSeconds: 2, returnWindowSeconds: 4.4 };
    const shift = { insertionAtSeconds: 2, insertedSeconds: 4.4, appliedBy: "duration.json.outroPause" };
    const wordPayload = {
      regionId: "r", voiceId, rate: "+0%",
      boundary: "CharacterBoundary", timingMode: "provider-word-boundaries",
      textHash: wordTextHash, sourceAudioHash: "same-doubao-stream", audioHash: mp3Hash,
      timeline: "final-narration", shift,
      words: [
        { start: 0.1, end: 0.6, text: "开场" },
        { start: 1.0, end: 1.8, text: "村庄" },
        { start: 6.4, end: 7.3, text: "结尾" }
      ]
    };
    await writeFile(join(audio, "word-timestamps.json"), JSON.stringify(wordPayload));
    await writeFile(join(sandbox, "content", "regions.zh-CN.json"), JSON.stringify({ r: {} }));
    await writeFile(join(job, "project.snapshot.json"), JSON.stringify(project));
    await writeFile(join(audio, "duration.json"), JSON.stringify({
      provider: "doubao-tts", voiceId, rate: "+0%", narrationTextHash: `sha256:${wordTextHash}`,
      durationSeconds: 8, formalReleaseReady: true, sampleRate: 48000, loudnessTargetLufs: -16, outroPause,
      wordTimestamps: { file: "word-timestamps.json", audioHash: mp3Hash, sourceAudioHash: "same-doubao-stream", textHash: wordTextHash, boundary: "CharacterBoundary", wordCount: 3, shift }
    }));

    await stageNarrationCache(root, sandbox, join(root, "new"), project);
    assert.equal(await canReuseFinalNarration(target, content), true, "按 outroPause 位移的豆包词表应被认证");

    // 词表声明了未位移（shift=0），与 meta.outroPause 的 2s/4.4s 冲突 —— 拒绝。
    const wordsPath = join(target, "word-timestamps.json");
    await writeFile(wordsPath, JSON.stringify({ ...wordPayload, shift: { insertionAtSeconds: 0, insertedSeconds: 0, appliedBy: null } }));
    assert.equal(await canReuseFinalNarration(target, content), false, "未位移词表不得复用");
    await writeFile(wordsPath, JSON.stringify(wordPayload));
    assert.equal(await canReuseFinalNarration(target, content), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
