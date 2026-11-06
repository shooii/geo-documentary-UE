#!/usr/bin/env python3
"""Restructure a regional unit's children: merge, rename, or split village boundaries.

The national village boundary dataset is a snapshot. It can still carry a village
that has since been merged away, keep a stale code for a village that was renamed,
or hold two settlements inside a single record. Correcting that by hand-editing
GeoJSON is unreviewable and does not survive a re-import, so the correction is
expressed as a plan under config/child-unit-restructures/ and applied here.

The plan is the source of truth for *why* the map differs from the SHP, and the
script refuses to guess: an operation that cannot be resolved exactly is an error,
never a silently dropped or duplicated parcel.

Example plan:

    {
      "regionId": "440882115",
      "reason": "Village merger/split corrections confirmed against the 2025 code table",
      "operations": [
        { "op": "merge", "absorb": ["440882115003"], "into": "440882115201" },
        { "op": "rename", "id": "440882115019", "newId": "440882115218", "name": "那澳村" },
        { "op": "split", "id": "440882115223",
          "parts": [
            { "id": "440882115223", "name": "三教村",
              "select": { "containsLandmark": [109.8484, 20.514748] } },
            { "id": "440882115228", "name": "铺前村",
              "unitRole": "locally-defined-settlement" }
          ] }
      ]
    }

A split declares one unit per parcel; at most one part may omit `select`, and it
receives every remaining parcel, so no geometry can go missing.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[4]
version = sys.version_info[:2]
if version >= (3, 14):
    LOCAL_PACKAGE_DIRS = [PROJECT_ROOT / "runtime-qindou", PROJECT_ROOT / ".python-packages"]
elif version >= (3, 13):
    LOCAL_PACKAGE_DIRS = [PROJECT_ROOT / ".python-packages", PROJECT_ROOT / "runtime-qindou"]
else:
    LOCAL_PACKAGE_DIRS = [PROJECT_ROOT / ".python-geo", PROJECT_ROOT / ".python-packages"]
for package_dir in reversed(LOCAL_PACKAGE_DIRS):
    if package_dir.exists():
        sys.path.insert(0, str(package_dir))

from shapely.geometry import Point, mapping, shape  # noqa: E402
from shapely.ops import unary_union  # noqa: E402
from pyproj import Geod  # noqa: E402

GEOD = Geod(ellps="WGS84")

# Mirrors import-shapefile.py so a restructured unit is framed exactly like an
# imported one; a different formula would make corrected villages zoom oddly.
def child_camera_height(bounds: tuple[float, float, float, float]) -> int:
    west, south, east, north = bounds
    latitude = (south + north) / 2
    width_km = abs(east - west) * 111.32 * math.cos(math.radians(latitude))
    height_km = abs(north - south) * 110.57
    return round(max(11_500, min(42_000, max(width_km, height_km) * 2_350)))


def portrait_child_camera_height(bounds: tuple[float, float, float, float]) -> int:
    west, south, east, north = bounds
    latitude = (south + north) / 2
    width_m = abs(east - west) * 111_320 * math.cos(math.radians(latitude))
    height_m = abs(north - south) * 110_570
    horizontal_tangent = math.tan(math.radians(36 / 2))
    vertical_tangent = math.tan(math.radians(58 / 2))
    width_fit = width_m / (2 * horizontal_tangent * 0.78)
    height_fit = height_m / (2 * vertical_tangent * 0.72)
    return round(max(4_200, min(32_000, max(width_fit, height_fit))))


def area_km2(geometry: Any) -> float:
    area, _ = GEOD.geometry_area_perimeter(geometry)
    return abs(area) / 1_000_000


def polygonal(geometry: Any) -> Any:
    """Collapse a one-part MultiPolygon back to a Polygon, as the importer does."""
    if geometry.geom_type == "MultiPolygon" and len(geometry.geoms) == 1:
        return geometry.geoms[0]
    return geometry


def parts_of(geometry: Any) -> list[Any]:
    return list(geometry.geoms) if geometry.geom_type == "MultiPolygon" else [geometry]


def properties_for(unit: dict[str, Any], geometry: Any, base: dict[str, Any]) -> dict[str, Any]:
    bounds = [round(value, 7) for value in geometry.bounds]
    representative = geometry.representative_point()
    camera = {
        "longitude": round(representative.x, 7),
        "latitude": round(representative.y, 7),
        "height": child_camera_height(geometry.bounds),
        "heading": 0,
        "pitch": -64,
        "roll": 0,
    }
    properties = {
        "id": unit["id"],
        "adcode": unit["id"],
        "name": unit["name"],
        "parentId": base.get("parentId"),
        "labelPoint": [round(representative.x, 7), round(representative.y, 7)],
        "bbox": bounds,
        "cameraPreset": camera,
        "cameraProfiles": {
            "portrait": {**camera, "height": portrait_child_camera_height(geometry.bounds)}
        },
        "source": base.get("source"),
        "sourceCrs": base.get("sourceCrs"),
        "sourceRecord": base.get("sourceRecord"),
        "legalNotice": base.get("legalNotice"),
    }
    for key, value in (base.get("extra") or {}).items():
        properties[key] = value
    for key in ("unitRole", "classification", "note"):
        if unit.get(key):
            properties[key] = unit[key]
    return properties


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--region", required=True, help="Parent region id, e.g. 440882115")
    parser.add_argument("--plan", help="Plan JSON path (default config/child-unit-restructures/<region>.json)")
    parser.add_argument("--dry-run", action="store_true", help="Report the outcome without writing")
    parser.add_argument("--out-report", help="Write the report to this path")
    args = parser.parse_args()

    plan_path = Path(args.plan) if args.plan else PROJECT_ROOT / "config" / "child-unit-restructures" / f"{args.region}.json"
    if not plan_path.exists():
        raise SystemExit(f"no restructure plan at {plan_path}")
    plan = load_json(plan_path)
    # A plan whose corrections were folded into the source data is a record, not a
    # set of instructions: re-running it would merge ids that no longer exist (or
    # re-apply a withdrawn operation), so refuse instead of half-applying it.
    if plan.get("status") and plan.get("status") != "active":
        raise SystemExit(
            f"{plan_path} is marked status={plan['status']!r}, not an executable plan. "
            "Its corrections already live in the source data; re-import instead "
            "(see import-shapefile.py)."
        )

    region_path = PROJECT_ROOT / "data" / "regions" / f"{args.region}.json"
    region = load_json(region_path)
    children_path = PROJECT_ROOT / region["childGeometryPath"]
    collection = load_json(children_path)

    features: dict[str, dict[str, Any]] = {
        str(feature["properties"]["id"]): feature for feature in collection["features"]
    }
    order: list[str] = [str(value) for value in region["childIds"]]
    geometries: dict[str, Any] = {
        key: shape(feature["geometry"]) for key, feature in features.items()
    }
    base_props: dict[str, dict[str, Any]] = {
        key: dict(feature["properties"]) for key, feature in features.items()
    }
    # Units carry the geometry plus the provenance we need to rebuild properties.
    units: dict[str, dict[str, Any]] = {}
    for key, feature in features.items():
        props = feature["properties"]
        units[key] = {
            "id": key,
            "name": props["name"],
            "geometry": geometries[key],
            "base": {
                "parentId": props.get("parentId", args.region),
                "source": props.get("source"),
                "sourceCrs": props.get("sourceCrs"),
                "sourceRecord": props.get("sourceRecord"),
                "legalNotice": props.get("legalNotice"),
                "extra": {
                    k: v
                    for k, v in props.items()
                    if k not in {
                        "id", "adcode", "name", "parentId", "labelPoint", "bbox",
                        "cameraPreset", "cameraProfiles", "source", "sourceCrs",
                        "sourceRecord", "legalNotice",
                    }
                },
            },
        }

    parent_geometry = shape(load_json(PROJECT_ROOT / region["geometryPath"])["features"][0]["geometry"])
    before_area = area_km2(unary_union(list(geometries.values())))
    log: list[str] = []

    for operation in plan.get("operations", []):
        kind = operation.get("op")

        if kind == "merge":
            target_id = str(operation["into"])
            absorbed_ids = [str(value) for value in operation["absorb"]]
            for absorbed in absorbed_ids:
                if absorbed not in units:
                    raise SystemExit(f"merge: {absorbed} is not a current child of {args.region}")
                if absorbed == target_id:
                    raise SystemExit(f"merge: {absorbed} cannot be absorbed into itself")
            target = units[target_id]
            merged = unary_union([target["geometry"]] + [units[key]["geometry"] for key in absorbed_ids])
            log.append(
                f"merge   {'+'.join(absorbed_ids)} -> {target_id} ({target['name']}): "
                f"{area_km2(target['geometry']):.4f} + "
                f"{sum(area_km2(units[key]['geometry']) for key in absorbed_ids):.4f} = {area_km2(merged):.4f} km2"
            )
            units[target_id] = {
                **target,
                "geometry": merged,
                "base": {
                    **target["base"],
                    "extra": {
                        **target["base"]["extra"],
                        **({"mergedFrom": absorbed_ids} if absorbed_ids else {}),
                        **({"mergedFromNames": [units[key]["name"] for key in absorbed_ids]} if absorbed_ids else {}),
                    },
                },
            }
            for absorbed in absorbed_ids:
                units.pop(absorbed)
                order.remove(absorbed)
            continue

        if kind == "rename":
            source_id = str(operation["id"])
            if source_id not in units:
                raise SystemExit(f"rename: {source_id} is not a current child of {args.region}")
            unit = units[source_id]
            new_id = str(operation.get("newId") or source_id)
            new_name = operation.get("name") or unit["name"]
            if new_id != source_id and new_id in units:
                raise SystemExit(f"rename: {source_id} cannot take {new_id}, it already exists")
            log.append(f"rename  {source_id} {unit['name']} -> {new_id} {new_name}")
            units[new_id] = {
                **unit,
                "id": new_id,
                "name": new_name,
                "base": {
                    **unit["base"],
                    "extra": {
                        **unit["base"]["extra"],
                        "renamedFrom": {"id": source_id, "name": unit["name"]},
                    },
                },
            }
            if new_id != source_id:
                del units[source_id]
                order[order.index(source_id)] = new_id
            continue

        if kind == "split":
            source_id = str(operation["id"])
            if source_id not in units:
                raise SystemExit(f"split: {source_id} is not a current child of {args.region}")
            unit = units[source_id]
            parcels = parts_of(unit["geometry"])
            declared = operation["parts"]
            remaining = set(range(len(parcels)))
            assignment: dict[int, dict[str, Any]] = {}
            wildcard: dict[str, Any] | None = None

            for part in declared:
                selector = part.get("select")
                if not selector:
                    if wildcard is not None:
                        raise SystemExit(f"split: {source_id} declares more than one selector-free part")
                    wildcard = part
                    continue
                if "containsLandmark" in selector:
                    lon, lat = selector["containsLandmark"]
                    point = Point(float(lon), float(lat))
                    taken = [index for index in sorted(remaining) if parcels[index].contains(point)]
                    if len(taken) != 1:
                        raise SystemExit(
                            f"split: landmark {lon},{lat} falls in {len(taken)} unassigned parcels of "
                            f"{source_id} ({unit['name']}); the plan is ambiguous"
                        )
                elif "partIndex" in selector:
                    taken = [int(selector["partIndex"])]
                    if taken[0] not in remaining:
                        raise SystemExit(f"split: partIndex {taken[0]} of {source_id} is not available")
                else:
                    raise SystemExit(f"split: unsupported selector {selector!r}")
                for index in taken:
                    remaining.discard(index)
                assignment[taken[0]] = part

            if wildcard is not None:
                for index in sorted(remaining):
                    assignment[index] = wildcard
                remaining.clear()
            if remaining:
                raise SystemExit(
                    f"split: {source_id} has {len(remaining)} parcel(s) no declared part claims; "
                    "every parcel must be assigned so no land is lost"
                )

            grouped: dict[str, list[int]] = {}
            for index, part in assignment.items():
                grouped.setdefault(str(part["id"]), []).append(index)
            if len(grouped) != len(declared):
                raise SystemExit(f"split: {source_id} declares duplicate part ids")

            order_index = order.index(source_id)
            order.pop(order_index)
            for offset, part in enumerate(declared):
                part_id = str(part["id"])
                indexes = sorted(grouped[part_id])
                geometry = polygonal(unary_union([parcels[index] for index in indexes]))
                if part_id in units and part_id != source_id:
                    raise SystemExit(f"split: {part_id} already exists as a child of {args.region}")
                log.append(
                    f"split   {source_id} ({unit['name']}) parcel(s) {indexes} -> {part_id} "
                    f"({part['name']}): {area_km2(geometry):.4f} km2"
                )
                units[part_id] = {
                    "id": part_id,
                    "name": part["name"],
                    "geometry": geometry,
                    "unitRole": part.get("unitRole"),
                    "classification": part.get("classification"),
                    "note": part.get("note"),
                    "base": {
                        **unit["base"],
                        "extra": {
                            **unit["base"]["extra"],
                            "splitFrom": {"id": source_id, "name": unit["name"], "parcels": len(parcels)},
                        },
                    },
                }
                order.insert(order_index + offset, part_id)
            # A part may reuse the source id (the settlement that keeps the name);
            # only drop the original when no part claimed it.
            if source_id not in grouped:
                units.pop(source_id)
            continue

        raise SystemExit(f"unsupported operation {kind!r}")

    # --- consistency: the repartition must reproduce the town exactly ---------
    after_geometry = unary_union([units[key]["geometry"] for key in order])
    after_area = area_km2(after_geometry)
    gap_area = area_km2(parent_geometry.difference(after_geometry))
    symmetric = area_km2(parent_geometry.symmetric_difference(after_geometry))
    # Pairwise, bbox-filtered: a merge that silently grabbed a neighbour's land
    # would still leave the *union* unchanged, so the union test alone cannot see it.
    overlap_area = 0.0
    for i, left in enumerate(order):
        for right in order[i + 1:]:
            a, b = units[left]["geometry"], units[right]["geometry"]
            if not a.bounds[2] >= b.bounds[0] or not b.bounds[2] >= a.bounds[0]:
                continue
            if not a.bounds[3] >= b.bounds[1] or not b.bounds[3] >= a.bounds[1]:
                continue
            shared = a.intersection(b)
            if not shared.is_empty:
                overlap_area += area_km2(shared)

    features_out = []
    for key in order:
        unit = units[key]
        properties = properties_for(unit, unit["geometry"], unit["base"])
        features_out.append({
            "type": "Feature",
            "properties": properties,
            "geometry": mapping(unit["geometry"]),
        })

    child_regions = [
        {
            "id": feature["properties"]["id"],
            "name": feature["properties"]["name"],
            "labelPoint": feature["properties"]["labelPoint"],
            "bbox": feature["properties"]["bbox"],
            "cameraPreset": feature["properties"]["cameraPreset"],
            "cameraProfiles": feature["properties"]["cameraProfiles"],
        }
        for feature in features_out
    ]

    region_out = {
        **region,
        "childIds": order,
        "tourChildIds": order,
        "boundaryUnitIds": order,
        "tourChildCount": len(order),
        "boundaryUnitCount": len(order),
        "childRegions": child_regions,
    }

    # The coverage manifest documents which source features the region was built
    # from, so it goes stale the moment the unit list changes; build-child-tour
    # only annotates it, it never rebuilds the membership.
    manifest_out: dict[str, Any] | None = None
    manifest_path = PROJECT_ROOT / str(region.get("coverageManifestPath") or "") if region.get("coverageManifestPath") else None
    if manifest_path and manifest_path.exists():
        manifest = load_json(manifest_path)
        prior_children = {str(entry["id"]): entry for entry in manifest.get("children", [])}
        prior_units = {str(entry["id"]): entry for entry in manifest.get("boundaryUnits", [])}
        children_entries = []
        unit_entries = []
        for key in order:
            unit = units[key]
            prior = dict(prior_children.get(key) or {})
            prior.pop("editorialOrder", None)
            entry = {**prior, "id": key, "name": unit["name"]}
            entry.setdefault("included", True)
            entry.setdefault("reason", "SHP feature")
            if "splitFrom" in (unit["base"]["extra"] or {}):
                entry["reason"] = f"local restructure: split from {unit['base']['extra']['splitFrom']['id']}"
            if "mergedFrom" in (unit["base"]["extra"] or {}):
                entry["mergedFrom"] = unit["base"]["extra"]["mergedFrom"]
            if "renamedFrom" in (unit["base"]["extra"] or {}):
                entry["renamedFrom"] = unit["base"]["extra"]["renamedFrom"]
            children_entries.append(entry)
            unit_entries.append({
                **(prior_units.get(key) or {}),
                "id": key,
                "name": unit["name"],
                "unitRole": unit.get("unitRole") or (prior_units.get(key) or {}).get("unitRole") or "administrative-village",
                **({"note": unit["note"]} if unit.get("note") else {}),
            })
        manifest_out = {
            **manifest,
            "completeImmediateChildCoverage": True,
            "coverageScope": (
                f"{len(order)} reliable boundary units: {len(order)} tour children "
                f"and {len(manifest.get('supplementalUnits') or [])} supplemental management units"
            ),
            "tourChildIds": order,
            "boundaryUnitIds": order,
            "children": children_entries,
            "boundaryUnits": unit_entries,
            "restructuredFrom": plan_path.relative_to(PROJECT_ROOT).as_posix(),
            "restructureReason": plan.get("reason"),
        }
        manifest_out.pop("narrationCoverage", None)  # rebuilt by build-child-tour

    report = {
        "regionId": args.region,
        "regionName": region.get("name"),
        "planPath": plan_path.relative_to(PROJECT_ROOT).as_posix(),
        "reason": plan.get("reason"),
        "beforeChildCount": len(features),
        "afterChildCount": len(order),
        "childIds": order,
        "operations": log,
        "areaKm2": {
            "childrenBefore": round(before_area, 4),
            "childrenAfter": round(after_area, 4),
            "parent": round(area_km2(parent_geometry), 4),
            "parentMinusChildren": round(gap_area, 4),
            "childrenMinusParent": round(overlap_area, 4),
            "symmetricDifference": round(symmetric, 4),
        },
        "dryRun": bool(args.dry_run),
    }

    for line in log:
        print(line)
    print()
    print(f"children: {len(features)} -> {len(order)}")
    print(f"union of children vs parent: gap {gap_area:.4f} km2, overlap {overlap_area:.4f} km2")
    if args.out_report:
        Path(args.out_report).write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf8")
        print(f"report: {args.out_report}")

    if args.dry_run:
        print("dry run: nothing written")
        return 0

    collection_out = {"type": "FeatureCollection", "features": features_out}
    children_path.write_text(json.dumps(collection_out, ensure_ascii=False), "utf8")
    region_path.write_text(json.dumps(region_out, ensure_ascii=False, indent=2), "utf8")
    print(f"wrote {children_path.relative_to(PROJECT_ROOT)}")
    print(f"wrote {region_path.relative_to(PROJECT_ROOT)}")
    if manifest_out is not None and manifest_path is not None:
        manifest_path.write_text(json.dumps(manifest_out, ensure_ascii=False, indent=2), "utf8")
        print(f"wrote {manifest_path.relative_to(PROJECT_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
