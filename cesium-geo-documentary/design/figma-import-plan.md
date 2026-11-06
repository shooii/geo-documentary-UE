# Figma 导入计划

1. 连接用户指定的 Figma 设计文件。
2. 先加载 `figma-use` 与 `figma-generate-library`，搜索可复用设计系统。
3. 从 `tokens.json` 创建颜色、字号、间距、圆角和动效变量。
4. 用 Auto Layout 创建全部视频组件及横屏、竖屏变体。
5. 截图检查 1920×1080、1080×1920、1080×1080 安全区。
6. 将节点 ID 回写 `figma-node-map.json`，再建立前端映射。
