import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRetryableRenderFailure, NARRATION_REUSE_FILES, pruneJobIntermediates } from "../apps/studio/render-engine.js";

const root = resolve(import.meta.dirname, "..");

test("transient tool failures retry and authored failures do not", () => {
  // Every message below is copied from a real record in workspace/jobs.
  for (const message of [
    "编码新的 MP4 exited with 1",
    "生成或复用正式配音 exited with 1",
    "生成或复用正式配音 exited with null",
    "合成素材、字幕、配音与地图 exited with 1",
    "生成实际 cue 时间轴与行政区巡游 exited with 1",
    "录制 Cesium 穿云、村级边界巡游和返回镜头 exited with 1",
    "connect ECONNRESET 127.0.0.1:443",
    "net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4174"
  ]) {
    assert.equal(isRetryableRenderFailure(message), true, `${message} must be retryable`);
  }
  for (const message of [
    "Project configuration is incomplete",
    "黄金成片 QA 未通过：allChildrenPresent、perceptualParity",
    "输出文件不是本任务新生成",
    "无法按文本稳定映射场景 overview-1；请重新生成配音，或检查旁白是否与 SRT 一致",
    "Visual v1 has no display window before its scene boundary",
    "Selected visuals have no visible video frame: 3:asset-a",
    "Render cancelled"
  ]) {
    assert.equal(isRetryableRenderFailure(message), false, `${message} must not be retried`);
  }
});

test("a terminal job keeps its narration and gives the sandbox back", async () => {
  const tempRoot = join(tmpdir(), "geo-video-studio");
  const jobId = `prune-test-${Date.now().toString(36)}`;
  // The temp working copy is named after the job directory, exactly as
  // `prepareSandbox` derives it.
  const base = await mkdtemp(join(tmpdir(), "geo-job-"));
  const jobRoot = join(base, jobId);
  const tempJobRoot = join(tempRoot, jobId);
  const sandbox = join(tempJobRoot, "sandbox");
  try {
    await mkdir(jobRoot, { recursive: true });
    // A sandbox is a whole working copy plus its intermediates, including the
    // 200-400 MB map video.
    await mkdir(join(sandbox, "renders", "intermediate"), { recursive: true });
    await mkdir(join(sandbox, "assets", "audio", "440825112"), { recursive: true });
    await mkdir(join(sandbox, "node_modules"), { recursive: true });
    await writeFile(join(sandbox, "renders", "intermediate", "440825112-map-portrait.mp4"), "x".repeat(4096), "utf8");
    await writeFile(join(sandbox, "node_modules", "tsx.js"), "// dependency, must survive\n", "utf8");
    for (const name of NARRATION_REUSE_FILES) await writeFile(join(sandbox, "assets", "audio", "440825112", name), `${name}\n`, "utf8");
    await writeFile(join(jobRoot, "job.json"), "{}\n", "utf8");
    await mkdir(join(jobRoot, "output"), { recursive: true });
    await writeFile(join(jobRoot, "output", "film.mp4"), "film\n", "utf8");
    await symlink(sandbox, join(jobRoot, "sandbox"), process.platform === "win32" ? "junction" : "dir");

    await pruneJobIntermediates({ id: jobId, jobRoot, regionId: "440825112" });

    for (const name of NARRATION_REUSE_FILES) {
      assert.ok(existsSync(join(jobRoot, "audio", name)), `${name} must survive for the narration preview`);
    }
    assert.equal(existsSync(join(jobRoot, "sandbox")), false, "the job-directory junction must be unlinked");
    assert.equal(existsSync(tempJobRoot), false, "the temp working copy must be reclaimed");
    assert.ok(existsSync(join(jobRoot, "output", "film.mp4")), "the delivered film must stay");
    assert.ok(existsSync(join(jobRoot, "job.json")), "the durable record must stay");
    // Removing the sandbox must never walk a linked dependency tree.
    assert.ok(existsSync(join(root, "node_modules", "tsx", "dist", "cli.mjs")), "a linked dependency tree must survive pruning");
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(tempJobRoot, { recursive: true, force: true });
  }
});

test("the retry budget and the sandbox reclaim are wired into the export queue", async () => {
  const server = await readFile(join(root, "apps/studio/server.ts"), "utf8");
  assert.match(server, /const DEFAULT_JOB_ATTEMPTS = 2;/);
  assert.match(server, /STUDIO_JOB_ATTEMPTS/);
  assert.match(server, /!isRetryableRenderFailure\(message\)/);
  assert.match(server, /await pruneJobIntermediates\(job\)/);
  // The narration preview reads the kept copy first now that the sandbox is
  // reclaimed at every terminal outcome.
  assert.match(server, /join\(job\.jobRoot, "audio", "narration\.mp3"\)/);
});
