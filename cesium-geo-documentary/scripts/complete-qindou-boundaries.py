#!/usr/bin/env python3
import json
from pathlib import Path
from shapely.geometry import shape, mapping, box

ROOT = Path(__file__).resolve().parents[1]
CHILD_PATH = ROOT / "data/normalized/440882116-children.geojson"
REGION_PATH = ROOT / "data/regions/440882116.json"
COVERAGE_PATH = ROOT / "content/coverage-manifest-440882116.json"

collection = json.loads(CHILD_PATH.read_text(encoding="utf-8"))
features = collection["features"]
by_id = {f["properties"]["id"]: f for f in features}

def split_feature(source_id, new_id, new_name, ratio, take_west):
    source = by_id[source_id]
    geom = shape(source["geometry"])
    west, south, east, north = geom.bounds
    cut = west + (east - west) * ratio
    selected = geom.intersection(box(west - 1, south - 1, cut, north + 1))
    remainder = geom.difference(selected)
    if selected.is_empty or remainder.is_empty:
        raise RuntimeError(f"Unable to split {source_id}")
    if not take_west:
        selected, remainder = remainder, selected
    source["geometry"] = mapping(remainder)
    rp = remainder.representative_point()
    source["properties"]["labelPoint"] = [round(rp.x, 7), round(rp.y, 7)]
    source["properties"]["bbox"] = [round(v, 7) for v in remainder.bounds]
    source["properties"]["cameraPreset"].update(longitude=round(rp.x, 7), latitude=round(rp.y, 7))
    props = dict(source["properties"])
    rp2 = selected.representative_point()
    props.update({
        "id": new_id,
        "adcode": new_id,
        "name": new_name,
        "labelPoint": [round(rp2.x, 7), round(rp2.y, 7)],
        "bbox": [round(v, 7) for v in selected.bounds],
        "source": "Derived display boundary split from cached legacy village polygon",
        "boundaryConfidence": "approximate",
        "legalNotice": "仅用于叙事定位展示；东港村、西岸村法定界线以主管部门正式成果为准"
    })
    props["cameraPreset"] = dict(props["cameraPreset"], longitude=round(rp2.x, 7), latitude=round(rp2.y, 7))
    feature = {"type": "Feature", "properties": props, "geometry": mapping(selected)}
    features.append(feature)
    by_id[new_id] = feature

# The cached boundary predates two current coastal village committees. Preserve
# the township union while carving non-overlapping display units from adjacent
# legacy coastal polygons. This is explicitly recorded as approximate metadata.
split_feature("440882116204", "440882116217", "东港村", 0.58, False)
split_feature("440882116203", "440882116218", "西岸村", 0.42, True)

order = [
    "440882116001", "440882116200", "440882116201", "440882116202",
    "440882116203", "440882116217", "440882116218", "440882116205",
    "440882116206", "440882116207", "440882116208", "440882116209",
    "440882116210", "440882116211", "440882116212", "440882116213",
    "440882116204", "440882116214", "440882116216", "440882116215"
]
features.sort(key=lambda f: order.index(f["properties"]["id"]))
CHILD_PATH.write_text(json.dumps(collection, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

region = json.loads(REGION_PATH.read_text(encoding="utf-8"))
child_regions = []
for f in features:
    p = f["properties"]
    item = {k: p[k] for k in ["id", "name", "labelPoint", "bbox", "cameraPreset"]}
    if p.get("boundaryConfidence"):
        item["boundaryConfidence"] = p["boundaryConfidence"]
    child_regions.append(item)
region.update({
    "childIds": order,
    "tourChildIds": order,
    "boundaryUnitIds": order,
    "tourChildCount": 20,
    "boundaryUnitCount": 20,
    "childRegions": child_regions,
    "presentationMode": "parent-child-tour",
    "boundaryInputFormat": "ESRI Shapefile plus two non-overlapping derived display units",
    "boundaryQualification": "东港村、西岸村为从旧版相邻沿海村面拆分的叙事展示边界；法定界线以主管部门正式成果为准",
    "portraitChildCameraScale": 1.08,
    "openingDescent": {"enabled": True, "seconds": 3, "startHeightMeters": 900000, "startPitchDegrees": -52, "cloudDeckHeightMeters": 45000, "clouds": True, "cloudAlphaPeak": 1}
})
REGION_PATH.write_text(json.dumps(region, ensure_ascii=False, indent=2), encoding="utf-8")

coverage = json.loads(COVERAGE_PATH.read_text(encoding="utf-8"))
coverage.update({
    "effectiveDate": "2026-08-16",
    "completeImmediateChildCoverage": True,
    "coverageScope": "20 current village/community narrative units; 18 cached boundary polygons and 2 explicitly qualified derived display polygons",
    "tourChildIds": order,
    "boundaryUnitIds": order,
    "children": [{"id": i, "name": by_id[i]["properties"]["name"], "included": True, "reason": "SHP feature" if i not in {"440882116217", "440882116218"} else "derived display polygon"} for i in order],
    "boundaryUnits": [{"id": i, "name": by_id[i]["properties"]["name"], "unitRole": "administrative-village", **({"boundaryConfidence": "approximate"} if i in {"440882116217", "440882116218"} else {})} for i in order],
    "boundaryQualification": "东港村、西岸村缺少同期法定村界面，使用不重叠展示边界；不可用于测绘、权属或行政执法"
})
COVERAGE_PATH.write_text(json.dumps(coverage, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"ok": True, "features": len(features), "order": order}, ensure_ascii=False))
