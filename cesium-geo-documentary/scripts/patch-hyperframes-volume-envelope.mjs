/**
 * 持久化幂等补丁：修复 hyperframes 0.7.72 runtime 的音量包络采样性能灾难。
 *
 * 背景：runtime 的 aa() 对每个 <audio>/<video> 都会调用 Bc() 逐帧(60fps)扫描
 * 整段时间轴探测音量包络。镇隆镇成片 683s + 数千 tween 时，这是
 * O(片长×fps×tween) 的二次方计算，使 DOMContentLoaded 在 page.goto 阶段被打满
 * 180s 超时，hyperframes check 的 runtime 检查报 "Navigation timeout of 180000 ms exceeded"。
 *
 * 修复：仅当时间轴里确实存在作用于该媒体元素的音量动画（vars/startAt/keyframes 含
 * volume）时才采样；常量音量完全跳过，行为不变（常量音量本就无需包络）。
 * 已用独立浏览器验证：常量音量 seeks 602→0；直接 volume/startAt/keyframes/数组/
 * 嵌套 tween 全部保留包络；target 不匹配不误采样；无 getChildren 走兼容路径。
 *
 * 为什么需要：hyperframes 装在 node_modules（pnpm 软链），pnpm install / CI 重装
 * 会还原成未修复版。把修复固化为脚本，可在安装后重复运行（幂等）。
 *
 * 用法：  node scripts/patch-hyperframes-volume-envelope.mjs [--dry-run]
 * 退出码：0=全部就绪（已修复或本轮修复）；1=有目标无法处理（版本不匹配/路径缺失）。
 */
import { existsSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRY_RUN = process.argv.includes("--dry-run");

// 修复前的 aa()（hyperframes 0.7.72 原样，无音量动画检测）
const OLD_AA = 'function aa(e,t,n,r){if(!t||!(e instanceof HTMLAudioElement)&&!(e instanceof HTMLVideoElement)||n<=0)return;let i=c=>{try{typeof t.totalTime=="function"?t.totalTime(c,!0):typeof t.seek=="function"&&t.seek(c,!0)}catch{}},o=typeof t.totalTime=="function"?Number(t.totalTime()):typeof t.seek=="function"?Number(t.seek()):0,a=Bc(e,i,n,60);Number.isFinite(o)&&i(o),a&&r.set(e,a)}';

// 修复后的 aa()：先探测 getChildren(true,true,false)，只在该媒体存在音量动画时采样
const NEW_AA = 'function aa(e,t,n,r){if(!t||!(e instanceof HTMLAudioElement)&&!(e instanceof HTMLVideoElement)||n<=0)return;try{let q=t.getChildren;if(typeof q==="function"){let h=v=>v&&typeof v==="object"&&(Object.prototype.hasOwnProperty.call(v,"volume")||h(v.startAt)||h(v.keyframes)||Array.isArray(v)&&v.some(h)),a=q.call(t,true,true,false);if(!a.some(x=>typeof x.targets==="function"&&x.targets().includes(e)&&h(x.vars)))return}}catch{}let i=c=>{try{typeof t.totalTime=="function"?t.totalTime(c,!0):typeof t.seek=="function"&&t.seek(c,!0)}catch{}},o=typeof t.totalTime=="function"?Number(t.totalTime()):typeof t.seek=="function"?Number(t.seek()):0,a=Bc(e,i,n,60);Number.isFinite(o)&&i(o),a&&r.set(e,a)}';

// 修复 Signature：出现在 NEW_AA 中、绝不出现在 OLD_AA 中
// cli.js 的 aa 位于单引号字符串字面量内，双引号被转义成 \"；runtime 独立文件里是原样 "。
// 因此匹配/替换都要考虑两种形态。
const FIX_SIG_PLAIN = 'Object.prototype.hasOwnProperty.call(v,"volume")';
const FIX_SIG_ESC = 'Object.prototype.hasOwnProperty.call(v,\\"volume\\")';
export const FIX_SIG = FIX_SIG_PLAIN;
export { OLD_AA, NEW_AA };

function countOccurrences(haystack, needle) {
  let count = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { count++; i += needle.length; }
  return count;
}

/** 解析 hyperframes 的 dist 目录（跟随 pnpm 软链到真实包） */
export function resolveHyperframesDist() {
  try {
    const pkgPath = require.resolve("hyperframes/package.json", { paths: [ROOT] });
    return join(dirname(realpathSync(pkgPath)), "dist");
  } catch {
    const direct = join(ROOT, "node_modules", "hyperframes", "dist");
    return existsSync(direct) ? realpathSync(direct) : null;
  }
}

/** 对单文件做幂等替换，返回 {file, status} */
export function patchFile(file, dryRun = DRY_RUN) {
  if (!existsSync(file)) return { file, status: "MISSING" };
  const src = readFileSync(file, "utf8");
  if (src.includes(FIX_SIG_PLAIN) || src.includes(FIX_SIG_ESC)) return { file, status: "ALREADY_PATCHED" };

  for (const [oldForm, newForm] of [
    [OLD_AA, NEW_AA],
    [OLD_AA.replaceAll('"', '\\"'), NEW_AA.replaceAll('"', '\\"')]
  ]) {
    const oldCount = countOccurrences(src, oldForm);
    if (oldCount === 0) continue;
    if (oldCount !== 1) return { file, status: `AMBIGUOUS(${oldCount})` };
    const out = src.replace(oldForm, newForm);
    if (!dryRun) writeFileSync(file, out, "utf8");
    return { file, status: dryRun ? "WOULD_PATCH" : "PATCHED" };
  }
  return { file, status: "NO_MATCH" };
}

export function targetPaths(dist) {
  // cli.js 内的 RUNTIME_IIFE 是字符串字面量，但 aa() 源码不含单引号，OLD_AA 原文可直接匹配
  return [
    join(dist, "cli.js"),
    join(dist, "hyperframe-runtime.js"),
    join(dist, "hyperframe.runtime.iife.js")
  ];
}

/**
 * Patching hyperframe.runtime.iife.js changes its bytes, so the manifest's
 * sha256 must be refreshed or HyperframeRuntimeLoader rejects the runtime at
 * encode time ("Runtime checksum mismatch"). Idempotent: rewrites only when the
 * recorded digest differs from the actual patched artifact.
 */
export function syncRuntimeManifest(dist, dryRun = DRY_RUN) {
  const manifestPath = join(dist, "hyperframe.manifest.json");
  if (!existsSync(manifestPath)) return { file: manifestPath, status: "MISSING" };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const iifeName = manifest.artifacts?.iife;
  if (!iifeName || !manifest.sha256) return { file: manifestPath, status: "INVALID" };
  const iifePath = join(dist, iifeName);
  if (!existsSync(iifePath)) return { file: manifestPath, status: "MISSING_ARTIFACT" };
  const actual = createHash("sha256").update(readFileSync(iifePath)).digest("hex");
  if (manifest.sha256 === actual) return { file: manifestPath, status: "ALREADY_SYNCED" };
  const next = { ...manifest, sha256: actual };
  if (!dryRun) writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { file: manifestPath, status: dryRun ? "WOULD_SYNC" : "SYNCED" };
}

function main() {
  const dist = resolveHyperframesDist();
  if (!dist) {
    console.error("[hyperframes-volume-patch] 找不到 hyperframes/dist；请先 pnpm install");
    process.exit(1);
  }
  console.log(`[hyperframes-volume-patch] dist = ${dist}${DRY_RUN ? " (DRY RUN)" : ""}`);
  let failed = false;
  for (const file of targetPaths(dist)) {
    const r = patchFile(file);
    console.log(`  ${r.status.padEnd(18)} ${file}`);
    if (["MISSING", "NO_MATCH"].includes(r.status) || r.status.startsWith("AMBIGUOUS")) failed = true;
  }
  const manifestResult = syncRuntimeManifest(dist);
  console.log(`  ${manifestResult.status.padEnd(18)} ${manifestResult.file}`);
  if (["MISSING", "INVALID", "MISSING_ARTIFACT"].includes(manifestResult.status)) failed = true;
  if (failed) {
    console.error("[hyperframes-volume-patch] 有目标无法处理：可能 hyperframes 版本已升级（aa 函数形态变化）。请人工核对。");
    process.exit(1);
  }
  console.log("[hyperframes-volume-patch] 完成，全部目标已就绪。");
}

// 仅当作为主模块运行时执行 main（被 import 做测试时不触发）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
