#!/usr/bin/env python3
"""Extract the official village/community code table into a flat TSV index.

Why this exists
---------------
The production boundary SHP is authoritative for *geometry*, but some towns in it
were appended without their `PAC` (village code) field filled in - 调风镇
(440882111) is one: its 21 rows carry a town code and a name, and nothing else.
`import-shapefile.py` cannot mint a child id from a blank field, so project
creation died with `Record 26180 has no value in PAC`.

The 2025 行政区划编码 workbook (data/regions/2025全国行政区划编码) does carry those
codes, so this script flattens it into a small, streamable index the importer can
consult by name. It deliberately uses only the standard library: the project's
managed interpreters ship pyshp/pyproj/Shapely and nothing that reads `.xlsx`.

The output is derived data and lives in the gitignored `data/` tree. Rebuild it
whenever the workbook changes:

    python .agents/skills/cesium-geo-documentary/scripts/build-village-code-index.py
"""

from __future__ import annotations

import argparse
import gzip
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree

PROJECT_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_WORKBOOK = (
    PROJECT_ROOT
    / "data"
    / "regions"
    / "2025全国行政区划编码"
    / "省市区县街道乡镇居委会 - 汇总数据.xlsx"
)
DEFAULT_OUTPUT = (
    PROJECT_ROOT / "data" / "regions" / "2025全国行政区划编码" / "village-code-index.tsv"
)

MAIN_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PACKAGE_REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"

# Header names of the worksheet, in order. Two of them repeat, so the column
# indices are resolved from the whole sequence rather than from a single name.
HEADER = [
    "省份",
    "行政区域代码",
    "地级行政区",
    "行政区域代码",
    "区县行政区",
    "行政区域代码",
    "乡、镇、街道",
    "行政区域代码",
    "居委会",
    "行政区域代码",
    "城乡分类代码",
    "城乡分类",
]
FALLBACK_COLUMNS = {
    "cityName": 2,
    "countyName": 4,
    "townName": 6,
    "townCode": 7,
    "unitName": 8,
    "unitCode": 9,
    "urbanRuralCode": 10,
    "urbanRural": 11,
}


def column_index(letter: str) -> int:
    """A1-style column reference -> zero-based index ("A" -> 0, "AA" -> 26)."""
    value = 0
    for character in letter:
        if not character.isalpha():
            break
        value = value * 26 + (ord(character.upper()) - ord("A") + 1)
    return value - 1


def sheet_part(archive: zipfile.ZipFile, sheet_name: str | None) -> str:
    """Resolve the worksheet part for a sheet name (first sheet when unnamed)."""
    workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
    relationships = ElementTree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {
        relation.get("Id"): relation.get("Target")
        for relation in relationships
        if relation.get("Id") and relation.get("Target")
    }
    for sheet in workbook.iter(f"{MAIN_NS}sheet"):
        name = sheet.get("name")
        if sheet_name and name != sheet_name:
            continue
        target = targets.get(sheet.get(f"{REL_NS}id"), "")
        if not target:
            continue
        return target[1:] if target.startswith("/") else f"xl/{target.lstrip('/')}"
    raise SystemExit(f"Worksheet {sheet_name!r} not found in the workbook")


def read_shared_strings(archive: zipfile.ZipFile) -> list[str]:
    """Load xl/sharedStrings.xml into a list (33 MB for this workbook)."""
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    values: list[str] = []
    with archive.open("xl/sharedStrings.xml") as stream:
        for event, element in ElementTree.iterparse(stream, events=("end",)):
            if element.tag != f"{MAIN_NS}si":
                continue
            # A shared string is a run list; concatenating every text node keeps
            # rich-text cells ("大湖社区" split across runs) intact.
            values.append("".join(node.text or "" for node in element.iter(f"{MAIN_NS}t")))
            element.clear()
    return values


def cell_text(cell: ElementTree.Element, shared: list[str]) -> str:
    kind = cell.get("t")
    if kind == "inlineStr":
        return "".join(node.text or "" for node in cell.iter(f"{MAIN_NS}t")).strip()
    value = cell.find(f"{MAIN_NS}v")
    text = (value.text or "") if value is not None else ""
    if kind == "s":
        try:
            return shared[int(text)].strip()
        except (IndexError, ValueError):
            return ""
    return text.strip()


def digits(value: str) -> str:
    return "".join(character for character in value if character.isdigit())


def extract(workbook_path: Path, sheet_name: str | None) -> list[tuple[str, str, str, str, str, str, str]]:
    rows: list[tuple[str, str, str, str, str, str, str]] = []
    with zipfile.ZipFile(workbook_path) as archive:
        shared = read_shared_strings(archive)
        part = sheet_part(archive, sheet_name)
        columns = dict(FALLBACK_COLUMNS)
        header_seen = False
        with archive.open(part) as stream:
            for event, element in ElementTree.iterparse(stream, events=("end",)):
                if element.tag != f"{MAIN_NS}row":
                    continue
                cells: dict[int, str] = {}
                for cell in element.iter(f"{MAIN_NS}c"):
                    reference = cell.get("r") or ""
                    index = column_index(reference) if reference else -1
                    if index >= 0:
                        cells[index] = cell_text(cell, shared)
                element.clear()
                if not cells:
                    continue
                if not header_seen:
                    header_seen = True
                    names = [cells.get(index, "") for index in range(len(HEADER))]
                    if names == HEADER:
                        continue
                    # An unexpected header still yields a usable table through
                    # the documented fallback layout.
                    continue
                unit_code = digits(cells.get(columns["unitCode"], ""))
                # Both the unit and the town column carry full 12-digit codes
                # (440882111001 / 440882111000); the importer keys on the
                # nine-digit town code, so normalise here.
                town_code = digits(cells.get(columns["townCode"], ""))
                if len(unit_code) != 12 or len(town_code) < 9:
                    continue
                town_code = town_code[:9]
                rows.append(
                    (
                        unit_code,
                        town_code,
                        cells.get(columns["townName"], ""),
                        cells.get(columns["countyName"], ""),
                        cells.get(columns["unitName"], ""),
                        cells.get(columns["urbanRuralCode"], ""),
                        cells.get(columns["urbanRural"], ""),
                    )
                )
    return rows


def write_index(rows: list[tuple[str, str, str, str, str, str, str]], output: Path) -> None:
    rows.sort(key=lambda item: (item[0], item[4]))
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = "\n".join("\t".join(row) for row in rows) + "\n"
    if output.suffix == ".gz":
        with gzip.open(output, "wt", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
    else:
        output.write_text(payload, encoding="utf-8", newline="\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workbook", default=str(DEFAULT_WORKBOOK))
    parser.add_argument("--sheet", default=None)
    parser.add_argument("--out", default=str(DEFAULT_OUTPUT))
    args = parser.parse_args()

    workbook_path = Path(args.workbook)
    if not workbook_path.is_absolute():
        workbook_path = PROJECT_ROOT / workbook_path
    if not workbook_path.exists():
        raise SystemExit(f"Workbook not found: {workbook_path}")
    output = Path(args.out)
    if not output.is_absolute():
        output = PROJECT_ROOT / output

    rows = extract(workbook_path, args.sheet)
    if not rows:
        raise SystemExit("No village rows extracted; check --sheet and the workbook layout")
    write_index(rows, output)
    towns = {row[1] for row in rows}
    sys.stdout.write(
        f"VILLAGE_CODE_INDEX ok units={len(rows)} towns={len(towns)} out={output}\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
