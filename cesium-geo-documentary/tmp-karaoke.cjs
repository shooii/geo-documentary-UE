// 1) 出一张改前/改后对照（同一帧、只差字影）
// 2) 用新字影重录字幕点亮动画
const { chromium } = require("playwright");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const ffmpeg = require("ffmpeg-static");

const source = fs.readFileSync(".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts", "utf8");
const pick = (anchor) => {
  const line = source.split("\n").find((l) => l.includes(anchor));
  if (!line) throw new Error("找不到 CSS 锚点: " + anchor);
  return line
    .trim()
    .replace(/\$\{subtitleBottomPx\}/g, "480")
    .replace(/\$\{isPortrait \? 50 : isSquare \? 44 : 46\}/g, "50")
    .replace(/\$\{isPortrait \? 900 : isSquare \? 920 : 1180\}/g, "900");
};

const subtitleCss = [pick(".subtitle{z-index:40"), pick(".subtitle-inner{position:relative")].join("\n");
const fontB64 = fs.readFileSync("assets/fonts/NotoSansSC-Medium.woff2").toString("base64");
const imageB64 = fs.readFileSync("workspace/karaoke-bg.png").toString("base64");

const W = 1080;
const H = 420;
const text = "这条水道养活了沿岸六个村庄";

const head = (totalH) => `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:"GeoSubtitle";src:url('data:font/woff2;base64,${fontB64}') format('woff2');font-weight:500;font-display:block}
html,body{margin:0;background:#050c11;color:#fff;font-family:"GeoSubtitle","Microsoft YaHei",sans-serif;overflow:hidden}
.stage{position:relative;width:${W}px;height:${H}px;overflow:hidden;
  background-image:url('data:image/png;base64,${imageB64}');background-size:${W}px 1920px;background-position:0 -940px}
.stage:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(4,10,15,.34),rgba(4,10,15,.1) 45%,rgba(4,10,15,.44))}
.clip{position:absolute}
${subtitleCss}
.subtitle{bottom:auto;top:${H / 2}px;transform:translate(-50%,-50%)}
.sheet{width:${W}px;height:${totalH}px}
.cap{height:30px;line-height:30px;padding-left:18px;color:#8fa6b0;font:500 15px/30px "Microsoft YaHei",sans-serif;letter-spacing:.06em}
/* 旧值：10px 光晕 + 92% 黑 */
.stage.old .subtitle{text-shadow:0 2px 10px rgba(0,0,0,.92),0 0 2px rgba(0,0,0,.7)}
`;

const block = (cls) => `<div class="stage ${cls}"><div class="clip subtitle">
<span class="subtitle-inner"><span class="subtitle-wash" aria-hidden="true">${text}</span><span class="subtitle-ink">${text}</span></span>
</div></div>`;

(async () => {
  const browser = await chromium.launch();

  // ---- 对照图 ----
  const totalH = (H + 30) * 2;
  const cmp = await browser.newPage({ viewport: { width: W, height: totalH }, deviceScaleFactor: 1 });
  await cmp.setContent(`${head(totalH)}</style><div class="sheet">
    <div class="cap">改前 · 字影 10px / 92% 黑</div>${block("old")}
    <div class="cap">改后 · 字影 5px / 50% 黑，填充纯白</div>${block("")}
  </div>`, { waitUntil: "load" });
  await cmp.evaluate(() => document.fonts.ready);
  await cmp.evaluate(() => {
    document.querySelectorAll(".subtitle-wash").forEach((el) => { el.style.clipPath = "inset(0 60% 0 0)"; });
  });
  await cmp.waitForTimeout(300);
  await cmp.screenshot({ path: "workspace/karaoke/shadow-compare.png", fullPage: true });
  await cmp.close();

  // ---- 动画 ----
  const FPS = 30, HOLD_IN = 0.5, SPEAK = 3.2, HOLD_OUT = 0.6;
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(`${head(H)}</style><div class="sheet">${block("")}</div>`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);

  const frames = "workspace/karaoke/frames";
  fs.rmSync(frames, { recursive: true, force: true });
  fs.mkdirSync(frames, { recursive: true });
  const count = Math.round((HOLD_IN + SPEAK + HOLD_OUT) * FPS);
  for (let i = 0; i < count; i += 1) {
    const t = i / FPS;
    const p = Math.max(0, Math.min(1, (t - HOLD_IN) / SPEAK));
    await page.evaluate((v) => { document.querySelector(".subtitle-wash").style.clipPath = `inset(0 ${(1 - v) * 100}% 0 0)`; }, p);
    await page.screenshot({ path: `${frames}/f_${String(i).padStart(3, "0")}.png` });
  }
  await browser.close();

  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(FPS), "-i", `${frames}/f_%03d.png`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "workspace/karaoke/subtitle-karaoke.mp4"]);
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(FPS), "-i", `${frames}/f_%03d.png`,
    "-vf", "fps=20,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer",
    "-loop", "0", "workspace/karaoke/subtitle-karaoke.gif"]);
  fs.rmSync(frames, { recursive: true, force: true });
  console.log("done", count + " frames");
})();
