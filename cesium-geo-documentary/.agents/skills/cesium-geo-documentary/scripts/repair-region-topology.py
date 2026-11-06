#!/usr/bin/env python3
"""Validate and repair boundary geometry referenced by data/regions/*.json.

Checks every geometryPath / childGeometryPath GeoJSON for invalid polygons
(self intersections, bowties, slivers, broken rings) and rewrites them with
Shapely make_valid so Cesium rendering and the admin picker stay usable.

Usage:
  python repair-region-topology.py --check-only   # report only, no writes
  python repair-region-topology.py --fix          # repair and rewrite files
  python repair-region-topology.py --fix --ids 440825112,440825107
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[4]
if (PROJECT_ROOT / ".python-packages").exists():
    sys.path.insert(0, str(PROJECT_ROOT / ".python-packages"))

from shapely import make_valid  # noqa: E402
from shapely.geometry import shape  # noqa: E402
from shapely.validation import explain_validity  # noqa: E402


def geometry_file_fields(regions_dir: Path) -> list[tuple[str, Path]]:
    seen: dict[Path, str] = {}
    for region_file in sorted(regions_dir.glob("*.json")):
        try:
            meta = json.loads(region_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(meta, dict):
            continue
        region_id = str(meta.get("id") or region_file.stem)
        for key in ("geometryPath", "childGeometryPath"):
            rel = meta.get(key)
            if not isinstance(rel, str):
                continue
            path = (PROJECT_ROOT / rel).resolve() if not Path(rel).is_absolute() else Path(rel)
            seen.setdefault(path, region_id)
    return [(region_id, path) for path, region_id in seen.items()]


def iter_features(data: object):
    """Yield (geometry_dict, properties) regardless of GeoJSON wrapper shape."""
    if not isinstance(data, dict):
        return
    kind = data.get("type")
    if kind == "FeatureCollection":
        for feature in data.get("features", []) or []:
            if isinstance(feature, dict):
                yield feature.get("geometry"), feature.get("properties")
    elif kind == "GeometryCollection":
        for idx, geometry in enumerate(data.get("geometries", []) or []):
            yield geometry, {"index": idx}
    elif kind == "Feature":
        yield data.get("geometry"), data.get("properties")
    elif kind:
        yield data, None


def read_document(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"cannot parse {path.name}: {exc}") from exc


def collect_geometries(document: object):
    """Materialise a top-level shapely collection + per-feature list when possible."""
    features = []
    wrapper_is_fc = isinstance(document, dict) and document.get("type") == "FeatureCollection"
    for geometry, properties in iter_features(document):
        if geometry is None:
            continue
        try:
            geom = shape(geometry)
        except Exception:
            continue
        features.append({"geometry": geometry, "props": properties, "shapely": geom})
    return features, wrapper_is_fc


def repair_document(document: object, log: Counter) -> tuple[bool, object]:
    """Return (changed, new_document) after make_valid on every feature geometry."""
    changed = False
    if isinstance(document, dict) and document.get("type") == "FeatureCollection":
        document = dict(document)
        document["features"] = list(document.get("features", []) or [])
        for feature in document["features"]:
            if not isinstance(feature, dict):
                continue
            geometry = feature.get("geometry")
            if geometry is None:
                continue
            try:
                geom = shape(geometry)
            except Exception:
                continue
            if geom.is_valid:
                continue
            log["invalid_features"] += 1
            repaired = make_valid(geom)
            if repaired.is_valid:
                log["fixed"] += 1
                feature["geometry"] = __import__("shapely.geometry", fromlist=["mapping"]).mapping(repaired)
                changed = True
            else:
                log["still_invalid"] += 1
        return changed, document

    changed_top = False
    container = dict(document) if isinstance(document, dict) else None

    def patch(geometry):
        nonlocal changed_top
        if geometry is None:
            return geometry
        try:
            geom = shape(geometry)
        except Exception:
            return geometry
        if geom.is_valid:
            return geometry
        log["invalid_top"] += 1
        repaired = make_valid(geom)
        if repaired.is_valid:
            log["fixed_top"] += 1
            changed_top = True
            return __import__("shapely.geometry", fromlist=["mapping"]).mapping(repaired)
        log["still_invalid"] += 1
        return geometry

    if container is not None:
        kind = container.get("type")
        if kind == "GeometryCollection":
            container["geometries"] = [patch(g) for g in container.get("geometries", []) or []]
            return changed_top, container
        if kind == "Feature":
            container["geometry"] = patch(container.get("geometry"))
            return changed_top, container
        container["geometry"] = patch(container.get("geometry"))
        return changed_top, container
    return False, document


def audit_pair(region_id: str, parent_path: Path, children_path: Path):
    """Quantify child-set gaps/overlaps against the parent boundary."""
    from shapely.ops import unary_union

    try:
        parent_doc = read_document(parent_path)
        children_doc = read_document(children_path)
    except ValueError:
        return None
    parent_geoms = []
    for geometry, _props in iter_features(parent_doc):
        if geometry is not None:
            try:
                parent_geoms.append(shape(geometry))
            except Exception:
                continue
    if not parent_geoms:
        return None
    parent = unary_union(parent_geoms)

    child_geoms = []
    for geometry, _props in iter_features(children_doc):
        if geometry is not None:
            try:
                child_geoms.append(shape(geometry))
            except Exception:
                continue
    if not child_geoms:
        return None
    children = unary_union(child_geoms)
    overlap_between_children = max(0.0, sum(geometry.area for geometry in child_geoms) - children.area)
    outside_parent = max(0.0, children.difference(parent).area)
    gap_inside_parent = max(0.0, parent.area - parent.intersection(children).area)
    return {
        "region": region_id,
        "children": len(child_geoms),
        "parent_area": round(parent.area, 6),
        "overlap_area": round(overlap_between_children, 9),
        "outside_area": round(outside_parent, 9),
        "gap_area": round(gap_inside_parent, 9),
    }


def audit_command() -> int:
    regions_dir = PROJECT_ROOT / "data" / "regions"
    rows = []
    for region_file in sorted(regions_dir.glob("*.json")):
        try:
            meta = json.loads(region_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(meta, dict):
            continue
        parent_rel = meta.get("geometryPath")
        children_rel = meta.get("childGeometryPath")
        if not isinstance(parent_rel, str) or not isinstance(children_rel, str):
            continue
        parent_path = (PROJECT_ROOT / parent_rel).resolve()
        children_path = (PROJECT_ROOT / children_rel).resolve()
        if not parent_path.exists() or not children_path.exists():
            print(f"[missing] region={meta.get('id')} parent={parent_path.exists()} children={children_path.exists()}")
            continue
        row = audit_pair(str(meta.get("id")), parent_path, children_path)
        if row:
            rows.append(row)
    area_tol = 1e-7
    issues = [row for row in rows if row["overlap_area"] > area_tol or row["outside_area"] > area_tol or row["gap_area"] > area_tol]
    print(f"audited {len(rows)} parent/children pairs | consistent={len(rows) - len(issues)} | issues={len(issues)}")
    for row in sorted(issues, key=lambda r: max(r["overlap_area"], r["outside_area"], r["gap_area"]), reverse=True):
        print(f"  {row['region']:14s} children={row['children']:3d} parent={row['parent_area']:<10.4f} overlap={row['overlap_area']:<12.9f} outside={row['outside_area']:<12.9f} gap={row['gap_area']:<12.9f}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-only", action="store_true", help="report only, do not write")
    parser.add_argument("--fix", action="store_true", help="repair and rewrite invalid files")
    parser.add_argument("--ids", default="", help="comma separated region ids to limit scope")
    parser.add_argument("--audit-cover", action="store_true", help="check child-set gaps/overlaps vs parent boundary")
    args = parser.parse_args()

    if args.audit_cover:
        return audit_command()

    regions_dir = PROJECT_ROOT / "data" / "regions"
    allow = {item.strip() for item in args.ids.split(",") if item.strip()}
    targets = [(rid, path) for rid, path in geometry_file_fields(regions_dir) if not allow or rid in allow]
    if not targets:
        print("no geometry references found under data/regions")
        return 2

    stats: Counter = Counter()
    broken_files = []
    fixed_files = []
    for region_id, path in targets:
        try:
            document = read_document(path)
        except ValueError as exc:
            print(f"[parse-error] {region_id} {path.name}: {exc}")
            continue
        log: Counter = Counter()
        changed, document = repair_document(document, log)
        stats.update(log)
        if not log["invalid_features"] and not log["invalid_top"]:
            continue
        broken_files.append((region_id, path.name, log["invalid_features"] + log["invalid_top"], log["fixed"] + log["fixed_top"], log["still_invalid"]))
        if changed and args.fix:
            path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
            fixed_files.append(path.name)

    total_invalid = stats["invalid_features"] + stats["invalid_top"]
    print(f"scanned {len(targets)} geometry files | invalid features: {stats['invalid_features']} | invalid top-level: {stats['invalid_top']} | fixed: {stats['fixed'] + stats['fixed_top']} | still invalid: {stats['still_invalid']}")
    if broken_files:
        print("--- files with invalid geometry ---")
        for rid, name, bad, fixed, still in broken_files:
            print(f"  {rid:14s} {name:40s} invalid={bad:4d} fixed={fixed:4d} remaining_invalid={still}")
    if args.fix and fixed_files:
        print(f"repaired & rewrote {len(fixed_files)} file(s)")
    print("RESULT", "ok" if total_invalid == 0 else ("fixed" if args.fix else "needs-fix"))
    return 0 if total_invalid == 0 or args.fix else 1


if __name__ == "__main__":
    raise SystemExit(main())
