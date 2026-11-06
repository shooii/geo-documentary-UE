#!/usr/bin/env python3
"""Convert Edge TTS sentence timings into safe SRT/VTT and deterministic character timings."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

PROJECT_ROOT = Path(os.environ.get("GEO_VIDEO_PROJECT_ROOT", Path(__file__).resolve().parents[4]))
TIME_RE = re.compile(r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})")
PUNCTUATION = set("，。！？；：、,.!?;:（）()《》“”‘’—… ")
BREAK_PUNCTUATION = "，；。！？、：,.!?;:"
SOFT_BOUNDARY_PUNCTUATION = "，；、：,;:"
NUMBER_UNIT_SOURCE = r"-?\d+(?:\.\d+)?(?:万|亿|千|百)?(?:平方公里|平方千米|平方米|立方米|公顷|公里|千米|人|户|名|位|个|座|所|家|村|镇|县|亩|米|吨|元|年|月|日|岁|次|项|条|艘|%|％)?"
CHINESE_NUMBER_UNIT_SOURCE = r"[零〇一二两三四五六七八九十百千万亿点]+(?:平方公里|平方千米|平方米|立方米|公顷|公里|千米|人|户|名|位|个|座|所|家|村|镇|县|亩|米|吨|元|年|月|日|岁|次|项|条|艘|%|％)?"
MEASURE_VALUE_SOURCE = rf"(?:{NUMBER_UNIT_SOURCE}|{CHINESE_NUMBER_UNIT_SOURCE})"
METRIC_LABEL_SOURCE = r"(?:常住人口|户籍人口|城镇人口|总人口|人口|面积|海岸线|农林牧渔业总产值|地区生产总值|生产总值|城镇化率|行政村|自然村)"
MEASURE_PHRASE_SOURCE = rf"(?:{METRIC_LABEL_SOURCE}|约有|共有|超过|达到|有|达|为|共)\s*{MEASURE_VALUE_SOURCE}"
PROTECTED_NUMBER_UNIT_RE = re.compile(MEASURE_VALUE_SOURCE)
PROTECTED_METRIC_LABEL_RE = re.compile(METRIC_LABEL_SOURCE)
PROTECTED_ASCII_RE = re.compile(r"[A-Za-z]+(?:[-'][A-Za-z0-9]+)*")
PROTECTED_MEASURE_PHRASE_RE = re.compile(MEASURE_PHRASE_SOURCE)


def seconds(value: str) -> float:
    match = TIME_RE.fullmatch(value.strip())
    if not match:
        raise ValueError(f"Invalid SRT timestamp: {value}")
    hour, minute, second, millisecond = map(int, match.groups())
    return hour * 3600 + minute * 60 + second + millisecond / 1000


def stamp(value: float, comma: bool = True) -> str:
    milliseconds = max(0, round(value * 1000))
    hour, remainder = divmod(milliseconds, 3_600_000)
    minute, remainder = divmod(remainder, 60_000)
    second, millisecond = divmod(remainder, 1000)
    separator = "," if comma else "."
    return f"{hour:02d}:{minute:02d}:{second:02d}{separator}{millisecond:03d}"


def parse_srt(path: Path) -> list[dict[str, object]]:
    blocks = re.split(r"\r?\n\r?\n", path.read_text(encoding="utf-8-sig").strip())
    cues = []
    previous_end = 0.0
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if len(lines) < 3 or "-->" not in lines[1]:
            continue
        start_raw, end_raw = [item.strip() for item in lines[1].split("-->", 1)]
        start = max(previous_end, seconds(start_raw))
        end = max(start + 0.2, seconds(end_raw))
        text = "".join(lines[2:])
        cues.append({"start": start, "end": end, "text": text})
        previous_end = end
    normalized: list[dict[str, object]] = []
    for cue in cues:
        text = str(cue["text"])
        if text and all(char in PUNCTUATION for char in text) and normalized:
            normalized[-1]["text"] = f'{normalized[-1]["text"]}{text}'
            normalized[-1]["end"] = cue["end"]
            continue
        while text and text[0] in "，。！？；：、,.!?;:" and normalized:
            normalized[-1]["text"] = f'{normalized[-1]["text"]}{text[0]}'
            normalized[-1]["end"] = cue["start"]
            text = text[1:]
        if text:
            cue["text"] = text
            normalized.append(cue)
    return normalized


def protected_break_positions(text: str, maximum: int, protected_phrases: list[str] | None = None) -> set[int]:
    positions: set[int] = set()
    for pattern, limit_to_maximum in (
        (PROTECTED_NUMBER_UNIT_RE, False),
        (PROTECTED_METRIC_LABEL_RE, False),
        (PROTECTED_ASCII_RE, False),
        (PROTECTED_MEASURE_PHRASE_RE, True),
    ):
        for match in pattern.finditer(text):
            if limit_to_maximum and len(match.group(0)) > maximum:
                continue
            positions.update(range(match.start() + 1, match.end()))
    for phrase in dict.fromkeys(value.strip() for value in (protected_phrases or []) if value.strip()):
        if len(phrase) < 2 or len(phrase) > maximum:
            continue
        start = text.find(phrase)
        while start >= 0:
            positions.update(range(start + 1, start + len(phrase)))
            start = text.find(phrase, start + len(phrase))
    return positions


def choose_semantic_break(text: str, minimum: int, maximum: int, target: int, protected_phrases: list[str] | None = None) -> int:
    bounded_minimum = max(1, minimum)
    punctuation_overflow = 1 if text[maximum:maximum + 1] in BREAK_PUNCTUATION else 0
    bounded_maximum = min(len(text) - 1, maximum + punctuation_overflow)
    forbidden = protected_break_positions(text, maximum, protected_phrases)
    allowed = [
        index
        for index in range(bounded_minimum, bounded_maximum + 1)
        if index not in forbidden and (text[index:index + 1] not in BREAK_PUNCTUATION)
    ]
    punctuation_candidates = [index for index in allowed if text[index - 1:index] in BREAK_PUNCTUATION]
    punctuation_choice = min(punctuation_candidates, key=lambda index: abs(index - target)) if punctuation_candidates else None
    allowed_choice = min(allowed, key=lambda index: abs(index - target)) if allowed else None
    punctuation_tolerance = max(2, int(maximum * 0.2 + 0.999))
    if punctuation_choice is not None and abs(punctuation_choice - target) <= punctuation_tolerance:
        return punctuation_choice
    if allowed_choice is not None:
        return allowed_choice
    emergency_allowed = [
        index
        for index in range(1, bounded_minimum)
        if index not in forbidden and (text[index:index + 1] not in BREAK_PUNCTUATION)
    ]
    return min(emergency_allowed, key=lambda index: abs(index - target)) if emergency_allowed else bounded_maximum


def has_dominant_measure_phrase(text: str, maximum: int) -> bool:
    if len(text) > maximum:
        return False
    return any(len(match.group(0)) >= len(text) - 3 for match in PROTECTED_MEASURE_PHRASE_RE.finditer(text))


def has_dominant_protected_phrase(text: str, maximum: int, protected_phrases: list[str] | None = None) -> bool:
    cleaned = text.strip()
    while cleaned and cleaned[0] in BREAK_PUNCTUATION:
        cleaned = cleaned[1:]
    while cleaned and cleaned[-1] in BREAK_PUNCTUATION:
        cleaned = cleaned[:-1]
    return len(cleaned) <= maximum and any(phrase.strip() == cleaned for phrase in (protected_phrases or []))


def clean_single_line_chunk(text: str, maximum: int | None = None) -> str:
    cleaned = text.strip()
    while cleaned and cleaned[0] in BREAK_PUNCTUATION:
        cleaned = cleaned[1:]
    while cleaned and cleaned[-1] in SOFT_BOUNDARY_PUNCTUATION:
        cleaned = cleaned[:-1]
    while maximum is not None and len(cleaned) > maximum and cleaned[-1] in BREAK_PUNCTUATION:
        cleaned = cleaned[:-1]
    return cleaned


def split_single_line_text(text: str, maximum: int, protected_phrases: list[str] | None = None) -> list[str]:
    chunks: list[str] = []
    remaining = text
    minimum = max(4, int(maximum * 0.45))
    preferred = max(minimum, round(maximum * 0.78))
    soft_maximum = min(maximum, preferred + 1)
    while (len(remaining) > soft_maximum
           and not has_dominant_measure_phrase(remaining, maximum)
           and not has_dominant_protected_phrase(remaining, maximum, protected_phrases)):
        planned_chunks = max(2, (len(remaining) + soft_maximum - 1) // soft_maximum)
        target = min(soft_maximum, max(minimum, round(len(remaining) / planned_chunks)))
        split_at = choose_semantic_break(remaining, minimum, maximum, target, protected_phrases)
        chunks.append(remaining[:split_at])
        remaining = remaining[split_at:]
    if remaining:
        chunks.append(remaining)
    chunks = [cleaned for chunk in chunks if (cleaned := clean_single_line_chunk(chunk, maximum))]
    minimum_tail = max(4, int(maximum * 0.35))
    tail_is_protected = (
        has_dominant_protected_phrase(chunks[-1] if chunks else "", maximum, protected_phrases)
        or has_dominant_measure_phrase(chunks[-1] if chunks else "", maximum)
    )
    if len(chunks) >= 2 and not tail_is_protected and (len(chunks[-1]) < minimum_tail or max(len(chunks[-2]), len(chunks[-1])) > preferred):
        combined = f"{chunks[-2]}{chunks[-1]}"
        minimum_split = max(minimum_tail, len(combined) - maximum)
        maximum_split = min(maximum, len(combined) - minimum_tail)
        if minimum_split <= maximum_split:
            target = round(len(combined) / 2)
            split_at = choose_semantic_break(combined, minimum_split, maximum_split, target, protected_phrases)
            chunks[-2:] = [combined[:split_at], combined[split_at:]]
    return chunks


def split_single_line_cues(cues: list[dict[str, object]], maximum: int, protected_phrases: list[str] | None = None) -> list[dict[str, object]]:
    output: list[dict[str, object]] = []
    for cue in cues:
        chunks = split_single_line_text(str(cue["text"]), maximum, protected_phrases)
        total = sum(len(chunk) for chunk in chunks)
        duration = float(cue["end"]) - float(cue["start"])
        cursor = float(cue["start"])
        for index, chunk in enumerate(chunks):
            chunk_duration = float(cue["end"]) - cursor if index == len(chunks) - 1 else duration * len(chunk) / max(1, total)
            output.append({"start": cursor, "end": cursor + chunk_duration, "text": chunk, "lines": [chunk]})
            cursor += chunk_duration
    return output


def load_region_protected_phrases(region_id: str) -> list[str]:
    record_path = PROJECT_ROOT / "data" / "regions" / f"{region_id}.json"
    if not record_path.exists():
        return []
    record = json.loads(record_path.read_text(encoding="utf-8"))
    phrases = {str(value).strip() for value in record.get("subtitleProtectedPhrases", []) if str(value).strip()}
    region_name = str(record.get("name", "")).strip()
    title_topic = str(record.get("title", "")).split("·")[-1].strip()
    phrases.update(value for value in (region_name, title_topic) if value)
    phrases.update(str(child.get("name", "")).strip() for child in record.get("childRegions", []) if str(child.get("name", "")).strip())
    parent_id = str(record.get("parentId", "")).strip()
    parent_path = PROJECT_ROOT / "data" / "regions" / f"{parent_id}.json"
    if parent_id and parent_path.exists():
        parent = json.loads(parent_path.read_text(encoding="utf-8"))
        parent_name = str(parent.get("name", "")).strip()
        if parent_name:
            phrases.add(parent_name)
            if region_name:
                phrases.add(f"{parent_name}{region_name}")
    content_index_path = PROJECT_ROOT / "content" / "regions.zh-CN.json"
    if content_index_path.exists():
        content_index = json.loads(content_index_path.read_text(encoding="utf-8"))
        content = content_index.get(region_id, {})
        phrases.update(
            str(value).strip()
            for value in content.get("subtitleProtectedPhrases", [])
            if str(value).strip()
        )
        phrases.update(
            str(item.get("term", "")).strip()
            for item in content.get("pronunciations", [])
            if isinstance(item, dict) and str(item.get("term", "")).strip()
        )
    return sorted((phrase for phrase in phrases if len(phrase) >= 2), key=lambda value: (-len(value), value))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", required=True)
    parser.add_argument("--max-chars", type=int, default=26)
    parser.add_argument("--protected-phrase", action="append", default=[])
    # Overrides exist so a caller can synthesise subtitles for one project
    # without writing into the repo's canonical caption files. The Studio's
    # narration preview needs that: those captions are what makeProject() reads
    # to measure the CONTENT baseline, so a project-specific SRT left there
    # makes every later project read fail ("无法按文本稳定映射场景").
    parser.add_argument("--narration-srt", help="Narration SRT to read (default: assets/audio/<region>/narration-edge.srt)")
    parser.add_argument("--captions-dir", help="Where to write .srt/.vtt/.json/-words.json (default: apps/video-compositor/captions)")
    args = parser.parse_args()
    source = Path(args.narration_srt) if args.narration_srt else PROJECT_ROOT / "assets" / "audio" / args.region / "narration-edge.srt"
    output_dir = Path(args.captions_dir) if args.captions_dir else PROJECT_ROOT / "apps" / "video-compositor" / "captions"
    output_dir.mkdir(parents=True, exist_ok=True)
    protected_phrases = load_region_protected_phrases(args.region)
    protected_phrases.extend(args.protected_phrase)
    protected_phrases = list(dict.fromkeys(protected_phrases))
    # Preserve provider sentence cues here. Profile-specific composition performs the
    # only visible split, so portrait captions can rebalance the whole spoken phrase
    # instead of inheriting irreversible breaks made for a wider profile.
    cues = [
        {**cue, "lines": [str(cue["text"])]}
        for cue in parse_srt(source)
    ]
    words = []
    for cue_index, cue in enumerate(cues):
        visible = [char for char in str(cue["text"]) if char not in PUNCTUATION]
        span = float(cue["end"]) - float(cue["start"])
        unit = span / max(1, len(visible))
        cursor = float(cue["start"])
        for char in visible:
            words.append({"text": char, "start": round(cursor, 3), "end": round(cursor + unit, 3), "cueIndex": cue_index, "timingMode": "tts-derived-interpolation"})
            cursor += unit
    srt_blocks = []
    vtt_blocks = ["WEBVTT", ""]
    for index, cue in enumerate(cues, start=1):
        line = str(cue["text"])
        srt_blocks.append(f"{index}\n{stamp(float(cue['start']))} --> {stamp(float(cue['end']))}\n{line}")
        vtt_blocks.append(f"{stamp(float(cue['start']), False)} --> {stamp(float(cue['end']), False)}\n{line}\n")
    (output_dir / f"{args.region}.srt").write_text("\n\n".join(srt_blocks) + "\n", encoding="utf-8")
    (output_dir / f"{args.region}.vtt").write_text("\n".join(vtt_blocks), encoding="utf-8")
    (output_dir / f"{args.region}.json").write_text(json.dumps({"regionId": args.region, "mode": "provider-sentence-source", "protectedPhrases": protected_phrases, "cues": cues}, ensure_ascii=False, indent=2), encoding="utf-8")
    (output_dir / f"{args.region}-words.json").write_text(json.dumps({"regionId": args.region, "mode": "tts-derived-interpolation", "words": words}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Generated {len(cues)} cues and {len(words)} character timings")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
