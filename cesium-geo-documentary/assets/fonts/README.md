# YouSheBiaoTiHei / 优设标题黑

- 来源：优设免费商用字体页 https://www.uisdc.com/uisdc-first-free-font
- 镜像下载：https://font.doany.cn/f/youshebiaotihei
- 用途：apps/ue-player/label-plate.ts 生成行政区标注牌（3D 立体标签设计）。
- 授权：优设标题黑为免费商用字体，发布时请保留本说明并遵守字体发布方的授权条款。

# NotoSansSC-Medium.woff2 / 思源黑体 Medium（字幕）

- 来源：`@fontsource/noto-sans-sc@5`（Google Fonts 官方分发的 Noto Sans SC，与 Adobe 的
  Source Han Sans / 思源黑体是同一套字形，只是家族名不同）
  https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.0.0/files/noto-sans-sc-chinese-simplified-500-normal.woff2
- 用途：视频字幕。成片里由 `compose-hyperframes.ts` 以 `GeoSubtitle` 家族引入（随 media/fonts
  一起拷进合成目录），Studio 预览由 `/fonts/NotoSansSC-Medium.woff2` 路由读同一份文件。
- 为什么自带：本机没装思源黑体，CSS 里写 `local(...)` 只会静默回退到微软雅黑，字重和字形都不对。
- 授权：SIL Open Font License 1.1，可随项目再分发；保留本说明即可。

# NotoSansSC-Bold.woff2 / 思源黑体 Bold（字幕）

- 来源：同一套 `@fontsource/noto-sans-sc@5`，只换成 700 字重
  https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.0.0/files/noto-sans-sc-chinese-simplified-700-normal.woff2
- 用途：字幕正文（`font-weight:700`）。原先只有 Medium 一份，CSS 写 700 会让浏览器做
  合成加粗——中文笔画会糊，所以补一份真 Bold。
- 两处引用必须同时存在：`compose-hyperframes.ts` 的 `@font-face` + `media/fonts` 拷贝，
  以及 Studio 预览的 `/fonts/NotoSansSC-Bold.woff2` 路由。
- 授权：同 SIL OFL 1.1。
