#!/usr/bin/env python3
"""Normalize a prefecture GeoJSON into one EPSG:4326 feature per county-level region."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any, Iterable

PROJECT_ROOT = Path(__file__).resolve().parents[4]
LOCAL_PACKAGES = PROJECT_ROOT / ".python-packages"
if LOCAL_PACKAGES.exists():
    sys.path.insert(0, str(LOCAL_PACKAGES))

try:
    from shapely.geometry import mapping, shape
    from shapely.ops import unary_union
    from shapely.validation import make_valid
except ImportError as exc:  # pragma: no cover - handled with an actionable message
    raise SystemExit("Shapely is required. Run: python -m pip install --target .python-packages -r requirements.txt") from exc

REGION_TYPES = {
    "440802": "district", "440803": "district", "440804": "district", "440811": "district",
    "440823": "county", "440825": "county", "440881": "county-city", "440882": "county-city", "440883": "county-city"
}

ENGLISH_NAMES = {
    "440800": "Zhanjiang",
    "440802": "Chikan", "440803": "Xiashan", "440804": "Potou", "440811": "Mazhang",
    "440823": "Suixi", "440825": "Xuwen", "440881": "Lianjiang", "440882": "Leizhou", "440883": "Wuchuan"
}


def iter_positions(value: Any) -> Iterable[tuple[float, float]]:
    if isinstance(value, (list, tuple)) and len(value) >= 2 and all(isinstance(number, (int, float)) for number in value[:2]):
        yield float(value[0]), float(value[1])
        return
    if isinstance(value, (list, tuple)):
        for child in value:
            yield from iter_positions(child)


def recommended_height(bbox: list[float]) -> int:
    west, south, east, north = bbox
    latitude = (south + north) / 2
    width_km = abs(east - west) * 111 * math.cos(math.radians(latitude))
    height_km = abs(north - south) * 111
    return round(max(35_000, min(900_000, max(width_km, height_km) * 2_200)))


def action_timeline(region_id: str, duration: float = 50.0) -> dict[str, Any]:
    if region_id == "440800":
        return {
            "duration": duration,
            "actions": [
                {"id": "overview-01", "time": 0, "duration": duration, "type": "showParentOverview", "target": region_id, "easing": "linear"},
                {"id": "population-01", "time": 8, "duration": 9, "type": "showPopulation", "target": region_id, "easing": "linear"},
                {"id": "economy-01", "time": 17, "duration": 9, "type": "showEconomy", "target": region_id, "easing": "linear"},
                {"id": "history-01", "time": 26, "duration": 9, "type": "showHistory", "target": region_id, "easing": "linear"},
                {"id": "culture-01", "time": 35, "duration": 9, "type": "showCulture", "target": region_id, "easing": "linear"},
                {"id": "summary-01", "time": 44, "duration": duration - 44, "type": "showSummary", "target": region_id, "easing": "linear"}
            ]
        }
    actions = [
        {"id": "overview-01", "time": 0, "duration": 2, "type": "showParentOverview", "target": "440800", "easing": "linear"},
        {"id": "camera-01", "time": 2, "duration": 6, "type": "flyToRegion", "target": region_id, "easing": "cubicInOut"},
        {"id": "fill-01", "time": 1.6, "duration": 4.4, "type": "fadeSelectedFill", "target": region_id, "easing": "cubicInOut"},
        {"id": "hold-01", "time": 8, "duration": 36, "type": "holdRegionCamera", "target": region_id, "easing": "linear"},
        {"id": "fill-out-01", "time": 44, "duration": 5.4, "type": "fadeSelectedOut", "target": region_id, "easing": "cubicInOut"},
        {"id": "return-01", "time": 44, "duration": 5.4, "type": "pullBackToParent", "target": "440800", "easing": "cubicInOut"},
        {"id": "population-01", "time": 8, "duration": 9, "type": "showPopulation", "target": region_id, "easing": "sineInOut"},
        {"id": "economy-01", "time": 17, "duration": 9, "type": "showEconomy", "target": region_id, "easing": "sineInOut"},
        {"id": "history-01", "time": 26, "duration": 9, "type": "showHistory", "target": region_id, "easing": "cubicInOut"},
        {"id": "culture-01", "time": 35, "duration": 9, "type": "showCulture", "target": region_id, "easing": "cubicInOut"},
        {"id": "summary-01", "time": 44, "duration": duration - 44, "type": "showSummary", "target": region_id, "easing": "sineInOut"}
    ]
    return {"duration": duration, "actions": actions}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", nargs="?", default="data/raw/440800_full.geojson")
    parser.add_argument("--output-dir", default="data/normalized")
    parser.add_argument("--regions-dir", default="data/regions")
    arguments = parser.parse_args()

    input_path = PROJECT_ROOT / arguments.input
    normalized_dir = PROJECT_ROOT / arguments.output_dir
    regions_dir = PROJECT_ROOT / arguments.regions_dir
    normalized_dir.mkdir(parents=True, exist_ok=True)
    regions_dir.mkdir(parents=True, exist_ok=True)
    raw = json.loads(input_path.read_text(encoding="utf-8"))
    output_index: list[dict[str, Any]] = []
    quality: list[dict[str, Any]] = []
    parent_features: list[dict[str, Any]] = []
    parent_geometries = []

    for feature in raw.get("features", []):
        properties = feature.get("properties", {})
        region_id = str(properties.get("adcode", ""))
        if region_id not in REGION_TYPES:
            continue
        original = shape(feature["geometry"])
        fixed = make_valid(original) if not original.is_valid else original
        if fixed.geom_type not in {"Polygon", "MultiPolygon"}:
            fixed = fixed.buffer(0)
        west, south, east, north = [round(value, 7) for value in fixed.bounds]
        representative = fixed.representative_point()
        center_value = properties.get("centroid") or properties.get("center") or [representative.x, representative.y]
        center = [float(center_value[0]), float(center_value[1])]
        label_point = [round(representative.x, 7), round(representative.y, 7)]
        area_km2 = round(fixed.area * 111.0 * 111.0 * math.cos(math.radians(center[1])), 2)
        name = str(properties.get("name", region_id))
        normalized_feature = {
            "type": "Feature",
            "properties": {
                "id": region_id,
                "name": name,
                "parentId": "440800",
                "source": "Alibaba Cloud DataV administrative boundary visualization dataset",
                "sourceCrs": "EPSG:4326",
                "legalNotice": "仅供视频可视化，不作为测绘或法定行政界线依据"
            },
            "geometry": mapping(fixed)
        }
        normalized_collection = {"type": "FeatureCollection", "name": name, "crs": {"type": "name", "properties": {"name": "EPSG:4326"}}, "features": [normalized_feature]}
        parent_features.append(normalized_feature)
        parent_geometries.append(fixed)
        (normalized_dir / f"{region_id}.geojson").write_text(json.dumps(normalized_collection, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        record = {
            "id": region_id,
            "name": name,
            "nameEn": ENGLISH_NAMES[region_id],
            "level": REGION_TYPES[region_id],
            "parentId": "440800",
            "sourceCrs": "EPSG:4326",
            "center": [round(center[0], 7), round(center[1], 7)],
            "labelPoint": label_point,
            "bbox": [west, south, east, north],
            "areaKm2": area_km2,
            "geometryPath": f"data/normalized/{region_id}.geojson",
            "cameraPreset": {
                "longitude": round(center[0], 7), "latitude": round(center[1], 7),
                "height": recommended_height([west, south, east, north]),
                "heading": 0, "pitch": -78, "roll": 0
            },
            "children": [],
            "contentRefs": {
                "research": f"content/research/{region_id}.md",
                "script": f"content/scripts/{region_id}.md",
                "storyboard": f"content/storyboards/{region_id}.json"
            }
        }
        (regions_dir / f"{region_id}.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        (regions_dir / f"{region_id}.timeline.json").write_text(json.dumps(action_timeline(region_id), ensure_ascii=False, indent=2), encoding="utf-8")
        output_index.append(record)
        quality.append({
            "id": region_id, "name": name, "originalValid": original.is_valid,
            "normalizedValid": fixed.is_valid, "geometryType": fixed.geom_type,
            "pointCount": sum(1 for _ in iter_positions(mapping(fixed)["coordinates"])),
            "bbox": record["bbox"], "areaKm2Approx": area_km2
        })

    parent_geometry = unary_union(parent_geometries)
    parent_west, parent_south, parent_east, parent_north = [round(value, 7) for value in parent_geometry.bounds]
    parent_center = [round((parent_west + parent_east) / 2, 7), round((parent_south + parent_north) / 2, 7)]
    parent_label = parent_geometry.representative_point()
    parent_area_km2 = round(parent_geometry.area * 111.0 * 111.0 * math.cos(math.radians(parent_center[1])), 2)
    parent_collection = {
        "type": "FeatureCollection",
        "name": "湛江市",
        "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
        "features": parent_features
    }
    (normalized_dir / "440800.geojson").write_text(json.dumps(parent_collection, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    parent_record = {
        "id": "440800",
        "name": "湛江市",
        "nameEn": ENGLISH_NAMES["440800"],
        "level": "prefecture",
        "parentId": "440000",
        "sourceCrs": "EPSG:4326",
        "center": parent_center,
        "labelPoint": [round(parent_label.x, 7), round(parent_label.y, 7)],
        "bbox": [parent_west, parent_south, parent_east, parent_north],
        "areaKm2": parent_area_km2,
        "geometryPath": "data/normalized/440800.geojson",
        "cameraPreset": {
            "longitude": parent_center[0], "latitude": parent_center[1],
            "height": recommended_height([parent_west, parent_south, parent_east, parent_north]),
            "heading": 0, "pitch": -78, "roll": 0
        },
        "children": sorted(REGION_TYPES.keys()),
        "contentRefs": {
            "research": "content/research/440800.md",
            "script": "content/scripts/440800.md",
            "storyboard": "content/storyboards/440800.json"
        }
    }
    (regions_dir / "440800.json").write_text(json.dumps(parent_record, ensure_ascii=False, indent=2), encoding="utf-8")
    (regions_dir / "440800.timeline.json").write_text(json.dumps(action_timeline("440800"), ensure_ascii=False, indent=2), encoding="utf-8")
    output_index.append(parent_record)
    quality.append({
        "id": "440800", "name": "湛江市", "originalValid": True,
        "normalizedValid": parent_geometry.is_valid, "geometryType": parent_geometry.geom_type,
        "pointCount": sum(1 for feature in parent_features for _ in iter_positions(feature["geometry"]["coordinates"])),
        "bbox": parent_record["bbox"], "areaKm2Approx": parent_area_km2
    })

    output_index.sort(key=lambda item: item["id"])
    (regions_dir / "index.json").write_text(json.dumps(output_index, ensure_ascii=False, indent=2), encoding="utf-8")
    report_path = PROJECT_ROOT / "renders" / "diagnostics" / "geodata-quality.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps({"source": str(input_path.relative_to(PROJECT_ROOT)), "projection": "EPSG:4326", "regions": quality}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Normalized {len(output_index)} regions")
    return 0 if len(output_index) == 10 and all(item["normalizedValid"] for item in quality) else 1


if __name__ == "__main__":
    raise SystemExit(main())
