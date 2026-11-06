import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { PYTHON_SPAWN_OPTIONS, projectPythonRuntime } from "./python-runtime.js";

const root = process.cwd();

test("Dongli township boundary is dissolved from the exact village boundary set", () => {
  const python = String.raw`
import json
from pathlib import Path
from shapely.geometry import shape
from shapely.ops import unary_union

root = Path.cwd()
region_id = "440882110"
parent = json.loads((root / "data" / "normalized" / f"{region_id}.geojson").read_text(encoding="utf-8"))
children = json.loads((root / "data" / "normalized" / f"{region_id}-children.geojson").read_text(encoding="utf-8"))
region = json.loads((root / "data" / "regions" / f"{region_id}.json").read_text(encoding="utf-8"))
manifest = json.loads((root / "content" / f"coverage-manifest-{region_id}.json").read_text(encoding="utf-8"))

parent_feature = parent["features"][0]
parent_geom = shape(parent_feature["geometry"])
child_union = unary_union([shape(feature["geometry"]) for feature in children["features"]])
difference_area = parent_geom.symmetric_difference(child_union).area

assert len(children["features"]) == 20, len(children["features"])
assert difference_area <= 1e-12, difference_area
assert parent_feature["properties"]["parentDerivation"] == "union-of-child-village-features"
assert region["parentBoundaryMethod"] == "union-of-child-village-features"
assert manifest["parentMatchesChildUnion"] is True
print(json.dumps({"children": len(children["features"]), "differenceArea": difference_area}))
`;
  const runtime = projectPythonRuntime(root);
  const result = spawnSync(runtime.command, ["-c", python], {
    cwd: root,
    env: runtime.env,
    encoding: "utf8",
    windowsHide: true,
    ...PYTHON_SPAWN_OPTIONS
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim()) as { children: number; differenceArea: number };
  assert.equal(report.children, 20);
  assert.ok(report.differenceArea <= 1e-12);
});
