import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PYTHON_SPAWN_OPTIONS, projectPythonRuntime } from "./python-runtime.js";

// 调风镇 (440882111) was appended to the Guangdong province table without the
// village code field filled in, so creating its plan died with
//   自动提取乡镇边界失败（exit 1）：Record 26180 has no value in PAC
// - an error that named a source row and no way forward. The importer now looks a
// blank id up by name in the official 2025 code table (--code-index), and treats
// a unit the table does not know as a management unit instead of inventing a
// twelve-digit code for it. These assertions are the contract for that split.
const root = process.cwd();
const script = join(root, ".agents", "skills", "cesium-geo-documentary", "scripts", "import-shapefile.py");
const codeIndex = join(root, "data", "regions", "2025全国行政区划编码", "village-code-index.tsv");
const sourceDbf = join(
  root,
  "data",
  "regions",
  "01【25096】全国村级行政边界数据",
  "广东村界",
  "广东全省",
  "广东省CJ.dbf"
);

const probe = String.raw`
import importlib.util
import json
import re
import tempfile
from pathlib import Path

import shapefile

root = Path.cwd()
spec = importlib.util.spec_from_file_location(
    "importer", root / ".agents/skills/cesium-geo-documentary/scripts/import-shapefile.py"
)
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)

report = {}

# 1. Administrative suffixes have to collapse, or the source SHP's short names
#    ("调风村") never compare equal to the code table's full ones ("调风村委会").
report["nameKeys"] = {
    "full": importer.village_name_key("调风村委会"),
    "short": importer.village_name_key("调风村"),
    "community": importer.village_name_key("大湖社区居委会"),
    "farm": importer.village_name_key("湖仔农场"),
}

# 2. The index is read per town and stops at the town boundary.
with tempfile.TemporaryDirectory() as tmp:
    index_path = Path(tmp) / "codes.tsv"
    index_path.write_text(
        "\n".join(
            [
                "440882111200\t440882111\t调风镇\t雷州市\t调风村委会\t122\t镇乡结合区",
                "440882111201\t440882111\t调风镇\t雷州市\t企树村委会\t220\t村庄",
                "440882112200\t440882112\t龙门镇\t雷州市\t龙门村委会\t121\t镇中心区",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    units = importer.read_code_index(index_path, "440882111")
    report["indexedTown"] = sorted(unit["code"] for unit in units.values())

# 3. A unit the code table does not carry is a management unit, and its id is a
#    stable, hyphenated key that cannot be mistaken for an administrative code.
report["classifications"] = {
    "farm": importer.classify_management_unit("湖仔农场"),
    "forest": importer.classify_management_unit("北坡林场"),
    "unknown": importer.classify_management_unit("三教村"),
}
first = importer.synthetic_unit_id("440882111", "湖仔农场")
report["synthetic"] = {
    "id": first,
    "stable": first == importer.synthetic_unit_id("440882111", "湖仔农场"),
    "distinct": first != importer.synthetic_unit_id("440882111", "水库农场"),
    "prefixed": first.startswith("440882111-"),
    "looksLikeCode": bool(re.fullmatch(r"\d{12}", first)),
}

# 4. Against the real dataset: 18 of the town's 21 rows recover an official code,
#    the three farms do not, and the three communities the boundary source never
#    drew stay visible in the report instead of being silently dropped.
dbf = root / "data/regions/01【25096】全国村级行政边界数据/广东村界/广东全省/广东省CJ.dbf"
index = root / "data/regions/2025全国行政区划编码/village-code-index.tsv"
if dbf.exists() and index.exists():
    units = importer.read_code_index(index, "440882111")
    reader = shapefile.Reader(str(dbf), encoding="gb18030")
    fields = [field[0] for field in reader.fields[1:]]
    resolved = []
    unresolved = []
    for record in reader.iterRecords():
        row = dict(zip(fields, record))
        if not str(row.get("乡镇码", "")).strip().startswith("440882111"):
            continue
        name = str(row.get("NAME", "")).strip()
        official = units.get(importer.village_name_key(name))
        if official:
            resolved.append(f"{name}={official['code']}")
        else:
            unresolved.append(name)
    unused = sorted(
        f"{unit['code']} {unit['name']}"
        for unit in units.values()
        if unit["code"] not in {item.split("=")[1] for item in resolved}
    )
    report["tiaofeng"] = {
        "resolved": len(resolved),
        "unresolved": sorted(unresolved),
        "unused": unused,
        "linzhai": [item for item in resolved if item.startswith("林宅村")],
    }
else:
    report["tiaofeng"] = None

# ensure_ascii keeps the pipe ASCII: the child's stdout encoding follows the
# Windows locale (cp936 here), so raw Chinese would reach Node as mojibake.
print(json.dumps(report))
`;

test("a blank village code is recovered from the official index, or kept as a management unit", () => {
  const runtime = projectPythonRuntime(root);
  const result = spawnSync(runtime.command, ["-c", probe], {
    cwd: root,
    env: runtime.env,
    encoding: "utf8",
    windowsHide: true,
    ...PYTHON_SPAWN_OPTIONS
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim()) as {
    nameKeys: Record<string, string>;
    indexedTown: string[];
    classifications: Record<string, string>;
    synthetic: Record<string, string | boolean>;
    tiaofeng: {
      resolved: number;
      unresolved: string[];
      unused: string[];
      linzhai: string[];
    } | null;
  };

  assert.equal(report.nameKeys.full, "调风");
  assert.equal(report.nameKeys.short, "调风");
  assert.equal(report.nameKeys.community, "大湖");
  assert.equal(report.nameKeys.farm, "湖仔农场", "a farm is not an administrative name and must not collapse");

  assert.deepEqual(report.indexedTown, ["440882111200", "440882111201"], "only the requested town is indexed");

  assert.equal(report.classifications.farm, "farm-management-unit");
  assert.equal(report.classifications.forest, "forest-farm-management-unit");
  assert.equal(report.classifications.unknown, "unclassified-management-unit");

  assert.equal(report.synthetic.prefixed, true);
  assert.equal(report.synthetic.stable, true);
  assert.equal(report.synthetic.distinct, true);
  assert.equal(report.synthetic.looksLikeCode, false, "a synthesized unit must never wear a twelve-digit code shape");

  assert.ok(report.tiaofeng, "the Guangdong source data is missing; the end-to-end half of this contract was skipped");
  assert.equal(report.tiaofeng.resolved, 18);
  assert.deepEqual(report.tiaofeng.unresolved, ["仕礼农场", "水库农场", "湖仔农场"]);
  assert.deepEqual(report.tiaofeng.linzhai, ["林宅村=440882111212"]);
  assert.deepEqual(
    report.tiaofeng.unused,
    [
      "440882111001 大湖社区居委会",
      "440882111002 下市桥社区居委会",
      "440882111003 丰收公司总部社区居委会"
    ],
    "the communities the source never drew must be reported, not invented"
  );
  assert.ok(existsSync(script), "the importer script must stay put");
  assert.ok(codeIndex.endsWith("village-code-index.tsv"));
});
