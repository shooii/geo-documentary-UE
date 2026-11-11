import type { Page } from 'playwright';

export type SubtitleBounds = { left: number; top: number; right: number; bottom: number };
export type SubtitleWindow = { start: number; end: number; bounds: SubtitleBounds };

export function subtitleBounds(value: unknown): SubtitleBounds | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { left, top, right, bottom } = value as SubtitleBounds;
  if (![left, top, right, bottom].every(Number.isFinite) || left < 0 || top < 0 || right > 1 || bottom > 1 || right <= left || bottom <= top) return undefined;
  return { left, top, right, bottom };
}

// 时间窗使用地图捕获时钟，不是音频时钟或含封面的最终合成时钟。
export function activeSubtitleBounds(windows: readonly SubtitleWindow[], mapTime: number): SubtitleBounds | undefined {
  if (!Number.isFinite(mapTime)) return undefined;
  let active: SubtitleBounds | undefined;
  for (const window of windows) {
    if (mapTime < window.start || mapTime >= window.end) continue;
    const bounds = subtitleBounds(window.bounds);
    if (!bounds) continue;
    active = active ? { left: Math.min(active.left, bounds.left), top: Math.min(active.top, bounds.top), right: Math.max(active.right, bounds.right), bottom: Math.max(active.bottom, bounds.bottom) } : bounds;
  }
  return active;
}

// 从合成页读取真实字体排版。时间来自合成器已舍入的 data-start，不重算旁白/开场偏移。
export async function measureSubtitleWindows(page: Page): Promise<SubtitleWindow[]> {
  await page.evaluate(async () => {
    await document.fonts.load('700 56px "GeoSubtitle"');
    await document.fonts.ready;
  });
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('main[data-map-clock-offset]');
    if (!root) throw new Error('合成页缺少地图时钟偏移，无法确定字幕避让时间');
    const offset = Number(root.dataset.mapClockOffset);
    const frame = root.getBoundingClientRect();
    if (!Number.isFinite(offset) || !frame.width || !frame.height) throw new Error('合成页坐标无效');
    return Array.from(root.querySelectorAll<HTMLElement>('.subtitle')).map(box => {
      const inner = box.querySelector<HTMLElement>('.subtitle-inner');
      if (!inner) throw new Error('合成字幕缺少文字布局');
      // 清除GSAP入场位移，测量稳定位置；下边再覆盖8px入场运动包络。
      inner.style.transform = 'none';
      const rect = inner.getBoundingClientRect();
      const pad = (parseFloat(getComputedStyle(inner).fontSize) || 16) * .12;
      const start = Number(box.dataset.start) - offset;
      const end = box.dataset.activeEnd === undefined ? start + Number(box.dataset.duration) : Number(box.dataset.activeEnd) - offset;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !rect.width || !rect.height) throw new Error('合成字幕排版或时间窗无效');
      return { start, end, bounds: {
        left: Math.max(0, (rect.left - pad - frame.left) / frame.width),
        top: Math.max(0, (rect.top - pad - frame.top) / frame.height),
        right: Math.min(1, (rect.right + pad - frame.left) / frame.width),
        bottom: Math.min(1, (rect.bottom + pad + 8 - frame.top) / frame.height)
      } };
    });
  });
}

export function clearanceAlpha(distance: number, softDistance = 12): number {
  const t = Math.max(0, Math.min(1, distance / softDistance));
  return t * t * (3 - 2 * t);
}
