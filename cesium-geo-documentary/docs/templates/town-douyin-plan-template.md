# 乡镇「地理图说」抖音方案标准模板

> 母版：吴川市吴阳镇（`project-mvknwzfk`，28 场 / 4:21 估算 / 47 图位）。
> 完整存档：`docs/templates/wuyang-plan-snapshot.json`（结构 + 每图关键词）、`docs/templates/wuyang-plan-copy.md`（逐场文案）。
> 只要给出新地点（如「生成徐闻角尾乡的方案」），**直接按本模板执行到工作台生成，不再询问细节**。

---

## 一、结构框架（固定骨架，共 8 + N 场）

| 序 | 场景 | 目标时长 | 作用 | 必须包含 |
|---|---|---|---|---|
| 0 | cover | 1.6 s | 封面 | 主标题 4–6 字 + 副标题一句反差 |
| 1 | 开场 | 10–13 s | 3 秒钩子 | 数字反差 + 身份（它叫什么、在哪） |
| 2 | 地标 A（第一 IP） | 20–26 s | 立住主题 | 具体年代/尺寸 + 一个「只有本地人知道」的细节 + 1 句互动 |
| 3 | 地标 B | 16–20 s | 第二证据 | 数字 + 一句情感落点（不提问） |
| 4 | 地标 C | 16–22 s | 第三证据 | 典故/文献原句引用 |
| 5 | 地标 D（可选，产业/风物） | 14–18 s | 换气口 | 画面感强的自然或产业镜头 |
| 6 | 风物/美食合集 | 22–28 s | 收藏动机 | **4 样，每样一句一行一段**，末尾一句问店家 |
| 7 | 转入 | 6–8 s | 转场 | 明示「接下来是村庄」，避免误以为已结束 |
| 8 | 每个下级单元 | 4–8 s | 同乡钩子 | 一句一行，只讲村本身；末句统一「你是哪个村的？」 |
| 9 | 结尾 | 18–22 s | 转发 + 评论 | 四个意象收束 → 给动线 → 转发指令 → 报村名 |

**时长纪律**：总长 4:20–5:30。超过 6 分钟即砍地标数量，不要砍村（村是同乡流量的入口）。

**互动纪律**（全片只留 4 个问句 + 1 句转发指令）：
1. 地标 A 末尾（记忆类提问）
2. 地标 D 末尾（年份类提问）
3. 风物合集末尾（报店名）
4. 结尾（报村名）
5. 转发指令：「把这条转给你们 X 的群，让他们来补」——**指定收件人，不写「转发给朋友」**

---

## 二、内容要素（每场必须写满的字段）

- **title**：`卖点｜一句人话`，如「双峰塔｜四百年，它一直在」。标题即合集选段名。
- **narration**：**段数 = 图数**，一段一行，一行只讲一张图。
  - 每段 20–32 字（字数越均匀，均分误差越小）
  - 段内不要出现第二张图的内容
- **subtitle**：与 narration 完全一致（只允许标点/断句差异）。
- **图片**：每张一图，顺序 = 语句顺序；`requiredKeywords` 必须**出自本段文字**。
- **alt**：`对象｜来源`（如「双峰塔塔身｜高德 POI 实景」），进溯源，不进画面。

**禁止**：
- 一个场景多图但旁白不分段（旧版图文错位的根源）
- 同一景点在多场重复讲同一组数字（母版曾把双峰塔讲四遍）
- 用「总体介绍 N」当标题
- 结尾后面再挂「结尾补充」（CTA 会被埋掉）

---

## 三、字段顺序（写入 project JSON 时保持一致）

```jsonc
// scene
{
  "id": "overview-spot-xxx" | "child-<adcode>" | "overview-1" | "overview-2" | "outro",
  "type": "map-overview" | "region-focus" | "outro",
  "section": "overview" | "child" | "outro",
  "title": "卖点｜一句人话",
  "narration": "段1\n段2\n段3",
  "subtitle": "段1\n段2\n段3",
  "duration": 20.5,                       // 估算：字数 / 5.1（导出会被实测覆盖）
  "assetIds": ["..."],
  "placements": [{
    "assetId": "...",
    "fit": "cover" | "contain",           // 按图片比例自动判定，见下
    "crop": { "x": 0, "y": 0, "width": 1, "height": 1 },
    "focalPoint": { "x": 0.5, "y": 0.5 },
    "scale": 1, "offsetX": 0, "offsetY": 0, "animation": "push-in",
    "leadSeconds": 0.25, "tailSeconds": 0.2,
    "minimumDisplaySeconds": 2.5,
    "requiredKeywords": ["本段中真实存在的词"],
    "alt": "对象｜来源",
    "includeInRender": true
  }],
  "timing": { "actualNarrationSeconds": 20.5, "preHoldSeconds": 0, "postHoldSeconds": 0, "minimumVisualSeconds": 3, "mapHoldSeconds": 0 },
  "camera": { "longitude": 0, "latitude": 0, "height": 2600, "heading": 0, "pitch": -60, "roll": 0, "transition": "fly" }
}
```

**fit 判定**（图卡窗口 1080×780 ≈ 1.385）：
`|图比例 − 1.385| / 1.385 > 12%` → `contain`（完整显示 + 同图模糊底）；否则 `cover`。

---

## 四、执行 SOP（新地点一条龙，不再确认）

### 1. 定 code
```bash
node -e "const{searchAdminDivisions}=await import('./apps/studio/admin-catalog.js');console.log(await searchAdminDivisions(process.cwd(),'角尾'))"
```
得到 `code / villageCount / sourcePath`。

### 2. 生成区域边界
优先 `ensureTownPlan(root, code)`。若报 **`DBF names contain Unicode private-use characters`**，改直调：
```bash
python .agents/skills/cesium-geo-documentary/scripts/import-shapefile.py \
  "<data/regions/01【25096】…/广东村界/广东全省/广东省CJ.shp>" \
  --region-id <code> --region-name <镇名> --parent-id <县code> \
  --level-role township --level-name 镇 --id-field PAC --name-field NAME \
  --encoding gb18030 --expected-children <N> --title <县+镇> --simplify-meters 1 \
  --filter-field 乡镇码 --filter-prefix <code> --name-map tmp/name-map-<code>.json
```
并在 `content/regions.zh-CN.json` 补该 region 条目（name/title/narration 骨架/tourOrder）。

### 3. 建项目
`POST /api/projects {"regionId":"<code>","name":"<县><镇>"}`

### 4. 抓素材
- 政府网/党媒文章页 → 抓图（`scan-page-imgs2.mjs`），逐张目视
- 高德 POI（`fetch-poi-assets.mjs`）：每个地标 2–4 张；每个村优先「村牌/门楼/宗祠/太祖庙」
- 用户提供的图直接入 `workspace/assets/<uuid>.asset.json`

### 5. 写文案 JSON（本模板唯一需要人写的东西）
格式见 `docs/templates/wuyang-plan-snapshot.json`：每场 `title + narration（段=图）+ images[[assetId, 关键词, alt]]`；村场景只给 `narration`，图自动取该村候选第一张。

### 6. 应用 + 校验
```bash
node scripts/apply-town-template.mjs tmp/<place>-plan.json
```
脚本会：段图对齐检查 → 关键词归属检查 → fit 自动判定 → PUT → `POST /validate` → 打印结论。

### 7. 导出
`POST /api/projects/<id>/render`，随后核对：体积 / ffprobe（时长、1080×1920、30fps、h264+aac）/ `qa/golden-report.json` 全 true / 抽帧 10 点看图文是否同步。

---

## 五、验收清单（8 项，缺一不可）

1. `validate` 11 项全 PASS、0 警告
2. **每场段数 = 图数**
3. 每个 `requiredKeywords` 都能在本场旁白里搜到
4. fit 判定已重算（竖图/横图 contain，比例接近的 cover）
5. 双峰塔类竖图抽帧确认塔尖塔基完整
6. 导出 QA 全 true、无黑帧
7. 音频有效内容铺到片尾（差 1 秒以上会被 `silence-event` 拦）
8. 成片复制到 `E:/AI视频/00视频输出/<地名>/`，命名 `<县><镇>-地理图说-竖屏.mp4`

---

## 六、已知坑（都踩过）

| 坑 | 现象 | 处理 |
|---|---|---|
| 关键词不在本场旁白 | 合成时报 `no display window before its scene boundary`，预检就死 | keywords 必须出自本段；已加 ±3 cue 兜底 |
| 图数 ≠ 段数 | A 图讲 B 文案 | 段数=图数，图序=句序 |
| 默认 cover | 竖图被裁 40%+，塔尖/牌匾丢失 | 按比例批量改 contain |
| 片尾静音 | QA 89% 处 `silence-event` | `-t <音频有效末尾> -c copy` 裁尾，不必重导 |
| DBF 私用区字符 | 导入失败 | `--name-map` 手工映射（先读 DBF 十六进制确认字） |
| 源数据缺村 | 官方 19 村、源数据 18 村 | 在 content 与文档里写明缺哪个；缺的那个用地标场景补 |
| `ensureTownPlan` 不传 name-map | 同上 | 见 SOP 第 2 步直调 |
| 字幕切词 | 「陈兰 / 彬」 | 改写为短句、标点前置 |

---

*版本：2026-10-23 · 母版 rev 17。新地点直接套用，除「文案内容」外的一切结构与参数保持不变。*
