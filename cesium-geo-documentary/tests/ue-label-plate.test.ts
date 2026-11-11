import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { labelPlate } from '../apps/ue-player/label-plate.js';

const FONT_NAME = 'NotoSansSC-Bold';
const FONT_PATH = resolve('assets/fonts/NotoSansSC-Bold.ttf');

async function temporaryRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ue-label-plate-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('名牌字体加载失败可诊断且不锁死后续注册', async t => {
  await temporaryRoot(async root => {
    assert.equal(GlobalFonts.has(FONT_NAME), false);
    const expected = (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /名牌字体 NotoSansSC-Bold 加载失败/);
      assert.ok(error.message.includes(join(root, 'assets', 'fonts', 'NotoSansSC-Bold.ttf')));
      assert.match(error.message, /禁止系统字体回退/);
      assert.ok(error.cause instanceof Error);
      return true;
    };
    await assert.rejects(labelPlate(root, '测试村'), expected);
    const register = t.mock.method(GlobalFonts, 'registerFromPath', () => null);
    await assert.rejects(labelPlate(root, '测试村'), expected);
    register.mock.mockImplementation(() => { throw new Error('无效字体文件'); });
    await assert.rejects(labelPlate(root, '测试村'), expected);
    register.mock.restore();
    assert.ok(GlobalFonts.registerFromPath(FONT_PATH, FONT_NAME));
    assert.ok(await labelPlate(root, '测试村'));
  });
});

test('预先全局注册的同名字体不要求根目录存在字体文件', async t => {
  assert.ok(GlobalFonts.registerFromPath(FONT_PATH, FONT_NAME));
  await temporaryRoot(async root => {
    const register = t.mock.method(GlobalFonts, 'registerFromPath', () => {
      throw new Error('不应重复注册');
    });
    const file = await labelPlate(root, '示例村');
    assert.ok((await readFile(file)).length > 0);
    assert.equal(register.mock.callCount(), 0);
    assert.equal(await labelPlate(root, ' 示例村 '), file);
    assert.equal(await labelPlate(root, '  '), '');
  });
});

for (const [description, name] of [
  ['正常短名', '示例村'],
  ['长中文名', '青山绿水风景文化生态旅游特色村落'],
  ['超长中文名', '青山绿水风景文化生态旅游特色村落'.repeat(5)],
] as const) {
  test(`${description}完整绘制并保留二倍像素及含字距的安全留白`, async t => {
    assert.ok(GlobalFonts.registerFromPath(FONT_PATH, FONT_NAME));
    await temporaryRoot(async root => {
      const context = createCanvas(8, 8).getContext('2d');
      const prototype = Object.getPrototypeOf(context);
      const original = context.fillText;
      let draw: { text: string; size: number; spacing: number; width: number } | undefined;
      t.mock.method(prototype, 'fillText', function (this: typeof context, text: string, x: number, y: number) {
        draw = {
          text,
          size: parseFloat(this.font),
          spacing: parseFloat(this.letterSpacing),
          width: this.measureText(text).width,
        };
        return original.call(this, text, x, y);
      });
      const file = await labelPlate(root, name);
      const image = await loadImage(file);
      assert.ok(draw);
      assert.equal(draw.text, name);
      assert.equal(image.height, 150 * 2);
      assert.ok(image.width <= 1280 * 2);
      assert.ok(image.width >= 340 * 2);
      assert.ok(Math.abs(draw.spacing - draw.size * 0.045) < 0.001);
      assert.ok(draw.width <= image.width - 50 * 2 * 2);
      if (description === '正常短名') {
        assert.equal(draw.size, 78 * 2);
        context.font = `${draw.size}px ${FONT_NAME}`;
        context.letterSpacing = '0px';
        assert.ok(draw.width > context.measureText(name).width + 15);
      } else {
        assert.ok(draw.size < 78 * 2);
        if (description === '超长中文名') assert.ok(draw.size < 42);
      }
      const raster = createCanvas(image.width, image.height).getContext('2d');
      raster.drawImage(image, 0, 0);
      const { data } = raster.getImageData(0, 0, image.width, image.height);
      let minX = image.width, maxX = -1;
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          const i = (y * image.width + x) * 4;
          if (data[i]! >= 245 && data[i + 1]! >= 245 && data[i + 2]! >= 245 && data[i + 3]! >= 245) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
          }
        }
      }
      assert.ok(maxX > minX, '应存在完整的白色文字像素');
      assert.ok(minX >= 50 * 2 && maxX < image.width - 50 * 2, '文字像素不侵入横向安全留白');
    });
  });
}
