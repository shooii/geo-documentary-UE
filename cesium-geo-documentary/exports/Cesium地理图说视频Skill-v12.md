# Cesium 地理图说视频 Skill v12（2026-08-09）

版本：`cesium-geo-documentary-skill-v12-20260809.zip`

## 本版新增：世界到行政区的穿云开场

- 每支独立成片以“封面 → 高空地球 → 穿透云层 → 行政区范围”开场。封面之后，Cesium 画面从区域中心上方至少 800 公里（默认约 2200 公里）的高空开始，镜头沿同一经度/纬度连续俯冲，穿过内置 `CloudCollection` 体积云层，精确落在父级概览相机上，随即开始父级边界笔绘。
- 俯冲全程是地图视频内**一条连续相机飞行**，默认 10 秒（可配置 6–16 秒），高度与俯仰角用五次平滑曲线插值、末端减速；云层从高空若隐若现到穿越时铺满画面，再在概览高度前完全消散。禁止在封面、云层、边界揭示之间出现硬切、相机重置或交叉淡化。
- 为保证丝滑：整段俯冲按 ≤0.5 秒间隔预热并在同样间隔设置重载检查点；开场与边界揭示合并为同一动态区间；末帧用 `--end-inclusive` 精确落在概览状态。高空地球边缘可能出现 1 LSB 的亚像素抖动，开场帧允许“低于 0.1% 像素变化且平均差 ≤3”的视觉稳定判定，概览稳态帧仍要求字节级一致。
- 换用新开场后必须**整段重捕**地图视频；不要用单独预热的新开场拼接旧视频，因为瓦片 LOD 选择依赖缓存历史，两次渲染拼接处会出现清晰度跳变。

## 核心制作规范（延续）

- 边界永远贴地：`clampToGround: true`、地形分类填充、无高度偏移；深色底线 + 语义主线相邻 `zIndex`。
- 层级配色：父级湖蓝 `#2D9CDB`、选中下级金色 `#FFD166`、上下文下级冷白 `#E8F0F5`；交接时边界不得黑闪、空白或白闪。
- 父级边界一次性笔绘（约 3.0–3.4 秒），随后完整下级边界组整体淡入；揭示期间相机完全固定。
- 区域转场用 `Cesium.EllipsoidGeodesic` + 五次平滑 + 单一低幅高度弧；紧凑乡镇巡游 3.2–5.4 秒；到达后低斜俯视相机锁定不动。
- 子级标签“访问过即保留”：首次访问出现、此后常显，当前标签强调、历史标签弱化；最后一位巡游后 3.8–5.0 秒静默回到首帧父级相机。
- 卫星影像必须为授权正式源；禁止用 Natural Earth、OpenStreetMap 等演示底图冒充。
- 配音：`zh-CN-YunyangNeural` 约 `-4%`、约 `-16 LUFS`；SAPI 仅限草稿。字幕严格单行、按语义短语切分、保护地名/数字/单位。
- 封面为地点中立的深蓝金地球 + 制图师地球徽章，标题 `地理图说·{层级主题}`，播放约 1.8–2.0 秒后淡出；地图、旁白、音乐、字幕、SRT/VTT 统一偏移；带俯冲开场时旁白与字幕再叠加开场时长偏移。
- 图片证据只使用可核验的真实本地照片；无可靠实拍时保持地图主导，禁止用生成图冒充纪实素材。

## 交付物

- 每个请求档位的 MP4、SRT/VTT 字幕、封面 PNG、来源与证据清单、构建报告。
- 成片与分段按需提供；多区县系列额外提供按序 stream-copy 拼接的主片。

## 脚本速览

```powershell
pnpm geo-video doctor
pnpm geo-video validate-data --region <区域ID>
pnpm geo-video capture --region <区域ID> --profile portrait --encode
pnpm geo-video compose --region <区域ID> --profile portrait
pnpm geo-video qa --region <区域ID> --profile portrait --stage final
pnpm typecheck
pnpm test
```

- `capture-frames.ts`：支持 `--end-time`、`--end-inclusive`、开场动态区间与 0.5 秒重载检查点。
- `compose-hyperframes.ts` / `validate-delivery.ts`：按 `coverIntroSeconds + narrationStartSeconds` 偏移旁白、字幕与静音容差。
- `apps/cesium-player/public/runtime.js`：实现高空俯冲相机、体积云层、`presentationTime` 相对时间轴。
