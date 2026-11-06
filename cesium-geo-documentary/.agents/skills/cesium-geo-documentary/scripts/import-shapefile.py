#!/usr/bin/env python3
"""Import polygon SHP boundaries, reproject to EPSG:4326, and write Cesium-ready QA artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[4]
# Vendored native wheels are CPython-version specific, so the interpreter that
# runs this script has to be paired with the directory built for it:
#   runtime-qindou   -> cp314 (the qindou runtime's environment)
#   .python-packages -> cp313 (this repo's managed toolchain)
#   .python-geo      -> cp312 (legacy)
# Each branch below therefore lists only the directories whose binaries match the
# running interpreter, most preferred first. Loading a mismatched directory used
# to surface as a misleading "SHP support requires..." ImportError — most often
# because a `.pyd` built for another CPython had overwritten the expected one.
version = sys.version_info[:2]
if version >= (3, 14):
    LOCAL_PACKAGE_DIRS = [PROJECT_ROOT / "runtime-qindou", PROJECT_ROOT / ".python-packages"]
elif version >= (3, 13):
    LOCAL_PACKAGE_DIRS = [PROJECT_ROOT / ".python-packages"]
elif version >= (3, 12):
    LOCAL_PACKAGE_DIRS = [PROJECT_ROOT / ".python-geo"]
else:
    LOCAL_PACKAGE_DIRS = [PROJECT_ROOT / ".python-geo", PROJECT_ROOT / ".python-packages"]
for package_dir in reversed(LOCAL_PACKAGE_DIRS):
    if package_dir.exists():
        sys.path.insert(0, str(package_dir))

try:
    import shapefile
    from pyproj import CRS, Geod, Transformer
    from shapely import coverage_is_valid, coverage_simplify, set_precision
    from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, mapping, shape
    from shapely.ops import transform, unary_union
    from shapely.validation import make_valid
except ImportError as exc:  # pragma: no cover - actionable runtime failure
    searched = "\n".join(f"    - {item}" for item in LOCAL_PACKAGE_DIRS) or "    (none)"
    raise SystemExit(
        "SHP support requires pyshp, pyproj, and Shapely 2.1 or newer.\n"
        f"  interpreter : Python {sys.version.split()[0]}  ({sys.executable})\n"
        f"  searched    :\n{searched}\n"
        f"  cause       : {type(exc).__name__}: {exc}\n"
        "The vendored wheels must match the interpreter above. Reinstall them with:\n"
        f"  \"{sys.executable}\" -m pip install --target .python-packages -r requirements.txt"
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


## Village-name normalisation and the official code index.
##
## Some towns in the production SHP were appended to their province table
## without the `PAC` field: 调风镇 (440882111) has 21 rows carrying a town code
## and a name, and nothing else. Aborting with `Record 26180 has no value in PAC`
## made that town un-buildable and told the operator nothing. The 2025
## 行政区划编码 workbook does carry those codes, so a blank id is first looked up
## by name (build-village-code-index.py flattens the workbook into the TSV that
## --code-index points at) and only then given a management-unit id.
NAME_SUFFIXES = (
    "村民委员会", "居民委员会", "社区居委会", "村委会", "居委会",
    "管理委员会", "社区", "村",
)


def village_name_key(value: str) -> str:
    """Reduce a village/community name to a comparison key.

    "调风村委会", "调风村" and "调风社区居委会" all reduce to "调风", which is what
    makes the source SHP's short names comparable with the code table's full
    administrative names.
    """
    text = re.sub(r"[（(][^）)]*[）)]\s*$", "", value.strip())
    text = re.sub(r"[\s·、]", "", text)
    changed = True
    while changed and text:
        changed = False
        for suffix in NAME_SUFFIXES:
            if len(text) > len(suffix) and text.endswith(suffix):
                text = text[: -len(suffix)]
                changed = True
    return text


def classify_management_unit(name: str) -> str:
    """Name a non-administrative unit by what the source calls it."""
    if "林场" in name:
        return "forest-farm-management-unit"
    if "农场" in name:
        return "farm-management-unit"
    return "unclassified-management-unit"


def synthetic_unit_id(town_code: str, name: str) -> str:
    """A stable, obviously non-official id for a unit the source left uncoded.

    Derived from the name so a re-import (or a change in the source row order)
    keeps the same key, and hyphenated so it can never be mistaken for a
    twelve-digit administrative code.
    """
    digest = hashlib.sha1(name.encode("utf-8")).hexdigest()[:6]
    return f"{town_code}-{digest}"


def read_code_index(path: Path, town_code: str) -> dict[str, dict[str, str]]:
    """Read the official units of one town out of the flat code index.

    The index is sorted by unit code, so every row for a town is contiguous and
    the scan stops as soon as it passes the town. Loading the whole 49 MB table
    would cost hundreds of megabytes for the sake of one town.
    """
    units: dict[str, dict[str, str]] = {}
    if not path.exists():
        raise SystemExit(f"Code index not found: {path}")
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line or line[0] == "#":
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 7:
                continue
            code, town = parts[0], parts[1]
            if town < town_code:
                continue
            if town > town_code:
                break
            units.setdefault(village_name_key(parts[4]), {
                "code": code,
                "name": parts[4],
                "urbanRuralCode": parts[5],
                "urbanRural": parts[6],
            })
    return units


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


# A hand-edited source SHP carries a few last-place float digits of separation
# along the seams where polygons were unioned. The geometry itself is sound (the
# union's symmetric difference is zero and there is no real overlap), but
# `coverage_is_valid` demands *exact* shared-edge equality, so it reports False.
# That used to silently disable simplification and, because the import's `ok` flag
# is gated on `outputCoverageValid`, made `generateTownPlan` abort a brand-new town
# with "自动提取乡镇边界失败". Snapping onto a sub-micron grid restores the exact
# shared edges while moving no vertex by more than half the grid (5e-8 m at 1e-7).
#
# 草潭镇 (440823113) needs a wider grid than a sub-micron one. Six of its village
# pairs overlap by 5-140 mm² - a ~20 µm sliver running 13 km along their shared
# seams - and 124 sub-millimetre gaps sit where three villages meet, 1.6e-9 of the
# township's area in total. `coverage_is_valid` rejects *any* overlap, so every
# sub-micron candidate failed and the import aborted a town the studio had already
# listed in its catalogue.
#
# 港门镇 (440823112) is the same defect one notch wider: a single village sits
# 2-4 cm out of place along the seams it shares with eight neighbours (0.369 m² of
# slivers in total) and 339 pinholes add up to 0.350 m² - 3.0e-9 of a 105 km²
# township, invisible on screen but rejected by `coverage_is_valid`. It still fails
# on a 15 cm grid and repairs on a 20 cm one, because a snap only restores a seam
# once the grid is coarse enough for both copies of it to round onto the same
# lattice line - and *which* grid that is depends on where the offset sits inside
# the lattice. The ladder therefore walks a dense sequence rather than a single
# leap, so one of its rungs lands on the alignment a given source file needs.
#
# The ladder runs from sub-micron to 25 cm, so a repair moves no vertex by more
# than ~18 cm - four times less than the 1 m simplification tolerance the studio
# passes on top, and seventeen times less than the 0.8 m library default. A snap can
# therefore never move a boundary further than the pipeline already moves it by
# itself. A defect wider than the widest grid survives every rung: that is a real
# topology error, the import aborts, and `describe_failure` tells the operator which
# check failed and which report to open.
COVERAGE_SNAP_GRIDS: tuple[float, ...] = (
    1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 5e-2, 7.5e-2, 1e-1, 1.5e-1, 2e-1, 2.5e-1
)


def coverage_snap_grids(tolerance: float) -> tuple[float, ...]:
    """The grid ladder to try, finest first, capped by the simplification tolerance.

    A caller that asked for a 1 mm simplification must not receive geometry
    snapped onto a grid a hundred times coarser than that, so the repair grids
    stop at the tolerance. A non-positive tolerance (simplification disabled)
    still gets the whole ladder: the snap is then the only thing between a
    hairline source defect and a failed import, and every attempt is reported
    through `snapGrid`.
    """

    if tolerance <= 0:
        return COVERAGE_SNAP_GRIDS
    return tuple(grid for grid in COVERAGE_SNAP_GRIDS if grid <= tolerance)


def snap_coverage(
    geometries: list[Any], tolerance: float
) -> tuple[list[Any] | None, list[Any] | None, float | None]:
    """Snap a nominally-valid coverage onto a grid until it validates.

    Returns the snapped coverages, the simplified coverages, and the grid that
    worked. The finest grid is tried first so the perturbation stays as small as
    it possibly can. A genuine overlap is never "repaired" by snapping: every
    candidate has to pass `coverage_is_valid` on its own, and overlap far wider
    than the grid survives all of them. A non-positive tolerance snaps without
    simplifying (see ``coverage_snap_grids`` for the ladder itself).
    """

    for grid in coverage_snap_grids(tolerance):
        snapped = [polygonal(set_precision(item, grid)) for item in geometries]
        if not coverage_is_valid(snapped):
            continue
        if tolerance <= 0:
            return snapped, snapped, grid
        simplified = [
            polygonal(item)
            for item in coverage_simplify(snapped, tolerance, simplify_boundary=False)
        ]
        if not coverage_is_valid(simplified):
            continue
        return snapped, simplified, grid
    return None, None, None


def simplify_polygon_coverage(geometries: list[Any], tolerance: float) -> tuple[list[Any], dict[str, Any]]:
    """Simplify a complete polygon coverage without breaking shared edges.

    Shapely's ordinary per-feature ``simplify`` can move the two copies of a
    shared edge independently, creating hairline gaps and overlaps. Coverage
    simplification processes the full set together. If the input is not a
    valid coverage, the safe fallback is to retain the original geometries —
    after first trying a sub-micron precision snap, which recovers the exact
    shared edges that a hand edit in a GIS toolshed broke (see
    ``COVERAGE_SNAP_GRIDS``) instead of discarding the simplification entirely.
    """

    raw_geometries = [polygonal(item) for item in geometries]
    raw_union = polygonal(unary_union(raw_geometries))
    raw_valid = bool(coverage_is_valid(raw_geometries))

    snapped: list[Any] | None = None
    snap_grid: float | None = None

    if raw_valid:
        if tolerance <= 0:
            output_geometries: list[Any] = raw_geometries
            mode = "disabled"
        else:
            output_geometries = [
                polygonal(item)
                for item in coverage_simplify(raw_geometries, tolerance, simplify_boundary=False)
            ]
            mode = "coverage-preserving"
    else:
        snapped, snapped_simplified, snap_grid = snap_coverage(raw_geometries, tolerance)
        if snap_grid is None:
            output_geometries = raw_geometries
            mode = "skipped-invalid-coverage"
        elif tolerance <= 0:
            output_geometries = snapped
            mode = "precision-snap-only"
        else:
            output_geometries = snapped_simplified
            mode = "coverage-preserving-after-precision-snap"

    # `applied` keeps its original meaning: a coverage-preserving simplification ran.
    applied = mode in {"coverage-preserving", "coverage-preserving-after-precision-snap"}

    output_valid = bool(coverage_is_valid(output_geometries))
    if (raw_valid or snapped is not None) and not output_valid:
        raise RuntimeError("Coverage simplification unexpectedly produced an invalid polygon coverage")

    output_union = polygonal(unary_union(output_geometries))
    raw_hole_count, raw_hole_area = polygon_hole_metrics(raw_union)
    output_hole_count, output_hole_area = polygon_hole_metrics(output_union)
    return output_geometries, {
        "requestedTolerance": tolerance,
        "mode": mode,
        "applied": applied,
        "snapGrid": snap_grid,
        "snapApplied": snap_grid is not None,
        "snapGridsAttempted": list(coverage_snap_grids(tolerance)),
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


def describe_failure(
    quality: list[dict[str, Any]],
    simplification: dict[str, Any],
    overlap_ratio: float,
    report_relative: str
) -> str:
    """Explain a failed import in the one line the studio hands to the operator.

    `ok` is the AND of two independent checks, and 草潭镇 (440823113) is why that
    is not enough: the studio turned a bare `ok: false` into
    "自动提取乡镇边界失败（exit 1）：{"ok": false, ...}" and left the operator with no
    cause and no next step. Name the check that failed, the numbers behind it, and
    the diagnostic report to open instead.
    """

    reasons: list[str] = []
    invalid = [str(item["id"]) for item in quality if not item.get("valid")]
    if invalid:
        listed = "、".join(invalid[:3]) + (" 等" if len(invalid) > 3 else "")
        reasons.append(f"{len(invalid)} 个村级图斑几何无效（{listed}）")
    if not simplification.get("outputCoverageValid"):
        gaps = float(simplification.get("outputUnionHoleAreaSourceUnits2") or 0.0)
        overlaps = float(simplification.get("rawSumAreaMinusUnionAreaSourceUnits2") or 0.0)
        widest = float((simplification.get("snapGridsAttempted") or [0.0])[-1])
        reasons.append(
            f"村级图斑拼不成有效覆盖：{gaps:.3f} 平方米缝隙、{overlaps:.3f} 平方米图斑重叠"
            f"（占区域面积 {overlap_ratio:.1e}），已按 {widest * 100:g} 厘米精度尝试修复仍未通过"
        )
    if not reasons:
        reasons.append("导入自检未通过")
    return (
        "自动提取乡镇边界失败：" + "；".join(reasons)
        + f"。请人工核对源边界数据后重试，诊断报告：{report_relative}"
    )


def area_km2(geometry: Any, geod: Geod) -> float:
    area, _ = geod.geometry_area_perimeter(geometry)
    return abs(area) / 1_000_000


# The overview camera is pitched, not straight down, so the ground it frames is a
# trapezoid and its near edge is magnified. Both the runtime and the functions
# below carry the same pitch, frame aspect and safe fraction; the runtime's copy
# is the one that renders.
CAMERA_PITCH_DEGREES = -64
PORTRAIT_OVERVIEW_FRAME_ASPECT = 1080 / 1920
PORTRAIT_OVERVIEW_FRUSTUM_FOV_DEGREES = 60
PORTRAIT_OVERVIEW_SAFE_FRACTION = 0.82
PORTRAIT_OVERVIEW_MINIMUM_RANGE_METERS = 4_000
PORTRAIT_OVERVIEW_MAXIMUM_RANGE_METERS = 180_000
# Recentring fixed point. Because the projection is not affine, aiming at the
# geographic centre does not centre the drawing: a point south of the target sits
# at a shorter depth and is magnified. Measured on the shipped player at 540x960
# with the target on 草潭镇's extent centre, the drawn box held 1.0 % of frame
# left-right imbalance and 2.4 % top-bottom. The target is walked to the fixed
# point where the projected box is centred. Mirrors the runtime's
# PORTRAIT_OVERVIEW_RECENTER_* constants.
PORTRAIT_OVERVIEW_RECENTER_GAIN = 0.7
PORTRAIT_OVERVIEW_RECENTER_ITERATIONS = 40
PORTRAIT_OVERVIEW_RECENTER_TOLERANCE = 0.0001


def _portrait_overview_tangents() -> tuple[float, float]:
    """Half-frame tangents of the 60 degree long-edge frustum, as (horizontal, vertical)."""
    half_long_edge = math.tan(math.radians(PORTRAIT_OVERVIEW_FRUSTUM_FOV_DEGREES / 2))
    aspect = PORTRAIT_OVERVIEW_FRAME_ASPECT
    return math.tan(math.atan(half_long_edge * aspect)), half_long_edge


def _portrait_overview_range(
    points: list[tuple[float, float]], tangent_horizontal: float, tangent_vertical: float
) -> int:
    """Smallest range holding every (east, north) point inside the safe fraction."""
    pitch = math.radians(abs(CAMERA_PITCH_DEGREES))
    sin_pitch = math.sin(pitch)
    cos_pitch = math.cos(pitch)
    share = PORTRAIT_OVERVIEW_SAFE_FRACTION
    range_m = float(PORTRAIT_OVERVIEW_MINIMUM_RANGE_METERS)
    for east_m, north_m in points:
        range_m = max(
            range_m,
            abs(east_m) / (share * tangent_horizontal) - north_m * cos_pitch,
            abs(north_m) * sin_pitch / (share * tangent_vertical) - north_m * cos_pitch,
        )
    return int(min(PORTRAIT_OVERVIEW_MAXIMUM_RANGE_METERS, math.ceil(range_m)))


def _portrait_overview_projected_box(
    points: list[tuple[float, float]], range_m: float, tangent_horizontal: float, tangent_vertical: float
) -> tuple[float, float, float, float] | None:
    """Drawn extents of `points` in half-frame units, or None if nothing projects."""
    pitch = math.radians(abs(CAMERA_PITCH_DEGREES))
    sin_pitch = math.sin(pitch)
    cos_pitch = math.cos(pitch)
    min_x = min_y = math.inf
    max_x = max_y = -math.inf
    for east_m, north_m in points:
        depth = range_m + north_m * cos_pitch
        if depth <= 0:
            continue
        x = east_m / (depth * tangent_horizontal)
        y = north_m * sin_pitch / (depth * tangent_vertical)
        min_x, max_x = min(min_x, x), max(max_x, x)
        min_y, max_y = min(min_y, y), max(max_y, y)
    if not math.isfinite(min_x) or not math.isfinite(min_y):
        return None
    return min_x, max_x, min_y, max_y


def _portrait_overview_target(points: list[tuple[float, float]]) -> tuple[float, float, int]:
    """Ground offset (east, north) to the target that centres the drawing, plus its range."""
    tangent_horizontal, tangent_vertical = _portrait_overview_tangents()
    if not points:
        return 0.0, 0.0, PORTRAIT_OVERVIEW_MINIMUM_RANGE_METERS
    pitch = math.radians(abs(CAMERA_PITCH_DEGREES))
    sin_pitch = math.sin(pitch)
    offset_east = 0.0
    offset_north = 0.0
    best: tuple[float, float, float, int] | None = None
    for _ in range(PORTRAIT_OVERVIEW_RECENTER_ITERATIONS):
        shifted = [(east - offset_east, north - offset_north) for east, north in points]
        range_m = _portrait_overview_range(shifted, tangent_horizontal, tangent_vertical)
        box = _portrait_overview_projected_box(shifted, range_m, tangent_horizontal, tangent_vertical)
        if box is None:
            break
        min_x, max_x, min_y, max_y = box
        centre_x = (min_x + max_x) / 2
        centre_y = (min_y + max_y) / 2
        error = math.hypot(centre_x, centre_y)
        if best is None or error < best[0]:
            best = (error, offset_east, offset_north, range_m)
        if error <= PORTRAIT_OVERVIEW_RECENTER_TOLERANCE:
            break
        # `y` reads out as `north * sin(pitch) / depth`; at a pitch of zero there
        # is no vertical parallax to recentre, so the term is dropped rather than
        # divided by zero.
        north_gain = sin_pitch if sin_pitch > 1e-6 else 0.0
        offset_east += PORTRAIT_OVERVIEW_RECENTER_GAIN * centre_x * range_m * tangent_horizontal
        offset_north += (
            PORTRAIT_OVERVIEW_RECENTER_GAIN * (centre_y * range_m * tangent_vertical) / (north_gain or 1.0)
        )
    if best is None:
        return 0.0, 0.0, PORTRAIT_OVERVIEW_MINIMUM_RANGE_METERS
    return best[1], best[2], best[3]


def portrait_overview_camera(bounds: tuple[float, float, float, float]) -> dict[str, float]:
    """Portrait establishing camera that frames the whole boundary.

    The portrait establishing shot is derived from the boundary, never carried
    over from a previous import: `cameraProfiles.portrait` used to be preserved
    verbatim, which is how 草潭镇 440823113 kept a target 873 m west of its own
    centre after a boundary revision refreshed `bbox` and `cameraPreset` around
    it. The player derives the same frame from the geometry it draws ("portrait
    overview framing" in apps/cesium-player/public/runtime.js) and that derivation
    is what renders; this value is what a consumer reading the record alone sees.
    Both follow the same policy -- the extent fitted into
    PORTRAIT_OVERVIEW_SAFE_FRACTION of a 9:16 frame, evaluated at the near side of
    a camera pitched CAMERA_PITCH_DEGREES, with the target walked to the point
    that centres the drawn (not the geographic) extent.

    Evaluated on the bounding box rather than the ring: conservative, and the box
    is the only extent a record is guaranteed to carry.
    """
    west, south, east, north = bounds
    latitude = (south + north) / 2
    metres_per_degree_longitude = 111_320 * math.cos(math.radians(latitude))
    half_width_m = abs(east - west) * metres_per_degree_longitude / 2
    half_height_m = abs(north - south) * 110_570 / 2
    points = [
        (-half_width_m, -half_height_m),
        (half_width_m, -half_height_m),
        (half_width_m, half_height_m),
        (-half_width_m, half_height_m),
    ]
    offset_east, offset_north, range_m = _portrait_overview_target(points)
    return {
        "longitude": round((west + east) / 2 + offset_east / metres_per_degree_longitude, 7),
        "latitude": round(latitude + offset_north / 110_570, 7),
        "height": range_m,
        "heading": 0,
        "pitch": CAMERA_PITCH_DEGREES,
        "roll": 0,
    }


def portrait_overview_range(bounds: tuple[float, float, float, float]) -> int:
    """Slant range of the portrait establishing camera; see `portrait_overview_camera`."""
    return portrait_overview_camera(bounds)["height"]


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


def relative(path: Path) -> str:
    return path.relative_to(PROJECT_ROOT).as_posix()


def has_private_use(value: str) -> bool:
    return any("\ue000" <= char <= "\uf8ff" for char in value)


def main() -> int:
    # The studio reads both streams as UTF-8 and shows a failed import's message
    # to the operator; the inherited Windows encoding (cp936 on this machine)
    # turned every Chinese message into mojibake before it arrived.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):  # pragma: no cover - detached/odd streams
            pass

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
    parser.add_argument("--filter-field", help="Optional DBF field used to select records independently of the feature ID")
    parser.add_argument("--filter-prefix", help="Keep records whose --filter-field value starts with this prefix")
    parser.add_argument(
        "--code-index",
        help=(
            "TSV index of official village codes (build-village-code-index.py). "
            "Used to fill in an id field the source left blank, by unit name."
        )
    )
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
    if args.filter_field and args.filter_field not in field_names:
        raise SystemExit(f"Filter DBF field {args.filter_field!r} is missing; fields: {sorted(field_names)}")

    selected_records: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    private_use_errors: list[str] = []
    filtered_source_bbox = [math.inf, math.inf, -math.inf, -math.inf]
    # The town this import is scoped to, and its official unit table. Both are
    # only available when the caller said which town it is importing.
    town_code = ""
    if args.filter_field and args.filter_prefix:
        town_code = "".join(character for character in args.filter_prefix if character.isdigit())[:9]
    elif args.id_prefix and len("".join(character for character in args.id_prefix if character.isdigit())) >= 9:
        town_code = "".join(character for character in args.id_prefix if character.isdigit())[:9]
    official_units: dict[str, dict[str, str]] = {}
    if args.code_index and town_code:
        official_units = read_code_index(project_path(args.code_index), town_code)
    resolved_from_index: list[str] = []
    synthesized_units: list[str] = []

    for index, shape_record in enumerate(reader.iterShapeRecords()):
        record = shape_record.record.as_dict()
        town_scoped = False
        if args.filter_field and args.filter_prefix:
            filter_value = str(record.get(args.filter_field, "")).strip().removesuffix(".0")
            if not filter_value.startswith(args.filter_prefix):
                continue
            town_scoped = True
        feature_id = str(record.get(args.id_field, "")).strip()
        raw_name = str(record.get(args.name_field, "")).strip()
        id_source = "source-id-field"
        if not feature_id and official_units:
            official = official_units.get(village_name_key(raw_name))
            if official:
                feature_id = official["code"]
                id_source = "reference-code-index"
                resolved_from_index.append(f"{feature_id} {raw_name}")
        if args.id_prefix and not feature_id.startswith(args.id_prefix):
            continue
        if id_pattern and not id_pattern.fullmatch(feature_id):
            continue
        name = name_map.get(feature_id, raw_name)
        if "\ufffd" in feature_id or "\ufffd" in raw_name or "\ufffd" in name:
            raise SystemExit(
                f"Selected record {index} ({feature_id}) contains an undecodable replacement character; "
                "verify --encoding or provide a corrected --name-map"
            )
        if not feature_id:
            if not town_scoped:
                raise SystemExit(
                    f"Record {index} has no value in {args.id_field}, and this import does not say which town it "
                    "belongs to. Select the town with --filter-field/--filter-prefix, or pass --code-index so the "
                    "official code can be looked up by name (see build-village-code-index.py)."
                )
            # The source row is scoped to a verified town but carries no code, so
            # it is not an administrative unit with a code to recover - it is a
            # management unit (调风镇's 湖仔/仕礼/水库农场). Mint a stable,
            # deliberately non-official id and register it as supplemental, so
            # no administrative code is ever invented.
            feature_id = synthetic_unit_id(town_code or args.region_id, raw_name)
            id_source = "synthesized-management-unit"
            synthesized_units.append(f"{feature_id} {raw_name}")
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
            "idSource": id_source,
            "managementUnit": id_source == "synthesized-management-unit",
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
    # Units the source left without a code are management units by construction:
    # they keep their boundary and their name, stay out of the narrated tour, and
    # are listed separately so nothing presents them as administrative villages.
    for selected in selected_records:
        if not selected.get("managementUnit"):
            continue
        unit_id = selected["id"]
        supplemental_by_id[unit_id] = {
            "id": unit_id,
            "unitRole": "supplemental-management-unit",
            "classification": classify_management_unit(selected["name"]),
            "includedInTour": False
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
            "pitch": CAMERA_PITCH_DEGREES,
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
            "cameraProfiles": {
                "portrait": {**child_camera, "height": portrait_child_camera_height(geometry.bounds)}
            },
            "source": args.source_label,
            "sourceCrs": source_crs.to_string(),
            "sourceRecord": selected["sourceRecord"],
            "idSource": selected["idSource"],
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
    # Intersecting alone silently drops a unit whose id changed upstream: rename a
    # village in the source and the saved order still holds the old id, so the new
    # one matches nothing and that village disappears from the tour while remaining
    # a boundary unit. Keep the curated order for what survived, then append
    # whatever the source has that the order does not mention yet.
    tour_child_ids += [
        item_id
        for item_id in boundary_unit_ids
        if item_id not in tour_child_ids and item_id not in supplemental_by_id
    ]

    feature_by_id = {feature["properties"]["id"]: feature for feature in features}
    existing_coverage_children = {
        str(item["id"]): item
        for item in existing_coverage.get("children", [])
        if isinstance(item, dict) and item.get("id")
    }
    # The companion coverage manifest keeps the *editorial* tour order — the
    # curated "start at the seat, then walk the villages" sequence — which is not
    # the order the source file happens to list its features in. Rebuilding the
    # manifest from `tour_child_ids` silently replaced it on every re-import
    # (河头镇's tour ends at 虎溪村, not at the last row of the SHP).
    coverage_tour_ids = [
        str(item_id)
        for item_id in existing_coverage.get("tourChildIds") or []
        if str(item_id) in tour_child_ids
    ]
    coverage_tour_ids += [
        child_id for child_id in tour_child_ids if child_id not in coverage_tour_ids
    ]
    children = []
    for child_id in coverage_tour_ids:
        properties = feature_by_id[child_id]["properties"]
        existing_child = existing_coverage_children.get(child_id, {})
        children.append({
            **existing_child,
            "id": child_id,
            "name": properties["name"],
            "included": True,
            # A curated reason ("reliable SHP feature") distinguishes a source
            # feature from an inferred one; the generic wording is only for a
            # child that has no curated entry yet.
            "reason": existing_child.get("reason") or "SHP feature"
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
        "tourChildIds": coverage_tour_ids,
        "boundaryUnitIds": boundary_unit_ids,
        "children": children,
        "boundaryUnits": boundary_units,
        "supplementalUnits": supplemental_units
    }
    # `parentGeometryBasis` spells out how the township outline was derived, and
    # its "union-of-all-N-reliable-source-features" count is a fact about the
    # source that a re-import can change (河头镇 went from 13 units to 11). It is
    # regenerated only when the curated field already exists, so manifests that
    # never carried it are not given a null.
    basis = existing_coverage.get("parentGeometryBasis")
    if isinstance(basis, str) and "reliable-source-features" in basis:
        coverage["parentGeometryBasis"] = f"union-of-all-{len(boundary_unit_ids)}-reliable-source-features"
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
            "cameraPreset": properties["cameraPreset"],
            "cameraProfiles": properties["cameraProfiles"]
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
        "pitch": CAMERA_PITCH_DEGREES,
        "roll": 0
    }
    existing_camera_profiles = existing_region.get("cameraProfiles")
    if not isinstance(existing_camera_profiles, dict):
        existing_camera_profiles = {}
    # Portrait is recomputed, not carried over. Keeping the previous profile was
    # the whole bug: `center` above follows the boundary just read while the
    # preserved profile kept aiming at the boundary from an earlier import, so a
    # revision moved the subject off centre instead of the frame. Any other
    # profile an operator added by hand is still preserved verbatim.
    camera_profiles = {
        **existing_camera_profiles,
        "portrait": portrait_overview_camera(parent_geometry.bounds)
    }
    region_record = {
        **existing_region,
        "id": args.region_id,
        "name": args.region_name,
        # A curated title outlives a re-import: the caller's `--title` is a
        # default for a brand-new record, not an instruction to rename an
        # existing one back to the county-plus-town form.
        "title": existing_region.get("title") or args.title or f"地理图说·{args.region_name}",
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
        # Which ids came from where, and which official units of this town the
        # boundary source does not cover (调风镇's three 社区 are folded into
        # 调风村's polygon upstream, so they have no boundary of their own).
        "codeResolution": {
            "townCode": town_code,
            "codeIndex": relative(project_path(args.code_index)) if args.code_index else None,
            "resolvedFromIndex": resolved_from_index,
            "synthesizedManagementUnits": synthesized_units,
            "officialUnitsWithoutBoundary": sorted(
                f"{unit['code']} {unit['name']}"
                for unit in official_units.values()
                if unit["code"] not in boundary_unit_ids
            ) if official_units else []
        },
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
    summary: dict[str, Any] = {
        "ok": report["ok"],
        "regionId": args.region_id,
        "features": len(features),
        "report": relative(report_path)
    }
    if not report["ok"]:
        # The studio prints this verbatim when the import fails (see
        # `townImportFailureMessage`), so it has to explain itself on its own.
        summary["message"] = describe_failure(quality, simplification, overlap_ratio, relative(report_path))
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
