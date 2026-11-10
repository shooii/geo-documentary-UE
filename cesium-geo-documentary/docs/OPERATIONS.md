# 运行维护

## 断点续建

先检查 `.build-state/`、`renders/diagnostics/` 和目标输出。已有通过报告的行政区和画幅无需重新采集。

## 批量渲染

`scripts/render-profile.ps1` 每次处理一个画幅的全部地区。可同时运行横屏、竖屏、方形三个进程；每个 HyperFrames 渲染固定 `--workers 1`，降低显存竞争。

FFmpeg 与 FFprobe 来自项目静态依赖。脚本首次运行时会复制到 `%LOCALAPPDATA%\cesium-geo-documentary-tools`，规避 Windows 中文路径代码页问题。

## 失败重试与磁盘回收

WorkBuddy 工作台的导出按「尽量自己恢复」设计，四条规则：

- **失败自动重试一次**。只对可重试失败重跑：外部工具非零退出（配音、采集、合成、编码）和进程级网络错误。
  QA 未通过、配置不完整、素材挡住场景边界这类确定性失败不重试，直接报错。次数上限用 `STUDIO_JOB_ATTEMPTS` 调整（默认 2，最大 3）。
  重跑不是从零开始：配音复用已测好的音频，地图缓存按签名命中后直接从约 48% 续跑。
- **编码前预检**。合成完成后、编码开始前跑一次 `hyperframes check`，只拦 `error` 级问题；工具本身跑不起来（超时、崩溃、输出不可解析）视为无结论并放行，不制造新的失败。
  `STUDIO_PREFLIGHT=off` 关闭；`STUDIO_PREFLIGHT_SAMPLES`（默认 8）、`STUDIO_PREFLIGHT_TIMEOUT_MS`（默认 480000）可调。
- **方案快照保留**。每次保存写入新的 `workspace/projects/<id>.v######.json`。现在保留最近 30 个修订 + 最近 14 天的每日归档点，每 25 次保存清理一次。
  策略在 `apps/studio/project-revisions.ts`，编辑器只读最新修订，历史快照不提供浏览入口。
- **终态任务自动回收沙箱**。任务进入完成/失败/取消后，回收作业目录链接与 `%TEMP%\geo-video-studio\<jobId>` 实体，保留 `output/`、`qa/`、`job.json`、`render-spec*.json`；回收前把旁白音频落到 `<jobDir>/audio/` 供旁白预览复用。

历史积压用 `pnpm workspace:prune` 查看，默认只读：

```
pnpm workspace:prune            # 列出每个任务的中间产物体积与合计
pnpm workspace:prune -- --apply # 真正删除
```

它会顺带清理过期的方案快照。只碰三处：任务自己的 `sandbox`、同名的临时工作副本、过期快照；成片、QA 报告和任务记录都不动。

`--apply` 要在**普通终端**里跑，不要在 WorkBuddy 会话里跑。CLI 会给会话注入一个批量删除守卫
（`CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD`，默认 20），预算按**会话**累计、不按轮次重置，
一次 `--apply` 要删上千个条目，必然被拦在
`[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]` 上并中断进程。被拦时进程是在**删到一半时**
抛出的，所以看到命令失败不要以为它没干活——重新跑一次只读预览，对比合计值就知道实际删掉了多少。
普通终端没有这个守卫，一次跑完。

## 日志与诊断

- UE 录制（当前管线）：`renders/ue-frames/<region>-<profile>/`（`frame-%06d.png`、`unreal-*.log`、
  `capture-report.json`，内含 `framesWritten` 与实际编码时长）。导出失败时这些文件会被复制到
  `workspace/jobs/<jobId>/diagnostics/`。
- Cesium 采集（旧管线）：`renders/diagnostics/<region>-<profile>/capture-report-full.json`
- HyperFrames 队列：`renders/diagnostics/render-<quality>-<profile>.*.log`
- 草稿验证：`renders/diagnostics/draft-delivery-validation.json`
- 正式验证：`renders/diagnostics/final-delivery-validation.json`
- 总构建报告：`renders/diagnostics/build-report.json` 和 `.md`

## 发布前检查

运行 `pnpm typecheck`、`pnpm test`、HyperFrames check 和最终交付验证。确认报告为 27/27 或符合当前配置的完整数量后再发布。
