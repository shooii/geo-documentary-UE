#!/usr/bin/env python3
"""Offset standalone region captions into master SRT/VTT deliverables."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[4]


def stamp(value: float, comma: bool) -> str:
    milliseconds = max(0, round(value * 1000))
    hour, remainder = divmod(milliseconds, 3_600_000)
    minute, remainder = divmod(remainder, 60_000)
    second, millisecond = divmod(remainder, 1000)
    separator = "," if comma else "."
    return f"{hour:02d}:{minute:02d}:{second:02d}{separator}{millisecond:03d}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--regions", required=True, help="Comma-separated editorial order")
    parser.add_argument("--output-base", required=True, help="Path without extension")
    args = parser.parse_args()

    regions = [value.strip() for value in args.regions.split(",") if value.strip()]
    if not regions:
        raise ValueError("At least one region is required")

    output_base = (PROJECT_ROOT / args.output_base).resolve()
    output_base.parent.mkdir(parents=True, exist_ok=True)
    cues: list[dict[str, object]] = []
    offset = 0.0

    for region_id in regions:
        caption_path = PROJECT_ROOT / "apps" / "video-compositor" / "captions" / f"{region_id}.json"
        timeline_path = PROJECT_ROOT / "data" / "regions" / f"{region_id}.timeline.json"
        caption_data = json.loads(caption_path.read_text(encoding="utf-8"))
        timeline_data = json.loads(timeline_path.read_text(encoding="utf-8"))
        for cue in caption_data["cues"]:
            cues.append(
                {
                    "regionId": region_id,
                    "start": float(cue["start"]) + offset,
                    "end": float(cue["end"]) + offset,
                    "text": str(cue["text"]),
                }
            )
        offset += float(timeline_data["duration"])

    srt_blocks: list[str] = []
    vtt_blocks = ["WEBVTT", ""]
    for index, cue in enumerate(cues, start=1):
        start = float(cue["start"])
        end = float(cue["end"])
        text = str(cue["text"])
        srt_blocks.append(f"{index}\n{stamp(start, True)} --> {stamp(end, True)}\n{text}")
        vtt_blocks.append(f"{stamp(start, False)} --> {stamp(end, False)}\n{text}\n")

    output_base.with_suffix(".srt").write_text("\n\n".join(srt_blocks) + "\n", encoding="utf-8")
    output_base.with_suffix(".vtt").write_text("\n".join(vtt_blocks), encoding="utf-8")
    report = {
        "ok": bool(cues) and float(cues[-1]["end"]) <= offset,
        "regions": regions,
        "cueCount": len(cues),
        "masterDuration": offset,
        "lastCueEnd": float(cues[-1]["end"]) if cues else 0,
        "text": "".join(str(cue["text"]) for cue in cues),
    }
    output_base.with_suffix(".captions.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps({key: value for key, value in report.items() if key != "text"}, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
