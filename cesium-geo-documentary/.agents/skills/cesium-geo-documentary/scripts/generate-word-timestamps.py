"""从同一次 Edge TTS 流保存音频 + WordBoundary 真实逐词时间戳。

设计要点（不要退回“先合成音频、再独立合成一次词表”的做法）：
- 一次 `Communicate(..., boundary="WordBoundary")` 的 stream 同时产出音频字节和
  WordBoundary 事件；`--write-media` 写出的 mp3 就是这些词对应的音频。
- `--write-subtitles` 写出的句级 SRT 也由同一批词推导：按输入文本还原标点并
  切句，再把词按语义顺序分配到句子。格式与 edge CLI / parseSrt 兼容，继续供
  generate-subtitles.py 与 mapParagraphsToCues 使用。
- `--word-timestamps` 写出的 JSON 带 sourceAudioHash（同一流音频的 sha256），
  供 generate-narration.ts 位移到最终旁白时间轴并绑定最终 mp3 hash 后，再由
  narration-cache 认证。没有 --write-media 时拒绝生成词表，避免假同源。

用法：
  python .agents/skills/cesium-geo-documentary/scripts/generate-word-timestamps.py \
    --region <id> --text-file <narration-input.txt> --voice <voice> --rate <rate> \
    --write-media <narration-source.mp3> \
    --write-subtitles <narration-edge-source.srt> \
    --word-timestamps <word-timestamps-source.json> \
    [--write-word-subtitles <word-source.srt>] [--total-duration <seconds>]
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any

# 脚本目录可能经符号链接进入导出沙箱：依赖按脚本真实位置解析，
# 但所有产物必须写到当前工作目录（ROOT），否则沙箱读不到、主仓库被污染。
PACKAGE_ROOT = Path(__file__).resolve().parents[4]
ROOT = Path.cwd()
sys.path.insert(0, str(PACKAGE_ROOT / ".python-packages"))

import edge_tts  # noqa: E402

SENTENCE_SPLIT_RE = re.compile(r"(?<=[。！？；;…])")
TRAILING_CLOSERS_RE = re.compile(r"^[”’」』）】》]+")
CJK_EXTENSION_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


def narration_input(content: dict) -> str:
    """与 generate-narration.ts 的 narrationInput 保持一致。"""
    paragraphs = [re.sub(r"\s+", " ", str(p).strip()) for p in content.get("narration", [])]
    text = "\n\n".join(p for p in paragraphs if p)
    for rec in content.get("pronunciations", []) or []:
        term = rec.get("term")
        spoken = rec.get("spokenForm")
        if spoken and term and spoken != term:
            text = text.replace(term, spoken)
    return text + "\n"


def normalize_spoken(text: str) -> str:
    """与 narration-timing.ts normalizeNarrationText 同口径：只留字母和数字。"""
    normalized = unicodedata.normalize("NFKC", text)
    return "".join(ch.lower() for ch in normalized if unicodedata.category(ch)[0] in ("L", "N"))


def split_sentences(text: str) -> list[str]:
    """按朗读换气点切句：换行 + 句末标点，收尾引号并回上一句。"""
    parts: list[str] = []
    for line in re.split(r"\n+", text):
        for chunk in SENTENCE_SPLIT_RE.split(line):
            part = chunk.strip()
            if part:
                parts.append(part)
    sentences: list[str] = []
    for part in parts:
        current = part
        if sentences:
            match = TRAILING_CLOSERS_RE.match(current)
            if match:
                sentences[-1] += match.group(0)
                current = current[match.end():]
        if not current:
            continue
        if sentences and not any(ch.isalnum() or CJK_EXTENSION_RE.match(ch) for ch in current):
            sentences[-1] += current
        else:
            sentences.append(current)
    return sentences


def proportional_word_groups(words: list[dict], sentences: list[str]) -> list[list[dict]]:
    """词文本与句子对不上时的兜底：按归一化字符数切分，仍保证每词只用一次。"""
    targets = [normalize_spoken(sentence) for sentence in sentences]
    word_lengths = [len(normalize_spoken(str(word["text"]))) for word in words]
    total_words = max(1, sum(word_lengths))
    total_targets = max(1, sum(len(target) for target in targets))
    boundaries: list[int] = []
    accumulated = 0.0
    for target in targets:
        accumulated += len(target) * total_words / total_targets
        boundaries.append(min(len(words), max(boundaries[-1] + 1 if boundaries else 1, round(accumulated))))
    groups: list[list[dict]] = []
    cursor = 0
    for index, boundary in enumerate(boundaries):
        stop = boundary if index == len(boundaries) - 1 else max(boundary, cursor + 1)
        stop = min(len(words), max(stop, cursor))
        if index == len(boundaries) - 1:
            stop = len(words)
        groups.append(words[cursor:stop])
        cursor = stop
    return [group for group in groups if group]


def assign_words_to_sentences(words: list[dict], sentences: list[str]) -> list[list[dict]]:
    """用词事件的文字把句子按语义顺序对齐，返回每句包含的词。"""
    targets = [normalize_spoken(sentence) for sentence in sentences]
    if not targets or any(not target for target in targets):
        raise SystemExit("旁白文本没有可映射的句子，无法生成同源句级字幕")
    groups: list[list[dict]] = [[] for _ in sentences]
    index = 0
    joined = ""
    for word in words:
        spoken = normalize_spoken(str(word["text"]))
        if not spoken:
            if index < len(sentences):
                groups[index].append(word)
            continue
        if index >= len(sentences):
            return proportional_word_groups(words, sentences)
        candidate = joined + spoken
        if not targets[index].startswith(candidate):
            return proportional_word_groups(words, sentences)
        groups[index].append(word)
        joined = candidate
        if joined == targets[index]:
            index += 1
            joined = ""
    if index != len(sentences) or any(not group for group in groups):
        return proportional_word_groups(words, sentences)
    return groups


def format_srt_timestamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def serialize_srt(cues: list[tuple[float, float, str]]) -> str:
    blocks = [
        f"{index}\n{format_srt_timestamp(start)} --> {format_srt_timestamp(end)}\n{text}"
        for index, (start, end, text) in enumerate(cues, start=1)
    ]
    return "\n\n".join(blocks) + "\n" if blocks else ""


def build_sentence_cues(
    groups: list[list[dict]],
    sentences: list[str],
    total_duration: float | None
) -> list[tuple[float, float, str]]:
    """句级时间完全来自同一批词事件：起点=本句首词，终点=下句首词（末句用音频总长）。"""
    non_empty = [(group, text) for group, text in zip(groups, sentences) if group]
    cues: list[tuple[float, float, str]] = []
    for index, (group, text) in enumerate(non_empty):
        start = round(float(group[0]["start"]), 3)
        if index + 1 < len(non_empty):
            end = round(float(non_empty[index + 1][0][0]["start"]), 3)
        else:
            tail = float(group[-1]["end"])
            end = round(max(tail, total_duration or tail), 3)
        if end <= start:
            end = round(start + 0.2, 3)
        cues.append((start, end, text))
    return cues


async def synth_stream(text: str, voice: str, rate: str, media_path: Path) -> list[dict]:
    """唯一一次 Edge 合成：音频写盘，同流 WordBoundary 事件返回为词表。"""
    communicate = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    words: list[dict] = []
    media_path.parent.mkdir(parents=True, exist_ok=True)
    with media_path.open("wb") as media:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                media.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                start = chunk["offset"] / 1e7
                end = (chunk["offset"] + chunk["duration"]) / 1e7
                if end <= start:
                    continue
                words.append({"start": round(start, 4), "end": round(end, 4), "text": chunk["text"]})
    return words


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def self_test() -> None:
    words = [
        {"start": 0.5, "end": 1.0, "text": "开场"},
        {"start": 1.5, "end": 2.0, "text": "村庄"},
        {"start": 2.0, "end": 2.4, "text": "这里"},
        {"start": 2.4, "end": 2.8, "text": "有一座桥"},
        {"start": 3.3, "end": 4.0, "text": "结尾"},
    ]
    sentences = split_sentences("开场。\n\n村庄，这里有一座桥。\n\n结尾！\n")
    assert sentences == ["开场。", "村庄，这里有一座桥。", "结尾！"], sentences
    groups = assign_words_to_sentences(words, sentences)
    assert [len(group) for group in groups] == [1, 3, 1], groups
    cues = build_sentence_cues(groups, sentences, 4.2)
    assert cues[0] == (0.5, 1.5, "开场。"), cues
    assert cues[1] == (1.5, 3.3, "村庄，这里有一座桥。"), cues
    assert abs(cues[2][1] - 4.2) < 1e-9, cues
    srt = serialize_srt(cues)
    assert srt.startswith("1\n00:00:00,500 --> 00:00:01,500\n开场。"), srt
    assert normalize_spoken("WordBoundary ！") == "wordboundary"
    assert normalize_spoken("2026年，A镇。") == "2026年a镇"
    print("WORD_TIMESTAMPS_SELFTEST_OK")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", required=True)
    parser.add_argument("--content", help="覆盖 content/regions.zh-CN.json 路径")
    parser.add_argument("--text-file", help="直接读取同一次合成使用的旁白文本")
    parser.add_argument("--voice")
    parser.add_argument("--rate")
    parser.add_argument("--out", help="词表默认输出目录（默认 ROOT/assets/audio/<region>）")
    parser.add_argument("--write-media", help="把这一次 Edge 流的音频写到这里（生成词表时必填）")
    parser.add_argument("--write-subtitles", help="把同源句级 SRT 写到这里（供 generate-subtitles.py）")
    parser.add_argument("--write-word-subtitles", help="可选：把每个 WordBoundary 事件写成词级 SRT")
    parser.add_argument("--word-timestamps", help="同源原始词表 JSON 输出路径")
    parser.add_argument("--total-duration", type=float, help="源音频总时长（秒），用于末句字幕终点")
    parser.add_argument("--self-test", action="store_true", help="只跑纯函数自检，不联网")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return 0
    if not args.write_media:
        raise SystemExit("必须提供 --write-media：逐词时间只能来自产出音频的同一次 Edge 流")
    if not args.word_timestamps and not args.write_subtitles:
        raise SystemExit("至少提供 --word-timestamps 或 --write-subtitles")

    master_path = Path(args.content) if args.content else ROOT / "content" / "regions.zh-CN.json"
    content: dict[str, Any] = {}
    if master_path.exists():
        master = json.loads(master_path.read_text(encoding="utf-8"))
        content = master.get(args.region) or {}
    voice = args.voice or content.get("voiceId") or "zh-CN-YunyangNeural"
    rate = args.rate or content.get("voiceRate") or "-4%"
    if args.text_file:
        text = Path(args.text_file).read_text(encoding="utf-8")
    else:
        if not content:
            raise SystemExit(f"找不到 {args.region} 的旁白文本，请提供 --text-file")
        text = narration_input(content)
    text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()

    media_path = Path(args.write_media)
    words = asyncio.run(synth_stream(text, voice, rate, media_path))
    if not words:
        raise SystemExit("Edge WordBoundary 未返回任何词，拒绝生成假精确词表")
    source_audio_hash = sha256_file(media_path)

    word_json_path = Path(args.word_timestamps) if args.word_timestamps else (
        Path(args.out) if args.out else ROOT / "assets" / "audio" / args.region
    ) / "word-timestamps.json"
    word_json_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "regionId": args.region,
        "voiceId": voice,
        "rate": rate,
        "boundary": "WordBoundary",
        "timingMode": "provider-word-boundaries",
        "textHash": text_hash,
        "sourceAudioHash": source_audio_hash,
        "audioHash": source_audio_hash,
        "durationSeconds": round(float(words[-1]["end"]), 4),
        "wordCount": len(words),
        "words": words,
        "timeline": "source"
    }
    word_json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    if args.write_subtitles:
        sentences = split_sentences(text)
        groups = assign_words_to_sentences(words, sentences)
        cues = build_sentence_cues(groups, sentences, args.total_duration)
        subtitle_path = Path(args.write_subtitles)
        subtitle_path.parent.mkdir(parents=True, exist_ok=True)
        subtitle_path.write_text(serialize_srt(cues), encoding="utf-8")
    if args.write_word_subtitles:
        word_cues = [(word["start"], word["end"], word["text"]) for word in words]
        word_srt_path = Path(args.write_word_subtitles)
        word_srt_path.parent.mkdir(parents=True, exist_ok=True)
        word_srt_path.write_text(serialize_srt(word_cues), encoding="utf-8")

    print(
        f"WORD_TIMESTAMPS_READY {args.region} words={len(words)} "
        f"sourceAudioHash={source_audio_hash[:12]} -> {word_json_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
