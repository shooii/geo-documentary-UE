#!/usr/bin/env python3
"""Rebuild the county-level region index from normalized region records."""

from __future__ import annotations

import json
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[4]
REGIONS = PROJECT_ROOT / "data" / "regions"


def main() -> int:
    records = []
    for path in sorted(REGIONS.glob("44????.json")):
        if path.name.endswith(".timeline.json") or path.name == "index.json":
            continue
        records.append(json.loads(path.read_text(encoding="utf-8")))
    (REGIONS / "index.json").write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Indexed {len(records)} regions")
    return 0 if len(records) == 9 else 1


if __name__ == "__main__":
    raise SystemExit(main())
