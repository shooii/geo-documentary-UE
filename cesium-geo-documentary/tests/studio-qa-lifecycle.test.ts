import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { runQaCommand, runGoldenQa } from "../apps/studio/golden-qa.js";
import { deliveryValidationFailure, DELIVERY_QA_DETERMINISTIC, isRetryableRenderFailure, runCaptured, publishMapCache } from "../apps/studio/render-engine.js";

function fakeChild(pid = 123): ChildProcess {
  return Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true }) as unknown as ChildProcess;
}

function mockSpawn(t: TestContext, operation: (command: string) => ChildProcess): void {
  t.mock.method(childProcess, "spawn", operation);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("QA 成功与 error/close 重复事件只释放一次进程注册", async (t) => {
  const child = fakeChild();
  mockSpawn(t, () => child);
  const registrations: Array<ChildProcess | null> = [];
  const result = runQaCommand("probe", [], { registerProcess: value => registrations.push(value) });
  child.stdout!.emit("data", "{}");
  child.emit("close", 0);
  child.emit("error", new Error("迟到的错误"));
  assert.equal(await result, "{}");
  assert.deepEqual(registrations, [child, null]);
});

test("QA 启动失败后 close 不会重复清理", async (t) => {
  const child = fakeChild();
  mockSpawn(t, () => child);
  const registrations: Array<ChildProcess | null> = [];
  const result = runQaCommand("probe", [], { registerProcess: value => registrations.push(value) });
  child.emit("error", new Error("ENOENT"));
  child.emit("close", -1);
  await assert.rejects(result, /ENOENT/);
  assert.deepEqual(registrations, [child, null]);
});

test("QA 取消先结束 Windows 进程树，成功退出也不能取消复活", async (t) => {
  const child = fakeChild();
  const killer = fakeChild(456);
  const calls: string[] = [];
  child.kill = () => { calls.push("kill"); return true; };
  mockSpawn(t, command => { calls.push(command); return command === "taskkill" ? killer : child; });
  const controller = new AbortController();
  const registrations: Array<ChildProcess | null> = [];
  const result = runQaCommand("probe", [], { signal: controller.signal, registerProcess: value => registrations.push(value) });
  controller.abort();
  if (process.platform === "win32") {
    assert.deepEqual(calls, ["probe", "taskkill"]);
    killer.emit("error", new Error("taskkill 不可用"));
    killer.emit("exit", 1);
    assert.equal(calls.filter(value => value === "kill").length, 1);
  }
  child.emit("close", 0);
  await assert.rejects(result, /Render cancelled/);
  assert.deepEqual(registrations, [child, null]);
  assert.equal(calls.at(-1), "kill");
});

test("QA 无 close 的取消在有界兜底后结束，超时仍可重试", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const child = fakeChild();
  mockSpawn(t, command => command === "taskkill" ? fakeChild(456) : child);
  let cancelled = false;
  const result = runQaCommand("probe", [], { cancelled: () => cancelled });
  const rejected = assert.rejects(result, /Render cancelled/);
  cancelled = true;
  t.mock.timers.tick(100);
  t.mock.timers.tick(15_000);
  await rejected;
  const timeout = runQaCommand("probe", [], { timeoutMs: 1000 });
  const timedOut = assert.rejects(timeout, error => error instanceof Error && /timed out after 1s/.test(error.message) && isRetryableRenderFailure(error.message));
  t.mock.timers.tick(1000);
  child.emit("close", 0);
  await timedOut;
});

test("QA 已取消时不启动任何子进程", async (t) => {
  mockSpawn(t, () => { throw new Error("不应启动"); });
  assert.throws(() => runQaCommand("probe", [], { cancelled: () => true }), /Render cancelled/);
  await assert.rejects(runGoldenQa({ lifecycle: { cancelled: () => true } } as Parameters<typeof runGoldenQa>[0]), /Render cancelled/);
});

test("正式交付报告的确定性错误优先于进程与网络重试分类", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qa-report-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reportPath = join(dir, "final-delivery-validation.json");
  const startedAt = Date.now();
  await writeFile(reportPath, JSON.stringify({ ok: false, generatedAt: new Date(startedAt).toISOString(), videos: [{ errors: ["resolution:100x100", "exited with 1 ECONNRESET"] }], subtitleErrors: ["semantic-text-mismatch"] }));
  const original = new Error("执行项目交付 QA exited with 1");
  const error = await deliveryValidationFailure(original, reportPath, startedAt);
  assert.match(error.message, new RegExp(DELIVERY_QA_DETERMINISTIC));
  assert.match(error.message, /resolution:100x100/);
  assert.match(error.message, /semantic-text-mismatch/);
  assert.equal(error.cause, original);
  assert.equal(isRetryableRenderFailure(error.message), false);
  assert.match(await readFile(reportPath, "utf8"), /resolution/);
  for (const message of ["执行项目交付 QA timed out after 120s", "ECONNRESET", "执行项目交付 QA exited with null"]) {
    const transient = new Error(message);
    assert.equal(await deliveryValidationFailure(transient, reportPath, startedAt), transient);
    assert.equal(isRetryableRenderFailure(message), true);
  }
  for (const report of [null, { ok: false }, { ok: true, errors: ["bad"] }, { ok: false, generatedAt: new Date(startedAt - 1).toISOString(), errors: ["旧报告"] }, { ok: false, generatedAt: new Date(startedAt).toISOString(), errors: [] }]) {
    await writeFile(reportPath, JSON.stringify(report));
    assert.equal(await deliveryValidationFailure(original, reportPath, startedAt), original);
  }
  await writeFile(reportPath, "不完整 JSON");
  assert.equal(await deliveryValidationFailure(original, reportPath, startedAt), original);
  assert.equal(await deliveryValidationFailure(original, join(dir, "missing.json"), startedAt), original);
});

test("预检取消后即使子进程成功退出也不会继续导出，进程注册只清理一次", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const child = fakeChild();
  mockSpawn(t, command => command === "taskkill" ? fakeChild(456) : child);
  const registrations: Array<ChildProcess | null> = [];
  let cancelled = false;
  const work = runCaptured("preflight", [], { cwd: process.cwd(), timeoutMs: 480_000, lifecycle: { cancelled: () => cancelled, registerProcess: value => registrations.push(value) } });
  const rejected = assert.rejects(work, /Render cancelled/);
  cancelled = true;
  t.mock.timers.tick(100);
  child.emit("close", 0);
  child.emit("error", new Error("迟到错误"));
  await rejected;
  assert.deepEqual(registrations, [child, null]);
});

test("预检取消不等待缺失close，超时报告保持有界且可继续队列", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  mockSpawn(t, () => fakeChild());
  let cancelled = false;
  const work = runCaptured("preflight", [], { cwd: process.cwd(), timeoutMs: 480_000, lifecycle: { cancelled: () => cancelled, registerProcess: () => {} } });
  const rejected = assert.rejects(work, /Render cancelled/);
  cancelled = true;
  t.mock.timers.tick(100);
  t.mock.timers.tick(15_000);
  await rejected;
  const timeout = runCaptured("preflight", [], { cwd: process.cwd(), timeoutMs: 1000 });
  t.mock.timers.tick(1000);
  t.mock.timers.tick(15_000);
  assert.equal((await timeout).timedOut, true);
  await assert.rejects(runCaptured("preflight", [], { cwd: process.cwd(), timeoutMs: 1000, lifecycle: { cancelled: () => true, registerProcess: () => { throw new Error("不应注册"); } } }), /Render cancelled/);
});

test("地图缓存失败发布保持旧文件并清理临时文件，成功才替换", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "map-cache-publish-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, "map.mp4");
  const source = join(dir, "source.mp4");
  await writeFile(target, "原有完整产物");
  await assert.rejects(publishMapCache(join(dir, "missing.mp4"), target));
  assert.equal(await readFile(target, "utf8"), "原有完整产物");
  assert.deepEqual(await readdir(dir), ["map.mp4"]);
  await writeFile(source, "新的完整产物");
  await publishMapCache(source, target);
  assert.equal(await readFile(target, "utf8"), "新的完整产物");
  assert.equal((await readdir(dir)).some(name => name.endsWith(".partial")), false);
});

test("引擎接入 QA 生命周期且 completed 紧前检查取消", async () => {
  const source = await readFile(new URL("../apps/studio/render-engine.ts", import.meta.url), "utf8");
  assert.match(source, /runGoldenQa\(\{[^\n]+lifecycle: \{ cancelled: callbacks.cancelled, registerProcess: callbacks.registerProcess \}/);
  assert.match(source, /if \(callbacks.cancelled\(\)\) throw new Error\("Render cancelled"\);\s+callbacks.update\(\{\s+status: "completed"/);
});
