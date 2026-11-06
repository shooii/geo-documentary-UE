import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StudioAsset, VideoProject } from "../../packages/project-schema/index.js";
import { HttpError } from "./http-error.js";
import { isAnimatedGif, isStorableMediaExtension, sniffMediaType, unsupportedMediaReason } from "./media-sniff.js";
import { transcodeAnimatedGif } from "./media-transcode.js";

/** Ceiling for one streamed upload. Bigger than a phone clip, small enough that a
 *  runaway file cannot fill the workspace disk unnoticed. */
export const MAX_BINARY_ASSET_BYTES = 256 * 1024 * 1024;

export const UNSUPPORTED_ASSET_MESSAGE =
  "无法识别的素材格式：支持 PNG / JPEG / WebP / 动态 GIF，以及 MP4 / MOV / M4V / WebM 视频";

/**
 * How much of an upload is read back to identify it. A GIF's frame descriptors
 * are spread through the file, so the probe is generous enough to hold every
 * ordinary clip; a container signature itself lives in the first few bytes.
 */
const MEDIA_PROBE_BYTES = 16 * 1024 * 1024;

async function readFilePrefix(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const size = Math.min(limit, Number((await handle.stat()).size));
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, 0);
    return buffer;
  } finally { await handle.close(); }
}

/** Refuse an upload the library could not use, and say which way to fix it. */
function assertStorableUpload(
  signature: ReturnType<typeof sniffMediaType>,
  named: string
): asserts signature is NonNullable<ReturnType<typeof sniffMediaType>> {
  if (!signature) {
    throw new HttpError(415, unsupportedMediaReason(named) ?? UNSUPPORTED_ASSET_MESSAGE);
  }
  if (!isStorableMediaExtension(signature.extension)) {
    throw new HttpError(415, `${signature.extension.toUpperCase()} 目前不能作为成片素材，请转成 PNG / JPEG / WebP / GIF 图片或 MP4 / MOV / WebM 视频`);
  }
}

function displayNameOf(requestedName: string, fallback: string): string {
  const name = requestedName.trim();
  return name.replace(/\.[^.]+$/, "") || name || fallback;
}

/**
 * Write the sidecar for a file that is already sitting in the workspace assets
 * directory. The bytes decided the extension before this runs, which is what
 * keeps a stored name from ever disagreeing with its contents.
 */
async function recordAsset(
  assetsRoot: string,
  owner: Pick<VideoProject, "id" | "regionId">,
  stored: { filename: string; kind: "video" | "image" },
  requestedName: string,
  alt?: string
): Promise<StudioAsset> {
  const id = stored.filename.replace(/\.[^.]+$/, "");
  const displayName = displayNameOf(requestedName, id);
  const asset: StudioAsset = {
    id,
    name: displayName,
    path: `/workspace-assets/${stored.filename}`,
    type: stored.kind,
    sourceType: "user-provided",
    verifiedReal: true,
    prohibitedContent: false,
    alt: String(alt ?? "").trim() || displayName,
    scope: { regionId: owner.regionId, projectId: owner.id }
  };
  await writeFile(join(assetsRoot, `${id}.asset.json`), JSON.stringify(asset, null, 2), "utf8");
  return asset;
}

/**
 * Sniff one uploaded file, store it and write its sidecar.
 *
 * The bytes decide the extension; an animated GIF is transcoded to MP4 first so
 * it keeps moving in the film (a still `<img>` cannot be seeked, and the renderer
 * steps its clock frame by frame). The caller owns `temporary` and removes it.
 */
export async function storeUploadedFile(
  root: string,
  owner: Pick<VideoProject, "id" | "regionId">,
  temporary: string,
  requestedName: string,
  alt?: string,
  declaredType?: string
): Promise<StudioAsset> {
  const assetsRoot = join(root, "workspace", "assets");
  const head = await readFilePrefix(temporary, MEDIA_PROBE_BYTES);
  if (!head.length) throw new HttpError(400, "上传内容为空");
  const signature = sniffMediaType(head);
  assertStorableUpload(signature, requestedName || declaredType || "");
  await mkdir(assetsRoot, { recursive: true });
  let source = temporary;
  let extension = signature.extension;
  let kind = signature.kind;
  if (extension === "gif" && isAnimatedGif(head)) {
    const converted = `${temporary}.mp4`;
    await transcodeAnimatedGif(temporary, converted);
    source = converted;
    extension = "mp4";
    kind = "video";
  }
  const filename = `${randomUUID()}.${extension}`;
  await rename(source, join(assetsRoot, filename));
  return recordAsset(assetsRoot, owner, { filename, kind }, requestedName, alt);
}

/** Sniff, store and register one in-memory upload (the base64 route). */
export async function storeUploadedBuffer(
  root: string,
  owner: Pick<VideoProject, "id" | "regionId">,
  buffer: Buffer,
  requestedName: string,
  alt?: string,
  declaredType?: string
): Promise<StudioAsset> {
  const assetsRoot = join(root, "workspace", "assets");
  await mkdir(assetsRoot, { recursive: true });
  const temporary = join(assetsRoot, `.upload-${randomUUID()}`);
  await writeFile(temporary, buffer);
  try {
    return await storeUploadedFile(root, owner, temporary, requestedName, alt, declaredType);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
