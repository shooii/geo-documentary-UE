export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
  lines?: string[];
  highlight?: Array<{ time: number; progress: number }>;
}

export interface DisplayCue extends SubtitleCue {
  lines: string[];
  /** 有词表且成功对齐时附带，供导出后核对金色擦出是否真的跟上了人声。 */
  wordAlignment?: SubtitleWordAlignmentInfo;
}

export interface SingleLineCueOverride {
  cueIndex: number;
  chunks: string[];
}

const breakPunctuation = "，；。！？、：,.!?;:";
const semanticPunctuation = "，。！？；：、,.!?;:（）()《》“”‘’—… ";
const numberUnitSource = String.raw`-?\d+(?:\.\d+)?(?:万|亿|千|百)?(?:平方公里|平方千米|平方米|立方米|公顷|公里|千米|人|户|名|位|个|座|所|家|村|镇|县|亩|米|吨|元|年|月|日|岁|次|项|条|艘|%|％)?`;
const chineseNumberUnitSource = String.raw`[零〇一二两三四五六七八九十百千万亿点]+(?:平方公里|平方千米|平方米|立方米|公顷|公里|千米|人|户|名|位|个|座|所|家|村|镇|县|亩|米|吨|元|年|月|日|岁|次|项|条|艘|%|％)?`;
const measureValueSource = String.raw`(?:${numberUnitSource}|${chineseNumberUnitSource})`;
const metricLabelSource = String.raw`(?:常住人口|户籍人口|城镇人口|总人口|人口|面积|海岸线|农林牧渔业总产值|地区生产总值|生产总值|城镇化率|行政村|自然村)`;
const measurePhraseSource = String.raw`(?:${metricLabelSource}|约有|共有|超过|达到|有|达|为|共)\s*${measureValueSource}`;

function protectedBreakPositions(text: string, maximum: number, protectedPhrases: readonly string[] = []): Set<number> {
  const positions = new Set<number>();
  const protectMatches = (pattern: RegExp, limitToMaximum: boolean) => {
    for (const match of text.matchAll(pattern)) {
      const value = match[0] ?? "";
      const start = match.index ?? 0;
      if (!value || (limitToMaximum && [...value].length > maximum)) continue;
      for (let index = start + 1; index < start + value.length; index += 1) positions.add(index);
    }
  };
  protectMatches(new RegExp(measureValueSource, "g"), false);
  protectMatches(new RegExp(metricLabelSource, "g"), false);
  protectMatches(/[A-Za-z]+(?:[-'][A-Za-z0-9]+)*/g, false);
  protectMatches(new RegExp(measurePhraseSource, "g"), true);
  for (const phrase of new Set(protectedPhrases.map((value) => value.trim()).filter(Boolean))) {
    if (phrase.length < 2 || phrase.length > maximum) continue;
    let start = text.indexOf(phrase);
    while (start >= 0) {
      for (let index = start + 1; index < start + phrase.length; index += 1) positions.add(index);
      start = text.indexOf(phrase, start + phrase.length);
    }
  }
  return positions;
}

function hasDominantMeasurePhrase(text: string, maximum: number): boolean {
  if (text.length > maximum) return false;
  return [...text.matchAll(new RegExp(measurePhraseSource, "g"))]
    .some((match) => (match[0]?.length ?? 0) >= text.length - 3);
}

function hasDominantProtectedPhrase(text: string, maximum: number, protectedPhrases: readonly string[]): boolean {
  let cleaned = text.trim();
  while (cleaned && breakPunctuation.includes(cleaned[0] ?? "")) cleaned = cleaned.slice(1);
  while (cleaned && breakPunctuation.includes(cleaned.at(-1) ?? "")) cleaned = cleaned.slice(0, -1);
  return cleaned.length <= maximum && protectedPhrases.some((phrase) => phrase.trim() === cleaned);
}

function closest(values: number[], target: number): number | undefined {
  return values.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
}

function chooseBreak(text: string, minimum: number, maximum: number, target: number, allowPunctuationOverflow = false, protectedPhrases: readonly string[] = []): number {
  const boundedMinimum = Math.max(1, minimum);
  const punctuationOverflow = allowPunctuationOverflow && breakPunctuation.includes(text[maximum] ?? "") ? 1 : 0;
  const boundedMaximum = Math.min(text.length - 1, maximum + punctuationOverflow);
  const forbidden = protectedBreakPositions(text, maximum, protectedPhrases);
  const allowed: number[] = [];
  for (let index = boundedMinimum; index <= boundedMaximum; index += 1) {
    if (forbidden.has(index)) continue;
    if (breakPunctuation.includes(text[index] ?? "")) continue;
    allowed.push(index);
  }
  const punctuationCandidates = allowed.filter((index) => breakPunctuation.includes(text[index - 1] ?? ""));
  const punctuationChoice = closest(punctuationCandidates, target);
  const allowedChoice = closest(allowed, target);
  const punctuationTolerance = Math.max(2, Math.ceil(maximum * 0.2));
  const emergencyAllowed: number[] = [];
  for (let index = 1; index < boundedMinimum; index += 1) {
    if (forbidden.has(index)) continue;
    if (breakPunctuation.includes(text[index] ?? "")) continue;
    emergencyAllowed.push(index);
  }
  return (punctuationChoice !== undefined && Math.abs(punctuationChoice - target) <= punctuationTolerance ? punctuationChoice : undefined)
    ?? allowedChoice
    ?? closest(emergencyAllowed, target)
    ?? boundedMaximum;
}

function cleanSingleLineChunk(text: string, maximum = Number.POSITIVE_INFINITY): string {
  let cleaned = text.trim();
  while (cleaned && breakPunctuation.includes(cleaned[0] ?? "")) cleaned = cleaned.slice(1);
  while (cleaned && breakPunctuation.includes(cleaned.at(-1) ?? "")) cleaned = cleaned.slice(0, -1);
  while ([...cleaned].length > maximum && breakPunctuation.includes(cleaned.at(-1) ?? "")) cleaned = cleaned.slice(0, -1);
  return cleaned;
}

export function normalizeSubtitleSemantics(text: string): string {
  // Whitespace counts as a break, not as content: a paragraph that carries its
  // own line breaks must still compare equal to the same text without them,
  // otherwise hand-authored display lines get rejected as semantic drift.
  return [...text].filter((char) => !semanticPunctuation.includes(char) && !/\s/.test(char)).join("");
}

export function wrapTwoLines(text: string, maximum: number, protectedPhrases: readonly string[] = []): string[] {
  if (maximum < 1) throw new Error("Subtitle line length must be positive");
  if (text.length <= maximum) return [text];
  if (text.length > maximum * 2) throw new Error("Text must be split into display cues before wrapping");
  const minimumFirstLine = Math.max(1, text.length - maximum);
  const maximumFirstLine = Math.min(maximum, text.length - 1);
  const split = chooseBreak(text, minimumFirstLine, maximumFirstLine, Math.round(text.length / 2), false, protectedPhrases);
  let first = text.slice(0, split);
  let second = text.slice(split);
  if (breakPunctuation.includes(second[0] ?? "") && second.length < maximum && first.length > 1) {
    second = `${first.at(-1)}${second}`;
    first = first.slice(0, -1);
  }
  return [first, second];
}

export function splitCueText(text: string, maximum: number, protectedPhrases: readonly string[] = []): string[] {
  if (maximum < 1) throw new Error("Subtitle line length must be positive");
  const maximumChunkLength = maximum * 2;
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maximumChunkLength) {
    const minimumBreak = Math.max(maximum, Math.floor(maximumChunkLength * 0.62));
    const split = chooseBreak(remaining, maximum, maximumChunkLength, minimumBreak, false, protectedPhrases);
    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function buildDisplayCues(cues: SubtitleCue[], maximum: number, protectedPhrases: readonly string[] = []): DisplayCue[] {
  return cues.flatMap((cue) => {
    if (cue.end <= cue.start) throw new Error(`Subtitle cue must have positive duration: ${cue.start}-${cue.end}`);
    const chunks = splitCueText(cue.text, maximum, protectedPhrases).flatMap((chunk) => {
      if (chunk.length <= maximum) return [chunk];
      const minimumFirstLine = Math.max(1, chunk.length - maximum);
      const maximumFirstLine = Math.min(maximum, chunk.length - 1);
      const split = chooseBreak(chunk, minimumFirstLine, maximumFirstLine, Math.round(chunk.length / 2), false, protectedPhrases);
      if (breakPunctuation.includes(chunk[split] ?? "") && chunk.length - split >= maximum) {
        return [chunk.slice(0, split + 1), chunk.slice(split + 1)].filter(Boolean);
      }
      return [chunk];
    });
    const totalCharacters = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const duration = cue.end - cue.start;
    let elapsed = 0;
    return chunks.map((chunk, index) => {
      const start = cue.start + elapsed;
      const chunkDuration = index === chunks.length - 1
        ? cue.end - start
        : duration * chunk.length / totalCharacters;
      elapsed += chunkDuration;
      return {
        start,
        end: index === chunks.length - 1 ? cue.end : start + chunkDuration,
        text: chunk,
        lines: wrapTwoLines(chunk, maximum, protectedPhrases)
      };
    });
  });
}

export function splitSingleLineText(text: string, maximum: number, protectedPhrases: readonly string[] = []): string[] {
  const chunks: string[] = [];
  let remaining = text;
  const minimum = Math.max(4, Math.floor(maximum * 0.45));
  const preferred = Math.max(minimum, Math.round(maximum * 0.78));
  const softMaximum = Math.min(maximum, preferred + 1);
  while (remaining.length > softMaximum
    && !hasDominantMeasurePhrase(remaining, maximum)
    && !hasDominantProtectedPhrase(remaining, maximum, protectedPhrases)) {
    const plannedChunks = Math.max(2, Math.ceil(remaining.length / softMaximum));
    const target = Math.min(softMaximum, Math.max(minimum, Math.round(remaining.length / plannedChunks)));
    const split = chooseBreak(remaining, minimum, maximum, target, true, protectedPhrases);
    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split);
  }
  if (remaining) chunks.push(remaining);
  chunks.splice(0, chunks.length, ...chunks.map((chunk) => cleanSingleLineChunk(chunk, maximum)).filter(Boolean));
  const minimumTail = Math.max(4, Math.floor(maximum * 0.35));
  const previousLength = chunks.at(-2)?.length ?? 0;
  const tailLength = chunks.at(-1)?.length ?? 0;
  const tailIsProtected = hasDominantProtectedPhrase(chunks.at(-1) ?? "", maximum, protectedPhrases)
    || hasDominantMeasurePhrase(chunks.at(-1) ?? "", maximum);
  if (chunks.length >= 2 && !tailIsProtected && (tailLength < minimumTail || Math.max(previousLength, tailLength) > preferred)) {
    const combined = `${chunks.at(-2) ?? ""}${chunks.at(-1) ?? ""}`;
    const minimumSplit = Math.max(minimumTail, combined.length - maximum);
    const maximumSplit = Math.min(maximum, combined.length - minimumTail);
    if (minimumSplit <= maximumSplit) {
      const split = chooseBreak(combined, minimumSplit, maximumSplit, Math.round(combined.length / 2), true, protectedPhrases);
      chunks.splice(chunks.length - 2, 2, combined.slice(0, split), combined.slice(split));
    }
  }
  return chunks;
}

// 数字按中文读法估算音节，年份/编号保留逐位读法；这仍是句级时序内的插值。
export function subtitleSpeechUnits(text: string): Array<{ text: string; weight: number; width: number }> {
  return [...text.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?|[^\d]/gu)].map((match) => {
    const value = match[0];
    const width = [...value].reduce((sum, char) => sum + (/[\x00-\xff]/.test(char) ? 0.5 : 1), 0);
    if (/^\d/.test(value)) {
      const digits = value.replaceAll(",", "");
      const [integer = "", decimal] = digits.split(".");
      const following = text.slice((match.index ?? 0) + value.length);
      let weight = integer.length;
      if (integer.length <= 4 && !/^年/.test(following) && !/^0/.test(integer)) {
        let spoken = "";
        const units = ["千", "百", "十", ""];
        for (let index = 0; index < integer.length; index += 1) {
          const digit = integer[index]!;
          if (digit !== "0") spoken += `${digit}${units[4 - integer.length + index]}`;
          else if (/[1-9]/.test(integer.slice(index + 1)) && !spoken.endsWith("零")) spoken += "零";
        }
        if (spoken.startsWith("1十")) spoken = spoken.slice(1);
        weight = spoken.length;
      }
      return { text: value, weight: Math.max(1, weight + (decimal ? decimal.length + 1 : 0)), width };
    }
    const weight = /\s/.test(value) || /[“”‘’（）()《》]/.test(value) ? 0
      : /[，、,:：]/.test(value) ? 0.65
      : /[。！？；!?;…]/.test(value) ? 1 : 1;
    return { text: value, weight, width };
  });
}

export function subtitleHighlightPoints(text: string, start: number, end: number): Array<{ time: number; progress: number }> {
  const units = subtitleSpeechUnits(text);
  const totalWeight = units.reduce((sum, unit) => sum + unit.weight, 0) || 1;
  const totalWidth = units.reduce((sum, unit) => sum + unit.width, 0) || 1;
  let elapsed = 0;
  let width = 0;
  const points = [{ time: start, progress: 0 }];
  for (const unit of units) {
    const at = start + (end - start) * elapsed / totalWeight;
    // Include punctuation in the preceding spoken sweep instead of jumping its
    // width in a zero-duration step. Hold the progress during the actual pause.
    if (/^[\p{P}\s]+$/u.test(unit.text)) {
      width += unit.width;
      points[points.length - 1]!.progress = width / totalWidth;
      elapsed += unit.weight;
      points.push({ time: start + (end - start) * elapsed / totalWeight, progress: width / totalWidth });
    } else {
      elapsed += unit.weight;
      width += unit.width;
      points.push({ time: start + (end - start) * elapsed / totalWeight, progress: width / totalWidth });
    }
  }
  return points;
}

/** 逐词时间（来自 TTS WordBoundary，秒，相对旁白音频起点）。 */
export interface WordTiming { start: number; end: number; text: string }

/** 单行字幕与词表的对齐诊断，便于导出后核对金色字幕是否真的跟上了人声。 */
export interface SubtitleWordAlignmentInfo {
  /** 是否使用了真实词时间（false 表示回退到字重插值）。 */
  aligned: boolean;
  /** 匹配到真实词的发音字符数。 */
  matchedChars: number;
  /** 该行发音字符总数。 */
  totalChars: number;
  /** matchedChars / totalChars。 */
  coverage: number;
  /** 覆盖该行的不同词数。 */
  wordCount: number;
  /** 该行第一个匹配词的起点（秒）。 */
  firstWordStart?: number;
  /** 该行最后一个匹配词的终点（秒）。 */
  lastWordEnd?: number;
}

/** 汇总所有字幕行的对齐覆盖，供主线程在导出时打印验收。 */
export interface SubtitleAlignmentReport {
  totalCues: number;
  alignedCues: number;
  fallbackCues: number;
  totalChars: number;
  matchedChars: number;
  coverage: number;
  rows: Array<SubtitleWordAlignmentInfo & { text: string; start: number; end: number }>;
}

interface SpeechChar {
  char: string;
  sourceIndex: number;
  width: number;
  speak: boolean;
}

interface AlignedCharInfo {
  time: number;
  word: number | undefined;
  /** 该字符在所属词发音字符序列中的下标（跨行切词时用来切出词的真实片段）。 */
  charIndex: number;
  /** 所属词的发音字符总数。 */
  wordCharCount: number;
}

interface WordCursor { word: number; char: number }

interface CueAlignment {
  /** 按 cue 文本 UTF16 下标索引的对齐信息；非发音字符为 undefined。 */
  chars: Array<AlignedCharInfo | undefined>;
  cursor: WordCursor;
}

/** 低于此覆盖率就认为这行和词表对不上，严格回退，不用错位时间硬套。 */
const MIN_ALIGN_COVERAGE = 0.6;

function clampTime(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.max(low, Math.min(high, value));
}

function isSpeechChar(char: string): boolean {
  return Boolean(char) && !semanticPunctuation.includes(char) && !/\s/u.test(char);
}

/** 文本 -> 发音字符序列。宽度沿用字重插值口径（半角 0.5、全角 1、标点 0）。 */
function toSpeechChars(text: string): SpeechChar[] {
  const chars: SpeechChar[] = [];
  let sourceIndex = 0;
  for (const char of text) {
    const speak = isSpeechChar(char);
    chars.push({
      char,
      sourceIndex,
      width: speak ? (/[\x00-\xff]/.test(char) ? 0.5 : 1) : 0,
      speak
    });
    sourceIndex += char.length;
  }
  return chars;
}

function wordSpeechChars(word: WordTiming): string[] {
  return toSpeechChars(word.text).filter((char) => char.speak).map((char) => char.char);
}

/** 一个词内第 charIndex 个发音字符读完的时刻；词内按字符线性擦出。 */
function wordLightTime(word: WordTiming, charIndex: number, charCount: number): number {
  if (charCount <= 0) return word.end;
  return word.start + (word.end - word.start) * (charIndex + 1) / charCount;
}

/**
 * 全局按顺序把一段字幕文本对齐到词表。
 *
 * - 用「发音字符」逐个比较（标点/空白不参与），因此数字 "42,104" 与字幕 "42104"
 *   在去掉千分位后逐字符一致，不再把 UTF16 下标误当 speechUnits 数组下标。
 * - 重复词、跨行切词天然由顺序游标处理：游标只在真正消费发音字符时前移。
 * - 词内 TTS 多读一个字时允许向后看 1~2 个字符跳过，但绝不做「首字相同就算匹配」
 *   的宽松兜底；对不上就留空，交给覆盖率判定严格回退。
 * - word.start 决定节点起点：词间静音期间不产生新节点，渲染端线性插值时
 *   progress 保持不变，即停顿 hold，不会在静音里继续扫。
 */
function alignTextToWords(text: string, words: readonly WordTiming[], cursor: WordCursor): CueAlignment {
  const chars = toSpeechChars(text);
  const alignedChars: Array<AlignedCharInfo | undefined> = new Array(chars.length);
  const cache = words.map((word) => wordSpeechChars(word));
  let word = cursor.word;
  let char = cursor.char;

  for (let index = 0; index < chars.length; index += 1) {
    if (!chars[index]!.speak) continue;
    while (word < words.length && char >= (cache[word]?.length ?? 0)) {
      word += 1;
      char = 0;
    }
    if (word >= words.length) continue;
    const expected = cache[word]![char]!;
    const current = chars[index]!.char;
    const record = (charIndex: number) => {
      alignedChars[index] = {
        time: wordLightTime(words[word]!, charIndex, cache[word]!.length),
        word,
        charIndex,
        wordCharCount: cache[word]!.length
      };
    };
    if (current === expected) {
      record(char);
      char += 1;
      continue;
    }
    let skipped = false;
    for (let look = 1; look <= 2 && char + look < cache[word]!.length; look += 1) {
      if (current === cache[word]![char + look]) {
        record(char + look);
        char += look + 1;
        skipped = true;
        break;
      }
    }
    if (skipped) continue;
    // 不匹配：不消费词字符、不记录时间，严格交给覆盖率回退。
  }

  return { chars: alignedChars, cursor: { word, char } };
}

/** 把 cue 级对齐（按 cue 文本下标）映射到单行 chunk（按 chunk 文本下标）。 */
function mapAlignmentToChunk(
  chunk: string,
  cueText: string,
  from: number,
  to: number,
  alignment: CueAlignment
): Array<AlignedCharInfo | undefined> {
  const result: Array<AlignedCharInfo | undefined> = new Array(chunk.length);
  const sourceChars = toSpeechChars(cueText.slice(from, to)).filter((char) => char.speak);
  const targetChars = toSpeechChars(chunk).filter((char) => char.speak);
  let sourceIndex = 0;
  for (const target of targetChars) {
    while (sourceIndex < sourceChars.length && !sourceChars[sourceIndex]!.speak) sourceIndex += 1;
    if (sourceIndex >= sourceChars.length) break;
    const absolute = from + sourceChars[sourceIndex]!.sourceIndex;
    result[target.sourceIndex] = alignment.chars[absolute];
    sourceIndex += 1;
  }
  return result;
}

function normalizePoints(points: Array<{ time: number; progress: number }>, start: number, end: number): Array<{ time: number; progress: number }> {
  const clean: Array<{ time: number; progress: number }> = [];
  for (const point of points) {
    const time = clampTime(point.time, start, end);
    const progress = Math.max(clean.at(-1)?.progress ?? 0, Math.min(1, point.progress));
    if (clean.length && time <= clean.at(-1)!.time + 1e-6) {
      clean[clean.length - 1] = { time: clean.at(-1)!.time, progress: Math.max(clean.at(-1)!.progress, progress) };
    } else {
      clean.push({ time, progress });
    }
  }
  return clean;
}

interface RowAlignment {
  points: Array<{ time: number; progress: number }>;
  info: SubtitleWordAlignmentInfo;
  firstTime: number;
  lastTime: number;
}

/** 用对齐结果生成单行的金色节点：词内线性擦出，词间（含停顿）progress 保持不变。 */
function highlightFromAlignment(
  chunk: string,
  aligned: ReadonlyArray<AlignedCharInfo | undefined>,
  words: readonly WordTiming[],
  start: number,
  end: number
): RowAlignment | null {
  const chars = toSpeechChars(chunk).filter((char) => char.speak);
  if (!chars.length) return null;
  const totalWidth = chars.reduce((sum, char) => sum + char.width, 0) || 1;
  let acc = 0;
  const rows = chars.map((char) => {
    acc += char.width;
    const info = aligned[char.sourceIndex];
    return {
      ...char,
      progress: acc / totalWidth,
      time: info?.time,
      word: info?.word,
      charIndex: info?.charIndex ?? 0,
      wordCharCount: info?.wordCharCount ?? 1
    };
  });
  const matched = rows.filter((row) => row.time !== undefined);
  const wordSet = new Set(matched.map((row) => row.word).filter((word): word is number => word !== undefined));
  if (matched.length < Math.max(1, rows.length * MIN_ALIGN_COVERAGE) || !wordSet.size) return null;

  const firstTime = Math.min(...matched.map((row) => row.time!));
  const lastTime = Math.max(...matched.map((row) => row.time!));
  const firstWord = Math.min(...wordSet);
  const lastWord = Math.max(...wordSet);
  const info: SubtitleWordAlignmentInfo = {
    aligned: true,
    matchedChars: matched.length,
    totalChars: rows.length,
    coverage: matched.length / rows.length,
    wordCount: wordSet.size,
    firstWordStart: words[firstWord]?.start ?? firstTime,
    lastWordEnd: words[lastWord]?.end ?? lastTime
  };

  const groups: Array<Array<typeof rows[number]>> = [];
  for (const row of rows) {
    const current = groups.at(-1);
    if (row.word !== undefined && current?.[0]?.word === row.word) current.push(row);
    else groups.push([row]);
  }

  const points: Array<{ time: number; progress: number }> = [{ time: start, progress: 0 }];
  let previousProgress = 0;
  for (const group of groups) {
    const timed = group.filter((row) => row.time !== undefined);
    if (!timed.length) continue;
    // 用词的真实时间区间做擦出：从该行覆盖到的第一个词内字符位置起，
    // 到最后一个字符念完止。跨行切词时两行各拿词的一段，不会抢同一个词首。
    const timing = timed[0]!.word !== undefined ? words[timed[0]!.word] : undefined;
    const fromIndex = Math.min(...timed.map((row) => row.charIndex));
    const toIndex = Math.max(...timed.map((row) => row.charIndex));
    const charCount = timed[0]!.wordCharCount;
    const fraction = (index: number) => (charCount > 0 ? (index + 1) / charCount : 1);
    const groupStart = clampTime(timing ? timing.start + (timing.end - timing.start) * (fromIndex / charCount) : Math.min(...timed.map((row) => row.time!)), start, end);
    const groupEnd = clampTime(timing ? timing.start + (timing.end - timing.start) * fraction(toIndex) : Math.max(...timed.map((row) => row.time!)), start, end);
    const afterProgress = timed.at(-1)!.progress;
    if (groupStart > (points.at(-1)?.time ?? start) + 1e-4) {
      // 静音/停顿：上一节点的 progress 保持不动，直到这个词真正开始。
      points.push({ time: groupStart, progress: previousProgress });
    }
    let advanceTime = groupEnd;
    if (advanceTime <= (points.at(-1)?.time ?? start) + 1e-4) {
      advanceTime = (points.at(-1)?.time ?? start) + 0.001;
    }
    points.push({ time: Math.min(advanceTime, end), progress: afterProgress });
    previousProgress = afterProgress;
  }
  if ((points.at(-1)?.progress ?? 0) < 0.999 && end > (points.at(-1)?.time ?? start) + 1e-4) {
    points.push({ time: end, progress: 1 });
  }
  return { points: normalizePoints(points, start, end), info, firstTime, lastTime };
}

/**
 * 用真实逐词时间生成金色擦出节点。
 *
 * 旧算法把整句时长按“字重”均分，遇到数字、英文或明显停顿时，金色扫描会和
 * 人声错位。这里改为：每个词在它真正念完的时刻推进到该词末尾，词内再按宽度
 * 均分。若该行可匹配到的词覆盖不足（跨行截断、文本被改写等），返回 null，
 * 由调用方回退到按字重插值，避免用错位的时间强行覆盖。
 */
export function subtitleHighlightPointsFromWords(
  text: string,
  start: number,
  end: number,
  words: readonly WordTiming[]
): Array<{ time: number; progress: number }> | null {
  if (!words.length || end <= start) return null;
  // 词表可能覆盖整条旁白而本行只是其中一段：先裁到本行附近再对齐，
  // 既让游标从这行的第一个词起步，也不会把相邻行的词误算进来。
  const window = 0.5;
  const sorted = [...words]
    .filter((word) => word.end > start - window && word.start < end + window)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (!sorted.length) return null;
  const alignment = alignTextToWords(text, sorted, { word: 0, char: 0 });
  return highlightFromAlignment(text, alignment.chars, sorted, start, end)?.points ?? null;
}

export function buildSingleLineCues(
  cues: SubtitleCue[],
  maximum: number,
  protectedPhrases: readonly string[] = [],
  overrides: readonly SingleLineCueOverride[] = [],
  wordTimings: readonly WordTiming[] = []
): DisplayCue[] {
  const overrideMap = new Map<number, string[]>();
  for (const override of overrides) {
    if (!Number.isInteger(override.cueIndex) || override.cueIndex < 0 || override.cueIndex >= cues.length) {
      throw new Error(`Subtitle override cueIndex is out of range: ${override.cueIndex}`);
    }
    if (overrideMap.has(override.cueIndex)) throw new Error(`Duplicate subtitle override for cue ${override.cueIndex}`);
    overrideMap.set(override.cueIndex, override.chunks);
  }

  // 全局按时间排序后，用一条跨 cue 连续推进的词游标把所有字幕对齐到词表。
  // 这样跨行/跨句切词的字符都能拿到真正属于它的词时间，而不是各自在时间窗里
  // 重新找词导致错位。无词表时 sortedWords 为空，下面整体走字重插值兼容路径。
  // 词表常覆盖整条旁白，而传入的 cues 可能只是其中一段；先按 cue 时间范围
  // 裁掉范围外的词，避免游标从音频开头一路空转到这段字幕才开始对齐。
  const windowStart = cues.length ? Math.min(...cues.map((cue) => cue.start)) : 0;
  const windowEnd = cues.length ? Math.max(...cues.map((cue) => cue.end)) : 0;
  const wordWindow = 0.5;
  const sortedWords = wordTimings.length
    ? [...wordTimings]
        .filter((word) => word.end > windowStart - wordWindow && word.start < windowEnd + wordWindow)
        .sort((a, b) => a.start - b.start || a.end - b.end)
    : [];
  let cursor: WordCursor = { word: 0, char: 0 };
  const cueAlignments = cues.map((cue) => {
    const alignment = alignTextToWords(cue.text, sortedWords, cursor);
    // Carry the consumed-word cursor into the next cue: alignTextToWords copies
    // the incoming cursor and returns its advanced position. Without this the
    // second and later cues all restart at word 0 and their text no longer
    // matches the head of the table, collapsing coverage and forcing fallbacks.
    cursor = alignment.cursor;
    return alignment;
  });

  return cues.flatMap((cue, cueIndex) => {
    if (cue.end <= cue.start) throw new Error(`Subtitle cue must have positive duration: ${cue.start}-${cue.end}`);
    const overrideChunks = overrideMap.get(cueIndex);
    const chunks = overrideChunks
      ? overrideChunks.map((chunk) => cleanSingleLineChunk(chunk, maximum)).filter(Boolean)
      : splitSingleLineText(cue.text, maximum, protectedPhrases);
    if (chunks.length === 0) throw new Error(`Subtitle override for cue ${cueIndex} is empty`);
    if (chunks.some((chunk) => [...chunk].length > maximum)) {
      throw new Error(`Subtitle override for cue ${cueIndex} exceeds ${maximum} characters`);
    }
    if (overrideChunks && normalizeSubtitleSemantics(chunks.join("")) !== normalizeSubtitleSemantics(cue.text)) {
      throw new Error(`Subtitle override for cue ${cueIndex} changes spoken semantic text`);
    }
    const speechWeight = (text: string) => subtitleSpeechUnits(text).reduce((sum, unit) => sum + unit.weight, 0);
    const totalWeight = Math.max(1, speechWeight(cue.text));
    const duration = cue.end - cue.start;
    const alignment = cueAlignments[cueIndex]!;
    let sourceCursor = 0;

    const prepared = chunks.map((chunk) => {
      const sourceStart = cue.text.indexOf(chunk, sourceCursor);
      // 手工换行可能移除了内部标点：按语义字符匹配原句，保留原句里的停顿权重。
      let from = sourceStart;
      let to = sourceStart + chunk.length;
      if (from < 0) {
        from = sourceCursor;
        while (from < cue.text.length && !normalizeSubtitleSemantics(cue.text[from]!)) from += 1;
        to = from;
        const target = normalizeSubtitleSemantics(chunk);
        while (to < cue.text.length && normalizeSubtitleSemantics(cue.text.slice(from, to)).length < target.length) to += 1;
      }
      sourceCursor = to;
      const fallbackStart = cue.start + duration * speechWeight(cue.text.slice(0, from)) / totalWeight;
      const fallbackEnd = cue.start + duration * speechWeight(cue.text.slice(0, to)) / totalWeight;
      const aligned = sortedWords.length
        ? mapAlignmentToChunk(chunk, cue.text, from, to, alignment)
        : [];
      return { chunk, fallbackStart, fallbackEnd, aligned };
    });

    // 行的出现时机跟随真实词：以行内第一个匹配字符的点亮时刻为锚，同时保证
    // 各行窗口单调递增、首尾仍锁在 cue 区间内（停顿留在行内，不把行提前）。
    const starts: number[] = [];
    for (const [index, row] of prepared.entries()) {
      const previous = index === 0 ? cue.start : (starts[index - 1] ?? cue.start);
      const firstInfo = row.aligned.find((info) => info?.time !== undefined);
      let desired = row.fallbackStart;
      if (sortedWords.length && firstInfo && firstInfo.word !== undefined) {
        const firstWord = sortedWords[firstInfo.word];
        if (firstWord) {
          // 跨行切词时行首若落在词的后半段，用该字符在词内的位置推算起点，
          // 不能整行退回词首，否则上一行会被挤成零宽。
          desired = firstWord.start
            + (firstWord.end - firstWord.start) * firstInfo.charIndex / Math.max(1, firstInfo.wordCharCount);
        }
      }
      starts.push(clampTime(desired, previous + (index === 0 ? 0 : 0.001), cue.end - 0.001));
    }

    return prepared.map((row, index) => {
      const start = starts[index]!;
      const end = index === prepared.length - 1 ? cue.end : Math.max(start + 0.001, starts[index + 1]!);
      const wordResult = sortedWords.length
        ? highlightFromAlignment(row.chunk, row.aligned, sortedWords, start, end)
        : null;
      // 无词表时保留旧的「句尾标点留白」：字重窗口里末尾标点的权重不该被
      // 已读文字占满，所以先用字重节点收窄发声窗口再重新生成高亮。
      const fallbackWindow = subtitleHighlightPoints(row.chunk, row.fallbackStart, row.fallbackEnd);
      const spokenStart = Math.max(start, fallbackWindow[0]?.time ?? start);
      const spokenEnd = Math.max(spokenStart + 0.001, Math.min(end, fallbackWindow.at(-1)?.time ?? end));
      const highlight = wordResult?.points ?? subtitleHighlightPoints(row.chunk, spokenStart, spokenEnd);
      const wordAlignment: SubtitleWordAlignmentInfo = wordResult?.info ?? {
        aligned: false,
        matchedChars: 0,
        totalChars: toSpeechChars(row.chunk).filter((char) => char.speak).length,
        coverage: 0,
        wordCount: 0
      };
      return { start, end, text: row.chunk, lines: [row.chunk], highlight, wordAlignment };
    });
  });
}

/** 汇总字幕行的对齐覆盖，主线程可在生成 composition 后打印它做金色字幕验收。 */
export function subtitleAlignmentReport(displayCues: readonly DisplayCue[]): SubtitleAlignmentReport {
  const rows = displayCues.map((cue) => ({
    ...(cue.wordAlignment ?? {
      aligned: false,
      matchedChars: 0,
      totalChars: 0,
      coverage: 0,
      wordCount: 0
    }),
    text: cue.text,
    start: cue.start,
    end: cue.end
  }));
  const totalChars = rows.reduce((sum, row) => sum + row.totalChars, 0);
  const matchedChars = rows.reduce((sum, row) => sum + row.matchedChars, 0);
  const alignedCues = rows.filter((row) => row.aligned).length;
  return {
    totalCues: displayCues.length,
    alignedCues,
    fallbackCues: displayCues.length - alignedCues,
    totalChars,
    matchedChars,
    coverage: totalChars ? matchedChars / totalChars : 0,
    rows
  };
}

export function timelineValues(start: number, end: number): { start: string; duration: string } {
  const startMilliseconds = Math.round(start * 1000);
  const endMilliseconds = Math.max(startMilliseconds + 1, Math.round(end * 1000));
  return {
    start: (startMilliseconds / 1000).toFixed(3),
    duration: ((endMilliseconds - startMilliseconds) / 1000).toFixed(3)
  };
}
