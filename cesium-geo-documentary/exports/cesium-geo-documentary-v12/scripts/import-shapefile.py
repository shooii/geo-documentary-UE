#!/usr/bin/env python3
"""Import polygon SHP boundaries, reproject to EPSG:4326, and write Cesium-ready QA artifacts."""

from __future__ import annotations

import argparse
import json
import math
import re
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
    from shapely import coverage_is_valid, coverage_simplify
    from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, mapping, shape
    from shapely.ops import transform, unary_union
    from shapely.validation import make_valid
except ImportError as exc:  # pragma: no cover - actionable runtime failure
    raise SystemExit(
        "SHP support requires pyshp, pyproj, and Shapely 2.1 or newer. "
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


def read_existing_object(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise SystemExit(f"Expected a JSON object: {path}")
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


def polygon_part_count(geometry: Any) -> int:
    if isinstance(geometry, Polygon):
        return 1
    if isinstance(geometry, MultiPolygon):
        return len(geometry.geoms)
    return 0


def polygon_hole_metrics(geometry: Any) -> tuple[int, float]:
    polygons = [geometry] if isinstance(geometry, Polygon) else list(geometry.geoms)
    hole_count = 0
    hole_area = 0.0
    for polygon in polygons:
        hole_count += len(polygon.interiors)
        hole_area += sum(Polygon(ring).area for ring in polygon.interiors)
    return hole_count, hole_area


def simplify_polygon_coverage(geometries: list[Any], tolerance: float) -> tuple[list[Any], dict[str, Any]]:
    """Simplify a complete polygon coverage without breaking shared edges.

    Shapely's ordinary per-feature ``simplify`` can move the two copies of a
    shared edge independently, creating hairline gaps and overlaps. Coverage
    simplification processes the full set together. If the input is not a
    valid coverage, the safe fallback is to retain the original geometries.
    """

    raw_geometries = [polygonal(item) for item in geometries]
    raw_union = polygonal(unary_union(raw_geometries))
    raw_valid = bool(coverage_is_valid(raw_geometries))

    if tolerance <= 0:
        output_geometries = raw_geometries
        mode = "disabled"
        applied = False
    elif raw_valid:
        output_geometries = [
            polygonal(item)
            for item in coverage_simplify(raw_geometries, tolerance, simplify_boundary=False)
        ]
        mode = "coverage-preserving"
        applied = True
    else:
        output_geometries = raw_geometries
        mode = "skipped-invalid-coverage"
        applied = False

    output_valid = bool(coverage_is_valid(output_geometries))
    if raw_valid and not output_valid:
        raise RuntimeError("Coverage simplification unexpectedly produced an invalid polygon coverage")

    output_union = polygonal(unary_union(output_geometries))
    raw_hole_count, raw_hole_area = polygon_hole_metrics(raw_union)
    output_hole_count, output_hole_area = polygon_hole_metrics(output_union)
    return output_geometries, {
        "requestedTolerance": tolerance,
        "mode": mode,
        "applied": applied,
        "rawCoverageValid": raw_valid,
        "outputCoverageValid": output_valid,
        "rawPointCount": sum(point_count(item) for item in raw_geometries),
        "outputPointCount": sum(point_count(item) for item in output_geometries),
        "rawPartCount": sum(polygon_part_count(item) for item in raw_geometries),
        "outputPartCount": sum(polygon_part_count(item) for item in output_geometries),
        "rawSumAreaMinusUnionAreaSourceUnits2": max(
            0.0, sum(item.area for item in raw_geometries) - raw_union.area
        ),
        "outputSumAreaMinusUnionAreaSourceUnits2": max(
            0.0, sum(item.area for item in output_geometries) - output_union.area
        ),
        "rawUnionHoleCount": raw_hole_count,
        "rawUnionHoleAreaSourceUnits2": raw_hole_area,
        "outputUnionHoleCount": output_hole_count,
        "outputUnionHoleAreaSourceUnits2": output_hole_area,
        "outerUnionSymmetricDifferenceSourceUnits2": raw_union.symmetric_difference(output_union).area
    }


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
    parser.add_argument("--id-regex", help="Import only records whose full ID matches this regular expression")
    parser.add_argument("--encoding", help="Override DBF encoding when no trustworthy .cpg is available")
    parser.add_argument("--source-label", default="User-provided SHP boundary dataset")
    parser.add_argument("--name-map", help="Optional JSON mapping feature ID to corrected display name")
    parser.add_argument("--expected-children", type=int)
    parser.add_argument("--title", help="Override the visible hierarchical video title")
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
    try:
        id_pattern = re.compile(args.id_regex) if args.id_regex else None
    except re.error as exc:
        raise SystemExit(f"Invalid --id-regex: {exc}") from exc

    reader = shapefile.Reader(str(shp_path), encoding=encoding, encodingErrors="replace")
    if reader.shapeType not in {shapefile.POLYGON, shapefile.POLYGONM, shapefile.POLYGONZ}:
        raise SystemExit(f"Only polygon SHP boundary data is supported; found {reader.shapeTypeName}")
    field_names = {field[0] for field in reader.fields[1:]}
    for field in [args.id_field, args.name_field]:
        if field not in field_names:
            raise SystemExit(f"Required DBF field {field!r} is missing; fields: {sorted(field_names)}")

    selected_records: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    private_use_errors: list[str] = []
    filtered_source_bbox = [math.inf, math.inf, -math.inf, -math.inf]

    for index, shape_record in enumerate(reader.iterShapeRecords()):
        record = shape_record.record.as_dict()
        feature_id = str(record.get(args.id_field, "")).strip()
        if args.id_prefix and not feature_id.startswith(args.id_prefix):
            continue
        if id_pattern and not id_pattern.fullmatch(feature_id):
            continue
        raw_name = str(record.get(args.name_field, "")).strip()
        name = name_map.get(feature_id, raw_name)
        if "\ufffd" in feature_id or "\ufffd" in raw_name or "\ufffd" in name:
            raise SystemExit(
                f"Selected record {index} ({feature_id}) contains an undecodable replacement character; "
                "verify --encoding or provide a corrected --name-map"
            )
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
        selected_records.append({
            "id": feature_id,
            "name": name,
            "sourceRecord": index,
            "sourceGeometry": source_geometry
        })

    if private_use_errors:
        raise SystemExit(
            "DBF names contain Unicode private-use characters. Add verified corrections with --name-map: "
            + ", ".join(private_use_errors)
        )
    if not selected_records:
        filters = []
        if args.id_prefix:
            filters.append(f"--id-prefix {args.id_prefix!r}")
        if args.id_regex:
            filters.append(f"--id-regex {args.id_regex!r}")
        filter_detail = f" matching {' and '.join(filters)}" if filters else ""
        raise SystemExit(f"No polygon records found{filter_detail}")
    if args.expected_children is not None and len(selected_records) != args.expected_children:
        raise SystemExit(f"Expected {args.expected_children} child features, found {len(selected_records)}")

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

    existing_region = read_existing_object(region_path)
    existing_coverage = read_existing_object(coverage_path)
    existing_supplemental = existing_region.get("supplementalUnits") or existing_coverage.get("supplementalUnits") or []
    supplemental_by_id: dict[str, dict[str, Any]] = {}
    for item in existing_supplemental:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        item_id = str(item["id"])
        supplemental_by_id[item_id] = {
            **item,
            "id": item_id,
            "unitRole": item.get("unitRole") or "supplemental-management-unit",
            "classification": item.get("classification") or "supplemental-management-unit"
        }

    raw_source_geometries = [item["sourceGeometry"] for item in selected_records]
    simplified_source_geometries, simplification = simplify_polygon_coverage(
        raw_source_geometries, args.simplify_meters
    )

    features: list[dict[str, Any]] = []
    geometries: list[Any] = []
    quality: list[dict[str, Any]] = []
    for selected, raw_source_geometry, source_geometry in zip(
        selected_records, raw_source_geometries, simplified_source_geometries, strict=True
    ):
        feature_id = selected["id"]
        name = selected["name"]
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
        properties = {
            "id": feature_id,
            "adcode": feature_id,
            "name": name,
            "parentId": args.region_id,
            "labelPoint": [round(representative.x, 7), round(representative.y, 7)],
            "bbox": child_bbox,
            "cameraPreset": child_camera,
            "source": args.source_label,
            "sourceCrs": source_crs.to_string(),
            "sourceRecord": selected["sourceRecord"],
            "legalNotice": "用于地理图说可视化；法定效力以主管部门正式成果为准"
        }
        supplemental = supplemental_by_id.get(feature_id)
        if supplemental:
            properties["unitRole"] = supplemental["unitRole"]
            properties["classification"] = supplemental["classification"]
        features.append({
            "type": "Feature",
            "properties": properties,
            "geometry": mapping(geometry)
        })
        geometries.append(geometry)
        quality.append({
            "id": feature_id,
            "name": name,
            "sourceRecord": selected["sourceRecord"],
            "valid": geometry.is_valid,
            "geometryType": geometry.geom_type,
            "partCount": polygon_part_count(geometry),
            "holeCount": polygon_hole_metrics(geometry)[0],
            "rawSourcePointCount": point_count(raw_source_geometry),
            "outputSourcePointCount": point_count(source_geometry),
            "pointCount": point_count(geometry),
            "areaKm2": round(area_km2(geometry, geod), 4),
            "bbox": child_bbox,
            "cameraPreset": child_camera
        })

    parent_geometry = polygonal(unary_union(geometries))
    parent_label = parent_geometry.representative_point()
    west, south, east, north = parent_geometry.bounds
    center = [(west + east) / 2, (south + north) / 2]
    sum_area = sum(item.area for item in geometries)
    overlap_ratio = max(0.0, (sum_area - parent_geometry.area) / max(parent_geometry.area, 1e-12))
    if overlap_ratio > 0.005:
        raise SystemExit(f"Child polygon overlap ratio {overlap_ratio:.3%} exceeds 0.5%")

    boundary_unit_ids = [feature["properties"]["id"] for feature in features]
    existing_tour_ids = existing_region.get("tourChildIds") or existing_region.get("childIds") or [
        item.get("id") for item in existing_coverage.get("children", []) if isinstance(item, dict)
    ]
    tour_child_ids = [
        str(item_id)
        for item_id in existing_tour_ids
        if str(item_id) in boundary_unit_ids and str(item_id) not in supplemental_by_id
    ]
    if not tour_child_ids:
        tour_child_ids = [item_id for item_id in boundary_unit_ids if item_id not in supplemental_by_id]

    feature_by_id = {feature["properties"]["id"]: feature for feature in features}
    existing_coverage_children = {
        str(item["id"]): item
        for item in existing_coverage.get("children", [])
        if isinstance(item, dict) and item.get("id")
    }
    children = []
    for child_id in tour_child_ids:
        properties = feature_by_id[child_id]["properties"]
        children.append({
            **existing_coverage_children.get(child_id, {}),
            "id": child_id,
            "name": properties["name"],
            "included": True,
            "reason": "SHP feature"
        })

    supplemental_units = []
    for unit_id in boundary_unit_ids:
        if unit_id not in supplemental_by_id:
            continue
        properties = feature_by_id[unit_id]["properties"]
        supplemental_units.append({
            **supplemental_by_id[unit_id],
            "id": unit_id,
            "name": properties["name"],
            "unitRole": properties["unitRole"],
            "classification": properties["classification"],
            "includedInTour": False
        })

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

    boundary_units = []
    for feature in features:
        properties = feature["properties"]
        unit = {
            "id": properties["id"],
            "name": properties["name"],
            "unitRole": properties.get("unitRole", "administrative-village")
        }
        if properties.get("classification"):
            unit["classification"] = properties["classification"]
        boundary_units.append(unit)

    coverage = {
        **existing_coverage,
        "parentId": args.region_id,
        "parentName": args.region_name,
        "levelRole": args.level_role,
        "officialLevelName": args.level_name,
        "childRole": "administrative-village",
        "source": args.source_label,
        "effectiveDate": existing_coverage.get("effectiveDate"),
        "completeImmediateChildCoverage": existing_coverage.get(
            "completeImmediateChildCoverage", not bool(existing_coverage.get("missingCurrentChildren"))
        ),
        "coverageScope": (
            f"{len(boundary_unit_ids)} reliable boundary units: "
            f"{len(tour_child_ids)} tour children and {len(supplemental_units)} supplemental management units"
        ),
        "tourChildIds": tour_child_ids,
        "boundaryUnitIds": boundary_unit_ids,
        "children": children,
        "boundaryUnits": boundary_units,
        "supplementalUnits": supplemental_units
    }
    coverage_path.write_text(json.dumps(coverage, ensure_ascii=False, indent=2), encoding="utf-8")

    height = camera_height(parent_geometry.bounds)
    existing_child_regions = {
        str(item["id"]): item
        for item in existing_region.get("childRegions", [])
        if isinstance(item, dict) and item.get("id")
    }
    child_regions = []
    for feature in features:
        properties = feature["properties"]
        child_record = {
            **existing_child_regions.get(properties["id"], {}),
            "id": properties["id"],
            "name": properties["name"],
            "labelPoint": properties["labelPoint"],
            "bbox": properties["bbox"],
            "cameraPreset": properties["cameraPreset"]
        }
        if properties.get("unitRole"):
            child_record["unitRole"] = properties["unitRole"]
        if properties.get("classification"):
            child_record["classification"] = properties["classification"]
        child_regions.append(child_record)

    default_content_refs = {
        "research": f"content/research/{args.region_id}.md",
        "script": f"content/scripts/{args.region_id}.md",
        "storyboard": f"content/storyboards/{args.region_id}.json"
    }
    parent_camera = {
        "longitude": round(center[0], 7),
        "latitude": round(center[1], 7),
        "height": height,
        "heading": 0,
        "pitch": -64,
        "roll": 0
    }
    existing_camera_profiles = existing_region.get("cameraProfiles")
    if not isinstance(existing_camera_profiles, dict):
        existing_camera_profiles = {}
    camera_profiles = {
        **existing_camera_profiles,
        "portrait": existing_camera_profiles.get("portrait") or {
            **parent_camera,
            "height": round(max(20_000, height * 0.80))
        }
    }
    region_record = {
        **existing_region,
        "id": args.region_id,
        "name": args.region_name,
        "title": args.title or existing_region.get("title") or f"地理图说·{args.region_name}",
        "levelRole": args.level_role,
        "levelName": args.level_name,
        "parentId": args.parent_id,
        "childIds": tour_child_ids,
        "tourChildIds": tour_child_ids,
        "boundaryUnitIds": boundary_unit_ids,
        "tourChildCount": len(tour_child_ids),
        "boundaryUnitCount": len(boundary_unit_ids),
        "childRegions": child_regions,
        "supplementalUnits": supplemental_units,
        "sourceCrs": source_crs.to_string(),
        "center": [round(center[0], 7), round(center[1], 7)],
        "labelPoint": [round(parent_label.x, 7), round(parent_label.y, 7)],
        "bbox": [round(value, 7) for value in parent_geometry.bounds],
        "areaKm2": round(area_km2(parent_geometry, geod), 4),
        "geometryPath": relative(parent_path),
        "childGeometryPath": relative(child_path),
        "coverageManifestPath": relative(coverage_path),
        "presentationMode": existing_region.get("presentationMode", "parent-topic"),
        "boundaryInputFormat": "ESRI Shapefile",
        "sourceFiles": [relative(path) for path in sidecars.values()] + ([relative(cpg_path)] if cpg_path.exists() else []),
        "cameraPreset": parent_camera,
        "cameraProfiles": camera_profiles,
        "contentRefs": {**default_content_refs, **existing_region.get("contentRefs", {})}
    }
    region_path.write_text(json.dumps(region_record, ensure_ascii=False, indent=2), encoding="utf-8")
    timeline_preserved = timeline_path.exists()
    if not timeline_preserved:
        timeline = {
            "duration": args.duration,
            "actions": [
                {"id": "camera-approach", "time": 0, "duration": 6, "type": "flyToRegion", "target": args.region_id, "easing": "cubicInOut"},
                {"id": "parent-outline", "time": 0.35, "duration": 3.0, "type": "revealParentBoundary", "target": args.region_id, "easing": "sineInOut"},
                {"id": "child-boundaries", "time": 3.15, "duration": 1.35, "type": "fadeChildBoundaries", "target": args.region_id, "easing": "sineInOut"},
                {"id": "selected-fill", "time": 3.55, "duration": 1.25, "type": "fadeSelectedFill", "target": args.region_id, "easing": "sineInOut"},
                {"id": "camera-hold", "time": 6, "duration": max(0, args.duration - 6), "type": "holdRegionCamera", "target": args.region_id, "easing": "linear"}
            ]
        }
        timeline_path.write_text(json.dumps(timeline, ensure_ascii=False, indent=2), encoding="utf-8")

    report = {
        "ok": all(item["valid"] for item in quality) and simplification["outputCoverageValid"],
        "input": relative(shp_path),
        "inputFormat": "ESRI Shapefile",
        "requiredSidecars": [relative(path) for path in sidecars.values()],
        "encoding": encoding,
        "encodingSource": encoding_source,
        "idPrefixFilter": args.id_prefix,
        "idRegexFilter": args.id_regex,
        "sourceCrs": source_crs.to_string(),
        "outputCrs": "EPSG:4326",
        "featureCount": len(features),
        "expectedFeatureCount": args.expected_children,
        "tourChildIds": tour_child_ids,
        "boundaryUnitIds": boundary_unit_ids,
        "supplementalUnitIds": [item["id"] for item in supplemental_units],
        "parentDerivation": "union-of-child-shapefile-features",
        "overlapRatio": overlap_ratio,
        "simplification": simplification,
        "parentValid": parent_geometry.is_valid,
        "parentAreaKm2": round(area_km2(parent_geometry, geod), 4),
        "sourceDatasetBbox": list(reader.bbox),
        "filteredSourceBbox": filtered_source_bbox,
        "outputBbox": region_record["bbox"],
        "nameCorrections": name_map,
        "existingTimelinePreserved": timeline_preserved,
        "features": quality,
        "outputs": [relative(parent_path), relative(child_path), relative(region_path), relative(timeline_path), relative(coverage_path)]
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": report["ok"], "regionId": args.region_id, "features": len(features), "report": relative(report_path)}, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
