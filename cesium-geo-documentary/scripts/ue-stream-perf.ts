/**
 * Measures the pixel stream while the camera is actually moving.
 *
 * An idle preview sits at the frame cap no matter how slow the renderer is, so the
 * only number that says anything about "卡" is the one taken during a shot. This runs
 * the opening (descent + county wipe), then reads both sides: the renderer's own
 * frame timing through the data channel, and the inbound video stats from the peer
 * connection — the three places a stutter can come from: render, encode, transport.
 *
 *   pnpm exec tsx scripts/ue-stream-perf.ts [seconds]
 *
 * The page is only touched twice (before and after the shot) on purpose: polling it
 * while it plays starves the very decode it is meant to measure on a loaded machine.
 * `GEO_PROFILE` lines in workspace/ue-logs/preview-renderer.log carry the renderer
 * side of the same window.
 */
import { chromium } from 'playwright';

const seconds = Number(process.argv[2] || 16);
const base = process.env.UE_PLAYER_URL || 'http://127.0.0.1:4174';
const region = process.env.UE_PERF_REGION || '440825102';
const imagery = process.env.UE_PERF_IMAGERY || 'esri-world-imagery';

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 540, height: 960 } });
  // The player connects before the page script runs, so the peer must be wrapped first.
  await page.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    (window as any).__peers = [];
    (window as any).RTCPeerConnection = class extends Native {
      constructor(...args: any[]) {
        super(...(args as []));
        (window as any).__peers.push(this);
      }
    };
    (window as any).__videoStats = async () => {
      const peer = (window as any).__peers?.at(-1);
      if (!peer) return null;
      const report = await peer.getStats();
      const inbound: any = {};
      report.forEach((entry: any) => {
        if (entry.type === 'inbound-rtp' && entry.kind === 'video') Object.assign(inbound, entry);
      });
      const video = document.querySelector('video');
      return {
        at: performance.now(), width: video?.videoWidth, height: video?.videoHeight,
        framesDecoded: inbound.framesDecoded, framesDropped: inbound.framesDropped,
        freezeCount: inbound.freezeCount, totalFreezesDuration: inbound.totalFreezesDuration,
        jitter: inbound.jitter, bytesReceived: inbound.bytesReceived,
        rendererFps: 0
      };
    };
  });
  page.on('pageerror', error => console.log('PAGE_ERROR', error.message));
  await page.goto(`${base}/?region=${region}&profile=portrait&studioPreview=2&imagery=${encodeURIComponent(imagery)}&slot=off`);
  await page.waitForFunction(() => Boolean((window as any).geoVideo?.getDiagnostics().ready), {}, { timeout: 180000 });
  // Let the first tiles land, so the measurement is the shot and not the scene load.
  await page.waitForTimeout(8000);

  const before = await page.evaluate(async () => {
    const stats = await (window as any).__videoStats();
    return { ...stats, renderer: await (window as any).geoVideo.getRendererStatus() };
  });
  // `play-opening` is the descent plus the county wipe: the camera never stops, which
  // is exactly the case where the renderer used to fall behind the stream.
  await page.evaluate(() => (window as any).geoVideo.playOpeningPreview({}));
  await page.waitForTimeout(seconds * 1000);
  const after = await page.evaluate(async () => {
    const stats = await (window as any).__videoStats();
    return { ...stats, renderer: await (window as any).geoVideo.getRendererStatus() };
  });
  await page.screenshot({ path: 'workspace/ue-qa/stream-perf.png' });

  const elapsed = (after.at - before.at) / 1000;
  const decoded = (after.framesDecoded - before.framesDecoded) / elapsed;
  console.log(JSON.stringify({
    windowSeconds: Number(elapsed.toFixed(1)),
    renderer: {
      before: { fps: Number(before.renderer.fps?.toFixed(1)), frameMs: Number(before.renderer.frameMs?.toFixed(1)) },
      after: { fps: Number(after.renderer.fps?.toFixed(1)), frameMs: Number(after.renderer.frameMs?.toFixed(1)) }
    },
    video: {
      size: `${after.width}x${after.height}`,
      decodedFps: Number(decoded.toFixed(1)),
      droppedFrames: after.framesDropped - before.framesDropped,
      freezes: after.freezeCount - before.freezeCount,
      freezeSeconds: Number((after.totalFreezesDuration - before.totalFreezesDuration).toFixed(2)),
      mbps: Number((((after.bytesReceived - before.bytesReceived) * 8) / elapsed / 1e6).toFixed(1)),
      jitterMs: Number((after.jitter * 1000).toFixed(1))
    }
  }, null, 2));
} finally {
  await browser.close();
}
