/**
 * What a media file's extension means to the pipeline.
 *
 * This lives in `packages/` on purpose: the Studio registers assets from the
 * upload route while the compositor classifies them again when it builds the
 * composition HTML, and the export runs inside a sandbox that links `packages/`
 * but not `apps/studio/`. One table, two consumers - the alternative is the kind
 * of duplicated constant that has drifted before (see `sectionRank`).
 */

export type MediaKind = "image" | "video";

/** Still and animated pictures a scene visual may be. */
export const STORABLE_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"] as const;

/** Video containers Chromium can actually play back in the composition. */
export const STORABLE_VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm"] as const;

/** Extensions `/workspace-assets/<name>` may carry. */
export const WORKSPACE_ASSET_EXTENSIONS = [...STORABLE_IMAGE_EXTENSIONS, ...STORABLE_VIDEO_EXTENSIONS] as const;

/** Containers the pipeline recognises but refuses, with a reason to act on. */
export const UNPLAYABLE_VIDEO_EXTENSIONS = [
  "avi", "mkv", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts", "rm", "rmvb", "3gp", "vob", "asf", "ogv"
] as const;

export function extensionOf(pathOrName: string): string {
  const name = pathOrName.trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1);
}

/** Video containers play; everything else in the library is a picture. */
export function mediaKindForPath(path: string): MediaKind {
  return (STORABLE_VIDEO_EXTENSIONS as readonly string[]).includes(extensionOf(path)) ? "video" : "image";
}

/** Whether a stored `/workspace-assets/<file>` name may be served and listed. */
export function isWorkspaceAssetFileName(fileName: string): boolean {
  const match = /^[a-zA-Z0-9_-]+\.([a-zA-Z0-9]+)$/.exec(fileName);
  if (!match) return false;
  return (WORKSPACE_ASSET_EXTENSIONS as readonly string[]).includes(match[1]!.toLowerCase());
}

/**
 * Whether an identified format is one the library stores. Identifying a format
 * and accepting it are different questions: an AVIF can be correctly recognised
 * and still not be usable as a scene visual, and storing it anyway would mint an
 * asset the library scan then silently filters out.
 */
export function isStorableMediaExtension(extension: string): boolean {
  return (WORKSPACE_ASSET_EXTENSIONS as readonly string[]).includes(extension.trim().toLowerCase());
}

/**
 * Explain a file the sniffer refused, when its extension names a container we
 * know is not playable. Returns null when there is nothing to add beyond
 * "unrecognised".
 */
export function unsupportedMediaReason(fileNameOrExtension: string): string | null {
  const extension = extensionOf(fileNameOrExtension);
  if (!(UNPLAYABLE_VIDEO_EXTENSIONS as readonly string[]).includes(extension)) return null;
  return `暂不支持 .${extension} 视频（浏览器无法播放），请先转成 MP4 / MOV / WebM`;
}
