import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRetryableRenderFailure, NARRATION_REUSE_FILES, pruneJobIntermediates, collectJobDiagnostics, taskCaptureProcesses, releaseCaptureLeaseWhenSafe } from "../apps/studio/render-engine.js";

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
    "Render cancelled",
    "UE_CAPTURE_CLEANUP_FATAL: 录制 exited with 1",
    "UE_CAPTURE_CLEANUP_FATAL: 录制 timed out after 300s"
  ]) {
    assert.equal(isRetryableRenderFailure(message), false, `${message} must not be retried`);
  }
});

test("恢复探测精确匹配本任务的UE、绝对脚本及后代，不误认其他任务", () => {
  const sandbox = 'C:/Temp/geo-video-studio/job-a/sandbox';
  const processes = [
    { ProcessId: 1, CommandLine: 'UnrealEditor.exe "-GeoCaptureRoot=C:\\Temp\\geo-video-studio\\job-a\\sandbox\\renders\\ue-frames\\region-portrait-123"' },
    { ProcessId: 2, CommandLine: `node "${sandbox}/apps/ue-player/server.ts" --port=4000` },
    { ProcessId: 3, ParentProcessId: 2, CommandLine: 'node internal-worker' },
    { ProcessId: 4, CommandLine: 'node C:/Temp/geo-video-studio/job-b/sandbox/apps/ue-player/server.ts' },
    { ProcessId: 5, CommandLine: `node ${sandbox}/apps/ue-player/server.ts.backup` },
    { ProcessId: 6, CommandLine: 'UnrealEditor.exe -GeoCaptureRoot=C:/Temp/geo-video-studio/job-ab/sandbox/renders/ue-frames/r-portrait-1' },
    { ProcessId: 7, CommandLine: `node "${sandbox}/apps/ue-player/capture.ts" --region r` }
  ];
  assert.deepEqual(taskCaptureProcesses(processes, sandbox).map(info => info.ProcessId), [1, 2, 3, 7]);
  assert.deepEqual(taskCaptureProcesses(processes.slice(3, 6), sandbox), []);
});

test("有残留或查询异常时保留租约，空快照后自动恢复且停止探测", async () => {
  for (const initial of ['active', 'error']) {
    let calls = 0, releases = 0;
    let finished!: () => void;
    const released = new Promise<void>(resolve => { finished = resolve; });
    const logs: string[] = [];
    const result = await releaseCaptureLeaseWhenSafe({ token: 'test', release: async () => { releases++; finished(); } }, `mock-${initial}`, message => logs.push(message), async () => {
      calls++;
      if (calls === 1) {
        if (initial === 'error') throw new Error('CIM不可用');
        return true;
      }
      return false;
    }, 1);
    assert.equal(result, false);
    assert.equal(releases, 0);
    await released;
    await Promise.resolve();
    assert.equal(calls, 2);
    assert.equal(releases, 1);
    assert.equal(logs.length, 2);
  }
  let releases = 0;
  assert.equal(await releaseCaptureLeaseWhenSafe({ token: 'safe', release: async () => { releases++; } }, 'safe', () => {}, async () => false, 1), true);
  assert.equal(releases, 1);
});

test("已完成任务保留配音与成片并正常回收沙箱", async () => {
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

    await pruneJobIntermediates({ id: jobId, jobRoot, regionId: "440825112", status: "completed" });

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

for (const status of ["failed", "cancelled", "validating"] as const) {
  for (const materialized of [false, true]) {
    test(`${status} 任务原地保留${materialized ? "实体" : "链接"}沙箱、原始帧与恢复清单`, async () => {
      const base = await mkdtemp(join(tmpdir(), "geo-progress-"));
      const jobId = `retain-${status}-${materialized}-${Date.now().toString(36)}`;
      const jobRoot = join(base, jobId);
      const tempJobRoot = join(tmpdir(), "geo-video-studio", jobId);
      const sandbox = materialized ? join(jobRoot, "sandbox") : join(tempJobRoot, "sandbox");
      const take = join(sandbox, "renders", "ue-frames", "region-portrait-123");
      const manifest = JSON.stringify({ totalFrames: 18000, capturedFrames: 16915 });
      try {
        await mkdir(jobRoot, { recursive: true });
        await mkdir(take, { recursive: true });
        await mkdir(join(sandbox, "assets", "audio", "region"), { recursive: true });
        await writeFile(join(take, "frame-016914.png"), "原始录制帧");
        await writeFile(join(take, "capture-manifest.json"), manifest);
        await writeFile(join(sandbox, "assets", "audio", "region", "narration.mp3"), "配音");
        await writeFile(join(jobRoot, "render-spec.json"), "冻结规格");
        if (!materialized) await symlink(sandbox, join(jobRoot, "sandbox"), process.platform === "win32" ? "junction" : "dir");
        const job = { id: jobId, jobRoot, regionId: "region", status };

        await pruneJobIntermediates(job);
        await pruneJobIntermediates(job, { includeMaterializedSandbox: true });

        assert.equal(await readFile(join(jobRoot, "sandbox", "renders", "ue-frames", "region-portrait-123", "frame-016914.png"), "utf8"), "原始录制帧");
        assert.equal(await readFile(join(take, "capture-manifest.json"), "utf8"), manifest);
        assert.equal(await readFile(join(jobRoot, "render-spec.json"), "utf8"), "冻结规格");
        assert.equal(existsSync(join(jobRoot, "audio")), false, "保留策略应在复制或删除前返回，不复制任何录制进度");
        if (!materialized) assert.ok(existsSync(tempJobRoot), "临时沙箱目标与 jobRoot 链接必须同时保留");
      } finally {
        await rm(base, { recursive: true, force: true });
        await rm(tempJobRoot, { recursive: true, force: true });
      }
    });
  }
}

test("时间戳录制诊断仅收集本任务并优先保留最新报告与日志", async () => {
  const jobRoot = await mkdtemp(join(tmpdir(), "geo-diagnostics-"));
  const framesRoot = join(jobRoot, "sandbox", "renders", "ue-frames");
  try {
    for (const name of ["region-portrait-100", "region-portrait-200", "region-portrait-qa-300", "other-portrait-400"]) {
      await mkdir(join(framesRoot, name), { recursive: true });
      await writeFile(join(framesRoot, name, "capture-report.json"), name);
      await writeFile(join(framesRoot, name, "unreal.log"), name);
    }
    await writeFile(join(framesRoot, "region-portrait-200", "unreal-100.log"), "旧块");
    await writeFile(join(framesRoot, "region-portrait-200", "unreal-200.log"), "最新块");
    await writeFile(join(framesRoot, "region-portrait-200", "too-large.log"), Buffer.alloc(8 * 1024 * 1024 + 1));
    for (let i = 0; i < 20; i++) await writeFile(join(framesRoot, "region-portrait-200", `frame-${i}.png`), "帧");
    const result = await collectJobDiagnostics({ jobRoot, regionId: "region", profile: "portrait" });
    assert.ok(result);
    assert.equal(await readFile(join(result.dir, "capture-report.json"), "utf8"), "region-portrait-200");
    assert.equal(await readFile(join(result.dir, "unreal.log"), "utf8"), "region-portrait-200");
    assert.ok(result.files.indexOf("unreal-200.log") < result.files.indexOf("unreal-100.log"));
    assert.equal(result.files.includes("too-large.log"), false);
    assert.equal(result.files.length, 12);
  } finally { await rm(jobRoot, { recursive: true, force: true }); }
});

test("无录制目录也保留核心QA，报告优先于捕获日志并遵守原预算", async () => {
  const jobRoot = await mkdtemp(join(tmpdir(), 'geo-qa-diagnostics-'));
  const qaRoot = join(jobRoot, 'sandbox', 'renders', 'diagnostics');
  const captureRoot = join(jobRoot, 'sandbox', 'renders', 'ue-frames', 'region-portrait-123');
  const reports = ['final-delivery-validation.json', 'region-portrait-preflight.json', 'region-portrait-visual-sync.json', 'golden-report.json'];
  try {
    await mkdir(qaRoot, { recursive: true });
    await mkdir(join(jobRoot, 'qa'), { recursive: true });
    for (const name of reports.slice(0, 3)) await writeFile(join(qaRoot, name), name);
    await writeFile(join(jobRoot, 'qa', 'golden-report.json'), 'golden');
    await writeFile(join(qaRoot, 'unrelated.json'), '不应复制');
    const job = { jobRoot, regionId: 'region', profile: 'portrait' as const };
    const onlyQa = await collectJobDiagnostics(job);
    assert.ok(onlyQa);
    assert.deepEqual([...onlyQa.files].sort(), [...reports].sort());
    await mkdir(captureRoot, { recursive: true });
    // 捕获日志既不能耗完数量，也不能先耗完8MiB让核心报告丢失。
    for (let i = 0; i < 16; i++) await writeFile(join(captureRoot, `unreal-${i}.log`), 'log');
    await writeFile(join(captureRoot, 'unreal-999.log'), Buffer.alloc(8 * 1024 * 1024));
    const result = await collectJobDiagnostics(job);
    assert.ok(result);
    assert.equal(result.files.length, 12);
    for (const name of reports) assert.ok(result.files.slice(0, 4).includes(name), name);
    assert.equal(result.files.includes('unreal-999.log'), false);
    assert.equal(result.files.includes('unrelated.json'), false);
    await rm(join(jobRoot, 'sandbox'), { recursive: true, force: true });
    for (const name of reports) assert.ok((await readFile(join(result.dir, name), 'utf8')).length > 0);
  } finally { await rm(jobRoot, { recursive: true, force: true }); }
});

test("the retry budget and the sandbox reclaim are wired into the export queue", async () => {
  const server = await readFile(join(root, "apps/studio/server.ts"), "utf8");
  assert.match(server, /const DEFAULT_JOB_ATTEMPTS = 2;/);
  assert.match(server, /STUDIO_JOB_ATTEMPTS/);
  assert.match(server, /!isRetryableRenderFailure\(message\)/);
  assert.match(server, /await pruneJobIntermediates\(job\)/);
  // 成功任务回收沙箱后，配音预览仍应优先读取已保留的配音副本。
  assert.match(server, /join\(job\.jobRoot, "audio", "narration\.mp3"\)/);
});
