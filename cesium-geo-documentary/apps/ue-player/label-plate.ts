import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const STYLE_VERSION = 'v7';
const PIXELS = 2;
const PLATE_HEIGHT = 150 * PIXELS;
const BASE_FONT = 78 * PIXELS;
const SIDE_PADDING = 50 * PIXELS;
const MAX_WIDTH = 1280 * PIXELS;
// One family for the whole film. The plaque used to be set in 优设标题黑 while the map
// labels were YaHei Bold and the subtitles were Noto Sans SC Bold, so the most prominent
// word on screen — a village's own name — was a third typeface again. It is Noto now,
// the same file the HUD rasterises and the same face the narration is subtitled in.
const FONT_NAME = 'NotoSansSC-Bold';
const fontFile = (root: string) => join(root, 'assets', 'fonts', 'NotoSansSC-Bold.ttf');
const LETTER_SPACING_EM = 0.045;

function registerFont(root: string) {
  if (GlobalFonts.has(FONT_NAME)) return;
  const path = fontFile(root);
  try {
    if (!GlobalFonts.registerFromPath(path, FONT_NAME) || !GlobalFonts.has(FONT_NAME)) {
      throw new Error('字体注册未成功');
    }
  } catch (cause) {
    throw new Error(`名牌字体 ${FONT_NAME} 加载失败：${path}。请恢复该字体文件，或预先全局注册同名字体；已禁止系统字体回退。`, { cause });
  }
}

function escapeFileName(name: string) {
  return name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_');
}

export async function labelPlate(root: string, name: string) {
  const clean = name.trim();
  if (!clean) return '';
  const key = createHash('sha1').update(`${STYLE_VERSION}:${clean}`).digest('hex').slice(0, 20);
  const dir = join(root, 'workspace', 'ue-label-plates');
  const file = join(dir, `${key}-${escapeFileName(clean).slice(0, 24)}.png`);
  try {
    await access(file);
    return file;
  } catch {
    // generate below
  }
  registerFont(root);
  await mkdir(dir, { recursive: true });

  const measure = createCanvas(8, 8).getContext('2d');
  let fontSize = BASE_FONT;
  const measureWidth = () => {
    measure.font = `${fontSize}px ${FONT_NAME}`;
    // 以像素设置字距；原生画布的 em 换算不一定使用当前字体大小。
    measure.letterSpacing = `${fontSize * LETTER_SPACING_EM}px`;
    return measure.measureText(clean).width;
  };
  let textWidth = measureWidth();
  const availableWidth = MAX_WIDTH - SIDE_PADDING * 2;
  while (textWidth > availableWidth) {
    // 保留一个栅格像素余量，避免字体尺寸量化后的宽度超过安全区。
    fontSize *= (availableWidth - 1) / textWidth;
    textWidth = measureWidth();
  }
  const width = Math.max(340 * PIXELS, Math.ceil(textWidth + SIDE_PADDING * 2));

  const canvas = createCanvas(width, PLATE_HEIGHT);
  const ctx = canvas.getContext('2d');
  const x0 = 4 * PIXELS, y0 = 4 * PIXELS, x1 = width - 4 * PIXELS, y1 = PLATE_HEIGHT - 4 * PIXELS;
  const big = 32 * PIXELS, small = 12 * PIXELS;
  const banner = () => {
    ctx.beginPath();
    ctx.moveTo(x0 + big, y0);
    ctx.lineTo(x1 - small, y0);
    ctx.quadraticCurveTo(x1, y0, x1, y0 + small);
    ctx.lineTo(x1, y1 - big);
    ctx.quadraticCurveTo(x1, y1, x1 - big, y1);
    ctx.lineTo(x0 + small, y1);
    ctx.quadraticCurveTo(x0, y1, x0, y1 - small);
    ctx.lineTo(x0, y0 + big);
    ctx.quadraticCurveTo(x0, y0, x0 + big, y0);
    ctx.closePath();
  };

  // Dark chip with a thin white edge: the reference reel's labels are quiet pills,
  // not glowing blue banners, so the region fill stays the loudest thing on screen.
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 12 * PIXELS;
  ctx.shadowOffsetY = 3 * PIXELS;
  banner();
  ctx.fillStyle = 'rgba(8, 12, 16, 0.74)';
  ctx.fill();
  ctx.restore();

  banner();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.86)';
  ctx.lineWidth = 2.4 * PIXELS;
  ctx.stroke();

  banner();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.lineWidth = 0.8 * PIXELS;
  ctx.stroke();

  const cx = width / 2, cy = PLATE_HEIGHT / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.font = `${fontSize}px ${FONT_NAME}`;
  // Noto is tighter than the display face it replaces; a breath of tracking keeps the
  // three or four characters of a village name from reading as one block.
  ctx.letterSpacing = `${fontSize * LETTER_SPACING_EM}px`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(clean, 0, 0);
  ctx.restore();

  const png = canvas.toBuffer('image/png');
  await writeFile(file, png);
  return file;
}