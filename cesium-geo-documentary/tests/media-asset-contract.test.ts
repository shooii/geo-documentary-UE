import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { storeUploadedFile } from "../apps/studio/asset-store.js";
import { countGifFrames, isAnimatedGif, sniffMediaType, unsupportedMediaReason } from "../apps/studio/media-sniff.js";
import { isWorkspaceAssetFileName, mediaKindForPath } from "../packages/content-engine/media.js";
import { guardFreeEnv, rmGuarded, scratchDir } from "./safe-delete.js";

// The library accepted PNG/JPEG/WebP/MP4 and nothing else: a GIF upload was
// refused outright ("Only PNG, JPEG, WebP and MP4 assets are supported"), and an
// MP4 that did get in was drawn into the film as `<img src=...mp4>`, which
// renders nothing at all. These assertions cover the three things that had to
// change together: what the bytes are, what the library keeps, and what the
// compositor draws.

const root = process.cwd();
const ffmpeg = join(root, "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const ffprobe = join(
  root,
  "node_modules",
  "ffprobe-static",
  "bin",
  process.platform === "win32" ? "win32/x64/ffprobe.exe" : "linux/x64/ffprobe"
);

function mp4Bytes(): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(16, 0);
  header.write("ftyp", 4, "latin1");
  header.write("isom", 8, "latin1");
  return header;
}

function movBytes(): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(16, 0);
  header.write("ftyp", 4, "latin1");
  header.write("qt  ", 8, "latin1");
  return header;
}

function webmBytes(docType: string): Buffer {
  const header = Buffer.alloc(48);
  header.writeUInt32BE(0x1a45dfa3, 0);
  header.write(docType, 24, "latin1");
  return header;
}

function aviBytes(): Buffer {
  const header = Buffer.alloc(16);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(8, 4);
  header.write("AVI ", 8, "latin1");
  return header;
}

test("a stored asset's extension is decided by its bytes, not by the upload's MIME type", () => {
  assert.deepEqual(sniffMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), {
    mime: "image/png", extension: "png", kind: "image"
  });
  assert.deepEqual(sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), {
    mime: "image/jpeg", extension: "jpg", kind: "image"
  });
  // The animated GIF the library used to refuse, and the formats that are
  // recognised but deliberately not stored.
  assert.equal(sniffMediaType(Buffer.from("GIF89a----", "latin1"))?.extension, "gif");
  assert.equal(sniffMediaType(Buffer.from("GIF89a----", "latin1"))?.kind, "image");
  assert.equal(sniffMediaType(mp4Bytes())?.kind, "video");
  assert.equal(sniffMediaType(mp4Bytes())?.extension, "mp4");
  assert.deepEqual(sniffMediaType(movBytes()), { mime: "video/quicktime", extension: "mov", kind: "video" });
  assert.deepEqual(sniffMediaType(webmBytes("webm")), { mime: "video/webm", extension: "webm", kind: "video" });
  assert.equal(sniffMediaType(webmBytes("matroska")), null, "mkv is the same container family but not playable");
  assert.equal(sniffMediaType(aviBytes()), null);
  assert.equal(sniffMediaType(Buffer.from("<html><body>404</body></html>", "latin1")), null);

  assert.match(String(unsupportedMediaReason("holiday.AVI")), /暂不支持 \.avi/);
  assert.equal(unsupportedMediaReason("holiday.png"), null, "a supported name gets no lecture");

  assert.equal(isWorkspaceAssetFileName("abc-123.gif"), true);
  assert.equal(isWorkspaceAssetFileName("abc-123.mov"), true);
  assert.equal(isWorkspaceAssetFileName("abc-123.avif"), false, "recognised is not the same as storable");
  assert.equal(isWorkspaceAssetFileName(".upload-abc123"), false, "the streaming temp file is never a library asset");
  assert.equal(isWorkspaceAssetFileName("../secret.png"), false);

  assert.equal(mediaKindForPath("workspace/assets/x.mov"), "video");
  assert.equal(mediaKindForPath("workspace/assets/x.webm"), "video");
  assert.equal(mediaKindForPath("workspace/assets/x.gif"), "image");
  assert.equal(mediaKindForPath("workspace/assets/x.png"), "image");
});

test("an animated GIF is stored as a playable video, and a still one stays a picture", async (t) => {
  if (!existsSync(ffmpeg) || !existsSync(ffprobe)) {
    t.skip("ffmpeg/ffprobe not installed");
    return;
  }
  const scratch = scratchDir("media-assets");
  try {
    const sourceDir = join(scratch, "source");
    const tempRoot = join(scratch, "root");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(join(tempRoot, "workspace", "assets"), { recursive: true });
    const run = (args: string[]): void => {
      const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: guardFreeEnv()
      });
      assert.equal(result.status, 0, result.stderr?.toString() || "ffmpeg failed to build the fixture");
    };
    const animation = join(sourceDir, "walk.gif");
    const still = join(sourceDir, "poster.gif");
    const clip = join(sourceDir, "clip.mp4");
    run(["-f", "lavfi", "-i", "testsrc=size=160x120:rate=8", "-frames:v", "16", animation]);
    run(["-f", "lavfi", "-i", "testsrc=size=160x120:rate=8", "-frames:v", "1", still]);
    run(["-f", "lavfi", "-i", "testsrc=size=160x120:rate=12", "-frames:v", "24", "-pix_fmt", "yuv420p", clip]);

    assert.equal(countGifFrames(readFileSync(still)), 1);
    assert.ok(countGifFrames(readFileSync(animation)) > 1, "the animated fixture must count as several frames");
    assert.equal(isAnimatedGif(readFileSync(still)), false);
    assert.equal(isAnimatedGif(readFileSync(animation)), true);

    const owner = { id: "project-media-contract", regionId: "990000001" };
    const uploadedGif = await storeUploadedFile(tempRoot, owner, animation, "walk.gif", undefined, "image/gif");
    assert.equal(uploadedGif.type, "video", "an animated GIF has to become a video or it will sit still");
    assert.match(uploadedGif.path, /\.mp4$/);
    const storedVideo = join(tempRoot, "workspace", "assets", uploadedGif.path.split("/").pop()!);
    assert.equal(existsSync(storedVideo), true);
    assert.equal(sniffMediaType(readFileSync(storedVideo))?.mime, "video/mp4", "the stored bytes really are an MP4");
    const probe = spawnSync(ffprobe, [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "json", storedVideo
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: guardFreeEnv() });
    assert.equal(probe.status, 0, probe.stderr?.toString());
    const stream = (JSON.parse(probe.stdout.toString()) as { streams: Array<{ codec_name: string; width: number; height: number }> }).streams[0]!;
    assert.equal(stream.codec_name, "h264");
    assert.equal(stream.width % 2, 0, "H.264 needs even dimensions");
    assert.equal(stream.height % 2, 0);

    // The sidecar is the library's source of truth, so the transcode has to be
    // recorded there too - not just in the filename.
    const sidecar = JSON.parse(readFileSync(join(tempRoot, "workspace", "assets", `${uploadedGif.id}.asset.json`), "utf8")) as {
      type: string; path: string; scope: { projectId: string };
    };
    assert.equal(sidecar.type, "video");
    assert.equal(sidecar.path, uploadedGif.path);
    assert.equal(sidecar.scope.projectId, owner.id);

    const uploadedStill = await storeUploadedFile(tempRoot, owner, still, "poster.gif", undefined, "image/gif");
    assert.equal(uploadedStill.type, "image", "a one-frame GIF is just a picture");
    assert.match(uploadedStill.path, /\.gif$/);
    assert.equal(sniffMediaType(readFileSync(join(tempRoot, "workspace", "assets", uploadedStill.path.split("/").pop()!)))?.mime, "image/gif");

    const uploadedClip = await storeUploadedFile(tempRoot, owner, clip, "clip.mp4", undefined, "video/mp4");
    assert.equal(uploadedClip.type, "video");
    assert.match(uploadedClip.path, /\.mp4$/);

    const unplayable = join(sourceDir, "old-movie.avi");
    writeFileSync(unplayable, aviBytes());
    await assert.rejects(
      () => storeUploadedFile(tempRoot, owner, unplayable, "old-movie.avi"),
      /暂不支持 \.avi/
    );
  } finally {
    rmGuarded(scratch);
  }
});

test("the compositor draws a video visual as a video, and a GIF as a picture", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts"), "utf8")
  );
  // The branch that used to be missing: a video clip must not be emitted as an
  // <img>, and the video element keeps the id the GSAP motion code targets.
  assert.match(source, /mediaKindForPath\(visual\.src\)/);
  assert.match(source, /const kind = mediaKindForPath/);
  assert.match(source, /const videoAudioAttrs = visual\.hasAudio\s*\?\s*`data-has-audio="true" data-volume="0\.6"`\s*:\s*`muted`/);
    assert.match(source, /<video id="visual-main-\${index}" class="clip visual-main fit-\${visual\.fit \?\? "cover"}"[^>]*src="\${prefix}\/images\/\${visual\.src}" \${videoAudioAttrs\} loop playsinline preload="auto"/);
  // HyperFrames only owns a video's playback when the element itself carries the
  // timing (its lint reports media_missing_data_start otherwise), and a timed
  // <video> must NOT sit inside another timed element: that is
  // `video_nested_in_timed_element`, an error that fails the Studio preflight -
  // after the whole map capture. It cost one real export at 79%
  // (`…nested inside <figure id="visual-15">…`, 2026-10-10). So the timing lives
  // on the video, which then carries the clip class and a track like the map.
  assert.match(source, /<video id="visual-main-\$\{index\}" class="clip visual-main fit-\$\{visual\.fit \?\? "cover"\}"[^>]*data-start="\$\{startSeconds\}" data-duration="\$\{clipSeconds\}" data-track-index="\$\{visualTrack\(index\)\}"/);
  // …and the <figure> around it is a plain, non-timed container. The card still
  // fades in and out on schedule because the timeline drives #visual-N's opacity.
  assert.match(source, /const figureTiming = kind === "video" \? "" : ` data-start="\$\{startSeconds\}" data-duration="\$\{clipSeconds\}" data-track-index="\$\{visualTrack\(index\)\}"`;/);
  assert.match(source, /data-visual-id="\$\{visual\.id\}"\$\{figureTiming\}>/);
  assert.doesNotMatch(source, /data-visual-id="\$\{visual\.id\}" data-start=/, "the figure must not carry the timing itself");
  assert.match(source, /<img id="visual-main-\$\{index\}"/);
  // A video has nothing to blur behind it, so the background layer is only drawn
  // for pictures.
  assert.match(source, /const background = kind === "video"\s*\?\s*""/);
  assert.match(source, /class="clip visual \$\{sourceClass\} visual-\$\{kind\}\$\{layout\}"/, "the figure still carries the media kind (and the 全屏 layout suffix)");
});

test("video audio probe detects audio stream in videos and skips silent ones", async (t) => {
  if (!existsSync(ffmpeg) || !existsSync(ffprobe)) {
    t.skip("ffmpeg/ffprobe not installed");
    return;
  }
  const scratch = scratchDir("video-audio-probe");
  mkdirSync(scratch, { recursive: true });
  try {
    const silent = join(scratch, "silent.mp4");
    const audible = join(scratch, "audible.mp4");
    const run = (args: string[]): void => {
      const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: guardFreeEnv()
      });
      assert.equal(result.status, 0, result.stderr?.toString() || "ffmpeg failed");
    };
    run(["-f", "lavfi", "-i", "testsrc=size=160x120:rate=10", "-t", "0.5", "-pix_fmt", "yuv420p", silent]);
    run(["-f", "lavfi", "-i", "testsrc=size=160x120:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", "-c:v", "libx264", "-c:a", "aac", "-t", "0.5", audible]);

    const probeAudio = (filePath: string): boolean => {
      const result = spawnSync(ffprobe, [
        "-v", "error",
        "-select_streams", "a",
        "-show_entries", "stream=codec_type",
        "-of", "json",
        filePath
      ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      if (result.status !== 0) return false;
      const parsed = JSON.parse(result.stdout.toString()) as { streams?: Array<{ codec_type?: string }> };
      return Boolean(parsed.streams && parsed.streams.length > 0);
    };

    assert.equal(probeAudio(silent), false);
    assert.equal(probeAudio(audible), true);
  } finally {
    rmGuarded(scratch);
  }
});
