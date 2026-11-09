import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const STYLE_VERSION = 'v5';
const PIXELS = 2;
const PLATE_HEIGHT = 150 * PIXELS;
const BASE_FONT = 80 * PIXELS;
const SIDE_PADDING = 50 * PIXELS;
const MAX_WIDTH = 1280 * PIXELS;
const FONT_NAME = 'YouSheBiaoTiHei';
const fontFile = (root: string) => join(root, 'assets', 'fonts', `${FONT_NAME}.ttf`);
let fontRegistered = false;

function registerFont(root: string) {
  if (fontRegistered) return;
  try {
    GlobalFonts.registerFromPath(fontFile(root), FONT_NAME);
  } catch {
    // The plate still renders with the fallback font.
  }
  fontRegistered = true;
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
  measure.font = `${BASE_FONT}px ${FONT_NAME}`;
  let fontSize = BASE_FONT;
  let textWidth = measure.measureText(clean).width;
  let width = Math.ceil(textWidth + SIDE_PADDING * 2);
  if (width > MAX_WIDTH) {
    fontSize = Math.max(42, fontSize * (MAX_WIDTH - SIDE_PADDING * 2) / textWidth);
    measure.font = `${fontSize}px ${FONT_NAME}`;
    textWidth = measure.measureText(clean).width;
    width = Math.ceil(textWidth + SIDE_PADDING * 2);
  }
  width = Math.max(340 * PIXELS, width);

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
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(clean, 0, 0);
  ctx.restore();

  const png = canvas.toBuffer('image/png');
  await writeFile(file, png);
  return file;
}