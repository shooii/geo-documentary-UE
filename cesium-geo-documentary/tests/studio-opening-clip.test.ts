import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderSpec } from "../packages/render-spec/index.js";
import {
  openingClipMapSeconds,
  openingClipMediaChecks,
  parseOpeningClipDetections,
  parseOpeningClipDuration,
  runOpeningClipQa,
  type OpeningClipProbe
} from "../apps/studio/opening-clip.js";

function probe(frameCount = "300"): OpeningClipProbe {
  return {
    format: { duration: "10.000000" },
    streams: [
      { codec_type: "video", codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/1", nb_read_frames: frameCount },
      { codec_type: "audio", codec_name: "aac" }
    ]
  };
}

function checks(value = probe(), overrides: Partial<Parameters<typeof openingClipMediaChecks>[0]> = {}) {
  return openingClipMediaChecks({
    probe: value,
    output: { width: 1080, height: 1920, fps: 30 },
    durationSeconds: 10,
    mtimeMs: Date.parse("2026-11-14T10:00:00.000Z"),
    jobCreatedAt: "2026-11-14T10:00:00.000Z",
    ...overrides
  });
}

test("开头时长只允许缺省值及 1 到 60 秒的 30fps 整帧数字", () => {
  assert.equal(parseOpeningClipDuration(undefined), undefined);
  for (const value of [1, 10, 60, 31 / 30, 1799 / 30]) assert.equal(parseOpeningClipDuration(value), value);
  for (const value of [null, "10", "", true, false, {}, [], NaN, Infinity, -Infinity, 0, -1, 1 / 30, 60 + 1 / 30]) {
    assert.throws(() => parseOpeningClipDuration(value), /1 到 60 秒/);
  }
  for (const value of [1.01, 10.001, 1 + 1e-10]) assert.throws(() => parseOpeningClipDuration(value), /完整帧/);
});

test("地图片段扣除封面后按帧向上取整，至少生成一帧", () => {
  assert.equal(openingClipMapSeconds(10, 2), 8);
  assert.equal(openingClipMapSeconds(10, 2.01), 8);
  assert.equal(openingClipMapSeconds(10, 2.1), Math.ceil((10 - 2.1) * 30) / 30);
  assert.equal(openingClipMapSeconds(10, 10), 1 / 30);
  assert.equal(openingClipMapSeconds(10, 12), 1 / 30);
  assert.equal(openingClipMapSeconds(31 / 30, 1), Math.ceil((31 / 30 - 1) * 30) / 30);
  for (const value of [-1, NaN, Infinity]) assert.throws(() => openingClipMapSeconds(10, value), /封面时长/);
});

test("开头媒体检查仅使用片段规格且精确要求 300 个视频帧", () => {
  assert.equal(Object.values(checks()).every(Boolean), true);
  for (const count of ["299", "301", "N/A", "", "300.5"]) assert.equal(checks(probe(count)).exactFrameCount, false);
  const media = probe();
  media.streams![0]!.avg_frame_rate = "30000/1001";
  assert.equal(checks(media).frameRate, false);
  media.streams![0]!.avg_frame_rate = "30000/1000";
  assert.equal(checks(media).frameRate, true);
  media.streams![0]!.avg_frame_rate = "30/0";
  assert.equal(checks(media).frameRate, false);
  assert.equal(checks(probe(), { output: { width: 1080, height: 1920, fps: 60 } }).frameRate, false);
  assert.equal(checks(probe(), { output: { width: 1920, height: 1080, fps: 30 } }).resolution, false);
  const landscape = probe();
  landscape.streams![0]!.width = 1920;
  landscape.streams![0]!.height = 1080;
  assert.equal(checks(landscape, { output: { width: 1920, height: 1080, fps: 30 } }).resolution, true);
});

test("媒体检查拒绝非 H264、缺失音轨、超差时长及旧文件", () => {
  const media = probe();
  media.streams![0]!.codec_name = "hevc";
  assert.equal(checks(media).h264, false);
  media.streams!.pop();
  assert.equal(checks(media).audioPresent, false);
  media.format!.duration = "10.043";
  assert.equal(checks(media).duration, true);
  media.format!.duration = "10.044";
  assert.equal(checks(media).duration, false);
  media.format!.duration = "N/A";
  assert.equal(checks(media).duration, false);
  assert.equal(checks(probe(), { mtimeMs: Date.parse("2026-11-14T09:59:59.999Z") }).freshOutput, false);
  assert.equal(checks(probe(), { jobCreatedAt: "无效时间" }).freshOutput, false);
  assert.equal(checks({}).exactFrameCount, false);
});

test("检测元数据包含中间黑段与持续到片尾的黑段，不局限抽样帧", () => {
  const metadata = "lavfi.black_start=0.5\nlavfi.black_end=0.6\nlavfi.black_start=9.5\n";
  assert.deepEqual(parseOpeningClipDetections(metadata, "black", 10), [
    { start: 0.5, end: 0.6, duration: 0.6 - 0.5 },
    { start: 9.5, end: 10, duration: 0.5 }
  ]);
  assert.deepEqual(parseOpeningClipDetections("lavfi.silence_start=0\nlavfi.silence_end=5.25\n", "silence", 10), [{ start: 0, end: 5.25, duration: 5.25 }]);
  assert.deepEqual(parseOpeningClipDetections("lavfi.black_start=1e-05\nlavfi.black_end=3\n", "black", 2), [{ start: 0.00001, end: 2, duration: 2 - 0.00001 }]);
  assert.deepEqual(parseOpeningClipDetections("", "black", 10), []);
});

async function mockedQa(t: TestContext, blackMetadata: string, frameCount = "300") {
  const dir = await mkdtemp(join(tmpdir(), "opening-clip-qa-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, "opening.mp4");
  await writeFile(output, "新生成的视频");
  const calls: string[][] = [];
  t.mock.method(childProcess, "spawn", (_command: string, args: string[]) => {
    calls.push(args);
    const child = Object.assign(new EventEmitter(), {
      pid: 123, exitCode: null, signalCode: null,
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true
    }) as unknown as ChildProcess;
    queueMicrotask(() => {
      let text = "";
      if (args.includes("-count_frames")) text = JSON.stringify(probe(frameCount));
      else if (args.includes("-vf") && args.some(arg => arg.includes("blackdetect"))) text = blackMetadata;
      else if (args.includes("-af")) text = "lavfi.silence_start=0\nlavfi.silence_end=3.1\nlavfi.silence_start=5\nlavfi.silence_end=7\n";
      else if (args.includes("-frames:v")) writeFileSync(args.at(-1)!, "验收关键帧");
      child.stdout!.emit("data", text);
      child.emit("close", 0);
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const registrations: Array<ChildProcess | null> = [];
  const spec = {
    projectId: "current-project", projectRevision: 7, generatedAt: new Date().toISOString(),
    output: { width: 1080, height: 1920, fps: 30 },
    cover: { introSeconds: 2 }, opening: { narrationLeadSeconds: 1 },
    subtitleCues: [{ index: 0, start: 0, end: 7, text: "新方案旁白" }]
  } as RenderSpec;
  const input = { root: dir, jobRoot: dir, output, spec, jobCreatedAt: new Date(Date.now() - 1000).toISOString(), durationSeconds: 10, lifecycle: { registerProcess: (child: ChildProcess | null) => registrations.push(child) } };
  return { input, dir, calls, registrations };
}

test("片段 QA 输出逐秒关键帧和专属报告，静音仅记录，不要求全片场景", async t => {
  const { input, dir, calls, registrations } = await mockedQa(t, "");
  const report = await runOpeningClipQa(input);
  assert.equal(report.pass, true);
  const saved = JSON.parse(await readFile(join(dir, "qa", "opening-clip-report.json"), "utf8"));
  assert.equal(saved.scope, "opening-clip-only");
  assert.equal(saved.projectRevision, 7);
  assert.equal(saved.keyframes.length, 10);
  assert.deepEqual(saved.keyframes.map((frame: { time: number }) => frame.time), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(saved.silence.evaluatedAsFailure, false);
  assert.deepEqual(saved.silence.segments.map((segment: { classification: string }) => segment.classification), ["opening", "unplanned"]);
  assert.equal(calls.filter(args => args.includes("scale=270:-2")).length, 10);
  assert.equal(registrations.length, calls.length * 2);
  assert.equal(registrations.filter(child => child === null).length, calls.length);
  assert.equal("allChildrenPresent" in saved.checks, false);
  assert.equal("parentReturn" in saved.checks, false);
});

test("不足 0.1 秒的封面淡出暗帧仅记录，不拒绝片段", async t => {
  const { input, dir } = await mockedQa(t, "lavfi.black_start=1.4\nlavfi.black_end=1.466667\n");
  const report = await runOpeningClipQa(input);
  assert.equal(report.pass, true);
  const saved = JSON.parse(await readFile(join(dir, "qa", "opening-clip-report.json"), "utf8"));
  assert.equal(saved.blackFailureThresholdSeconds, 0.1);
  assert.equal(saved.blackSegments.length, 1);
  assert.equal(saved.checks.noBlackSegments, true);
});

test("黑段或少一帧会保存失败报告并明确拒绝片段", async t => {
  const { input, dir } = await mockedQa(t, "lavfi.black_start=4.2\nlavfi.black_end=4.3\n", "299");
  await assert.rejects(runOpeningClipQa(input), /开头片段 QA 未通过：exactFrameCount、noBlackSegments/);
  const saved = JSON.parse(await readFile(join(dir, "qa", "opening-clip-report.json"), "utf8"));
  assert.equal(saved.pass, false);
  assert.equal(saved.blackSegments.length, 1);
});

test("片段 QA 尊重已取消生命周期，不启动进程", async () => {
  await assert.rejects(runOpeningClipQa({ lifecycle: { cancelled: () => true } } as Parameters<typeof runOpeningClipQa>[0]), /Render cancelled/);
});
