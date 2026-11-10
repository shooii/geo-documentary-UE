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
| 行政边界后期风格 | 在 UE 内绘制区域填色、黑灰接触阴影、短金色追光、外围压暗；压暗与接触阴影的挖洞**始终是乡镇边界**，村巡游时不会把镇域也压暗；上级县界由镇中心向外**距离场蔓延**（极坐标扰动 + 逐行抖动 + 湿边），不再是直线擦除；**上级名称不再钉在县城点上**——县城点落在下级镇界上时（雷州市 / 龙门镇），名称沿镇界最近的空白侧让开、留在县域内，并在 HUD 占据登记里预留，下级名称不会压上来；当前村落突出，邻村轮廓减弱；多面与孔洞正确三角化；预览与原生截图共用 |
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

2026-11-10 像素流卡顿修复：渲染器日志里的帧号间隔显示，镜头一动就掉到 18–20fps、静止时满 30fps，说明瓶颈在每帧的 CPU 工作而不是 GPU。HUD 每帧对全部边界顶点调用一次 `ProjectWorldLocationToScreen`（镇界 2.1 万点，村落巡游后 4.6 万点），每次都重解析视点和视口；改为取一次画布视图投影矩阵后逐点相乘。瓦片侧把「每帧最多起 18 个请求、回调里立刻建纹理」改成每帧 4 个请求 + 4 次上传，可见性从「每帧给全部缓存瓦片重设」改成只diff 越界的那几个。改后 `GEO_PROFILE` 显示镜头运动期间稳定在 29.4–29.9fps，`apply` 0.04ms、`refresh` 0.01ms，剩下的大头是 `hud` 6.2–9.2ms；把 HUD 再拆成 `rings`/`mask`/其余之后可见，边界环与压暗遮罩合计只有 0.4ms，其余都花在县界擦除（12.5k 点描边两遍 + 填充裁剪）和标签排字上。压暗与投影阴影的 6500 个四边形已合成 4 个三角形批次，测得的 `hud` 没变化——这部分本来就不是瓶颈。同时验证过 `GEO_STREAM_FPS=60`：渲染器只能做到 28.6–58.9fps 抖动、码率翻三倍、浏览器侧丢帧 238，比锁 30fps 更差，因此默认仍是 30。测量脚本 `pnpm exec tsx scripts/ue-stream-perf.ts`；`GEO_PROFILE` 每 90 帧一行，在 `workspace/ue-logs/preview-renderer.log`。

2026-11-10 上级县界改为蔓延：原来是 PPT 式直线擦除（Sutherland-Hodgman 沿 X 轴切三角 + 一条刀锋线）。改成以乡镇标签为种子的距离场：`BaseRadius = (Reach+Jitter)*wipe^1.1 - Jitter`，半径按极角叠三条不通约正弦（3/5/11 次谐波，±18%，随 mapTime 缓慢漂移）形成舌状前缘，再叠每行 ±4px 抖动做撕裂边；县界填充改为扫描线奇偶填充（与压暗遮罩同一套），逐行用「左/右各自求半宽 + 两次定点迭代」求与前缘的交点，县界描边用同一距离场 + 二分求出交点裁切，前沿再加一条 7px 湿边。`LobeFade` 在 wipe→1 时把扰动收到 0，保证收尾时县界干净闭合、不留缝。副产品：县界环从每帧投影 3 遍（填充/刀锋/描边×2）降到 1 遍，这段 hud 从 ~10ms 降到 ~2.3ms。

2026-11-10 上级名称避让下级边界：原来县名固定画在 `labelPoint`（县城点）上，雷州市的点落在龙门镇北缘上，于是县名直接压着镇界线；而且旧逻辑要求「名字必须塞进镇内接圆」，总览时把它压到 16px，看着又小又糊。现在改成求解式落位：以县城点为原点，沿上下左右四个方向求「框跨度内的镇界包络」得到最近出口，候选取最短位移；每个候选要满足在安全框内、不进字幕带、不压镇界（盒内 4×3 采样点判 inside）、且在县域内（中心 + 四角 ≥3 个在内），并记进 `Occupied` 让村名镇名都避开它；上一次的落位在仍然成立时优先沿用，避免镜头移动时左右跳。县名字号 42→52（不再被内接圆压缩，实测字形约 34.7px@720 宽），镇名下限 16→24。显影区间从 `SmoothStep(.82,1,contextReveal)` 放宽到 `.45~.85`，否则在这条时间线上县名几乎没有可读窗口。验证通道：给 `apps/ue-player/dev.ts` 加了 `UE_CAPTURE_ROOT` 开关，启动时带 `-GeoCaptureRoot`，`geoVideo.renderFrame(t)` 就能离线渲染指定场景时间并落 PNG，不再受实时流单控制席（一个 UE 实例只接受第一个观看端的指令）影响。两边截图核对：雷州市在镇界上方留白、徐闻县在镇界右侧留白。

后续逐像素验收必须使用同一方案快照、影像源、分辨率、时间点、字体、相机参数，分别保存 Cesium 与 UE PNG，再计算图像误差并人工检查。现有纯逻辑回归通过不等于画面一致。
