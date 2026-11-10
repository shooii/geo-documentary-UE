#!/usr/bin/env python3
"""Derive a parent's outline from the boundaries of its child administrative units.

The prefecture GeoJSON that `preprocess-boundaries.py` produces carries a county's
*maritime* limit: coastal counties come out as a smooth arc that runs far out to sea,
and the ring is only a few hundred vertices. Drawing that as "徐闻县" puts a translucent
sheet over open water and its coast never lines up with the town plate inside it.

The village dataset is the ground truth here: every town's outline is exactly the union
of its villages (checked for 440825102: 100.0% overlap, 0.0% outside). So a county is
assembled as

    county = union(villages of every town we have)

i.e. nothing but administrative-village geometry, no other source. Towns whose village
file is missing are reported instead of being papered over.

Usage:
  python dissolve-admin-units.py --region 440825              # report only
  python dissolve-admin-units.py --region 440825 --apply      # write + switch the region
  python dissolve-admin-units.py --region 440825102 --apply   # a township: villages -> town

`--apply` refuses to switch when townships are missing (the ring would have a hole);
`--force` overrides. The switch is `derivedGeometryPath` on the region, which
`apps/ue-player/scene.ts` prefers over `geometryPath` — deleting that one field reverts.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[4]
if (PROJECT_ROOT / ".python-packages").exists():
    sys.path.insert(0, str(PROJECT_ROOT / ".python-packages"))

from shapely import make_valid  # noqa: E402
from shapely.geometry import mapping, shape  # noqa: E402
from shapely.ops import unary_union  # noqa: E402

# 1 deg^2 at 20.4 N. Only used for human-readable areas in the report.
KM2_PER_DEG2 = 111.32 * 110.57 * 0.94


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def polygons(path: Path):
    data = read_json(path)
    features = data.get("features") or [data]
    out = []
    for feature in features:
        geometry = feature.get("geometry") or feature
        if geometry.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        geom = shape(geometry)
        if not geom.is_valid:
            geom = make_valid(geom)
        if not geom.is_empty:
            out.append(geom)
    return out


def area_km2(geom) -> float:
    return round(geom.area * KM2_PER_DEG2, 1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", required=True, help="parent region id, e.g. 440825")
    parser.add_argument("--check-only", action="store_true", help="report only")
    parser.add_argument("--apply", action="store_true", help="write the ring and point the region at it")
    parser.add_argument("--force", action="store_true", help="apply even when townships are missing")
    parser.add_argument("--min-coverage", type=float, default=0.95, help="coverage required to apply")
    parser.add_argument("--out", help="output path (default data/normalized/<id>.dissolved.geojson)")
    args = parser.parse_args()

    regions_dir = PROJECT_ROOT / "data" / "regions"
    normalized = PROJECT_ROOT / "data" / "normalized"
    meta = read_json(regions_dir / f"{args.region}.json")
    index = {str(item["id"]): item for item in read_json(regions_dir / "index.json")}

    # The index knows every township of the county (so we can name what is missing), but
    # only some of them have geometry on disk. The national code table is the reliable
    # roster: /data/regions/2025全国行政区划编码/village-code-index.tsv lists every village
    # with its township code, so grouping it gives the full township list of the county.
    roster: dict[str, str] = {}
    codes = regions_dir / "2025全国行政区划编码" / "village-code-index.tsv"
    if codes.exists():
        with codes.open(encoding="utf-8") as handle:
            for line in handle:
                cols = line.rstrip("\n").split("\t")
                if len(cols) < 3:
                    continue
                township = cols[1]
                if len(township) == 9 and township.startswith(args.region):
                    roster[township] = cols[2]
    for item in index.get(args.region, {}).get("children") or meta.get("children") or []:
        cid = str(item)
        roster.setdefault(cid, index.get(cid, {}).get("name", "?"))

    on_disk = sorted(p.stem for p in normalized.glob(f"{args.region}[0-9][0-9][0-9].geojson"))
    child_ids = sorted({cid for cid in [*roster, *on_disk]})
    children = [cid for cid in child_ids if (normalized / f"{cid}.geojson").exists()]
    missing = [cid for cid in child_ids if cid not in children]

    pieces, used_villages, used_towns = [], [], []
    for cid in children:
        village_file = normalized / f"{cid}-children.geojson"
        source = village_file if village_file.exists() else normalized / f"{cid}.geojson"
        geoms = polygons(source)
        if not geoms:
            missing.append(cid)
            continue
        pieces.extend(geoms)
        (used_villages if source == village_file else used_towns).append(cid)

    if not pieces:
        print(f"no child geometry found for {args.region}", file=sys.stderr)
        return 1

    merged = unary_union(pieces)
    merged = make_valid(merged)
    if merged.geom_type == "Polygon":
        merged = merged.buffer(0)

    official_path = normalized / f"{args.region}.geojson"
    official = unary_union(polygons(official_path)) if official_path.exists() else None

    print(f"region        {args.region} {meta.get('name')}")
    print(f"child units   {len(children)}  villages={len(used_villages)} town-only={len(used_towns)}")
    if missing:
        names = [f"{cid} {roster.get(cid, '?')}" for cid in sorted(set(missing))]
        print("missing       " + ", ".join(names))
    print(f"dissolved     {area_km2(merged)} km2  parts={len(getattr(merged, 'geoms', [merged]))}")
    if official is not None:
        print(f"official      {area_km2(official)} km2")
        covered = merged.intersection(official).area / official.area * 100
        outside = merged.difference(official).area / merged.area * 100
        print(f"coverage      {covered:.1f}% of official, {outside:.1f}% of merged lies outside it")

    if args.check_only or not args.apply:
        if missing:
            print(
                f"\n{len(missing)} township(s) have no village geometry, so the dissolved ring is\n"
                "missing their area. Nothing was written; re-run with --apply once those files\n"
                "exist, or pass --force to accept the gap.",
                file=sys.stderr,
            )
        return 0

    if official is not None and missing and not args.force:
        print(
            f"\nrefusing to apply: {len(missing)} township(s) missing, coverage is only "
            f"{covered:.1f}%. Add their village geometry, or pass --force to apply anyway.",
            file=sys.stderr,
        )
        return 2
    if official is not None and not missing and covered < args.min_coverage and not args.force:
        print(
            f"\nrefusing to apply: coverage {covered:.1f}% < {args.min_coverage * 100:.0f}%.",
            file=sys.stderr,
        )
        return 2

    out_path = Path(args.out) if args.out else normalized / f"{args.region}.dissolved.geojson"
    feature = {
        "type": "Feature",
        "properties": {
            "id": args.region,
            "name": meta.get("name"),
            "source": "dissolve of child administrative units",
            "units": len(children),
            "villageUnits": len(used_villages),
        },
        "geometry": mapping(merged),
    }
    out_path.write_text(
        json.dumps({"type": "FeatureCollection", "features": [feature]}, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"written       {out_path.relative_to(PROJECT_ROOT)}")

    # Point the region at the derived ring. `geometryPath` is left untouched so the
    # original data stays inspectable and the switch is one field to undo.
    relative = out_path.relative_to(PROJECT_ROOT).as_posix()
    meta["derivedGeometryPath"] = relative
    if "bbox" in meta:
        meta["bbox"] = [round(v, 6) for v in merged.bounds]
    (regions_dir / f"{args.region}.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"region        derivedGeometryPath = {relative}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
