// Captures one full-resolution frame out of the running UE preview, so a HUD detail can be
// measured pixel-for-pixel instead of guessed at from a scaled screenshot of the studio.
//
//   node scripts/frame-probe.mjs <sceneTitle> <secondsIntoScene> <outfile> [projectId]
//
// `projectId` is the studio project to open (the studio remembers it in localStorage); when
// it is omitted the studio keeps whichever project it opened last.
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [title = '迈市社区', offset = '6', out = 'workspace/ue-qa/frame.png', projectId] = process.argv.slice(2);
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
  await page.waitForTimeout(2000);
  await page.waitForTimeout(Number(offset) * 1000);
  console.log('diagnostics', JSON.stringify(await frame.evaluate(() => window.geoVideo.getDiagnostics())));
  // The pixel-stream <video> carries the renderer's own resolution, not the CSS size.
  const data = await frame.evaluate(async () => {
    const video = document.querySelector('video');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    return { size: [video.videoWidth, video.videoHeight], png: canvas.toDataURL('image/png') };
  });
  await writeFile(resolve(out), Buffer.from(data.png.split(',')[1], 'base64'));
  console.log('wrote', out, data.size.join('x'));
} finally {
  await browser.close();
}
