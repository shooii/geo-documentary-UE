#!/usr/bin/env python3
"""Import polygon SHP boundaries, reproject to EPSG:4326, and write Cesium-ready QA artifacts."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[4]
LOCAL_PACKAGES = PROJECT_ROOT / ".python-packages"
if LOCAL_PACKAGES.exists():
    sys.path.insert(0, str(LOCAL_PACKAGES))

try:
    import shapefile
    from pyproj import CRS, Geod, Transformer
    from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, mapping, shape
    from shapely.ops import transform, unary_union
    from shapely.validation import make_valid
except ImportError as exc:  # pragma: no cover - actionable runtime failure
    raise SystemExit(
        "SHP support requires pyshp, pyproj, and shapely. "
        "Run: python -m pip install --target .python-packages -r requirements.txt"
    ) from exc


def project_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else PROJECT_ROOT / path


def read_json(path: Path | None) -> dict[str, str]:
    if path is None:
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or not all(isinstance(key, str) and isinstance(value, str) for key, value in raw.items()):
        raise SystemExit(f"Name map must be a string-to-string JSON object: {path}")
    return raw


def polygonal(value: Any):
    fixed = make_valid(value) if not value.is_valid else value
    if isinstance(fixed, (Polygon, MultiPolygon)):
        return fixed
    if isinstance(fixed, GeometryCollection):
        polygons = [item for item in fixed.geoms if isinstance(item, (Polygon, MultiPolygon))]
        if polygons:
            return unary_union(polygons)
    buffered = fixed.buffer(0)
    if not isinstance(buffered, (Polygon, MultiPolygon)) or buffered.is_empty:
        raise ValueError(f"Geometry could not be normalized to polygonal form: {fixed.geom_type}")
    return buffered


def point_count(geometry: Any) -> int:
    if isinstance(geometry, Polygon):
        return len(geometry.exterior.coords) + sum(len(ring.coords) for ring in geometry.interiors)
    if isinstance(geometry, MultiPolygon):
        return sum(point_count(item) for item in geometry.geoms)
    return 0


def area_km2(geometry: Any, geod: Geod) -> float:
    area, _ = geod.geometry_area_perimeter(geometry)
    return abs(area) / 1_000_000


def camera_height(bounds: tuple[float, float, float, float]) -> int:
    west, south, east, north = bounds
    latitude = (south + north) / 2
    width_km = abs(east - west) * 111.32 * math.cos(math.radians(latitude))
    height_km = abs(north - south) * 110.57
    return round(max(24_000, min(180_000, max(width_km, height_km) * 2_250)))


def child_camera_height(bounds: tuple[float, float, float, float]) -> int:
    west, south, east, north = bounds
    latitude = (south + north) / 2
    width_km = abs(east - west) * 111.32 * math.cos(math.radians(latitude))
    height_km = abs(north - south) * 110.57
    return round(max(11_500, min(42_000, max(width_km, height_km) * 2_350)))


def relative(path: Path) -> str:
    return path.relative_to(PROJECT_ROOT).as_posix()


def has_private_use(value: str) -> bool:
    return any("\ue000" <= char <= "\uf8ff" for char in value)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="Input .shp path, absolute or relative to project root")
    parser.add_argument("--region-id", required=True)
    parser.add_argument("--region-name", required=True)
    parser.add_argument("--parent-id", required=True)
    parser.add_argument("--level-role", default="township")
    parser.add_argument("--level-name", default="镇")
    parser.add_argument("--id-field", default="PAC")
    parser.add_argument("--name-field", default="NAME")
    parser.add_argument("--id-prefix", help="Import only records whose ID field starts with this prefix")
    parser.add_argument("--encoding", help="Override DBF encoding when no trustworthy .cpg is available")
    parser.add_argument("--source-label", default="User-provided SHP boundary dataset")
    parser.add_argument("--name-map", help="Optional JSON mapping feature ID to corrected display name")
    parser.add_argument("--expected-children", type=int)
    parser.add_argument("--simplify-meters", type=float, default=0.8)
    parser.add_argument("--duration", type=float, default=50.0)
    args = parser.parse_args()

    shp_path = project_path(args.input)
    if shp_path.suffix.lower() != ".shp" or not shp_path.exists():
        raise SystemExit(f"Input SHP does not exist: {shp_path}")
    sidecars = {suffix: shp_path.with_suffix(suffix) for suffix in [".shp", ".shx", ".dbf", ".prj"]}
    missing = [str(path) for path in sidecars.values() if not path.exists()]
    if missing:
        raise SystemExit(f"Incomplete SHP dataset; missing: {', '.join(missing)}")

    cpg_path = shp_path.with_suffix(".cpg")
    encoding = args.encoding or (cpg_path.read_text(encoding="ascii", errors="ignore").strip() if cpg_path.exists() else "utf-8")
    encoding_source = "command-line" if args.encoding else ("cpg" if cpg_path.exists() else "default")
    source_crs = CRS.from_wkt(sidecars[".prj"].read_text(encoding="utf-8-sig"))
    transformer = Transformer.from_crs(source_crs, "EPSG:4326", always_xy=True)
    geod = Geod(ellps="WGS84")
    name_map = read_json(project_path(args.name_map) if args.name_map else None)

    reader = shapefile.Reader(str(shp_path), encoding=encoding)
    if reader.shapeType not in {shapefile.POLYGON, shapefile.POLYGONM, shapefile.POLYGONZ}:
        raise SystemExit(f"Only polygon SHP boundary data is supported; found {reader.shapeTypeName}")
    field_names = {field[0] for field in reader.fields[1:]}
    for field in [args.id_field, args.name_field]:
        if field not in field_names:
            raise SystemExit(f"Required DBF field {field!r} is missing; fields: {sorted(field_names)}")

    features: list[dict[str, Any]] = []
    geometries = []
    quality: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    private_use_errors: list[str] = []
    filtered_source_bbox = [math.inf, math.inf, -math.inf, -math.inf]

    for index, shape_record in enumerate(reader.iterShapeRecords()):
        record = shape_record.record.as_dict()
        feature_id = str(record.get(args.id_field, "")).strip()
        if args.id_prefix and not feature_id.startswith(args.id_prefix):
            continue
        raw_name = str(record.get(args.name_field, "")).strip()
        name = name_map.get(feature_id, raw_name)
        if not feature_id:
            raise SystemExit(f"Record {index} has no value in {args.id_field}")
        if feature_id in seen_ids:
            raise SystemExit(f"Duplicate feature ID {feature_id}")
        seen_ids.add(feature_id)
        if not name:
            raise SystemExit(f"Record {index} ({feature_id}) has no display name")
        if has_private_use(name):
            private_use_errors.append(f"{feature_id}:{name.encode('unicode_escape').decode('ascii')}")

        source_geometry = polygonal(shape(shape_record.shape.__geo_interface__))
        source_bounds = source_geometry.bounds
        filtered_source_bbox = [
            min(filtered_source_bbox[0], source_bounds[0]),
            min(filtered_source_bbox[1], source_bounds[1]),
            max(filtered_source_bbox[2], source_bounds[2]),
            max(filtered_source_bbox[3], source_bounds[3])
        ]
        if args.simplify_meters > 0:
            source_geometry = polygonal(source_geometry.simplify(args.simplify_meters, preserve_topology=True))
        geometry = polygonal(transform(transformer.transform, source_geometry))
        representative = geometry.representative_point()
        child_bbox = [round(value, 7) for value in geometry.bounds]
        child_camera = {
            "longitude": round(representative.x, 7),
            "latitude": round(representative.y, 7),
            "height": child_camera_height(geometry.bounds),
            "heading": 0,
            "pitch": -64,
            "roll": 0
        }
        feature = {
            "type": "Feature",
            "properties": {
                "id": feature_id,
                "adcode": feature_id,
                "name": name,
                "parentId": args.region_id,
                "labelPoint": [round(representative.x, 7), round(representative.y, 7)],
                "bbox": child_bbox,
                "cameraPreset": child_camera,
                "source": args.source_label,
                "sourceCrs": source_crs.to_string(),
                "sourceRecord": index,
                "legalNotice": "用于地理图说可视化；法定效力以主管部门正式成果为准"
            },
            "geometry": mapping(geometry)
        }
        features.append(feature)
        geometries.append(geometry)
        quality.append({
            "id": feature_id,
            "name": name,
            "sourceRecord": index,
            "valid": geometry.is_valid,
            "geometryType": geometry.geom_type,
            "pointCount": point_count(geometry),
            "areaKm2": round(area_km2(geometry, geod), 4),
            "bbox": child_bbox,
            "cameraPreset": child_camera
        })

    if private_use_errors:
        raise SystemExit(
            "DBF names contain Unicode private-use characters. Add verified corrections with --name-map: "
            + ", ".join(private_use_errors)
        )
    if not features:
        filter_detail = f" matching --id-prefix {args.id_prefix!r}" if args.id_prefix else ""
        raise SystemExit(f"No polygon records found{filter_detail}")
    if args.expected_children is not None and len(features) != args.expected_children:
        raise SystemExit(f"Expected {args.expected_children} child features, found {len(features)}")

    parent_geometry = polygonal(unary_union(geometries))
    parent_label = parent_geometry.representative_point()
    west, south, east, north = parent_geometry.bounds
    center = [(west + east) / 2, (south + north) / 2]
    sum_area = sum(item.area for item in geometries)
    overlap_ratio = max(0.0, (sum_area - parent_geometry.area) / max(parent_geometry.area, 1e-12))
    if overlap_ratio > 0.005:
        raise SystemExit(f"Child polygon overlap ratio {overlap_ratio:.3%} exceeds 0.5%")

    normalized_dir = PROJECT_ROOT / "data" / "normalized"
    regions_dir = PROJECT_ROOT / "data" / "regions"
    diagnostics_dir = PROJECT_ROOT / "renders" / "diagnostics"
    content_dir = PROJECT_ROOT / "content"
    for directory in [normalized_dir, regions_dir, diagnostics_dir, content_dir]:
        directory.mkdir(parents=True, exist_ok=True)

    child_path = normalized_dir / f"{args.region_id}-children.geojson"
    parent_path = normalized_dir / f"{args.region_id}.geojson"
    coverage_path = content_dir / f"coverage-manifest-{args.region_id}.json"
    region_path = regions_dir / f"{args.region_id}.json"
    timeline_path = regions_dir / f"{args.region_id}.timeline.json"
    report_path = diagnostics_dir / f"{args.region_id}-shapefile-import.json"

    child_collection = {
        "type": "FeatureCollection",
        "name": f"{args.region_name}直接下级边界",
        "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
        "features": features
    }
    parent_feature = {
        "type": "Feature",
        "properties": {
            "id": args.region_id,
            "adcode": args.region_id,
            "name": args.region_name,
            "parentId": args.parent_id,
            "source": args.source_label,
            "sourceCrs": source_crs.to_string(),
            "parentDerivation": "union-of-child-shapefile-features",
            "legalNotice": "父级外轮廓由所提供的直接下级 SHP 面要素融合生成"
        },
        "geometry": mapping(parent_geometry)
    }
    parent_collection = {
        "type": "FeatureCollection",
        "name": args.region_name,
        "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
        "features": [parent_feature]
    }
    child_path.write_text(json.dumps(child_collection, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    parent_path.write_text(json.dumps(parent_collection, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    children = [
        {"id": feature["properties"]["id"], "name": feature["properties"]["name"], "included": True, "reason": "SHP feature"}
        for feature in features
    ]
    coverage = {
        "parentId": args.region_id,
        "parentName": args.region_name,
        "levelRole": args.level_role,
        "officialLevelName": args.level_name,
        "childRole": "administrative-village",
        "source": args.source_label,
        "effectiveDate": None,
        "completeImmediateChildCoverage": True,
        "children": children
    }
    coverage_path.write_text(json.dumps(coverage, ensure_ascii=False, indent=2), encoding="utf-8")

    height = camera_height(parent_geometry.bounds)
    region_record = {
        "id": args.region_id,
        "name": args.region_name,
        "title": f"地理图说·{args.region_name}",
        "levelRole": args.level_role,
        "levelName": args.level_name,
        "parentId": args.parent_id,
        "childIds": [item["id"] for item in children],
        "childRegions": [
            {
                "id": feature["properties"]["id"],
                "name": feature["properties"]["name"],
                "labelPoint": feature["properties"]["labelPoint"],
                "bbox": feature["properties"]["bbox"],
                "cameraPreset": feature["properties"]["cameraPreset"]
            }
            for feature in features
        ],
        "sourceCrs": source_crs.to_string(),
        "center": [round(center[0], 7), round(center[1], 7)],
        "labelPoint": [round(parent_label.x, 7), round(parent_label.y, 7)],
        "bbox": [round(value, 7) for value in parent_geometry.bounds],
        "areaKm2": round(area_km2(parent_geometry, geod), 4),
        "geometryPath": relative(parent_path),
        "childGeometryPath": relative(child_path),
        "coverageManifestPath": relative(coverage_path),
        "presentationMode": "parent-topic",
        "boundaryInputFormat": "ESRI Shapefile",
        "sourceFiles": [relative(path) for path in sidecars.values()] + ([relative(cpg_path)] if cpg_path.exists() else []),
        "cameraPreset": {
            "longitude": round(center[0], 7),
            "latitude": round(center[1], 7),
            "height": height,
            "heading": 0,
            "pitch": -64,
            "roll": 0
        },
        "contentRefs": {
            "research": f"content/research/{args.region_id}.md",
            "script": f"content/scripts/{args.region_id}.md",
            "storyboard": f"content/storyboards/{args.region_id}.json"
        }
    }
    region_path.write_text(json.dumps(region_record, ensure_ascii=False, indent=2), encoding="utf-8")
    timeline = {
        "duration": args.duration,
        "actions": [
            {"id": "camera-approach", "time": 0, "duration": 6, "type": "flyToRegion", "target": args.region_id, "easing": "cubicInOut"},
            {"id": "parent-outline", "time": 0.3, "duration": 2.4, "type": "revealParentBoundary", "target": args.region_id, "easing": "cubicInOut"},
            {"id": "child-boundaries", "time": 2.9, "duration": 1.3, "type": "fadeChildBoundaries", "target": args.region_id, "easing": "cubicInOut"},
            {"id": "selected-fill", "time": 3.4, "duration": 1.2, "type": "fadeSelectedFill", "target": args.region_id, "easing": "cubicInOut"},
            {"id": "camera-hold", "time": 6, "duration": max(0, args.duration - 6), "type": "holdRegionCamera", "target": args.region_id, "easing": "linear"}
        ]
    }
    timeline_path.write_text(json.dumps(timeline, ensure_ascii=False, indent=2), encoding="utf-8")

    report = {
        "ok": all(item["valid"] for item in quality),
        "input": relative(shp_path),
        "inputFormat": "ESRI Shapefile",
        "requiredSidecars": [relative(path) for path in sidecars.values()],
        "encoding": encoding,
        "encodingSource": encoding_source,
        "idPrefixFilter": args.id_prefix,
        "sourceCrs": source_crs.to_string(),
        "outputCrs": "EPSG:4326",
        "featureCount": len(features),
        "expectedFeatureCount": args.expected_children,
        "parentDerivation": "union-of-child-shapefile-features",
        "overlapRatio": overlap_ratio,
        "parentValid": parent_geometry.is_valid,
        "parentAreaKm2": round(area_km2(parent_geometry, geod), 4),
        "sourceDatasetBbox": list(reader.bbox),
        "filteredSourceBbox": filtered_source_bbox,
        "outputBbox": region_record["bbox"],
        "nameCorrections": name_map,
        "features": quality,
        "outputs": [relative(parent_path), relative(child_path), relative(region_path), relative(timeline_path), relative(coverage_path)]
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": report["ok"], "regionId": args.region_id, "features": len(features), "report": relative(report_path)}, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
