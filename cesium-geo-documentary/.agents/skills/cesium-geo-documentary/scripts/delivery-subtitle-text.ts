export function decodeCompositionText(html: string): string {
  return html
    .replaceAll(/<br\s*\/?\s*>/gi, "\n")
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll(/&(amp|lt|gt|quot|apos|#39);/g, (entity) => ({
      "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'"
    })[entity]!);
}

export function extractCaptionText(clip: string): string {
  // compose 的 wash 是 aria-hidden 高亮副本，只验证 ink；旧版字幕仍为纯文本。
  const ink = clip.match(/<span\b(?=[^>]*\bclass\s*=\s*(["'])(?:[^"']*\s)?subtitle-ink(?:\s[^"']*)?\1)[^>]*>([\s\S]*?)<\/span>/i);
  return decodeCompositionText(ink?.[2] ?? clip);
}
