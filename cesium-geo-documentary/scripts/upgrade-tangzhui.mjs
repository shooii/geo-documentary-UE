/**
 * 塘缀镇方案 v2：六维补全 + 素材纠错
 *
 * 依据 rev 119 诊断结论改写：
 *  1. 兑现开场「㙍」字钩子（字源、塘溪旧名、明万历圩市、读音之争）
 *  2. 新增地理总纲（丘陵 / 塘㙍河 / 鉴西灌区 / 鉴江右岸）
 *  3. 新增塘㙍话（高阳片口音、四市口音圩日）
 *  4. 松糕拆两场（一条街 + 短视频爆红）
 *  5. 新增年例（文化总纲，收口散落的年例/粤剧碎片）
 *  6. 空港、糖酒机械换成 2024 口径，补常住人口外流
 *  7. 修第 25 场 kw=水口 的跨场自愈隐患
 *  8. 村场去重（去掉四次「1978 年分大队」），按素材比例重设 fit
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PROJECT_ID = "project-mvnrlelg";
const API = "http://127.0.0.1:4180";
const DRY = process.argv.includes("--dry");

const CHAR_PER_SEC = 5.15;   // overview 实测系数
const CHAR_PER_SEC_CHILD = 5.10;
const CARD_RATIO = 1080 / 780; // 1.3846，图卡窗口宽高比

const round2 = (n) => Math.round(n * 100) / 100;

/* ---------------- 文案表 ---------------- */

const OVERVIEW_COPY = {
  "overview-1": {
    title: "开场｜名字里有个字，你打不出来",
    text: "广东有个镇，名字里有个字，你大概打不出来——塘㙍。\n输入法只有「塘缀」，身份证上是「塘㙍」。\n这个字字典里没有。塘㙍人造的：土字旁加四个「又」——这片土地，又宽、又广、又肥、又美。\n它原来叫塘溪。明万历年间的书里，就有「塘㙍圩」。四百年前，这儿已经是圩市。\n本地人一直读「缀」，字典偏给它注了个「多」。"
  },
  "spot-river": {
    title: "塘㙍河｜一条河，一片丘陵",
    text: "先看这片地。一百七十平方公里，不高，是丘陵，一个土坡连着一个土坡。\n塘㙍河从化州流过来，四十七公里，穿过全镇，到黄坡大岸汇进鉴江。两岸耕地十八万亩，是吴川最大的产粮区。\n吴川有句老话：左江出文官，右江出武官。塘㙍在鉴江右岸。"
  },
  "spot-airport": {
    title: "机场｜4E 级，落在自家地里",
    text: "2022年3月24日，整个湛江机场搬到了这个镇——塘㙍镇合山村。\n4E级，跑道3200米，能落波音777、787，航站楼六万一千八百平方米。\n以前塘㙍人坐飞机，要往湛江跑四十公里。现在机场在自家地里。"
  },
  "spot-konggang": {
    title: "空港｜三百二十二万人从这里过",
    text: "机场一落，路就往这挤：沈海、汕湛、广湛高铁，还有个塘㙍站。\n去年旅客三百二十二万，货邮九千三百吨，三十二条航线——已经是国际机场。\n空港经济区就在边上。邮政、京东、圆通都进来了；原子高科做医药。"
  },
  "spot-tangjiu": {
    title: "糖酒机械｜一百家厂，剩八家规上",
    text: "再往里走，是塘㙍的老本行：糖酒机械。\n七十年代从公社农机厂起家。最红火时全镇一百多家厂，宏泰甘化把设备卖到亚非拉。\n可去年，全镇规模以上工业只剩八家，产值一亿六千万。\n老产业在缩，人也在走——户籍十五万八，常住十万出头。"
  },
  "spot-chili": {
    title: "赤里｜45 栋别墅，村民拎包入住",
    text: "往北，杨赤里村。四十五栋别墅，统一图纸、统一层高，村民拎包入住。\n出钱的是本村人杨松，1980年揣着几十块去深圳。有人说这是炫富，村里人说：房本写的是自己名。"
  },
  "spot-zhangyan": {
    title: "张炎｜十九路军的将军",
    text: "樟山村，张炎故居。一·二八淞沪抗战，他带十九路军，在吴淞庙行跟日军硬拼。\n1945年1月，他在樟山宣布起义，一千多人打下伪县政府，活捉县长。3月被捕，遇害。\n1958年追认革命烈士。1989年列为省文物保护单位。"
  },
  "spot-lishan": {
    title: "丽山｜吴川八景，只剩一个名字",
    text: "丰六洞村西边有座丽山，五十六米高。古吴川八景之一，叫丽山樵唱。\n山顶那口井，水一半冷一半热。山脚的三仙古庙，1958年毁了。景还在，唱山歌的樵夫没有了。"
  },
  "spot-hua": {
    title: "塘㙍话｜吵架好听过唱歌",
    text: "塘㙍人说话，跟吴川市区不一样。塘缀口音属高阳片粤语，跟化州、茂名更近，九个声调。\n本地人自嘲：塘㙍人吵架，好听过唱歌。拿塘㙍话配短视频，很容易就火。\n圩日一条街上四种口音：塘㙍话、吴川话、廉江话、化州话。"
  },
  "overview-food": {
    title: "松糕｜市场里有一条街",
    text: "塘㙍人的早上，从一块松糕开始。\n市场里有条街，整排铺子只卖糕。松糕、芋头糕、马蹄糕，还有田艾籺、田薯籺。\n赤砂糖加碱水，发足了蒸四十分钟。切一条拎起来抖一抖，不断。"
  },
  "spot-songgao": {
    title: "松糕｜一块糕怎么火的",
    text: "几年前，市场里一个松糕摊。摊主的女儿拍了几段短视频，蒸糕、切糕，发到网上。\n热气往上冒，手指按下去，糕慢慢回弹。就这么火了。\n一度冲到湛江美食榜第一。有人开两三个小时车来，排队半小时，买两盒就走。"
  },
  "spot-nianli": {
    title: "年例｜塘㙍人最舍得的一天",
    text: "塘㙍人最舍得花钱的那天，不是过年，是年例。\n日子各村不同：六寿村二月初二宰牲，十月初一分众肉。外出的开车回来，摆几十桌，请亲戚、请朋友。\n还有粤剧。杨屋的文化广场，年年请省粤剧院。"
  },
  "overview-2": {
    title: "转入｜二十四个村",
    text: "接下来，一村一句，走完塘㙍下辖的二十四个村。走得快，也许有遗漏，也可能说得不准，欢迎在评论区补充。"
  },
  "outro": {
    title: "结尾｜你打「塘缀」，我们也认",
    text: "一个镇，名字打不出来，机场落下来，别墅盖起来，糖机卖到国外，人走了五万。\n塘㙍人不用解释。你打「塘缀」，我们也认。"
  }
};

/* 村场：一句一村，去掉四次重复的「1978 年分大队」 */
const CHILD_COPY = {
  "child-440883107214": "龙安。状元地人出去做皮带，珠三角开了近百家厂。六寿村二月二宰牲。",
  "child-440883107213": "岭脚。1943年南路特委机关进村，抗日前线指挥部就设在书房。2022年评上市文明村。",
  "child-440883107204": "翟屋。1943年王国强在这儿教书，白天上课，晚上做地下党。",
  "child-440883107212": "樟山。一条村两位将军，十八人参加八一南昌起义。",
  "child-440883107211": "石埠，一千五百多户。耕地四千六百亩，十三条自然村。",
  "child-440883107013": "西埇。「埇」是两山之间的田。塘㙍带这个字的村，不止它一个。",
  "child-440883107209": "三丫，十五条自然村，五千二百人，离镇区四公里。",
  "child-440883107208": "社山，1531年建村。文辉小学替张炎藏过枪，篮球队在吴川有名。",
  "child-440883107207": "大洋。赵明六十二岁去哈佛读书，回来建了大洋学堂，读书不要钱。",
  "child-440883107009": "塘㙍，镇政府在这儿。糖酒设备七十年代起家。农历一、四、七趁圩。",
  "child-440883107202": "杨屋，七千二百人，全镇最多。机场占的合山村在这儿。",
  "child-440883107205": "上圩，紧贴镇区。三十多亩释迦果，村里最拿得出手的产业。",
  "child-440883107203": "中堂。七十多亩多年生水稻，种一次收几年，稻里还养小龙虾。",
  "child-440883107007": "南埇。将军茶全手工炒。杨赤里四十五栋别墅在这儿。",
  "child-440883107224": "东村，一千二百多户。年例一到，外出的都往家赶。",
  "child-440883107028": "新桥和塘下，镇域最东头。趁圩去板桥。",
  "child-440883107221": "屋地山，十八条自然村，全镇最多。屋地山、大洋、凌田、冷水。",
  "child-440883107220": "板桥，原来是板桥镇，2003年并进来。板桥圩还在，二、五、八趁圩。",
  "child-440883107218": "上杭，九条自然村。易氏大宗祠，一年分红三万五。",
  "child-440883107222": "东岸，九条自然村。东岸、岭尾、大低垌三条大村，大低垌圩市最热闹。",
  "child-440883107225": "企石，二十五平方公里，全镇最大。曲田、企石、米各、占村。",
  "child-440883107026": "塘莲。山薯是招牌，2014年成立合作社，把生薯做成品牌。",
  "child-440883107217": "山瑶，2017年的全国文明村镇。乡贤捐一千二百万修路建校。"
};

/* 新增场定义：id -> 骨架 */
const NEW_SCENES = [
  { id: "spot-river", after: "overview-1" },
  { id: "spot-hua", after: "spot-lishan" },
  { id: "spot-songgao", after: "overview-food" },
  { id: "spot-nianli", after: "spot-songgao" }
];

/* ---------------- 配图方案 ---------------- */
/* includeInRender 的图与关键词，关键词必须出现在本场旁白里 */
const PLACEMENTS = {
  "overview-1": [
    { assetId: "43b630dd-0bd7-4e2e-82ae-d1626badfc7e", kw: ["塘㙍"], alt: "塘缀收费站（G15 沈海高速出口）｜高德 POI 实景" }
  ],
  "spot-river": [
    { assetId: "vsc18", kw: ["丘陵"], alt: "塘缀镇域卫星影像（丘陵、塘㙍河与 4E 机场跑道）｜Mapbox Satellite", fit: "cover" }
  ],
  "spot-airport": [
    { assetId: "web-66797abc873f", kw: ["2022年3月24日"], alt: "湛江吴川机场航拍｜澎湃新闻" },
    { assetId: "b62a6014-1ec0-440f-90e8-35ef91c368d6", kw: ["3200米"], alt: "「湛江吴川国际机场」站牌｜高德 POI 实景" },
    { assetId: "413fef07-90c8-472c-a34b-5ab99d4bf531", kw: ["四十公里"], alt: "航站楼值机大厅｜高德 POI 实景" }
  ],
  "spot-konggang": [
    { assetId: "web-1f126dd20c05", kw: ["国际机场"], alt: "航站楼与指廊俯视｜澎湃新闻" }
  ],
  "spot-zhangyan": [
    { assetId: "5d9cb85c-f12f-4372-8d90-d738742f1410", kw: ["樟山村"], alt: "张炎故居门楼｜高德 POI 实景" },
    { assetId: "d1225bf1-6b6b-4554-8940-b90ddbaceede", kw: ["起义"], alt: "张炎将军纪念馆｜高德 POI 实景" },
    { assetId: "f622bf9c-0368-43e1-9331-1b0a7bc3c378", kw: ["1958年"], alt: "「张炎故居」文物保护碑｜高德 POI 实景" }
  ],
  "spot-tangjiu": [
    { assetId: "eb79c547-3f7d-4439-afec-fe1ae059017c", kw: ["塘㙍"], alt: "广东宏泰甘化设备有限公司厂门｜高德 POI 实景" },
    { assetId: "34b5587a-008d-4feb-a549-c149136f234e", kw: ["亚非拉"], alt: "宏泰甘化厂区｜高德 POI 实景" }
  ],
  "spot-hua": [
    { assetId: "c9eb2f57-2ba7-4464-a245-5ff6888688d2", kw: ["圩日"], alt: "塘㙍市场门面｜高德 POI 实景" }
  ],
  "overview-food": [
    { assetId: "8ffeb685-62e0-4a2c-8ab4-2c1ec933cf66", kw: ["松糕"], alt: "整块松糕籺｜高德 POI 实景" },
    { assetId: "44fb12c8-7d49-4095-8006-6e4b16f6e8e2", kw: ["条街"], alt: "宵村街上的松糕摊｜高德 POI 实景" }
  ],
  "spot-songgao": [
    { assetId: "13bcb23d-9fd8-483a-a5f7-a4ed3a2f4a92", kw: ["短视频"], alt: "塘缀汤狗富仔网红松糕（吴川总店）｜高德 POI 实景" }
  ],
  "spot-nianli": [
    { assetId: "web-6ff2a64762be", kw: ["年例"], alt: "吴川飘色巡游航拍（吴川年例习俗）｜吴川市人民政府", fit: "contain" },
    { assetId: "web-aaa2ac530303", kw: ["几十桌"], alt: "吴川飘色巡游队伍（吴川年例习俗）｜吴川市人民政府", fit: "cover" },
    { assetId: "web-f0ce345bcfb8", kw: ["粤剧"], alt: "吴川年例游神队列（吴川年例习俗）｜吴川市人民政府", fit: "cover" }
  ],
  "child-440883107213": [
    { assetId: "3cf391e1-0b92-411f-8f72-b2506c038bc7", kw: ["南路特委"], alt: "中共南路特委抗日前线指挥部旧址（岭脚村）｜高德 POI 实景" }
  ],
  "child-440883107212": [
    { assetId: "66012696-1e5b-4c8a-8e62-4c03cfa245b6", kw: ["两位将军"], alt: "樟山村张世德故居｜高德 POI 实景" }
  ],
  "child-440883107214": [
    { assetId: "93410636-87e2-4ab8-a2cf-8c6e09e54162", kw: ["状元地"], alt: "龙安状元水塔（状元地村）｜高德 POI 实景" },
    { assetId: "d4b0c40e-a00d-4a29-bebb-e282f212174f", kw: ["二月二"], alt: "六寿村广福堂｜高德 POI 实景" }
  ],
  "child-440883107013": [
    { assetId: "5f5851b1-a3e9-4a31-b855-cea58093261f", kw: ["西埇"], alt: "西埇村深水文武庙｜高德 POI 实景" }
  ],
  "child-440883107218": [
    { assetId: "d0516391-11b6-4999-bba8-475663a65bb1", kw: ["易氏大宗祠"], alt: "上杭村易氏大宗祠｜高德 POI 实景" }
  ],
  "child-440883107026": [
    { assetId: "274155f3-e19e-425f-b574-72784823812e", kw: ["山薯"], alt: "塘莲山薯专业合作社｜高德 POI 实景" }
  ]
};

/* 无实拍图可用、且现图属跨村的场，改为纯地图镜头 */
const NO_IMAGE = ["child-440883107028"];

/* 单图村场：只改关键词，图不动（保留其原图，kw 换成本场旁白里真实存在的词） */
const KW_FIX = {
  "child-440883107204": ["翟屋"],
  "child-440883107211": ["石埠"],
  "child-440883107209": ["三丫"],
  "child-440883107208": ["社山"],
  "child-440883107207": ["大洋"],
  "child-440883107009": ["塘㙍"],
  "child-440883107202": ["杨屋"],
  "child-440883107205": ["上圩"],
  "child-440883107203": ["中堂"],
  "child-440883107007": ["南埇"],
  "child-440883107224": ["东村"],
  "child-440883107221": ["屋地山"],
  "child-440883107220": ["板桥"],
  "child-440883107222": ["东岸"],
  "child-440883107225": ["企石"],
  "child-440883107217": ["山瑶"]
};

/* ---------------- 工具 ---------------- */

/**
 * 字幕断行：一行 = 一个语义分句。
 *
 * 手工行如果和 TTS 的 cue 边界对不上，`subtitleOverrideChunks` 会整场放弃 override、
 * 退回按字数硬切（成片里出现过「的老本行糖酒机械」）。所以这里不再按字数合并，
 * 而是照着标点分句走 —— TTS 也是按停顿断的，两边天然对齐。
 * 单个分句仍超过 14 字时，才退而在顿号处拆。
 */
function splitLongLine(line, max) {
  if ([...line].length <= max) return [line];
  const parts = line.match(/[^、]+、?/g) || [line];
  const out = [];
  let buf = "";
  for (const part of parts) {
    if (buf && [...(buf + part)].length > max) { out.push(buf); buf = part; }
    else buf += part;
  }
  if (buf) out.push(buf);
  return out.flatMap((piece) => {
    if ([...piece].length <= max * 1.6) return [piece];
    // 连顿号都不够拆的极长分句，只能按字数硬切
    const chars = [...piece];
    const chunks = [];
    for (let i = 0; i < chars.length; i += max) chunks.push(chars.slice(i, i + max).join(""));
    return chunks;
  });
}

function subtitleOf(text) {
  const MAX_LINE = 14;
  const lines = [];
  for (const para of text.split("\n")) {
    const clauses = para.match(/[^，。！？；：、——]+[，。！？；：、——]*/g) || [para];
    for (const clause of clauses) {
      const trimmed = clause.trim();
      if (!trimmed) continue;
      lines.push(...splitLongLine(trimmed, MAX_LINE));
    }
  }
  return lines.join("\n");
}

function jpegSize(path) {
  try {
    const fd = openSync(path, "r");
    const stat = fstatSync(fd);
    let pos = 2;
    const buf = Buffer.alloc(4);
    while (pos < stat.size - 4) {
      readSync(fd, buf, 0, 2, pos);
      if (buf[0] !== 0xff) { pos += 1; continue; }
      const marker = buf[1];
      readSync(fd, buf, 0, 2, pos + 2);
      const len = buf.readUInt16BE(0);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        const hb = Buffer.alloc(4);
        readSync(fd, hb, 0, 4, pos + 5);
        closeSync(fd);
        return { w: hb.readUInt16BE(2), h: hb.readUInt16BE(0) };
      }
      pos += 2 + len;
    }
    closeSync(fd);
  } catch { /* ignore */ }
  return null;
}

function fitFor(assetPath) {
  const wh = jpegSize(assetPath);
  if (!wh) return "contain";
  const ratio = wh.w / wh.h;
  return Math.abs(ratio - CARD_RATIO) / CARD_RATIO > 0.12 ? "contain" : "cover";
}

function basePlacement(assetId, kw, alt, fit) {
  return {
    assetId, fit, crop: { x: 0, y: 0, width: 1, height: 1 },
    focalPoint: { x: 0.5, y: 0.5 }, scale: 1, offsetX: 0, offsetY: 0,
    animation: "push-in", leadSeconds: 0.25, tailSeconds: 0.2,
    minimumDisplaySeconds: 2.5, requiredKeywords: kw, alt, includeInRender: true
  };
}

/* ---------------- 主流程 ---------------- */

const meta = await (await fetch(`${API}/api/projects/${PROJECT_ID}`)).json();
const project = meta.project ?? meta;
const scenes = project.scenes;
const assetById = new Map(project.assets.map((a) => [a.id, a]));
const problems = [];

/* 备选素材池：来自改造前基线 rev 119。未启用的图不进成片，但留在方案里可换图。 */
const BACKUP_REV = 119;
const backupPool = new Map();
{
  const src = join(ROOT, "workspace", "projects", `${PROJECT_ID}.v${String(BACKUP_REV).padStart(6, "0")}.json`);
  if (existsSync(src)) {
    const original = JSON.parse(await readFile(src, "utf8"));
    for (const s of original.scenes ?? []) backupPool.set(s.id, s.placements ?? []);
  } else problems.push(`备选池基线 rev ${BACKUP_REV} 不存在`);
}

// 1. 重写已有 overview / 村场文案
for (const scene of scenes) {
  const copy = OVERVIEW_COPY[scene.id] ?? (CHILD_COPY[scene.id] ? { text: CHILD_COPY[scene.id] } : null);
  if (!copy) continue;
  scene.narration = copy.text;
  scene.subtitle = subtitleOf(copy.text);
  if (copy.title) scene.title = copy.title;
  const n = [...copy.text].length;
  const cps = scene.section === "child" ? CHAR_PER_SEC_CHILD : CHAR_PER_SEC;
  scene.duration = round2(Math.max(2, n / cps));
  scene.timing = { ...(scene.timing ?? {}), actualNarrationSeconds: scene.duration };
}

// 2. 新增场（先建场，配图才知道往哪儿挂）
const template = scenes.find((s) => s.id === "spot-airport");
for (const def of NEW_SCENES) {
  if (scenes.some((s) => s.id === def.id)) continue;
  const copy = OVERVIEW_COPY[def.id];
  const n = [...copy.text].length;
  const dur = round2(Math.max(2, n / CHAR_PER_SEC));
  const scene = {
    id: def.id, type: "map-overview", section: "overview", title: copy.title,
    narration: copy.text, subtitle: subtitleOf(copy.text), duration: dur,
    assetIds: [], placements: [], assetDisplayCount: 0,
    timing: {
      actualNarrationSeconds: dur, preHoldSeconds: 0, postHoldSeconds: 0,
      minimumVisualSeconds: 3, mapHoldSeconds: 0
    },
    camera: { ...template.camera }
  };
  const idx = scenes.findIndex((s) => s.id === def.after);
  scenes.splice(idx + 1, 0, scene);
}

// 3. 重设配图
for (const [sceneId, list] of Object.entries(PLACEMENTS)) {
  const scene = scenes.find((s) => s.id === sceneId);
  if (!scene) { problems.push(`缺场景 ${sceneId}`); continue; }
  const built = [];
  for (const item of list) {
    const asset = assetById.get(item.assetId);
    if (!asset) { problems.push(`${sceneId} 缺素材 ${item.assetId}`); continue; }
    const abs = join(ROOT, "workspace", "assets", String(asset.path).replace("/workspace-assets/", ""));
    const fit = item.fit ?? (existsSync(abs) ? fitFor(abs) : "contain");
    built.push(basePlacement(item.assetId, item.kw, item.alt, fit));
  }
  scene.placements = built;
  scene.assetIds = built.map((p) => p.assetId);
  scene.assetDisplayCount = built.length;

  // 原方案里未启用的备选图留在场景里，Studio 才能换图；它们不进成片。
  // 关键词跟着旁白改过，备选图必须一起重锚，否则一旦被启用就会指到别的句子。
  const originals = backupPool.get(sceneId) ?? [];
  const usedIds = new Set(built.map((b) => b.assetId));
  const safeKw = built[0]?.requiredKeywords ?? [];
  const backups = originals
    .filter((p) => !usedIds.has(p.assetId))
    .map((p) => ({ ...p, includeInRender: false, requiredKeywords: safeKw }));
  if (backups.length) {
    scene.placements = [...built, ...backups];
    scene.assetIds = scene.placements.map((p) => p.assetId);
  }
}

// 3b. 纯地图镜头：没有本村实拍图时宁可拍地图，也不拿邻村照片冒充
const NO_IMAGE_KW = { "child-440883107028": ["新桥"] };
for (const sceneId of NO_IMAGE) {
  const scene = scenes.find((s) => s.id === sceneId);
  if (!scene) { problems.push(`缺场景 ${sceneId}`); continue; }
  const originals = backupPool.get(sceneId) ?? [];
  const kw = NO_IMAGE_KW[sceneId] ?? [];
  scene.placements = originals.map((p) => ({ ...p, includeInRender: false, requiredKeywords: kw }));
  scene.assetIds = scene.placements.map((p) => p.assetId);
  scene.assetDisplayCount = 1;
}

// 4. 单图村场：只修关键词
for (const [sceneId, kw] of Object.entries(KW_FIX)) {
  const scene = scenes.find((s) => s.id === sceneId);
  if (!scene || !scene.placements?.length) continue;
  const keep = scene.placements.find((p) => p.includeInRender === true) ?? scene.placements[0];
  keep.requiredKeywords = kw;
  keep.includeInRender = true;
  const originals = backupPool.get(sceneId) ?? [];
  const backups = originals
    .filter((p) => p.assetId !== keep.assetId)
    .map((p) => ({ ...p, includeInRender: false, requiredKeywords: kw }));
  scene.placements = [keep, ...backups];
  scene.assetIds = scene.placements.map((p) => p.assetId);
  scene.assetDisplayCount = 1;
}

// 5. 关键词必须在本场旁白里
for (const scene of scenes) {
  const txt = scene.narration ?? "";
  for (const p of scene.placements ?? []) {
    if (p.includeInRender !== true) continue;
    for (const kw of p.requiredKeywords ?? []) {
      if (!txt.includes(kw)) problems.push(`[${scene.id}] 关键词「${kw}」不在旁白中`);
    }
  }
}

// 5b. 图卡窗口能不能放得下。
// child 场景的图要等镜头飞完才出现（flight 下限 3.2s），扣掉它以后
// 若不足 0.5s，合成器会在不报错的情况下整张丢掉。
const CHILD_FLIGHT_MIN = 3.2;
const MIN_RENDERED_VISUAL = 0.5;
for (const scene of scenes) {
  const figs = (scene.placements ?? []).filter((p) => p.includeInRender === true);
  if (!figs.length) continue;
  const dur = scene.duration ?? 0;
  const flight = scene.section === "child"
    ? Math.min(5.4, Math.max(CHILD_FLIGHT_MIN, dur - Number(scene.timing?.mapHoldSeconds ?? 2)))
    : 0;
  const windowPerFig = (dur - flight) / figs.length;
  if (windowPerFig < MIN_RENDERED_VISUAL) {
    problems.push(`[${scene.id}] ${dur}s / ${figs.length} 图，飞行 ${flight}s 后只剩 ${windowPerFig.toFixed(2)}s/张`);
  }
}

// 6. 素材必须进 assets 表
const wanted = new Set();
for (const scene of scenes) for (const p of scene.placements ?? []) if (p.includeInRender === true) wanted.add(p.assetId);
for (const id of wanted) {
  if (assetById.has(id)) continue;
  const side = join(ROOT, "workspace", "assets", `${id}.asset.json`);
  if (existsSync(side)) {
    const a = JSON.parse(await readFile(side, "utf8"));
    project.assets.push(a);
    assetById.set(id, a);
  } else problems.push(`素材 ${id} 既不在方案也不在素材库`);
}

// 7. 时长与排序自检
const order = { cover: 0, overview: 1, child: 2, outro: 3, "outro-lead": 4 };
for (let i = 1; i < scenes.length; i += 1) {
  if (order[scenes[i].section] < order[scenes[i - 1].section]) problems.push(`排序错位 @${scenes[i].id}`);
}

const total = scenes.reduce((sum, s) => sum + (s.duration ?? 0), 0);
console.log("场次", scenes.length, "| 总时长", `${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, "0")}`);
for (const s of scenes) {
  const inc = (s.placements ?? []).filter((p) => p.includeInRender === true).length;
  console.log(`  ${String(s.section).padEnd(9)} ${String(s.title).slice(0, 22).padEnd(24)} ${String(s.duration).padStart(6)}s  图${inc}`);
}

if (problems.length) {
  console.error("\n未通过：");
  for (const p of problems) console.error("  -", p);
  process.exit(1);
}

if (DRY) { console.log("\n[DRY RUN] 未写入"); process.exit(0); }

const res = await fetch(`${API}/api/projects/${PROJECT_ID}`, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(project)
});
const body = await res.json();
console.log("\nPUT", res.status, JSON.stringify(body).slice(0, 300));
