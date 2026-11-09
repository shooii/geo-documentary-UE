import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const STYLE_VERSION = 'v4';
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

  // Outer cyan glow, then the navy fill.
  ctx.save();
  ctx.shadowColor = 'rgba(111, 220, 255, 0.72)';
  ctx.shadowBlur = 16 * PIXELS;
  ctx.strokeStyle = 'rgba(111, 220, 255, 0.9)';
  ctx.lineWidth = 3 * PIXELS;
  banner();
  ctx.stroke();
  ctx.restore();

  const fill = ctx.createLinearGradient(0, y0, 0, y1);
  fill.addColorStop(0, '#0b3158');
  fill.addColorStop(0.55, '#062743');
  fill.addColorStop(1, '#04182e');
  banner();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = '#8fe6ff';
  ctx.lineWidth = 3.5 * PIXELS;
  ctx.stroke();

  banner();
  ctx.strokeStyle = 'rgba(215, 247, 255, 0.52)';
  ctx.lineWidth = 0.9 * PIXELS;
  ctx.stroke();

  const cx = width / 2, cy = PLATE_HEIGHT / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.transform(1, 0, -0.21, 1, 0, 0);
  ctx.font = `${fontSize}px ${FONT_NAME}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = ctx.createLinearGradient(0, -fontSize * .6, 0, fontSize * .6);
  text.addColorStop(0, '#ffffff');
  text.addColorStop(1, '#b5e8ff');
  ctx.fillStyle = text;
  ctx.shadowColor = 'rgba(130, 225, 255, 0.55)';
  ctx.shadowBlur = 7 * PIXELS;
  ctx.fillText(clean, 0, 0);
  ctx.restore();

  const png = canvas.toBuffer('image/png');
  await writeFile(file, png);
  return file;
}