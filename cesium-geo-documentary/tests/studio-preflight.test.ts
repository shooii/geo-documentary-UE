import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { summarizePreflightReport, previewStopCommand } from "../apps/studio/render-engine.js";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

const root = resolve(import.meta.dirname, "..");

test("暂停预览命令只终止同实例，目标消失或PID复用显式成功", { skip: process.platform !== 'win32' }, async () => {
  const command = previewStopCommand('123');
  assert.match(command, /if \(& \$same \$p\) \{ & taskkill\.exe/);
  assert.match(command, /if \(& \$same \$remaining\) \{ exit \$killCode \}/);
  assert.match(command, /; exit 0$/);
  assert.throws(() => previewStopCommand('123;exit 0'), /PID/);
  const exec = promisify(execFile);
  for (const scenario of ['missing', 'gone', 'reused', 'alive', 'different', 'success']) {
    const mock = `$global:queries=0; $global:kills=0; function Get-CimInstance { param($ClassName,$Filter) $global:queries++; if ('${scenario}' -eq 'missing' -or ('${scenario}' -eq 'gone' -and $global:queries -gt 1)) { return }; $text='owned'; if ('${scenario}' -eq 'different' -or ('${scenario}' -eq 'reused' -and $global:queries -gt 1)) { $text='other' }; [pscustomobject]@{CommandLine=$text;CreationDate=[datetime]::MinValue;ExecutablePath='owned.exe'} }; function taskkill.exe { $global:kills++; $global:LASTEXITCODE=128; if ('${scenario}' -eq 'success') { $global:LASTEXITCODE=0 }; [Console]::WriteLine('MOCK_TASKKILL') }; `;
    const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', mock + command], {
      windowsHide: true, timeout: 10_000,
      env: { ...process.env, GEO_PREVIEW_COMMAND: 'owned', GEO_PREVIEW_CREATED: '0', GEO_PREVIEW_EXECUTABLE: 'owned.exe' }
    }).then(value => ({ ...value, code: 0 }), error => ({ stdout: String(error.stdout), code: error.code }));
    assert.equal(result.code, scenario === 'alive' ? 128 : 0, scenario);
    assert.equal(result.stdout.includes('MOCK_TASKKILL'), !['missing', 'different'].includes(scenario), scenario);
  }
});

test("the composition preflight gates on errors and never on warnings", () => {
  // Captured from `hyperframes check --json` against this workspace's own
  // composition: 798 warnings, 0 errors, exit 0, and it renders fine.
  const warningHeavy = {
    ok: true,
    strict: false,
    lint: { ok: true, errorCount: 0, warningCount: 798, infoCount: 29, findings: [{ severity: "warning", code: "duplicate_audio_track", message: "Multiple <audio> elements on track 6 overlap" }] },
    runtime: { ok: true, errorCount: 0, warningCount: 0, findings: [] },
    layout: { ok: true, errorCount: 0, warningCount: 0, findings: [] },
    motion: { ok: true, errorCount: 0, warningCount: 2, findings: [], enabled: false },
    contrast: { ok: true, errorCount: 0, warningCount: 0, findings: [], enabled: true, samples: 0 }
  };
  assert.equal(summarizePreflightReport(warningHeavy).errors, 0, "warnings must not block an export");
  assert.equal(summarizePreflightReport(warningHeavy).warnings, 800);
  assert.equal(summarizePreflightReport(warningHeavy).perSection.length, 5);

  const withErrors = {
    ok: false,
    lint: { errorCount: 0, warningCount: 3, findings: [] },
    layout: { errorCount: 2, warningCount: 0, findings: [{ severity: "error", message: "caption-4 overflows the canvas" }] },
    contrast: { errorCount: 1, warningCount: 0, findings: [{ severity: "error", message: "subtitle contrast 2.1 below AA" }] }
  };
  const summary = summarizePreflightReport(withErrors);
  assert.equal(summary.errors, 3);
  assert.deepEqual(summary.findings, [
    "layout: caption-4 overflows the canvas",
    "contrast: subtitle contrast 2.1 below AA"
  ]);

  // 报错必须点名元素：`Two text blocks overlap and may render unreadable.`
  // 曾经让人（和一次导出）来回猜它到底指哪两块文字。
  const located = summarizePreflightReport({
    ok: false,
    layout: {
      errorCount: 1,
      findings: [{
        severity: "error",
        code: "content_overlap",
        message: "Two text blocks overlap and may render unreadable.",
        selector: "#provider-credit",
        containerSelector: "#visual-caption-2",
        time: 8.734
      }]
    }
  } as never);
  assert.deepEqual(located.findings, [
    "layout: Two text blocks overlap and may render unreadable. [#provider-credit ↔ #visual-caption-2] @8.7s"
  ]);

  // A report the tool could not produce must never look like a verdict.
  assert.equal(summarizePreflightReport(null).errors, 0);
  assert.equal(summarizePreflightReport(undefined).errors, 0);
  assert.equal(summarizePreflightReport({} as never).errors, 0);
});

test("预检超时先清理树并在15秒宽限内settle，error和close幂等", async () => {
  const engine = await readFile(resolve(root, "apps/studio/render-engine.ts"), "utf8");
  const source = engine.slice(engine.indexOf('function runCaptured('), engine.indexOf('function preflightEnabled('));
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let nextTimer = 0, kills = 0;
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { throw new Error('不可先杀父进程'); } });
  const { code } = transformSync(`${source}\nrunCaptured;`, { loader: 'ts' });
  const captured = runInNewContext(code, {
    spawn: () => child, process: { env: {} }, killProcessTree: () => { kills++; },
    setTimeout: (callback: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
    clearTimeout: (id: number) => timers.delete(id)
  }) as (exe: string, args: string[], options: object) => Promise<{ timedOut: boolean; code: number | null; stderr: string }>;
  const result = captured('mock', [], { cwd: '.', timeoutMs: 100 });
  timers.get(1)!.callback();
  assert.equal(kills, 1);
  assert.equal(timers.get(2)?.ms, 15_000);
  timers.get(2)!.callback();
  assert.equal((await result).timedOut, true);
  assert.equal((await result).code, null);
  child.emit('error', new Error('迟到错误'));
  child.emit('close', 0);
  assert.equal((await result).stderr, '');
  assert.equal(timers.size, 0);
});

test("command跨输出分片保留fatal清理标记，优先于exit和watchdog超时", async () => {
  const engine = await readFile(resolve(root, 'apps/studio/render-engine.ts'), 'utf8');
  const source = engine.slice(engine.indexOf('function command(callbacks:'), engine.indexOf('function relativeAssetPath('));
  const { code } = transformSync(`${source}\ncommand;`, { loader: 'ts' });
  for (const timeout of [false, true]) {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    const timers: Array<() => void> = [];
    const command = runInNewContext(code, {
      spawn: () => child, process: { env: {} }, CAPTURE_CLEANUP_FATAL: 'UE_CAPTURE_CLEANUP_FATAL',
      commandTimeoutMs: () => 1000, killProcessTree: () => {},
      setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; }, clearTimeout: () => {}
    });
    const result = command({ cancelled: () => false, update: () => {}, registerProcess: () => {} }, '.', 'mock', [], 'capturing', '录制', 42);
    const rejected = assert.rejects(result, /UE_CAPTURE_CLEANUP_FATAL/);
    child.stderr.emit('data', 'UE_CAPTURE_CLEAN');
    child.stderr.emit('data', 'UP_FATAL: 清理失败');
    if (timeout) { timers[0]!(); timers[1]!(); }
    else child.emit('close', 1);
    await rejected;
  }
});

test("the preflight runs before the encode and stays out of the way when it cannot run", async () => {
  const engine = await readFile(resolve(root, "apps/studio/render-engine.ts"), "utf8");
  // It has to sit between composition and encoding — the composition does not
  // exist before the map video does, and the whole point is to refuse a
  // composition that cannot render *before* twenty minutes of encoding.
  const compose = engine.indexOf('"合成素材、字幕、配音与地图"');
  // There is also a pre-capture gate that calls the same helper (see
  // export-preflight-order.test.ts), so the one that must follow this
  // composition is the LAST call site, not the first.
  const preflight = engine.lastIndexOf("await preflightComposition(sandbox, callbacks");
  const encode = engine.indexOf('"编码新的 MP4", 79');
  assert.ok(compose > 0 && preflight > compose, "the preflight must run after composition");
  assert.ok(encode > preflight, "the preflight must run before the encode");
  // An inconclusive preflight passes the export through rather than inventing a
  // new failure mode.
  assert.match(engine, /PREFLIGHT_INCONCLUSIVE/);
  assert.match(engine, /if \(!report\) \{/);
  assert.match(engine, /STUDIO_PREFLIGHT/);
  assert.doesNotMatch(engine, /"check", "\.", "--json", "--samples", String\(samples\), "--strict"/);
});
