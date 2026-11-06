#!/usr/bin/env python3
"""Normalize a prefecture-level DataV GeoJSON into parent and child artifacts.

The raw ``*_full`` DataV file contains the prefecture's immediate county-level
children. This script preserves that source, writes one normalized GeoJSON per
child, dissolves the children into a separate parent boundary, and emits the
region records, coverage manifest, and topology report required by the video
pipeline.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import date
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
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "Shapely is required. Run: python -m pip install --target .python-packages -r requirements.txt"
    ) from exc


def iter_positions(value: Any) -> Iterable[tuple[float, float]]:
    if (
        isinstance(value, (list, tuple))
        and len(value) >= 2
        and all(isinstance(number, (int, float)) for number in value[:2])
    ):
        yield float(value[0]), float(value[1])
        return
    if isinstance(value, (list, tuple)):
        for child in value:
            yield from iter_positions(child)


def recommended_height(bbox: list[float], *, parent: bool = False) -> int:
    west, south, east, north = bbox
    latitude = (south + north) / 2
    width_km = abs(east - west) * 111 * math.cos(math.radians(latitude))
    height_km = abs(north - south) * 111
    scale = 2_650 if parent else 2_200
    floor = 240_000 if parent else 55_000
    ceiling = 900_000 if parent else 360_000
    return round(max(floor, min(ceiling, max(width_km, height_km) * scale)))


def area_km2(geometry: Any, latitude: float) -> float:
    return round(geometry.area * 111.0 * 111.0 * math.cos(math.radians(latitude)), 2)


def child_level(name: str) -> tuple[str, str]:
    if name.endswith("区"):
        return "district", "区"
    if name.endswith("市"):
        return "county-city", "县级市"
    if name.endswith("县"):
        return "county", "县"
    return "county-level", "县级行政区"


def timeline(region_id: str, parent_id: str, *, parent: bool) -> dict[str, Any]:
    topic_actions = [
        {"id": "population-01", "time": 8, "duration": 9, "type": "showPopulation", "target": region_id, "easing": "linear"},
        {"id": "economy-01", "time": 17, "duration": 9, "type": "showEconomy", "target": region_id, "easing": "linear"},
        {"id": "history-01", "time": 26, "duration": 9, "type": "showHistory", "target": region_id, "easing": "linear"},
        {"id": "culture-01", "time": 35, "duration": 9, "type": "showCulture", "target": region_id, "easing": "linear"},
        {"id": "summary-01", "time": 44, "duration": 6, "type": "showSummary", "target": region_id, "easing": "linear"},
    ]
    if parent:
        actions = [
            {"id": "camera-approach", "time": 0, "duration": 6, "type": "flyToRegion", "target": region_id, "easing": "cubicInOut"},
            {"id": "parent-outline", "time": 0.3, "duration": 2.4, "type": "revealParentBoundary", "target": region_id, "easing": "cubicInOut"},
            {"id": "child-boundaries", "time": 2.9, "duration": 1.3, "type": "fadeChildBoundaries", "target": region_id, "easing": "cubicInOut"},
            {"id": "selected-fill", "time": 3.4, "duration": 1.2, "type": "fadeSelectedFill", "target": region_id, "easing": "cubicInOut"},
            {"id": "camera-hold", "time": 6, "duration": 44, "type": "holdRegionCamera", "target": region_id, "easing": "linear"},
            *topic_actions,
        ]
    else:
        actions = [
            {"id": "overview-01", "time": 0, "duration": 2, "type": "showParentOverview", "target": parent_id, "easing": "linear"},
            {"id": "camera-01", "time": 0, "duration": 8, "type": "flyToRegion", "target": region_id, "easing": "cubicInOut"},
            {"id": "fill-01", "time": 1.2, "duration": 6.2, "type": "fadeSelectedFill", "target": region_id, "easing": "cubicInOut"},
            {"id": "hold-01", "time": 8, "duration": 42, "type": "holdRegionCamera", "target": region_id, "easing": "linear"},
            *topic_actions,
        ]
    return {"duration": 50, "actions": actions}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("--parent-id", required=True)
    parser.add_argument("--parent-name", required=True)
    parser.add_argument("--parent-name-en", default="")
    parser.add_argument("--expected-children", type=int, required=True)
    parser.add_argument("--editorial-order", default="")
    parser.add_argument("--effective-date", default=str(date.today()))
    parser.add_argument("--source-url", default="https://geo.datav.aliyun.com/areas_v3/bound/")
    parser.add_argument("--source-accessed", default=str(date.today()))
    args = parser.parse_args()

    input_path = (PROJECT_ROOT / args.input).resolve()
    raw = json.loads(input_path.read_text(encoding="utf-8"))
    features = raw.get("features", [])
    if len(features) != args.expected_children:
        raise SystemExit(
            f"Expected {args.expected_children} children for {args.parent_id}, found {len(features)}"
        )

    normalized_dir = PROJECT_ROOT / "data" / "normalized"
    regions_dir = PROJECT_ROOT / "data" / "regions"
    coverage_dir = PROJECT_ROOT / "content"
    diagnostics_dir = PROJECT_ROOT / "renders" / "diagnostics"
    source_dir = PROJECT_ROOT / "data" / "sources" / "boundaries"
    for directory in (normalized_dir, regions_dir, coverage_dir, diagnostics_dir, source_dir):
        directory.mkdir(parents=True, exist_ok=True)

    source_name = "Alibaba Cloud DataV administrative boundary visualization dataset"
    legal_notice = "仅供视频可视化，不作为测绘或法定行政界线依据"
    child_records: list[dict[str, Any]] = []
    normalized_children: list[dict[str, Any]] = []
    child_geometries = []
    quality_children: list[dict[str, Any]] = []

    for feature in features:
        properties = feature.get("properties", {})
        child_id = str(properties.get("adcode") or properties.get("id") or "")
        name = str(properties.get("name") or "").strip()
        if not child_id.isdigit() or not name:
            raise SystemExit(f"Invalid child feature ID/name: {child_id!r} {name!r}")
        original = shape(feature["geometry"])
        fixed = make_valid(original) if not original.is_valid else original
        if fixed.geom_type not in {"Polygon", "MultiPolygon"}:
            fixed = fixed.buffer(0)
        if fixed.is_empty or not fixed.is_valid or fixed.geom_type not in {"Polygon", "MultiPolygon"}:
            raise SystemExit(f"Invalid normalized geometry for {child_id} {name}")

        west, south, east, north = [round(value, 7) for value in fixed.bounds]
        representative = fixed.representative_point()
        center_value = properties.get("centroid") or properties.get("center") or [representative.x, representative.y]
        center = [round(float(center_value[0]), 7), round(float(center_value[1]), 7)]
        label_point = [round(representative.x, 7), round(representative.y, 7)]
        level, level_name = child_level(name)
        normalized_feature = {
            "type": "Feature",
            "properties": {
                "id": child_id,
                "adcode": int(child_id),
                "name": name,
                "parentId": args.parent_id,
                "labelPoint": label_point,
                "source": source_name,
                "sourceCrs": "EPSG:4326",
                "legalNotice": legal_notice,
            },
            "geometry": mapping(fixed),
        }
        normalized_collection = {
            "type": "FeatureCollection",
            "name": name,
            "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
            "features": [normalized_feature],
        }
        (normalized_dir / f"{child_id}.geojson").write_text(
            json.dumps(normalized_collection, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )

        camera_height = recommended_height([west, south, east, north])
        record = {
            "id": child_id,
            "name": name,
            "title": f"地理图说·{name.removesuffix('区').removesuffix('市').removesuffix('县')}",
            "level": level,
            "levelRole": "admin3/locality",
            "levelName": level_name,
            "parentId": args.parent_id,
            "sourceCrs": "EPSG:4326",
            "boundaryInputFormat": "GeoJSON",
            "sourceFiles": [str(input_path.relative_to(PROJECT_ROOT)).replace("\\", "/")],
            "center": center,
            "labelPoint": label_point,
            "bbox": [west, south, east, north],
            "areaKm2": area_km2(fixed, center[1]),
            "geometryPath": f"data/normalized/{child_id}.geojson",
            "cameraPreset": {
                "longitude": center[0],
                "latitude": center[1],
                "height": camera_height,
                "heading": 0,
                "pitch": -66,
                "roll": 0,
            },
            "children": [],
            "childIds": [],
            "contentRefs": {
                "research": f"content/research/{child_id}.md",
                "script": f"content/scripts/{child_id}.md",
                "storyboard": f"content/storyboards/{child_id}.json",
            },
        }
        (regions_dir / f"{child_id}.json").write_text(
            json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (regions_dir / f"{child_id}.timeline.json").write_text(
            json.dumps(timeline(child_id, args.parent_id, parent=False), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        child_records.append(record)
        normalized_children.append(normalized_feature)
        child_geometries.append(fixed)
        quality_children.append(
            {
                "id": child_id,
                "name": name,
                "originalValid": original.is_valid,
                "normalizedValid": fixed.is_valid,
                "geometryType": fixed.geom_type,
                "pointCount": sum(1 for _ in iter_positions(mapping(fixed)["coordinates"])),
                "bbox": record["bbox"],
                "areaKm2Approx": record["areaKm2"],
            }
        )

    child_by_id = {record["id"]: record for record in child_records}
    editorial_order = [item.strip() for item in args.editorial_order.split(",") if item.strip()]
    if not editorial_order:
        editorial_order = [record["id"] for record in child_records]
    if set(editorial_order) != set(child_by_id) or len(editorial_order) != len(child_records):
        raise SystemExit("--editorial-order must contain every child ID exactly once")

    parent_geometry = unary_union(child_geometries)
    if parent_geometry.is_empty or not parent_geometry.is_valid:
        raise SystemExit(f"Dissolved parent geometry for {args.parent_id} is invalid")
    parent_west, parent_south, parent_east, parent_north = [
        round(value, 7) for value in parent_geometry.bounds
    ]
    parent_center = [
        round((parent_west + parent_east) / 2, 7),
        round((parent_south + parent_north) / 2, 7),
    ]
    parent_label_raw = parent_geometry.representative_point()
    parent_label = [round(parent_label_raw.x, 7), round(parent_label_raw.y, 7)]
    parent_feature = {
        "type": "Feature",
        "properties": {
            "id": args.parent_id,
            "adcode": int(args.parent_id),
            "name": args.parent_name,
            "parentId": "440000",
            "labelPoint": parent_label,
            "source": source_name,
            "sourceMethod": "union-of-child-datav-features",
            "sourceCrs": "EPSG:4326",
            "legalNotice": legal_notice,
        },
        "geometry": mapping(parent_geometry),
    }
    parent_collection = {
        "type": "FeatureCollection",
        "name": args.parent_name,
        "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
        "features": [parent_feature],
    }
    child_collection = {
        "type": "FeatureCollection",
        "name": f"{args.parent_name}县级行政区",
        "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
        "features": normalized_children,
    }
    (normalized_dir / f"{args.parent_id}.geojson").write_text(
        json.dumps(parent_collection, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    (normalized_dir / f"{args.parent_id}-children.geojson").write_text(
        json.dumps(child_collection, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    parent_record = {
        "id": args.parent_id,
        "name": args.parent_name,
        "nameEn": args.parent_name_en,
        "title": f"地理图说·{args.parent_name.removesuffix('市')}",
        "level": "prefecture",
        "levelRole": "admin2",
        "levelName": "地级市",
        "parentId": "440000",
        "childIds": editorial_order,
        "children": editorial_order,
        "childRegions": [
            {
                "id": child_by_id[child_id]["id"],
                "name": child_by_id[child_id]["name"],
                "labelPoint": child_by_id[child_id]["labelPoint"],
                "bbox": child_by_id[child_id]["bbox"],
                "cameraPreset": child_by_id[child_id]["cameraPreset"],
            }
            for child_id in editorial_order
        ],
        "sourceCrs": "EPSG:4326",
        "boundaryInputFormat": "GeoJSON",
        "sourceFiles": [str(input_path.relative_to(PROJECT_ROOT)).replace("\\", "/")],
        "parentBoundaryMethod": "union-of-child-datav-features",
        "center": parent_center,
        "labelPoint": parent_label,
        "bbox": [parent_west, parent_south, parent_east, parent_north],
        "areaKm2": area_km2(parent_geometry, parent_center[1]),
        "geometryPath": f"data/normalized/{args.parent_id}.geojson",
        "childGeometryPath": f"data/normalized/{args.parent_id}-children.geojson",
        "coverageManifestPath": f"content/coverage-manifest-{args.parent_id}.json",
        "presentationMode": "parent-topic",
        "cameraPreset": {
            "longitude": parent_center[0],
            "latitude": parent_center[1],
            "height": recommended_height([parent_west, parent_south, parent_east, parent_north], parent=True),
            "heading": 0,
            "pitch": -64,
            "roll": 0,
        },
        "contentRefs": {
            "research": f"content/research/{args.parent_id}.md",
            "script": f"content/scripts/{args.parent_id}.md",
            "storyboard": f"content/storyboards/{args.parent_id}.json",
        },
    }
    (regions_dir / f"{args.parent_id}.json").write_text(
        json.dumps(parent_record, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (regions_dir / f"{args.parent_id}.timeline.json").write_text(
        json.dumps(timeline(args.parent_id, args.parent_id, parent=True), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    coverage = {
        "parentId": args.parent_id,
        "parentName": args.parent_name,
        "parentLevelRole": "admin2",
        "childLevelRole": "admin3/locality",
        "effectiveDate": args.effective_date,
        "classificationPolicy": "statutory-county-level-units-only; functional-new-areas-excluded",
        "boundarySource": source_name,
        "boundarySourceUrl": args.source_url,
        "editorialOrder": editorial_order,
        "children": [
            {
                "id": child_by_id[child_id]["id"],
                "name": child_by_id[child_id]["name"],
                "included": True,
                "classification": "statutory-immediate-child",
                "editorialOrder": index + 1,
            }
            for index, child_id in enumerate(editorial_order)
        ],
        "excludedFunctionalAreas": [
            {
                "name": "茂名滨海新区等功能区",
                "reason": "不属于法定县级行政区，不与区、县级市并列进入主覆盖清单",
            }
        ],
    }
    (coverage_dir / f"coverage-manifest-{args.parent_id}.json").write_text(
        json.dumps(coverage, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    sum_area = sum(geometry.area for geometry in child_geometries)
    overlap_area = max(0.0, sum_area - parent_geometry.area)
    topology_report = {
        "parentId": args.parent_id,
        "source": str(input_path.relative_to(PROJECT_ROOT)).replace("\\", "/"),
        "sourceUrl": args.source_url,
        "sourceCrs": "EPSG:4326",
        "sourceAccessed": args.source_accessed,
        "expectedChildren": args.expected_children,
        "actualChildren": len(child_records),
        "parentBoundaryMethod": "union-of-child-datav-features",
        "parentValid": parent_geometry.is_valid,
        "unexplainedOverlapAreaDegrees2": overlap_area,
        "coverageCompleteByDissolve": True,
        "visualizationNotice": legal_notice,
        "children": quality_children,
    }
    (diagnostics_dir / f"{args.parent_id}-geodata-quality.json").write_text(
        json.dumps(topology_report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    source_record = {
        "id": f"boundary-{args.parent_id}-datav",
        "parentId": args.parent_id,
        "title": f"{args.parent_name}县级行政区边界",
        "publisher": "Alibaba Cloud DataV",
        "sourceUrl": args.source_url,
        "accessedAt": args.source_accessed,
        "sourceFormat": "GeoJSON",
        "sourceCrs": "EPSG:4326",
        "sourceFiles": [str(input_path.relative_to(PROJECT_ROOT)).replace("\\", "/")],
        "usage": "administrative-boundary-visualization",
        "legalNotice": legal_notice,
    }
    (source_dir / f"{args.parent_id}.json").write_text(
        json.dumps(source_record, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    index_path = regions_dir / "index.json"
    existing = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
    replaced_ids = {args.parent_id, *child_by_id.keys()}
    merged = [record for record in existing if str(record.get("id")) not in replaced_ids]
    merged.extend([parent_record, *child_records])
    merged.sort(key=lambda record: str(record["id"]))
    index_path.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")

    print(
        f"PREFECTURE_READY {args.parent_id} children={len(child_records)} "
        f"parentAreaKm2={parent_record['areaKm2']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
