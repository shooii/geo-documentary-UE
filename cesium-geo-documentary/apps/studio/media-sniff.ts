/**
 * Byte-level media identification for the asset library.
 *
 * The library used to trust whatever the browser put in the upload's MIME type
 * (or a hand-written extension list), and the two drifted apart: an AMap photo
 * whose CDN answered `application/octet-stream` was written as `.jpg` no matter
 * what its bytes were, and an animated GIF could not be stored at all even
 * though the workbook layer and Chromium both handle it.
 *
 * Identity is decided here from the bytes, and the returned `extension` is the
 * one the file is written with, so a stored name can never disagree with its
 * contents. Video containers are limited to what Chromium can actually play:
 * AVI, MKV, WMV and friends are named as unsupported instead of being stored as
 * a file that renders as nothing.
 */

import type { MediaKind } from "../../packages/content-engine/media.js";

export {
  isStorableMediaExtension,
  isWorkspaceAssetFileName,
  mediaKindForPath,
  unsupportedMediaReason,
  WORKSPACE_ASSET_EXTENSIONS
} from "../../packages/content-engine/media.js";

export interface MediaSignature {
  mime: string;
  extension: string;
  kind: MediaKind;
}

function ascii(buffer: Buffer, start: number, length: number): string {
  return buffer.subarray(start, start + length).toString("latin1");
}

function isoBmffBrand(buffer: Buffer): string {
  // `ftyp` box: size(4) type(4) major_brand(4) minor_version(4) ...
  if (buffer.length < 12 || ascii(buffer, 4, 4) !== "ftyp") return "";
  return ascii(buffer, 8, 4);
}

/**
 * Count the image descriptors in a GIF by walking its actual block structure.
 *
 * A naive `indexOf(0x2C)` also matches that byte inside LZW data, which is why
 * this walks the stream: header, logical screen descriptor, then extension and
 * image blocks with their sub-block chains until the trailer.
 */
export function countGifFrames(buffer: Buffer): number {
  if (buffer.length < 13) return 0;
  const header = ascii(buffer, 0, 6);
  if (header !== "GIF87a" && header !== "GIF89a") return 0;
  let cursor = 13; // header + logical screen descriptor
  const flags = buffer[10] ?? 0;
  if (flags & 0x80) cursor += 3 * (2 << (flags & 0x07)); // global colour table
  const skipSubBlocks = (from: number): number => {
    let at = from;
    while (at < buffer.length) {
      const size = buffer[at] ?? 0;
      at += 1;
      if (size === 0) break;
      at += size;
    }
    return at;
  };
  let frames = 0;
  while (cursor < buffer.length) {
    const marker = buffer[cursor];
    if (marker === 0x3b) break; // trailer
    if (marker === 0x2c) {
      frames += 1;
      const localFlags = buffer[cursor + 9] ?? 0;
      cursor += 10;
      if (localFlags & 0x80) cursor += 3 * (2 << (localFlags & 0x07));
      cursor = skipSubBlocks(cursor + 1); // LZW minimum code size, then data
      continue;
    }
    if (marker === 0x21) {
      cursor = skipSubBlocks(cursor + 2); // extension label, then data
      continue;
    }
    break;
  }
  return frames;
}

export function isAnimatedGif(buffer: Buffer): boolean {
  return countGifFrames(buffer) > 1;
}

export function sniffMediaType(buffer: Buffer): MediaSignature | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png", extension: "png", kind: "image" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", extension: "jpg", kind: "image" };
  }
  if (buffer.length >= 6) {
    const header = ascii(buffer, 0, 6);
    if (header === "GIF87a" || header === "GIF89a") return { mime: "image/gif", extension: "gif", kind: "image" };
  }
  if (buffer.length >= 12 && ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 4) === "WEBP") {
    return { mime: "image/webp", extension: "webp", kind: "image" };
  }
  // BMP and the ISO-BMFF image brands are recognised so a download is never
  // stored under an extension its bytes contradict; whether the library accepts
  // them is a separate question (see WORKSPACE_ASSET_EXTENSIONS).
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { mime: "image/bmp", extension: "bmp", kind: "image" };
  }
  if (buffer.length >= 12 && ascii(buffer, 4, 4) === "ftyp") {
    const imageBrand = ascii(buffer, 8, 4);
    if (/^(avif|avis)$/i.test(imageBrand)) return { mime: "image/avif", extension: "avif", kind: "image" };
    if (/^(heic|heix|hevc|hevx)$/i.test(imageBrand)) return { mime: "image/heic", extension: "heic", kind: "image" };
  }

  const brand = isoBmffBrand(buffer);
  if (brand) {
    if (/^qt\s\s$/i.test(brand)) return { mime: "video/quicktime", extension: "mov", kind: "video" };
    if (/^(isom|iso[2-9]|mp4[12]|avc1|dash|m4v|msnv|3gp[456]|3g2a|f4v|mmp4)$/i.test(brand.trim())) {
      return { mime: "video/mp4", extension: brand.trim().toLowerCase() === "m4v" ? "m4v" : "mp4", kind: "video" };
    }
    return null;
  }

  // Matroska and WebM share an EBML header; the DocType in the header decides
  // which one this is, and only WebM is playable in the browser.
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x1a45dfa3) {
    const head = ascii(buffer, 0, Math.min(buffer.length, 96)).toLowerCase();
    if (head.includes("webm")) return { mime: "video/webm", extension: "webm", kind: "video" };
    return null;
  }

  return null;
}

