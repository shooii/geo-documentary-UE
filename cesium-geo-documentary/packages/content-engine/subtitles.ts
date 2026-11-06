export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
  lines?: string[];
}

export interface DisplayCue extends SubtitleCue {
  lines: string[];
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

export function buildSingleLineCues(
  cues: SubtitleCue[],
  maximum: number,
  protectedPhrases: readonly string[] = [],
  overrides: readonly SingleLineCueOverride[] = []
): DisplayCue[] {
  const overrideMap = new Map<number, string[]>();
  for (const override of overrides) {
    if (!Number.isInteger(override.cueIndex) || override.cueIndex < 0 || override.cueIndex >= cues.length) {
      throw new Error(`Subtitle override cueIndex is out of range: ${override.cueIndex}`);
    }
    if (overrideMap.has(override.cueIndex)) throw new Error(`Duplicate subtitle override for cue ${override.cueIndex}`);
    overrideMap.set(override.cueIndex, override.chunks);
  }
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
    const weights = chunks.map((chunk) => Math.max(1, normalizeSubtitleSemantics(chunk).length));
    const totalCharacters = weights.reduce((sum, length) => sum + length, 0);
    const duration = cue.end - cue.start;
    let elapsedCharacters = 0;
    let cursor = cue.start;
    return chunks.map((chunk, index) => {
      const start = cursor;
      elapsedCharacters += weights[index] ?? 1;
      const end = index === chunks.length - 1
        ? cue.end
        : cue.start + duration * elapsedCharacters / totalCharacters;
      cursor = end;
      return {
        start,
        end,
        text: chunk,
        lines: [chunk]
      };
    });
  });
}

export function timelineValues(start: number, end: number): { start: string; duration: string } {
  const startMilliseconds = Math.round(start * 1000);
  const endMilliseconds = Math.max(startMilliseconds + 1, Math.round(end * 1000));
  return {
    start: (startMilliseconds / 1000).toFixed(3),
    duration: ((endMilliseconds - startMilliseconds) / 1000).toFixed(3)
  };
}
