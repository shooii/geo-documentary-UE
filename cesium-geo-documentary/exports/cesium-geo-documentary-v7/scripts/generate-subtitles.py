#!/usr/bin/env python3
"""Convert Edge TTS sentence timings into safe SRT/VTT and deterministic character timings."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[4]
TIME_RE = re.compile(r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})")
PUNCTUATION = set("，。！？；：、,.!?;:（）()《》“”‘’—… ")


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


def split_single_line_text(text: str, maximum: int) -> list[str]:
    chunks: list[str] = []
    remaining = text
    while len(remaining) > maximum:
        candidates = [index + 1 for index, char in enumerate(remaining[:maximum]) if char in "，；。！？、："]
        minimum = max(1, int(maximum * 0.55))
        candidates = [index for index in candidates if index >= minimum]
        split_at = candidates[-1] if candidates else maximum
        chunks.append(remaining[:split_at])
        remaining = remaining[split_at:]
    if remaining:
        chunks.append(remaining)
    return chunks


def split_single_line_cues(cues: list[dict[str, object]], maximum: int) -> list[dict[str, object]]:
    output: list[dict[str, object]] = []
    for cue in cues:
        chunks = split_single_line_text(str(cue["text"]), maximum)
        total = sum(len(chunk) for chunk in chunks)
        duration = float(cue["end"]) - float(cue["start"])
        cursor = float(cue["start"])
        for index, chunk in enumerate(chunks):
            chunk_duration = float(cue["end"]) - cursor if index == len(chunks) - 1 else duration * len(chunk) / max(1, total)
            output.append({"start": cursor, "end": cursor + chunk_duration, "text": chunk, "lines": [chunk]})
            cursor += chunk_duration
    return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", required=True)
    parser.add_argument("--max-chars", type=int, default=26)
    args = parser.parse_args()
    source = PROJECT_ROOT / "assets" / "audio" / args.region / "narration-edge.srt"
    output_dir = PROJECT_ROOT / "apps" / "video-compositor" / "captions"
    output_dir.mkdir(parents=True, exist_ok=True)
    cues = split_single_line_cues(parse_srt(source), args.max_chars)
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
    (output_dir / f"{args.region}.json").write_text(json.dumps({"regionId": args.region, "mode": "sentence", "cues": cues}, ensure_ascii=False, indent=2), encoding="utf-8")
    (output_dir / f"{args.region}-words.json").write_text(json.dumps({"regionId": args.region, "mode": "tts-derived-interpolation", "words": words}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Generated {len(cues)} cues and {len(words)} character timings")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
