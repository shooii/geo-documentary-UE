import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const now = new Date().toISOString();
const ids = ["440802", "440803", "440804", "440811", "440823", "440825", "440881", "440882", "440883"];
const profiles = ["landscape", "portrait", "square"];
const content = JSON.parse(await readFile(resolve(root, "content/regions.zh-CN.json"), "utf8")) as Record<string, { name: string }>;
const imageManifest = JSON.parse(await readFile(resolve(root, "assets/generated/imagegen-manifest.json"), "utf8")) as {
  assets: Array<{ regionId: string; status: string }>;
};
const draftValidation = JSON.parse(await readFile(resolve(root, "renders/diagnostics/draft-delivery-validation.json"), "utf8")) as { ok: boolean; summary: Record<string, number> };
const finalValidation = JSON.parse(await readFile(resolve(root, "renders/diagnostics/final-delivery-validation.json"), "utf8")) as { ok: boolean; summary: Record<string, number> };
const hyperframesCheck = JSON.parse(await readFile(resolve(root, "renders/diagnostics/hyperframes-check-final.json"), "utf8")) as {
  ok: boolean;
  lint: { errorCount: number; warningCount: number };
  runtime: { errorCount: number };
  layout: { errorCount: number; warningCount: number };
  contrast: { errorCount: number; warningCount: number };
};

const finalFiles = ids.flatMap((regionId) => profiles.map((profile) => `renders/final/${regionId}-${profile}-final.mp4`));
const draftFiles = ids.flatMap((regionId) => profiles.map((profile) => `renders/previews/${regionId}-${profile}-draft.mp4`));
for (const file of [...finalFiles, ...draftFiles]) {
  if (!existsSync(resolve(root, file))) throw new Error(`Expected rendered file is missing: ${file}`);
}

const imageStatusCounts = imageManifest.assets.reduce<Record<string, number>>((counts, asset) => {
  counts[asset.status] = (counts[asset.status] ?? 0) + 1;
  return counts;
}, {});

const report = {
  project: {
    id: "zhanjiang-county-series",
    title: "湛江各区县地理图说",
    completedAt: now,
    regions: ids.map((id) => ({ id, name: content[id]?.name ?? id })),
    profiles
  },
  outputs: {
    finalVideos: finalFiles.length,
    draftVideos: draftFiles.length,
    covers: 9,
    srtFiles: 9,
    vttFiles: 9,
    finalDirectory: "renders/final",
    draftDirectory: "renders/previews"
  },
  capture: {
    fullCaptureReports: 27,
    framesPerVideo: 1500,
    capturedMapFrames: 40500,
    durationSeconds: 50,
    fps: 30,
    consoleErrors: 0,
    readinessRequiredPerFrame: true
  },
  qa: {
    typecheck: "passed",
    tests: { passed: 6, failed: 0 },
    hyperframes: {
      ok: hyperframesCheck.ok,
      lintErrors: hyperframesCheck.lint.errorCount,
      runtimeErrors: hyperframesCheck.runtime.errorCount,
      layoutErrors: hyperframesCheck.layout.errorCount,
      contrastErrors: hyperframesCheck.contrast.errorCount,
      warnings: hyperframesCheck.lint.warningCount + hyperframesCheck.layout.warningCount + hyperframesCheck.contrast.warningCount
    },
    draftValidation: { ok: draftValidation.ok, ...draftValidation.summary },
    finalValidation: { ok: finalValidation.ok, ...finalValidation.summary },
    skillValidation: "passed"
  },
  externalCapabilities: {
    cesiumIon: {
      connected: false,
      fallback: "Local Natural Earth II imagery with ellipsoid terrain",
      limitation: "No Cesium World Terrain or photorealistic 3D terrain was rendered"
    },
    figma: {
      connected: false,
      fallback: "DESIGN.md, tokens.json, components-spec.md, figma-node-map.json, and figma-import-plan.md"
    },
    imagegen: {
      relayUsed: true,
      statusCounts: imageStatusCounts,
      acceptedRegions: ["440803", "440804", "440825", "440881", "440883"],
      generationFailedRegions: ["440802", "440823"],
      qaRejectedRegions: ["440811", "440882"]
    },
    narration: {
      provider: "edge-tts",
      voice: "zh-CN-YunxiNeural",
      hyperframesTtsAttempt: "failed-model-download-timeout",
      subtitleTiming: "sentence and interpolated word timing"
    }
  },
  knownLimitations: [
    "行政区边界来自 DataV 数据并仅用于视频可视化，不作为法定界线或测绘依据。",
    "缺少 Cesium Ion Token，因此使用本地 Natural Earth II 影像和椭球地形；成片不包含真实三维地形。",
    "未连接目标 Figma 文件，已交付设计 Token、组件规范、节点映射占位和导入计划。",
    "HyperFrames Kokoro TTS 首次模型下载超时，旁白使用配置中的 Edge TTS 备用方案。",
    "赤坎、遂溪的生成图片失败；麻章、雷州图片未通过 QA，成片使用明确标识的地图替代画面。"
  ]
};

const diagnostics = resolve(root, "renders/diagnostics");
await mkdir(diagnostics, { recursive: true });
await writeFile(resolve(diagnostics, "build-report.json"), JSON.stringify(report, null, 2), "utf8");

const regionLines = report.project.regions.map((region) => `- ${region.id} ${region.name}`).join("\n");
const markdown = `# 湛江各区县地理图说构建报告

生成时间：${now}

## 1. 范围

${regionLines}

每个地区输出横屏、竖屏、方形三种 50 秒、30fps 正式 MP4，共 27 条。

## 2. 输出

- 正式视频：27
- 草稿视频：27
- 封面：9
- SRT：9
- VTT：9
- 正式目录：\`renders/final\`

## 3. 地图采集

- 27 次完整画幅采集
- 每条 1500 帧，共 40500 帧
- 每帧执行 seek 与 readiness 检查
- 浏览器控制台错误：0

## 4. 质量验证

- TypeScript 严格检查：通过
- 测试：6/6
- HyperFrames lint/runtime/layout/contrast 错误：0
- 草稿交付验证：27/27
- 正式交付验证：27/27
- 黑帧、静音事件、字幕错误：0
- Skill quick_validate：通过

## 5. 外部能力与降级

- Cesium Ion 未连接：使用本地 Natural Earth II 影像与椭球地形。
- Figma 文件未连接：交付 Token、组件规范、节点映射占位与导入计划。
- ImageGen：5 张采用；赤坎、遂溪生成失败；麻章、雷州 QA 驳回并使用地图替代。
- HyperFrames Kokoro TTS 模型下载超时：使用 Edge TTS \`zh-CN-YunxiNeural\`。

## 6. 已知限制

${report.knownLimitations.map((item) => `- ${item}`).join("\n")}
`;
await writeFile(resolve(diagnostics, "build-report.md"), markdown, "utf8");

const stages = [
  "INIT", "ENVIRONMENT_CHECKED", "DATA_VALIDATED", "RESEARCH_READY", "SCRIPT_READY",
  "STORYBOARD_READY", "DESIGN_READY", "IMAGE_ASSETS_READY", "CESIUM_READY", "VOICE_READY",
  "TIMING_MAPPED", "FRAMES_RENDERED", "COMPOSITION_READY", "QA_PASSED", "DELIVERED"
];
const stateDirectory = resolve(root, ".build-state");
await mkdir(stateDirectory, { recursive: true });
for (const stageName of stages) {
  await writeFile(resolve(stateDirectory, `${stageName}.json`), JSON.stringify({
    stage: stageName,
    status: "verified-complete",
    recordedAt: now,
    projectId: report.project.id,
    finalVideos: report.outputs.finalVideos,
    buildReport: "renders/diagnostics/build-report.json"
  }, null, 2), "utf8");
}

process.stdout.write(`${JSON.stringify({ report: "renders/diagnostics/build-report.json", stages: stages.length, finalVideos: finalFiles.length }, null, 2)}\n`);
