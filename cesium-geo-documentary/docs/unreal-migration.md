# UE 5.7 迁移与验收记录

基线：`shooii/geo-documentary`，提交 `dea76f3`。开发分支 `refactor/unreal-pixel-streaming`。

当前为可运行的迁移版本，**尚未完成所有子功能或 Cesium 画面逐像素验收**。

## 启动

在 `cesium-geo-documentary` 目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm ue:build
pnpm studio
```

需要 UE 5.7、VS 2022 C++ Build Tools、Windows SDK、支持实时编码的 GPU。
构建脚本接受 `-EngineRoot`；为避开 MSVC 对中文路径的解码问题，在按项目路径散列区分的英文临时目录编译，再把二进制和生成材质复制回本项目。
`workspace/ue-runtime.json` 记录实际引擎与构建项目位置，不含凭据。

默认服务：Studio `http://127.0.0.1:4180`，UE 播放器 `http://127.0.0.1:4174`，浏览器信令 `8888`，UE 信令 `8889`。
当前信令只监听本机，每个实例仅允许一个控制端。公网部署还需 HTTPS/WSS、鉴权、TURN 和独立会话分配；当前不能作为多人公网站点部署。

## 实现边界

| 项目 | 当前状态 |
| --- | --- |
| 两侧页面与样式 | 沿用原 HTML/CSS，仅修改 iframe 的标题、权限及 URL |
| 地图引擎 | UE C++ 原生 WGS84/ENU、球面影像网格，无浏览器 Cesium 渲染 |
| 中间地图 | Epic 官方 UE5.7 Pixel Streaming/WebRTC，实测收到 1080×1920 视频 |
| 双向控制 | 同源校验、旧 Studio 消息协议、命令 ID、超时、UE 回执 |
| 冻结边界 | 先读取方案 boundary 快照，再回退到工作区数据 |
| 行政区描边 | Polygon/MultiPolygon 多环、逐步描边、持续显示 |
| 标签 | UE HUD 中文标签、巡游已访问标签保持、改名消息 |
| 镜头 | 开场下降、巡游、返航、播放/停止、场景片段；竖屏总览复用原 Cesium 边界/视锥取景算法，其他画幅使用同一拟合方式；整体仍未逐帧验收 |
| 卫星底图 | 默认 Cesium ion 资产 2（Bing Maps 航拍），另支持 Esri 和 Mapbox |
| 场景视角 | 在实际画面的「底图视角」调整中心、缩放、旋转、俯仰，随方案保存并用于导出 |
| 导出 | 独立 UE 实例、离线确定时间截图、逐帧回执、FFmpeg 编码，再沿用原字幕/素材/配音合成链路 |
| 穿云 | 补齐开场参数，按参考 SVG/CSS 生成云层纹理并在 UE HUD 内合成；云层显隐/透明度时序与参考算法对照通过；原 Cumulus 体积云形态未逐像素验收 |
| 行政边界后期风格 | 在 UE 内绘制区域填色、黑灰接触阴影、短金色追光、外围压暗；当前村落突出，邻村轮廓减弱；多面与孔洞正确三角化；预览与原生截图共用 |
| 命名地物、地形 | 尚未移植 |
| 预览性能 | 预览按画幅使用 720×1280 / 1280×720 / 720×720，目标 30fps（`GEO_STREAM_FPS` 可调）；正式截图仍按输出尺寸；HUD 全量顶点走一次视图投影矩阵、瓦片可见性只改越界的、下载解码与纹理上传按帧限流、亚像素边界简化、4 路瓦片请求队列和释放过期纹理 |
| 天地图注记 | 尚未移植；启用时明确报错 |
| 完全像素级一致 | 未验收，不应作为已完成交付宣称 |

原 Cesium 播放器保留为参考与回归基线，Studio 默认预览和地图导出已经改走 UE。旧导出与 UE 的缓存签名由 UE 源码内容区分，避免混用。

## 校验

边界风格参考 [GEOlayers 官方示例与 AE 扩展](https://www.geolayers.app/) 及 [Earth Studio 区域覆盖物](https://earth.google.com/studio/docs/en_gb/advanced-features/overlays-and-kmls/)。借鉴区域高亮、轮廓追光和清晰层级，在 UE 中实时实现；未调用 After Effects 软件，也没有复制示例素材。客户端采用铺满画布的视频样式，UE 同步固定 SceneViewport 与实际缓冲区尺寸。

嵌入工作台验证：`pnpm exec tsx scripts/ue-editor-qa.ts` 使用独立 UE/信令实例，在 1196×956 工作台中从方形启动画面切换到竖屏，断言原生画幅和解码视频均为 720×1280，再检查总览和真实村落镜头；截图位于 `workspace/ue-qa/editor-overview.png`、`editor-child.png`、`editor-child-trace.png`。416 项回归通过。

Cesium ion 使用拥有资产 2 读取权限的 `CESIUM_ION_TOKEN`，可放在本机忽略的 `.env.local` 中。Mapbox 沿用 `MAPBOX_ACCESS_TOKEN` 或 `config/project.yaml` 中的影像配置。令牌只在服务端读取，UE 与浏览器通过本机瓦片接口取图。需要代理时，启动服务前设置 `UE_HTTP_PROXY=http://127.0.0.1:10090`。缺少令牌、授权失败和网络故障均返回明确错误。

```powershell
pnpm typecheck
pnpm test
pnpm exec tsx scripts/ue-smoke.ts
pnpm ue:capture --region 440825102 --profile portrait --frames 3 --start-time 8
```

`workspace/ue-qa/` 保存真实视频帧与浏览器视频尺寸诊断。测试数据包括原工作区已有的行政区 JSON、规范化 GeoJSON、广东村界和区划索引；这些原始数据不随 Git 仓库完整提供，换机需要另外导入。

本机实测：UE C++ 编译与材质生成成功；TypeScript 类型检查通过；405 项回归全部通过；浏览器收到 1080×1920 原生视频流；三帧 UE PNG 截图与 H.264 MP4 编码通过。三帧冒烟测试不代表完整成片导出已验收。

2026-11-05 取景/穿云/性能修复验证：414 项回归通过；竖屏相机与 Cesium 原取景算法数值相同；三个真实行政区、三种画幅的边界拟合测试通过。UE 实机三画幅开场抽样均通过完整入镜断言，开场运动采样的渲染帧率约 29.9fps，浏览器接收约 29.3–29.9fps（首次瓦片加载期间仍观察到部分丢帧）。静态截图和报告分别位于 `workspace/ue-qa/portrait-fit.png`、`workspace/ue-qa/portrait-cloud.png`、`renders/ue-frames/440825102-<profile>/capture-report.json`。这里的预览帧率不是完整成片或跨网络性能保证。

2026-11-10 像素流卡顿修复：渲染器日志里的帧号间隔显示，镜头一动就掉到 18–20fps、静止时满 30fps，说明瓶颈在每帧的 CPU 工作而不是 GPU。HUD 每帧对全部边界顶点调用一次 `ProjectWorldLocationToScreen`（镇界 2.1 万点，村落巡游后 4.6 万点），每次都重解析视点和视口；改为取一次画布视图投影矩阵后逐点相乘。瓦片侧把「每帧最多起 18 个请求、回调里立刻建纹理」改成每帧 4 个请求 + 4 次上传，可见性从「每帧给全部缓存瓦片重设」改成只diff 越界的那几个。改后 `GEO_PROFILE` 显示镜头运动期间稳定在 29.4–29.9fps，`apply` 0.04ms、`refresh` 0.01ms，剩下的大头是 `hud` 6.4–7.2ms（压暗/投影阴影每帧约 6500 个 Canvas 四边形）。同时验证过 `GEO_STREAM_FPS=60`：渲染器只能做到 28.6–58.9fps 抖动、码率翻三倍、浏览器侧丢帧 238，比锁 30fps 更差，因此默认仍是 30。测量脚本 `pnpm exec tsx scripts/ue-stream-perf.ts`；`GEO_PROFILE` 每 90 帧一行，在 `workspace/ue-logs/preview-renderer.log`。

后续逐像素验收必须使用同一方案快照、影像源、分辨率、时间点、字体、相机参数，分别保存 Cesium 与 UE PNG，再计算图像误差并人工检查。现有纯逻辑回归通过不等于画面一致。
