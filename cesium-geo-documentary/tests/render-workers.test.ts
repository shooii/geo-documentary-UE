import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// 抽帧阶段是一次导出里最长的一步（400 秒竖屏片子实测 34 分钟），而且天然可并行：
// 每帧都对同一个确定性时钟渲染，多开 worker 改变的是「什么时候截到这些帧」，
// 不是帧的内容。Studio 以前把它保守地钉在 1，实测同一份 13.6 秒合成：
// 1 worker 总 74.7 s（抽帧 ~62 s）→ 4 workers 总 41.1 s（抽帧 29.9 s），约 2.1×。
const root = process.cwd();

test("the render asks HyperFrames for parallel capture workers, overridable per host", async () => {
  const engine = await readFile(resolve(root, "apps/studio/render-engine.ts"), "utf8");
  assert.doesNotMatch(engine, /"--workers", "1"/, "写死 1 个 worker 就是那条 34 分钟的抽帧");
  assert.match(engine, /"--workers", String\(renderWorkerCount\(\)\)/);
  assert.match(engine, /const requested = Number\(process\.env\.STUDIO_RENDER_WORKERS \?\? 4\);/);
  assert.match(engine, /return Math\.max\(1, Math\.min\(8, Math\.floor\(requested\)\)\);/);
});
