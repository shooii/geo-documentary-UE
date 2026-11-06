/**
 * A minimal, dependency-free SpreadsheetML (`.xlsx`) reader and writer.
 *
 * The Studio has to hand a whole scheme to a human in Excel and take it back.
 * The repository carries no spreadsheet dependency, and the round trip only
 * needs a few plain sheets, so this module implements exactly the parts of
 * OOXML that are involved: the ZIP container, inline-string and number cells, a
 * fixed style table (script-owned columns, text formatting, a header band).
 *
 *
 * Writer output is deliberately conservative — inline strings only, no shared
 * string table, no theme part, one style table — because every consumer (Excel,
 * WPS, LibreOffice) accepts that subset, and because it keeps the emitted XML
 * small enough to read by eye.
 *
 * It can also float encoded pictures inside cells (one anchor per image). Excel
 * and WPS only render a picture that is anchored to a cell, so an "image in a
 * cell" is really a one-cell anchor sized to that cell. `readXlsxImages` reads
 * those anchors back -- which is how a picture the operator pastes into the
 * sheet can become a real asset, the same way uploading it would.
 *
 * The reader cannot assume the file it gets back was written by this module: by
 * then Excel has re-saved it with shared strings, a theme, extra attributes and
 * its own style ids. So it walks the ZIP central directory itself and scans
 * cells tolerantly, resolving shared strings, inline strings, numbers, booleans
 * and formula results.
 */
import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";

export type SheetCellStyle = "header" | "lockedText" | "lockedNumber" | "text" | "number" | "note";

export interface SheetCell {
  value?: string | number | null;
  /** Defaults to `text`. `locked*` styles format script-owned columns as text/number. */
  style?: SheetCellStyle;
}

export interface SheetColumn {
  /** Column width in Excel's character units. */
  width: number;
}

export interface SheetValidation {
  /** A1-style range the dropdown applies to, e.g. `B2:B400`. */
  range: string;
  options: readonly string[];
}

/**
 * A picture anchored to a single cell. It is drawn at its own pixel size, so the
 * sheet has to be wide enough (column width) and tall enough (row height) for
 * the cell it targets; the caller owns both.
 */
export interface SheetImage {
  /** 0-based row index of the anchor cell. */
  row: number;
  /** 0-based column index of the anchor cell. */
  column: number;
  /** Encoded picture bytes, copied verbatim into `xl/media`. */
  data: Buffer;
  /** Package extension, which also selects the content type and part name. */
  extension: SheetImageExtension;
  /**
   * True for a thumbnail the caller generated from an existing asset (a preview)
   * rather than a picture the operator supplied. Previews are stamped with a
   * marker over their own bytes so a later import can recognise them; without
   * that distinction, reading the drawings back would turn every exported
   * thumbnail into a "new" asset on the next import.
   */
  preview?: boolean;
  /** Drawn width in pixels. */
  widthPx: number;
  /** Drawn height in pixels. */
  heightPx: number;
  /**
   * Offset from the anchor cell's top-left corner, in pixels. Lets a caller
   * centre a picture inside a cell that is larger than the picture, so a row of
   * mixed aspect ratios still reads as an aligned grid. Defaults to 0,0.
   */
  offsetXPx?: number;
  offsetYPx?: number;
}

/** Picture formats a sheet can carry as-is; the extension doubles as the part suffix. */
export type SheetImageExtension = "png" | "jpeg" | "gif" | "bmp" | "tiff" | "webp";

/** Prefix of the marker a generated preview carries over its own bytes. */
export const PREVIEW_MARKER_PREFIX = "wrk-preview:";

/** A picture's identity: the first 16 hex digits of the hash of its own bytes. */
export function pictureHash(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/**
 * The marker for one generated preview: a hash of that preview's own bytes.
 *
 * Self-referential on purpose. Storing merely "this is a preview" would be
 * defeated the moment the operator replaces the picture without the editor
 * renaming the shape -- a stale marker would then claim the new bytes were ours.
 * A hash of the bytes cannot be stale: it either matches what is inside the
 * shape or it does not.
 *
 * It rides in the shape's description, and the workbook ALSO records the same
 * hash as plain cell text, because a shape attribute is exactly the kind of
 * thing an editor may quietly drop while re-saving.
 */
export function previewMarker(data: Buffer): string {
  return PREVIEW_MARKER_PREFIX + pictureHash(data);
}

export interface SheetSpec {
  name: string;
  columns?: readonly SheetColumn[];
  rows: readonly (readonly SheetCell[])[];
  /** Explicit row height in points; a hole or `null` leaves the row auto-sized. */
  rowHeights?: readonly (number | null)[];
  validations?: readonly SheetValidation[];
  /** Pictures floated over cells. Import never reads them back. */
  images?: readonly SheetImage[];
  /**
   * Draw a thin grid around every populated cell — full inner and outer
   * borders. Only the data's own extent is boxed: the widest populated column
   * and, per row, the last populated cell decide where the grid stops, so
   * trailing empty rows and columns stay clean. A row with no value at all is
   * skipped entirely rather than left as a lone boxed rectangle.
   */
  border?: boolean;
}

export interface SheetTable {
  name: string;
  /** Cell values as text, indexed by row and then by column. Missing cells are `""`. */
  rows: string[][];
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";

/**
 * Fixed cell formats. Index order is the contract between `STYLE_INDEX`,
 * `STYLES_XML` and `cellXml`, so all three must change together.
 *   0 default                   4 editable text
 *   1 header band               5 editable number
 *   2 script text (wrapped)     6 note
 *   3 script number
 *
 * Indices 7-13 are the bordered twins of 0-6, selected per sheet by
 * `SheetSpec.border`. They exist as separate xf entries rather than a runtime
 * flag because OOXML has no per-cell border override: the border lives in the
 * xf the cell points at.
 */
const STYLE_INDEX: Record<SheetCellStyle, number> = {
  header: 1, lockedText: 2, lockedNumber: 3, text: 4, number: 5, note: 6
};

/** Offset added to a `STYLE_INDEX` entry when the sheet asks for borders. */
const BORDERED_STYLE_OFFSET = 7;

/** Every column index that actually carries data, as a `[first, last]` pair. */
function populatedColumnRange(sheet: SheetSpec): [number, number] | null {
  let first = Number.POSITIVE_INFINITY;
  let last = -1;
  for (const row of sheet.rows) {
    row.forEach((cell, index) => {
      const value = cell?.value;
      if (value === undefined || value === null || value === "") return;
      if (index < first) first = index;
      if (index > last) last = index;
    });
  }
  return last < 0 ? null : [first, last];
}

/**
 * The border always spans the same columns on every row — the sheet's first
 * through last populated column — so the grid forms one aligned rectangle
 * instead of a ragged right edge. A row with no value at all is skipped rather
 * than left as a lone boxed rectangle.
 */
function rowEndsAt(cells: readonly (SheetCell | undefined)[], lastColumn: number): number {
  for (let index = Math.min(lastColumn, cells.length - 1); index >= 0; index -= 1) {
    const value = cells[index]?.value;
    if (value !== undefined && value !== null && value !== "") return index;
  }
  return -1;
}

/** 2020-01-01 00:00:00 in MS-DOS packed time/date, so exports are byte-stable. */
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

function xmlEscape(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function columnName(index: number): string {
  let name = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function columnIndex(letters: string): number {
  let value = 0;
  for (const character of letters.toUpperCase()) value = value * 26 + (character.charCodeAt(0) - 64);
  return value - 1;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = -1;
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ -1) >>> 0;
}

const NUMERIC_TEXT = /^-?\d+(?:\.\d+)?$/;

function cellXml(cell: SheetCell | undefined, row: number, column: number, border = false): string {
  const reference = `${columnName(column)}${row + 1}`;
  const style = STYLE_INDEX[cell?.style ?? "text"] + (border ? BORDERED_STYLE_OFFSET : 0);
  const value = cell?.value;
  if (value === undefined || value === null || value === "") return `<c r="${reference}" s="${style}"/>`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `<c r="${reference}" s="${style}"/>`;
    return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
  }
  if ((cell?.style === "number" || cell?.style === "lockedNumber") && NUMERIC_TEXT.test(value)) {
    return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
  }
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function sheetXml(sheet: SheetSpec, drawingRelId: string | null = null): string {
  const columns = sheet.columns?.length
    ? `<cols>${sheet.columns.map((column, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const borderedRange = sheet.border ? populatedColumnRange(sheet) : null;
  const rows = sheet.rows
    .map((cells, index) => {
      const height = sheet.rowHeights?.[index];
      const attributes = height && height > 0 ? ` r="${index + 1}" ht="${height}" customHeight="1"` : ` r="${index + 1}"`;
      if (!borderedRange) {
        return `<row${attributes}>${cells.map((cell, column) => cellXml(cell, index, column)).join("")}</row>`;
      }
      // Rows keep the sheet's full data width so the grid is a clean rectangle
      // and a re-import sees every row at the same width it was written with.
      if (rowEndsAt(cells, borderedRange[1]) < 0) return `<row${attributes}/>`;
      const rendered: string[] = [];
      for (let column = borderedRange[0]; column <= borderedRange[1]; column += 1) {
        rendered.push(cellXml(cells[column], index, column, true));
      }
      return `<row${attributes}>${rendered.join("")}</row>`;
    })
    .join("");
  const validations = sheet.validations?.length
    ? `<dataValidations count="${sheet.validations.length}">${sheet.validations.map((entry) =>
        `<dataValidation type="list" allowBlank="1" showDropDown="0" sqref="${xmlEscape(entry.range)}">`
        + `<formula1>${xmlEscape(`"${entry.options.join(",")}"`)}</formula1></dataValidation>`).join("")}</dataValidations>`
    : "";
  const drawing = drawingRelId ? `<drawing r:id="${drawingRelId}"/>` : "";
  const namespaces = drawingRelId ? ` xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"` : ` xmlns="${MAIN_NS}"`;
  return `${XML_HEADER}<worksheet${namespaces}>${columns}<sheetData>${rows}</sheetData>${validations}${drawing}</worksheet>`;
}

const STYLES_XML = `${XML_HEADER}<styleSheet xmlns="${MAIN_NS}">`
  + '<fonts count="3">'
  + '<font><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/></font>'
  + '<font><sz val="11"/><color rgb="FF7A7A7A"/><name val="Calibri"/></font>'
  + "</fonts>"
  + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFEDF3F7"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
  + '<border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right>'
  + '<top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="14">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">'
  + '<alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1" applyProtection="1">'
  + '<alignment vertical="top" wrapText="1"/><protection locked="1"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1" applyProtection="1">'
  + '<alignment horizontal="center" vertical="center"/><protection locked="1"/></xf>'
  + '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1" applyProtection="1">'
  + '<alignment vertical="top" wrapText="1"/><protection locked="0"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1" applyProtection="1">'
  + '<alignment horizontal="center" vertical="center"/><protection locked="0"/></xf>'
  + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1" applyProtection="1">'
  + '<alignment vertical="top" wrapText="1"/><protection locked="1"/></xf>'
  // 7-13: the bordered twins of 0-6. Only the borderId differs, so a bordered
  // sheet reads identically to an unbordered one apart from its grid.
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">'
  + '<alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1" applyProtection="1">'
  + '<alignment vertical="top" wrapText="1"/><protection locked="1"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1" applyProtection="1">'
  + '<alignment horizontal="center" vertical="center"/><protection locked="1"/></xf>'
  + '<xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1" applyProtection="1">'
  + '<alignment vertical="top" wrapText="1"/><protection locked="0"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1" applyProtection="1">'
  + '<alignment horizontal="center" vertical="center"/><protection locked="0"/></xf>'
  + '<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1" applyProtection="1">'
  + '<alignment vertical="top" wrapText="1"/><protection locked="1"/></xf>'
  + "</cellXfs>"
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/>'
  + "</styleSheet>";

function zip(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const checksum = crc32(entry.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(deflated.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, deflated);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(DOS_TIME, 12);
    record.writeUInt16LE(DOS_DATE, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(deflated.length, 20);
    record.writeUInt32LE(entry.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += header.length + name.length + deflated.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, directory, end]);
}

const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const DRAWING_MAIN_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
/** English Metric Units per pixel at 96 dpi, the unit drawing anchors use. */
const EMU_PER_PIXEL = 9525;
/** Content type per picture extension; extension doubles as the media part suffix. */
const IMAGE_CONTENT_TYPES: Record<SheetImageExtension, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  webp: "image/webp"
};

function drawingAnchorXml(image: SheetImage, id: number, relationshipId: string): string {
  const cx = Math.max(1, Math.round(image.widthPx * EMU_PER_PIXEL));
  const cy = Math.max(1, Math.round(image.heightPx * EMU_PER_PIXEL));
  const offsetX = Math.max(0, Math.round((image.offsetXPx ?? 0) * EMU_PER_PIXEL));
  const offsetY = Math.max(0, Math.round((image.offsetYPx ?? 0) * EMU_PER_PIXEL));
  // The marker rides in the shape's description. The shape name stays a plain,
  // human-readable label: it is shown in the editor's selection pane, and the
  // workbook records the same hash as cell text anyway (see 预览指纹).
  const marker = image.preview ? previewMarker(image.data) : "";
  const name = image.preview ? `成片预览 ${image.row + 1}` : `图片 ${id}`;
  const description = marker ? ` descr="${marker}"` : "";
  return "<xdr:oneCellAnchor>"
    + `<xdr:from><xdr:col>${image.column}</xdr:col><xdr:colOff>${offsetX}</xdr:colOff>`
    + `<xdr:row>${image.row}</xdr:row><xdr:rowOff>${offsetY}</xdr:rowOff></xdr:from>`
    + `<xdr:ext cx="${cx}" cy="${cy}"/>`
    + "<xdr:pic><xdr:nvPicPr>"
    + `<xdr:cNvPr id="${id}" name="${xmlEscape(name)}"${description}/>`
    + '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>'
    + `<xdr:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
    + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>'
    + "</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>";
}

function drawingXml(anchors: readonly string[]): string {
  return `${XML_HEADER}<xdr:wsDr xmlns:xdr="${DRAWING_NS}" xmlns:a="${DRAWING_MAIN_NS}" xmlns:r="${REL_NS}">`
    + anchors.join("") + "</xdr:wsDr>";
}

function relationshipsXml(relationships: readonly string[]): string {
  return `${XML_HEADER}<Relationships xmlns="${PACKAGE_REL_NS}">${relationships.join("")}</Relationships>`;
}

export function writeXlsx(sheets: readonly SheetSpec[]): Buffer {
  if (!sheets.length) throw new Error("writeXlsx requires at least one sheet");
  const encoder = (value: string): Buffer => Buffer.from(value, "utf8");

  // Pictures need their own parts — a drawing, its relationship list, the media
  // binaries and a sheet relationship pointing at the drawing — so they are
  // collected first and laid into the package in a fixed order afterwards.
  const drawingParts: { name: string; data: Buffer }[] = [];
  const drawingOverrides: string[] = [];
  const mediaExtensions: SheetImageExtension[] = [];
  const sheetDrawingRelIds: (string | null)[] = sheets.map(() => null);
  let drawingCount = 0;
  let mediaCount = 0;
  sheets.forEach((sheet, index) => {
    const images = sheet.images ?? [];
    if (!images.length) return;
    drawingCount += 1;
    const drawingId = drawingCount;
    const drawingRelId = "rId1";
    sheetDrawingRelIds[index] = drawingRelId;
    const anchors: string[] = [];
    const imageRelationships: string[] = [];
    images.forEach((image, position) => {
      mediaCount += 1;
      if (!mediaExtensions.includes(image.extension)) mediaExtensions.push(image.extension);
      const mediaName = `image${mediaCount}.${image.extension}`;
      drawingParts.push({ name: `xl/media/${mediaName}`, data: image.data });
      const relationshipId = `rId${position + 1}`;
      imageRelationships.push(`<Relationship Id="${relationshipId}" Type="${REL_NS}/image" Target="../media/${mediaName}"/>`);
      anchors.push(drawingAnchorXml(image, position + 1, relationshipId));
    });
    drawingParts.push({ name: `xl/drawings/drawing${drawingId}.xml`, data: encoder(drawingXml(anchors)) });
    drawingParts.push({
      name: `xl/drawings/_rels/drawing${drawingId}.xml.rels`,
      data: encoder(relationshipsXml(imageRelationships))
    });
    drawingParts.push({
      name: `xl/worksheets/_rels/sheet${index + 1}.xml.rels`,
      data: encoder(relationshipsXml([
        `<Relationship Id="${drawingRelId}" Type="${REL_NS}/drawing" Target="../drawings/drawing${drawingId}.xml"/>`
      ]))
    });
    drawingOverrides.push(`<Override PartName="/xl/drawings/drawing${drawingId}.xml"`
      + ' ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>');
  });

  const overrides = sheets
    .map((_sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml"`
      + ' ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
    .join("");
  const contentTypes = `${XML_HEADER}<Types xmlns="${CONTENT_TYPES_NS}">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + mediaExtensions.map((extension) => `<Default Extension="${extension}" ContentType="${IMAGE_CONTENT_TYPES[extension]}"/>`).join("")
    + `<Override PartName="/xl/workbook.xml"`
    + ' ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + overrides
    + drawingOverrides.join("")
    + `<Override PartName="/xl/styles.xml"`
    + ' ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
  const rootRels = `${XML_HEADER}<Relationships xmlns="${PACKAGE_REL_NS}">`
    + `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const sheetsXml = sheets
    .map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join("");
  const workbook = `${XML_HEADER}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">`
    + `<bookViews><workbookView/></bookViews><sheets>${sheetsXml}</sheets></workbook>`;
  const workbookRels = `${XML_HEADER}<Relationships xmlns="${PACKAGE_REL_NS}">`
    + sheets.map((_sheet, index) =>
      `<Relationship Id="rId${index + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")
    + `<Relationship Id="rId${sheets.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`;
  const entries: { name: string; data: Buffer }[] = [
    { name: "[Content_Types].xml", data: encoder(contentTypes) },
    { name: "_rels/.rels", data: encoder(rootRels) },
    { name: "xl/workbook.xml", data: encoder(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder(workbookRels) },
    { name: "xl/styles.xml", data: encoder(STYLES_XML) }
  ];
  sheets.forEach((sheet, index) => {
    entries.push({ name: `xl/worksheets/sheet${index + 1}.xml`, data: encoder(sheetXml(sheet, sheetDrawingRelIds[index] ?? null)) });
  });
  entries.push(...drawingParts);
  return zip(entries);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff);
  for (let cursor = buffer.length - 22; cursor >= minimum; cursor--) {
    if (buffer.readUInt32LE(cursor) === 0x06054b50) return cursor;
  }
  throw new Error("无法解析表格文件：不是有效的 .xlsx 压缩包");
}

function parseZip(buffer: Buffer): Map<string, Buffer> {
  const end = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (entryCount === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    throw new Error("暂不支持 ZIP64 格式的表格文件，请用 Excel 另存为普通 .xlsx 后重试");
  }
  const files = new Map<string, Buffer>();
  let cursor = directoryOffset;
  const directoryEnd = directoryOffset + directorySize;
  for (let index = 0; index < entryCount && cursor + 46 <= directoryEnd; index++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("表格文件的 ZIP 目录已损坏");
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("暂不支持 ZIP64 格式的表格文件，请用 Excel 另存为普通 .xlsx 后重试");
    }
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`表格文件条目 ${name} 已损坏`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    if (method === 0) files.set(name, Buffer.from(raw));
    else if (method === 8) files.set(name, inflateRawSync(raw));
    else throw new Error(`表格文件使用了不支持的压缩方式（${method}）`);
  }
  return files;
}

/** Concatenated, still-escaped, contents of every `<t>` inside a fragment. */
function textParts(fragment: string): string {
  let text = "";
  for (const match of fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += match[1] ?? "";
  return text;
}

function parseSharedStrings(xml: string): string[] {
  const values: string[] = [];
  for (const match of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si(?:\s[^>]*)?\/>/g)) {
    values.push(decodeXmlText(textParts(match[1] ?? "")));
  }
  return values;
}

function parseRelationships(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of xml.matchAll(/<(?:\w+:)?Relationship(?:\s[^>]*)?\/>/g)) {
    const attributes = match[0];
    const id = /\bId="([^"]*)"/.exec(attributes)?.[1];
    const target = /\bTarget="([^"]*)"/.exec(attributes)?.[1];
    if (id && target) map.set(id, decodeXmlText(target));
  }
  return map;
}

function cellValue(type: string, body: string, shared: readonly string[]): string {
  if (type === "inlineStr") return decodeXmlText(textParts(body));
  const raw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1];
  if (raw === undefined) return "";
  if (type === "s") {
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 ? shared[index] ?? "" : "";
  }
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  return decodeXmlText(raw);
}

function parseSheet(xml: string, shared: readonly string[]): string[][] {
  const rows: string[][] = [];
  let currentRow = -1;
  let fallbackColumn = 0;
  const pattern = /<(?:\w+:)?row(?:\s[^>]*)?>|<(?:\w+:)?c(?:\s[^>]*)?\/>|<(?:\w+:)?c(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?c>/g;
  for (const match of xml.matchAll(pattern)) {
    const token = match[0];
    if (/^<(?:\w+:)?row/.test(token)) {
      const reference = /\br="(\d+)"/.exec(token)?.[1];
      currentRow = reference ? Number(reference) - 1 : currentRow + 1;
      if (currentRow < 0) currentRow = 0;
      rows[currentRow] ??= [];
      fallbackColumn = 0;
      continue;
    }
    if (currentRow < 0) {
      currentRow = 0;
      rows[0] ??= [];
    }
    const attributes = /^<(?:\w+:)?c\b((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/.exec(token)?.[1] ?? "";
    const reference = /\br="([A-Za-z]+)\d+"/.exec(attributes)?.[1];
    const column = reference ? columnIndex(reference) : fallbackColumn;
    fallbackColumn = column + 1;
    const type = /\bt="([^"]*)"/.exec(attributes)?.[1] ?? "";
    const row = rows[currentRow]!;
    while (row.length < column) row.push("");
    row[column] = cellValue(type, match[1] ?? "", shared);
  }
  // Excel and openpyxl omit <row> elements that carry no cells, which leaves
  // gaps in the index-keyed array. Densify so consumers can always iterate
  // rows without guarding against holes (Array.prototype.map would otherwise
  // propagate the gap into the result).
  const dense: string[][] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    dense.push(row ? row.map((cell) => cell ?? "") : []);
  }
  while (dense.length && dense[dense.length - 1]!.length === 0) dense.pop();
  return dense;
}

/**
 * Every part of the package, keyed by its path inside the ZIP. The round trip
 * only reads the sheets, but inspecting the rest — media, drawings, their
 * relationship parts — is how an export can prove it embedded the right
 * pictures.
 */
export function readXlsxPackage(buffer: Buffer): Map<string, Buffer> {
  return parseZip(buffer);
}

/** One picture floating over a cell, with the bytes the package stores for it. */
export interface SheetEmbeddedImage {
  /** Worksheet the picture floats over. */
  sheet: string;
  /**
   * 0-based anchor cell. A two-cell anchor (what Excel and WPS write when a
   * picture is pasted) reports the cell its top-left corner sits in.
   */
  row: number;
  column: number;
  /** Shape name as the editor recorded it; `""` when absent. */
  name: string;
  /** Shape description / alt text; `""` when absent. Carries the preview marker. */
  descr: string;
  /** Encoded picture bytes, exactly as stored under `xl/media`. */
  data: Buffer;
  /** Lower-case media extension, e.g. `png`. */
  extension: string;
}

/** Whether a shape's name or description claims the marker for these very bytes. */
function carriesPreviewMarker(name: string, descr: string, data: Buffer): boolean {
  const marker = previewMarker(data);
  return name.includes(marker) || descr.includes(marker);
}

/**
 * Whether this picture is a thumbnail this module wrote, rather than a picture
 * someone put there. Only the former may be ignored.
 */
export function isWrittenPreview(image: SheetEmbeddedImage): boolean {
  return carriesPreviewMarker(image.name, image.descr, image.data);
}

/** Resolve a relationship target (which may be `../media/x.png`) against a part. */
function resolvePartPath(baseDirectory: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = baseDirectory.split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

/** `xl/worksheets/sheet1.xml` -> `xl/worksheets/_rels/sheet1.xml.rels`. */
function relationPartPath(partPath: string): string {
  const slash = partPath.lastIndexOf("/");
  return `${partPath.slice(0, slash)}/_rels/${partPath.slice(slash + 1)}.rels`;
}

function shapeAttribute(attributes: string, name: string): string {
  return decodeXmlText(new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? "");
}

/**
 * Every picture embedded in the workbook, per sheet and anchor cell.
 *
 * Deliberately tolerant: a package with no drawings, a dangling relationship or
 * an anchor that is not attached to a cell (an `absoluteAnchor`) simply yields
 * fewer pictures. What it will not do is silently read a picture's *link* as if
 * it were its bytes -- a picture that only references an external file is
 * skipped, because there is nothing in the package to register.
 */
export function readXlsxImages(buffer: Buffer): SheetEmbeddedImage[] {
  const files = parseZip(buffer);
  const workbookXml = files.get("xl/workbook.xml")?.toString("utf8");
  if (!workbookXml) return [];
  const workbookRelationships = parseRelationships(files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "");
  const images: SheetEmbeddedImage[] = [];
  for (const match of workbookXml.matchAll(/<(?:\w+:)?sheet(?:\s[^>]*)?\/>/g)) {
    const sheetName = /(?:\b|\s)name="([^"]*)"/.exec(match[0])?.[1];
    const sheetRelId = /\b(?:\w+:)?id="([^"]*)"/.exec(match[0])?.[1];
    if (!sheetName || !sheetRelId) continue;
    const sheetTarget = workbookRelationships.get(sheetRelId);
    if (!sheetTarget) continue;
    const sheetPath = resolvePartPath("xl", sheetTarget);
    const sheetXml = files.get(sheetPath)?.toString("utf8");
    if (!sheetXml) continue;
    // `<drawing r:id="rId1"/>` is how a sheet points at its anchors.
    const drawingRelId = /<(?:\w+:)?drawing\b[^>]*?\b(?:\w+:)?id="([^"]+)"/.exec(sheetXml)?.[1];
    if (!drawingRelId) continue;
    const sheetRelationships = parseRelationships(files.get(relationPartPath(sheetPath))?.toString("utf8") ?? "");
    const drawingTarget = sheetRelationships.get(drawingRelId);
    if (!drawingTarget) continue;
    const drawingDirectory = sheetPath.slice(0, sheetPath.lastIndexOf("/"));
    const drawingPath = resolvePartPath(drawingDirectory, drawingTarget);
    const drawingXml = files.get(drawingPath)?.toString("utf8");
    if (!drawingXml) continue;
    const drawingRelationships = parseRelationships(files.get(relationPartPath(drawingPath))?.toString("utf8") ?? "");
    const anchors = drawingXml.matchAll(
      /<(?:\w+:)?(oneCellAnchor|twoCellAnchor|absoluteAnchor)(?:\s[^>]*)?>[\s\S]*?<\/(?:\w+:)?\1>/g
    );
    for (const anchor of anchors) {
      const xml = anchor[0];
      const embedId = /\b(?:\w+:)?embed="([^"]+)"/.exec(xml)?.[1];
      if (!embedId) continue;
      const mediaTarget = drawingRelationships.get(embedId);
      if (!mediaTarget) continue;
      const mediaPath = resolvePartPath(drawingPath.slice(0, drawingPath.lastIndexOf("/")), mediaTarget);
      const data = files.get(mediaPath);
      if (!data) continue;
      const from = /<(?:\w+:)?from>([\s\S]*?)<\/(?:\w+:)?from>/.exec(xml)?.[1] ?? "";
      const column = Number(/<(?:\w+:)?col>(\d+)<\/(?:\w+:)?col>/.exec(from)?.[1] ?? Number.NaN);
      const row = Number(/<(?:\w+:)?row>(\d+)<\/(?:\w+:)?row>/.exec(from)?.[1] ?? Number.NaN);
      if (!Number.isFinite(column) || !Number.isFinite(row)) continue;
      const shape = /<(?:\w+:)?cNvPr\b([^>]*)>/.exec(xml)?.[1] ?? "";
      images.push({
        sheet: decodeXmlText(sheetName),
        row,
        column,
        name: shapeAttribute(shape, "name"),
        descr: shapeAttribute(shape, "descr"),
        data,
        extension: (mediaPath.split(".").pop() ?? "").toLowerCase(),
      });
    }
  }
  return images;
}

export function readXlsx(buffer: Buffer): SheetTable[] {
  const files = parseZip(buffer);
  const workbook = files.get("xl/workbook.xml");
  if (!workbook) throw new Error("无法解析表格文件：缺少 xl/workbook.xml");
  const workbookXml = workbook.toString("utf8");
  const relationships = parseRelationships(files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "");
  const shared = parseSharedStrings(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "");
  const sheets: SheetTable[] = [];
  for (const match of workbookXml.matchAll(/<(?:\w+:)?sheet(?:\s[^>]*)?\/>/g)) {
    const attributes = match[0];
    const name = /(?:\b|\s)name="([^"]*)"/.exec(attributes)?.[1];
    const id = /\b(?:\w+:)?id="([^"]*)"/.exec(attributes)?.[1];
    if (!name || !id) continue;
    const target = relationships.get(id);
    if (!target) continue;
    const path = target.startsWith("/") ? target.slice(1) : target.startsWith("xl/") ? target : `xl/${target}`;
    const xml = files.get(path)?.toString("utf8");
    if (!xml) continue;
    sheets.push({ name: decodeXmlText(name), rows: parseSheet(xml, shared) });
  }
  if (!sheets.length) throw new Error("无法解析表格文件：工作簿里没有可读的工作表");
  return sheets;
}