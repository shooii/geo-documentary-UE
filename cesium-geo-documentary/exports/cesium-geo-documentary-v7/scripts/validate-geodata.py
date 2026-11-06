#!/usr/bin/env python3
"""Validate normalized GeoJSON structure, CRS range, polygon geometry, and stable IDs."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable

PROJECT_ROOT = Path(__file__).resolve().parents[4]
LOCAL_PACKAGES = PROJECT_ROOT / ".python-packages"
if LOCAL_PACKAGES.exists():
    sys.path.insert(0, str(LOCAL_PACKAGES))

try:
    from shapely.geometry import shape
except ImportError as exc:
    raise SystemExit("Shapely is required. Run: python -m pip install --target .python-packages -r requirements.txt") from exc


def positions(value: Any) -> Iterable[tuple[float, float]]:
    if isinstance(value, list) and len(value) >= 2 and all(isinstance(item, (int, float)) for item in value[:2]):
        yield float(value[0]), float(value[1])
    elif isinstance(value, list):
        for child in value:
            yield from positions(child)


def validate_file(path: Path) -> list[str]:
    errors: list[str] = []
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"{path}: unreadable JSON: {exc}"]
    features = document.get("features", [])
    if document.get("type") != "FeatureCollection" or not features:
        errors.append(f"{path}: expected a non-empty FeatureCollection")
        return errors
    seen_ids: set[str] = set()
    for index, feature in enumerate(features):
        properties = feature.get("properties", {})
        region_id = str(properties.get("id") or properties.get("adcode") or "")
        if not (region_id.isdigit() and 6 <= len(region_id) <= 12):
            errors.append(f"{path}: feature {index} has invalid stable geographic ID {region_id!r}")
        elif region_id in seen_ids:
            errors.append(f"{path}: duplicate geographic ID {region_id!r}")
        seen_ids.add(region_id)
        name = str(properties.get("name", "")).strip()
        if not name:
            errors.append(f"{path}: feature {index} has no name")
        if any("\ue000" <= char <= "\uf8ff" for char in name):
            errors.append(f"{path}: feature {index} name contains Unicode private-use characters")
        geometry = feature.get("geometry", {})
        if geometry.get("type") not in {"Polygon", "MultiPolygon"}:
            errors.append(f"{path}: feature {index} has unsupported geometry type {geometry.get('type')}")
            continue
        for longitude, latitude in positions(geometry.get("coordinates", [])):
            if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
                errors.append(f"{path}: feature {index} coordinate outside EPSG:4326 range: {longitude},{latitude}")
                break
        geom = shape(geometry)
        if geom.is_empty:
            errors.append(f"{path}: feature {index} geometry is empty")
        if not geom.is_valid:
            errors.append(f"{path}: feature {index} geometry is invalid")
        if geom.area <= 0:
            errors.append(f"{path}: feature {index} geometry area is zero")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", nargs="?", default="data/normalized")
    arguments = parser.parse_args()
    target = PROJECT_ROOT / arguments.path
    files = sorted(target.glob("*.geojson")) if target.is_dir() else [target]
    all_errors = [error for path in files for error in validate_file(path)]
    report = {"checked": len(files), "passed": len(files) - len({error.split(":", 1)[0] for error in all_errors}), "errors": all_errors}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if all_errors or not files else 0


if __name__ == "__main__":
    raise SystemExit(main())
