import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  OLD_AA,
  NEW_AA,
  FIX_SIG,
  patchFile,
  resolveHyperframesDist,
  syncRuntimeManifest,
  targetPaths
} from "../scripts/patch-hyperframes-volume-envelope.mjs";

/**
 * 回归护栏：hyperframes runtime 的音量包络采样曾让镇隆镇 683s 成片的预检在
 * page.goto(domcontentloaded) 阶段打满 180s 超时（runtime aa() 对常量音量也
 * 逐帧扫全时间轴，O(片长×fps×tween)）。补丁必须：①常量音量跳过采样；
 * ②真实音量动画（volume/startAt/keyframes/数组/嵌套）保留包络；③幂等可重装。
 */

test("补丁常量精确描述修复前后的 aa()", () => {
  // OLD：无条件调用采样器 Bc(e,i,n,60)
  assert.match(OLD_AA, /function aa\(e,t,n,r\)/);
  assert.match(OLD_AA, /Bc\(e,i,n,60\)/);
  assert.doesNotMatch(OLD_AA, /getChildren/);

  // NEW：先探测 getChildren(true,true,false)，仅对含 volume 动画的 tween 采样
  assert.match(NEW_AA, /function aa\(e,t,n,r\)/);
  assert.match(NEW_AA, /getChildren/);
  assert.match(NEW_AA, /q\.call\(t,true,true,false\)/);
  assert.ok(NEW_AA.includes(FIX_SIG), "NEW 必须含音量检测签名");
  assert.doesNotMatch(OLD_AA, new RegExp(FIX_SIG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // 递归检测 vars.startAt / vars.keyframes / 数组，覆盖 GSAP 常见音量写法
  assert.match(NEW_AA, /h\(v\.startAt\)/);
  assert.match(NEW_AA, /h\(v\.keyframes\)/);
  assert.match(NEW_AA, /Array\.isArray\(v\)&&v\.some\(h\)/);
  // target 必须命中当前媒体，避免误采样别的元素
  assert.match(NEW_AA, /x\.targets\(\)\.includes\(e\)/);
  // 采样器与缓存回写保持不变
  assert.match(NEW_AA, /Bc\(e,i,n,60\)/);
  assert.match(NEW_AA, /a&&r\.set\(e,a\)/);
});

test("补丁对 plain 形态（独立 runtime 文件）幂等替换", () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-vol-patch-plain-"));
  try {
    const file = join(dir, "runtime.js");
    writeFileSync(file, "// head\n" + OLD_AA + "\n// tail\n", "utf8");
    assert.equal(patchFile(file, false).status, "PATCHED");
    const after = readFileSync(file, "utf8");
    assert.ok(after.includes(FIX_SIG));
    assert.ok(!after.includes(OLD_AA));
    assert.ok(after.startsWith("// head\n"));
    assert.ok(after.endsWith("// tail\n"));
    assert.equal(patchFile(file, false).status, "ALREADY_PATCHED", "二次运行必须幂等");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("补丁对 esc 形态（cli.js 内嵌字符串字面量）幂等替换", () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-vol-patch-esc-"));
  try {
    const file = join(dir, "cli.js");
    const oldEsc = OLD_AA.replaceAll('"', '\\"');
    writeFileSync(file, "var RUNTIME_IIFE='" + oldEsc + "';", "utf8");
    assert.equal(patchFile(file, false).status, "PATCHED");
    const after = readFileSync(file, "utf8");
    assert.ok(after.includes(NEW_AA.replaceAll('"', '\\"')));
    assert.ok(!after.includes(oldEsc));
    assert.equal(patchFile(file, false).status, "ALREADY_PATCHED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("补丁目标覆盖 cli.js 与两份 runtime 副本", () => {
  const dist = resolveHyperframesDist();
  assert.ok(dist, "应能解析 hyperframes/dist（含 pnpm 软链）");
  const targets = targetPaths(dist).map((p) => p.replace(/\\/g, "/"));
  assert.ok(targets.some((p) => p.endsWith("/cli.js")));
  assert.ok(targets.some((p) => p.endsWith("/hyperframe-runtime.js")));
  assert.ok(targets.some((p) => p.endsWith("/hyperframe.runtime.iife.js")));
});

test("syncRuntimeManifest 在 runtime 变更后同步真实 sha256，且二次运行幂等", () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-vol-manifest-"));
  try {
    const iifeName = "hyperframe.runtime.iife.js";
    const iifePath = join(dir, iifeName);
    const manifestPath = join(dir, "hyperframe.manifest.json");
    // 模拟 patch 前：manifest 记录旧摘要，iife 已是打过补丁的新字节。
    writeFileSync(iifePath, "// patched runtime bytes\n" + NEW_AA, "utf8");
    writeFileSync(manifestPath, JSON.stringify({
      version: "0.1.0",
      sha256: "0".repeat(64),
      artifacts: { iife: iifeName, esm: "hyperframe.runtime.mjs" }
    }), "utf8");

    const first = syncRuntimeManifest(dir, false);
    assert.equal(first.status, "SYNCED");
    const actual = createHash("sha256").update(readFileSync(iifePath)).digest("hex");
    const afterFirst = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(afterFirst.sha256, actual, "manifest 必须写入 iife 的真实 sha256");

    const second = syncRuntimeManifest(dir, false);
    assert.equal(second.status, "ALREADY_SYNCED", "二次运行必须幂等");
    const afterSecond = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(afterSecond.sha256, afterFirst.sha256, "幂等运行不得改变摘要");

    // 再改一次 runtime 字节，必须重新同步到新摘要（防止完整性校验被绕过）。
    writeFileSync(iifePath, "// patched runtime bytes v2\n" + NEW_AA, "utf8");
    const third = syncRuntimeManifest(dir, false);
    assert.equal(third.status, "SYNCED");
    const newActual = createHash("sha256").update(readFileSync(iifePath)).digest("hex");
    assert.notEqual(newActual, actual);
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).sha256, newActual);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
