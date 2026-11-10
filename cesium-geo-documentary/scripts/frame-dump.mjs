// Dumps the frame JSON the studio preview actually sends to UE, so a missing HUD effect can
// be traced to the contract (what the page claims) or to the renderer (what it draws).
//
//   node scripts/frame-dump.mjs <sceneTitle> <seconds> [projectId]
//
// Plays the village segment for real (the studio only sends `tourStops` with a tour message)
// and samples every frame it sends afterwards.
import { chromium } from 'playwright';

const [title = '东莞村', at = '12', projectId] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  if (projectId) {
    await page.addInitScript((id) => {
      localStorage.setItem('geo-video-studio:last-project-id', id);
    }, projectId);
  }
  await page.goto('http://127.0.0.1:4180/', { waitUntil: 'domcontentloaded' });
  await page.locator('#timelineScenes .timeline-clip').first().waitFor({ timeout: 60000 });
  const projects = await fetch('http://127.0.0.1:4180/api/projects').then((r) => r.json());
  const project = projects.find((p) => p.scenes?.some((s) => s.title === title || s.childName === title));
  const scene = project?.scenes.find((s) => s.title === title || s.childName === title);
  if (!scene) throw new Error('scene not found: ' + title);
  await page.locator(`#timelineScenes [data-scene-id="${scene.id}"]`).click();
  const frame = await page.locator('#cesiumPreview').elementHandle().then((el) => el.contentFrame());
  await frame.waitForFunction(() => Boolean(window.geoVideo?.getDiagnostics().ready), {}, { timeout: 180000 });
  await frame.evaluate(() => {
    const original = RTCDataChannel.prototype.send;
    window.__samples = [];
    // UE's UI-interaction channel prepends a header to a UTF-16LE JSON body; find the body.
    const decode = (data) => {
      if (typeof data === 'string') return data;
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer);
      let start = 0;
      while (start + 1 < bytes.length && !(bytes[start] === 0x7b && bytes[start + 1] === 0)) start += 1;
      try { return new TextDecoder('utf-16le').decode(bytes.subarray(start)); } catch { return ''; }
    };
    RTCDataChannel.prototype.send = function (data) {
      const text = decode(data);
      if (text.includes('"frame"')) {
        try {
          const payload = JSON.parse(text);
          if (payload.action === 'apply-frame') window.__samples.push(payload.frame);
        } catch { /* partial */ }
      }
      return original.call(this, data);
    };
  });
  // Play the selected scene through the studio's own button: that is the only path
  // that ships `tourStops` to the player.
  await page.locator('#playButton').click();
  await page.waitForTimeout(Number(at) * 1000);
  const samples = await frame.evaluate(() => window.__samples.map((f) => ({
    t: Number(f.mapTime?.toFixed?.(2) ?? 0), current: f.current, alpha: f.trace?.alpha,
    progress: Number(f.trace?.progress?.toFixed?.(3) ?? 0),
    childReveal: f.childReveal, visited: (f.visitedIds ?? []).length, fills: Object.keys(f.fills ?? {}).length
  })));
  console.log('frames sampled', samples.length);
  const step = Math.max(1, Math.floor(samples.length / 8));
  console.log(JSON.stringify(samples.filter((s, i) => i % step === 0), null, 1));
} finally {
  await browser.close();
}
