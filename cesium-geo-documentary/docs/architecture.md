# 架构

事实资料进入研究包和来源清单；脚本引用事实 ID；故事板将句子映射为固定场景；Cesium 运行时只负责地图、边界和可 seek 镜头；Playwright 在固定视口逐帧采集；HyperFrames 负责信息卡、图片、字幕、旁白、音乐和转场；FFmpeg 负责编码与多比例封装。

浏览器运行时公开 `window.geoVideo.initialize/loadRegion/seek/renderFrame/getFrameStatus/getDiagnostics/dispose`。任何正式帧都必须在 `tilesReady`、`imageryReady`、`terrainReady`、`fontsReady` 和 `entitiesReady` 同时为真后采集。
