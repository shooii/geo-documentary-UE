import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { splitNarrationSentences } from "../render-spec/narration-align.js";
import {
  formatSrtTimestamp,
  type NarrationCue,
  type WordTiming
} from "../../.agents/skills/cesium-geo-documentary/scripts/narration-timing.js";
import {
  DOUBAO_MAX_TEXT_CHARS,
  synthesizeDoubao,
  type DoubaoCredentials,
  type DoubaoWord,
  type DoubaoSynthesizeOptions
} from "./index.js";

/**
 * 豆包逐字时间戳/逐句音频的编排层。
 *
 * 豆包单次请求上限 1000 字，且 enable_subtitle 返回的字级时间只在同一请求内
 * 可信（跨请求可能是句内相对时间）。所以这里按"朗读句"切块，每块单独请求，
 * 每块音频解码成 48k mono PCM 后用**实际解码帧数**算时长，依次累加作为下一块
 * 的偏移；绝不把 mp3 直接首尾相接当作时间连续，也不拿最后 word.end 当偏移。
 * 这样 word-timestamps-source.json 与拼接后的 source mp3 严格同源。
 */

export interface SynthesizeDoubaoNarrationOptions {
  credentials: DoubaoCredentials;
  /** `doubao:<speaker>` 完整 id。 */
  voiceId: string;
  /** 0.5 - 2.0，由现有 ratePercent 换算。 */
  speed: number;
  /** 已应用 pronunciation 替换的 TTS 输入文本（含末尾换行）。 */
  text: string;
  /** 输入文本的裸 sha256 hex（不带 `sha256:` 前缀），用于同源认证。 */
  textHash: string;
  /** edge 风格语速字符串（+0%/-4%），只作为元数据写回。 */
  rate: string;
  regionId: string;
  sourceMp3: string;
  sourceSrt: string;
  sourceWords: string;
  ffmpeg: string;
  root: string;
  signal?: AbortSignal;
  /** 仅测试注入；生产走官方 HTTP 端点。 */
  fetchImpl?: DoubaoSynthesizeOptions["fetchImpl"];
}

export interface DoubaoNarrationResult {
  chunkCount: number;
  wordCount: number;
  sourceAudioHash: string;
  sourceDurationSeconds: number;
  requestIds: string[];
}

const SAMPLE_RATE = 48_000;
const BYTES_PER_FRAME = 2; // s16le mono
const round = (value: number) => Math.round(value * 1000) / 1000;

interface TextChunk {
  text: string;
  /** splitNarrationSentences 的下标：同一句可拆成多块，但字幕仍只占一条 cue。 */
  sentenceIndex: number;
}

/** 按朗读句切块；超长句先按中文标点切，仍超限的片段按 Unicode 码点硬切。 */
export function chunkDoubaoNarration(text: string, maxChars = DOUBAO_MAX_TEXT_CHARS): TextChunk[] {
  const sentences = splitNarrationSentences(text);
  const chunks: TextChunk[] = [];
  // 兜底硬切：client 单次上限按码点算，任何单块都不能超过，否则请求前就报错。
  // 硬切只在"整句/整标点片段都超限"时发生，仍保留 sentenceIndex 归属同一句，
  // 字幕 cue 条数与词表偏移不受影响。
  const pushBounded = (value: string, sentenceIndex: number): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const codePoints = [...trimmed];
    for (let offset = 0; offset < codePoints.length; offset += maxChars) {
      chunks.push({ text: codePoints.slice(offset, offset + maxChars).join(""), sentenceIndex });
    }
  };
  for (const [sentenceIndex, sentence] of sentences.entries()) {
    if ([...sentence].length <= maxChars) {
      chunks.push({ text: sentence, sentenceIndex });
      continue;
    }
    let current = "";
    for (const piece of sentence.split(/(?<=[，、：,;；])/u)) {
      if (current && [...current + piece].length > maxChars) {
        pushBounded(current, sentenceIndex);
        current = "";
      }
      if ([...piece].length > maxChars) {
        pushBounded(piece, sentenceIndex);
        continue;
      }
      current += piece;
    }
    pushBounded(current, sentenceIndex);
  }
  return chunks;
}

function decodeToPcm(mp3: Buffer, ffmpeg: string, root: string): Buffer {
  const result = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "mp3", "-i", "pipe:0",
    "-ar", String(SAMPLE_RATE), "-ac", "1",
    "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"
  ], { cwd: root, input: mp3, maxBuffer: 512 * 1024 * 1024, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  if (result.error || result.status !== 0 || !result.stdout?.length) {
    throw new Error(`豆包音频块解码失败：${result.error?.message ?? `${result.stdout?.length ?? 0} bytes`}\n${result.stderr?.toString().slice(-1_000) ?? ""}`);
  }
  return result.stdout;
}

function encodePcmToMp3(pcm: Buffer, output: string, ffmpeg: string, root: string): void {
  const result = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
    "-c:a", "libmp3lame", "-b:a", "192k", output
  ], { cwd: root, input: pcm, maxBuffer: 512 * 1024 * 1024, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  if (result.error || result.status !== 0) {
    throw new Error(`豆包拼接音频编码失败：${result.error?.message ?? ""}\n${result.stderr?.toString().slice(-1_000) ?? ""}`);
  }
}

interface SynthChunk {
  chunk: TextChunk;
  pcm: Buffer;
  /** 本块在拼接时间轴上的起点，由前面各块真实解码时长累加得到。 */
  start: number;
  /** 该块真实解码时长（秒），由 PCM 帧数算出。 */
  duration: number;
  /** 已按本块起点位移过的字级时间，秒。 */
  words: WordTiming[];
  requestId: string;
}

/**
 * 逐块合成、解码、按真实时长位移拼接，落盘同源的 source mp3 / SRT / 源词表。
 * 任何一块失败或时间戳与音频长度矛盾都抛错，不静默产出半同源资产。
 */
export async function synthesizeDoubaoNarration(options: SynthesizeDoubaoNarrationOptions): Promise<DoubaoNarrationResult> {
  const chunks = chunkDoubaoNarration(options.text);
  if (!chunks.length) throw new Error("豆包旁白输入为空，无法合成");

  const synthesized: SynthChunk[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    const result = await synthesizeDoubao(chunk.text, options.credentials, {
      voice: options.voiceId,
      speed: options.speed,
      requireTimestamps: true,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    });
    const pcm = decodeToPcm(result.audio, options.ffmpeg, options.root);
    const duration = pcm.length / (SAMPLE_RATE * BYTES_PER_FRAME);
    if (!(duration > 0)) throw new Error(`豆包音频块解码时长无效：${chunk.text.slice(0, 40)}`);
    const blockEnd = cursor + duration;
    const words: WordTiming[] = result.words.map((word: DoubaoWord) => ({
      start: round(word.start + cursor),
      end: round(word.end + cursor),
      text: word.text
    }));
    for (const word of words) {
      if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start
        || word.start < cursor - 0.05 || word.end > blockEnd + 0.05) {
        throw new Error(`豆包字级时间戳超出该块音频范围（${chunk.text.slice(0, 40)}）；拒绝拼接非同源时间轴`);
      }
      if (word.end > blockEnd) word.end = round(blockEnd);
    }
    if (words.some((word, index) => index > 0 && word.start + 0.05 < words[index - 1]!.end)) {
      throw new Error(`豆包字级时间戳跨块非单调（${chunk.text.slice(0, 40)}）`);
    }
    synthesized.push({ chunk, pcm, start: cursor, duration, words, requestId: result.requestId });
    cursor = blockEnd;
  }

  const pcm = Buffer.concat(synthesized.map((entry) => entry.pcm));
  encodePcmToMp3(pcm, options.sourceMp3, options.ffmpeg, options.root);
  const sourceAudioHash = createHash("sha256").update(await readFile(options.sourceMp3)).digest("hex");

  // 一句一条 cue；同一句拆成多块时合并其词表时间，句尾回退到真实块尾，
  // 保证 SRT 条数仍等于 splitNarrationSentences 的句子数（tourIntroSentences 依赖它）。
  const sentences = splitNarrationSentences(options.text);
  const cues: NarrationCue[] = [];
  for (const [sentenceIndex, sentence] of sentences.entries()) {
    const group = synthesized.filter((entry) => entry.chunk.sentenceIndex === sentenceIndex);
    if (!group.length) throw new Error(`豆包分句 ${sentenceIndex} 没有对应音频块`);
    const groupWords = group.flatMap((entry) => entry.words);
    if (!groupWords.length) throw new Error(`豆包分句 ${sentenceIndex} 没有逐字时间戳`);
    // 词表已按每块真实起点位移过，直接用第一/最后词的绝对时间；句尾回退到
    // 本句最后一块的真实块尾，保证 cue 不越过实际音频。
    const sentenceStart = Math.max(0, groupWords[0]!.start);
    const groupEnd = group.at(-1)!.start + group.at(-1)!.duration;
    const sentenceEndRaw = groupWords.at(-1)!.end + 0.15;
    cues.push({
      start: round(sentenceStart),
      end: round(Math.min(groupEnd, Math.max(sentenceStart + 0.2, sentenceEndRaw))),
      text: sentence
    });
  }
  await writeFile(options.sourceSrt, `${cues.map((cue, index) => [
    String(index + 1),
    `${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}`,
    cue.text
  ].join("\n")).join("\n\n")}\n`, "utf8");

  const words = synthesized.flatMap((entry) => entry.words);
  await writeFile(options.sourceWords, JSON.stringify({
    regionId: options.regionId,
    voiceId: options.voiceId,
    rate: options.rate,
    boundary: "CharacterBoundary",
    timingMode: "provider-word-boundaries",
    textHash: options.textHash,
    sourceAudioHash,
    requestIds: synthesized.map((entry) => entry.requestId),
    words
  }, null, 1), "utf8");

  return {
    chunkCount: synthesized.length,
    wordCount: words.length,
    sourceAudioHash,
    sourceDurationSeconds: cursor,
    requestIds: synthesized.map((entry) => entry.requestId)
  };
}
