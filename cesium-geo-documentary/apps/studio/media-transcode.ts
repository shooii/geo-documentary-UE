import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Turn an animated GIF into an MP4 the film can actually play.
 *
 * A GIF stored as a picture would sit still: the renderer captures the
 * composition frame by frame against a deterministic clock, and an animated
 * `<img>` cannot be seeked to a moment, so the export would freeze on frame one.
 * Videos are handled by the same frame-extraction path as the Cesium map
 * (`__render_frame_<id>__` in hyperframes), so transcribing the animation into a
 * video keeps it moving - and, as a bonus, it gets a proper clip window,
 * looping, and the same `fit` handling as any other video asset.
 *
 * Runs the bundled ffmpeg rather than whatever is on PATH, matching how the
 * export stages its tools. The binary is resolved next to this module (where
 * `pnpm install` put it) instead of from the caller's workspace root: the Studio
 * always runs from that installation, while a caller may be pointed at another
 * data root entirely.
 */
export async function transcodeAnimatedGif(source: string, target: string): Promise<void> {
  const ffmpeg = fileURLToPath(new URL(
    `../../node_modules/ffmpeg-static/${process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"}`,
    import.meta.url
  ));
  if (!existsSync(ffmpeg)) {
    throw new Error("缺少 ffmpeg（node_modules/ffmpeg-static），无法把动态 GIF 转成视频；请先 pnpm install");
  }
  await new Promise<void>((resolvePromise, reject) => {
    // stdio ignores stdin on purpose: this host cannot start a child whose stdin
    // and stdout are both piped (see the sandbox notes in tests/python-runtime).
    const child = spawn(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", source,
      // H.264 needs even dimensions, and every frame has to share one pixel
      // format so the encoder is not handed a palette-only stream.
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
      "-movflags", "+faststart",
      "-an",
      target
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolvePromise();
      reject(new Error(`动态 GIF 转视频失败（ffmpeg exit ${code ?? "null"}）：${stderr.join("").trim().slice(-400) || "无输出"}`));
    });
  });
}
