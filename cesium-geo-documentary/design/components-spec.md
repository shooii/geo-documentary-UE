# 组件规范

| 组件 | 关键属性 | 横屏 | 竖屏 |
| --- | --- | --- | --- |
| TitleCard | title, kicker, subtitle | 左侧 72 px | 顶部 64 px |
| RegionLabel | name, code | 锚定代表点 | 避让字幕区 |
| GeoFactCard | title, body, accent | 右侧 520 px | 底部 880 px 以上 |
| HistoryTimeline | year, event | 左下、字幕上方 | 中部纵向 |
| CultureCard | image, title, badge | 右侧画中画 | 中上部 16:9 |
| SourceNote | source | 右下 | 底部安全区上方 |
| Subtitle | text, activeWord | 最多两行、每行 18 字 | 最多两行、每行 14 字 |
| AIReconstructionBadge | label | 素材左上角 | 素材左上角 |
| EndCard | sources, notice | 全屏 | 全屏 |

所有组件使用圆角 20 px、背景模糊和 1 px 低对比描边。组件入场 0.6 秒，转场 0.8 秒，不使用无限循环动画。
