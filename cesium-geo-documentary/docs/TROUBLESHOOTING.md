# 故障排查

## Cesium Ion Token 缺失

工程会使用本地 Natural Earth II 影像与椭球地形。报告中必须写明没有真实三维地形，不能把降级画面描述为 Cesium World Terrain。

## 单帧超时

检查对应 `failed-frame-*.png/json`、浏览器日志和 `getDiagnostics()`。正式采集不得跳过失败帧；修复后只重跑该地区与画幅。

## ImageGen 失败或画面不合格

查看 `assets/generated/imagegen-manifest.json`。失败、超时或 QA 驳回必须使用带“地图替代”标识的占位画面。

## TTS 下载或生成失败

记录失败提供商与原因，切换配置中的备用语音。重新测量真实音频时长并重建字幕和构图。

## HyperFrames 找不到 FFmpeg/FFprobe

运行 `pnpm install`，确认 `ffmpeg-static` 和 `ffprobe-static` 存在。批量渲染优先使用 `scripts/render-profile.ps1`，它会建立 ASCII 工具缓存。

## 字幕被截断或轨道重叠

使用 `packages/content-engine/subtitles.ts` 的分段逻辑，禁止直接截取前两行。运行 `pnpm test` 和 `validate-delivery.ts` 检查全文保留、双行上限和毫秒边界。

## 背景音乐不可闻

先检查源文件响度，再检查 composition 的 `data-volume`。本项目低电平音乐床使用 `0.5`，最终验证以 `-50dB`、持续 1 秒的静音检测为门禁。

## 创建乡镇方案失败：SHP support requires ...

这条报错几乎总是 Python 环境与二进制不匹配，而不是缺少依赖。原生轮子（`.pyd`）是**按 CPython 版本区分**的，而 `.python-packages` 是一个被多个解释器共用的目标目录，一旦用错版本执行 `pip install --target`，就会把别的版本 `.pyd` 覆盖进来。

三个包目录与解释器的对应关系（`import-shapefile.py` 顶部有同样的映射）：

| 目录 | 二进制 ABI | 对应解释器 |
| --- | --- | --- |
| `runtime-qindou` | cp314 | 3.14 |
| `.python-packages` | cp313 | 3.13（Studio 实际使用的受管 Python） |
| `.python-geo` | cp312 | 3.12 |

排查与修复：

1. 先确认服务实际用的解释器：`import-shapefile.py` 的报错信息里会打印解释器版本、路径和已搜索的目录，`pnpm doctor` 的 `pythonGeometryStack` 也会给出结论。
2. 检查 ABI 是否被污染：`ls .python-packages/shapely/*.pyd`，若只有 `cp314` 而解释器是 3.13，就是被覆盖了。
3. 用**目标解释器**重装，并且要先移走旧目录——`pip install --target` 遇到已存在的目录只会警告，不会覆盖：
   `mv .python-packages/shapely .python-packages/shapely.bak` 之后再 `"<目标 python>" -m pip install --target .python-packages -r requirements.txt`。
4. 注意 `shapely` 依赖 `numpy`，两者必须同时是同一个 ABI；只修 shapely 会接着在 numpy 上报错。

## 行政区划目录指向旧路径

`workspace/render-cache/admin-divisions.v*.json` 会记住 `sourceRoot`。工程被移动位置（例如从桌面搬到其它盘）后，如果新位置的边界数据是**逐字节相同的副本**，文件签名也一致，旧缓存就可能被误判为仍然有效，于是创建乡镇时会去读旧目录里的 SHP。

缓存现在会同时比对绝对路径，路径不一致即自动重建。若不想等重建，可手工把缓存里的 `sourceRoot` 改成当前工程下的 `data/regions/01【25096】全国村级行政边界数据` 绝对路径。

## 导出期间切换方案

导出**不在浏览器标签里执行**，而是跑在 Studio 服务进程内，并且队列是全局的（`/api/jobs` 按 `updatedAt` 排序，默认并发 1 个）。因此切换方案不会中断、也不会污染正在进行的导出：

- 任务在入队时就把方案深拷贝成快照（`structuredClone` + `<jobRoot>/project.snapshot.json`），之后不再读打开中的方案文件；
- 每个任务有独立沙箱目录（`%TEMP%\geo-video-studio\<jobId>\sandbox`）和独立端口（`4600 + hash(jobId) % 1000`），不占用 Cesium 预览的 4174；
  **任务进入完成/失败/取消后这个沙箱会被自动回收**（只留 `<jobRoot>/audio/` 里的旁白供预览复用），所以事后排查一个已结束的任务时，沙箱通常已经不在了——要看的是 `job.json` 的日志和 `render-spec.json`；
- 沙箱会重跑（重试、服务重启恢复），所以 `prepareSandbox` 里的目录联接必须是幂等的：无条件 `symlink` 会让任何一次重跑在 `node_modules` 上 EEXIST 直接失败；
- 切换方案只写 `workspace/projects/*.json`，不碰 `data/regions`、`content/`，与导出无共享写入。

所以导出期间改方案、存方案、切方案都是安全的。**但从此导出的成片用的是提交那一刻的快照**，之后对方案的修改不会进入这次成片，需要重新提交导出。

界面上，导出面板除了当前方案的任务，还会额外列出**其它方案正在后台导出**的任务（带方案名，可取消），顶部「导出视频」按钮也会显示进行中数量——这些就是为了让切换方案之后仍然看得见、管得着正在跑的导出。`download` / `open-output` / `DELETE` 接口会校验 `projectId`，所以跨方案的任务只提供「取消」。

改完 `server.ts` 需要重启 Studio 才生效；`studio.js` / CSS 属于静态资源，浏览器强刷即可。

