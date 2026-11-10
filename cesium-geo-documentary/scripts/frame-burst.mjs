// Burst-captures the running UE preview and reports how much golden beam shows up in each
// frame, so a beam that only flashes for part of its orbit can be told apart from one that
// never draws at all.
//
//   node scripts/frame-burst.mjs <sceneTitle> <seconds> [projectId]
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const [title = '东莞村', seconds = '8', projectId] = process.argv.slice(2);
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
  await page.locator('#playButton').click();
  const shot = async () => frame.evaluate(() => {
    const video = document.querySelector('video');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let gold = 0, yellow = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 170 && g > 130 && g < 245 && b < 130 && r - b > 80 && g - b > 50) gold += 1;
      else if (r > 120 && r - b > 50 && g - b > 30) yellow += 1;
    }
    return { gold, yellow, png: canvas.toDataURL('image/png') };
  });
  const total = Number(seconds);
  const started = Date.now();
  let index = 0;
  while ((Date.now() - started) / 1000 < total) {
    const result = await shot();
    console.log(`t=${((Date.now() - started) / 1000).toFixed(1)}s gold=${result.gold} yellow=${result.yellow}`);
    await writeFile(`workspace/ue-qa/seq/f-${String(index).padStart(2, '0')}.png`, Buffer.from(result.png.split(',')[1], 'base64'));
    index += 1;
    await page.waitForTimeout(300);
  }
} finally {
  await browser.close();
}
