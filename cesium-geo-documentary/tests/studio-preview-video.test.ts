import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// 「也支持视频预览啊」——场景预览画布上只有 <img id="previewAsset">，把 mp4 塞进
// <img src> 在浏览器里什么都不画，所以绑了视频素材的场景在预览里只能看到地图。
// 预览画布是「成片会长什么样」的权威表面，视频必须走 <video>，并且和成片同行为：
// 静音、循环、按素材窗口出现（旁白才是唯一声源）。
const root = process.cwd();

test("the scene preview canvas plays a video asset instead of feeding it to an <img>", async () => {
  const [html, client] = await Promise.all([
    readFile(resolve(root, "apps/studio/public/index.html"), "utf8"),
    readFile(resolve(root, "apps/studio/public/studio.js"), "utf8")
  ]);

  assert.match(html, /<video id="previewAssetVideo" class="preview-asset" hidden loop playsinline preload="auto"/);
  // 两个通道二选一：视频走 <video>，图片走 <img>，另一个必须隐藏并清源。
  assert.match(client, /function previewMediaElement\(\) \{/);
  assert.match(client, /return video && !video\.hidden \? video : \$\("previewAsset"\);/);
  assert.match(client, /function previewMediaReady\(media\) \{/);
  assert.match(client, /media\.readyState >= 2 && media\.videoWidth > 0/);
  assert.match(client, /const previewIsVideo = asset\?\.type === "video";/);
  assert.match(client, /previewAssetNode\.hidden = !asset \|\| isCover \|\| previewIsVideo;/);
  assert.match(client, /previewVideoNode\.hidden = !asset \|\| isCover \|\| !previewIsVideo;/);
  assert.match(client, /const previewAsset = previewIsVideo \? previewVideoNode : previewAssetNode;/);
  // 视频分支用 onloadeddata（首帧解码后才揭示），图片分支才用 onload。
  assert.match(client, /previewAsset\.onloadeddata = revealLoadedAsset;/);
  assert.match(client, /previewAsset\.muted = false;/);
  assert.match(client, /previewAsset\.volume = 0\.6;/);
  // 出现即从头循环播放，支持带入视频声音，被拦截时静音回退；收起即暂停。
  assert.match(client, /previewAsset\.currentTime = 0;/);
  assert.match(client, /previewAsset\.play\(\)\.catch\(/);
  assert.match(client, /previewAsset\.pause\(\);/);
});
