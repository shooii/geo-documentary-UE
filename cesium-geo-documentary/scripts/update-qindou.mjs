import { readFile, writeFile } from "node:fs/promises";

const path = "content/regions.zh-CN.json";
const master = JSON.parse(await readFile(path, "utf8"));
const order = [
  "440882116001", "440882116200", "440882116201", "440882116202",
  "440882116203", "440882116217", "440882116218", "440882116205",
  "440882116206", "440882116207", "440882116208", "440882116209",
  "440882116210", "440882116211", "440882116212", "440882116213",
  "440882116204", "440882116214", "440882116216", "440882116215"
];
const villageNames = ["覃斗社区", "讨泗村", "六高村", "凌新村", "英岭村", "东港村", "西岸村", "后洪村", "卜立村", "塘边村", "铺前村", "迈克村", "那金村", "山尾村", "流沙村", "下海村", "海边村", "头和村", "提交村", "英楠村"];
master["440882116"] = {
  name: "覃斗镇",
  title: "地理乡土情·雷州市覃斗镇",
  voiceRate: "+24%",
  voiceId: "zh-CN-YunxiNeural",
  subtitleLeadSeconds: -0.08,
  tourIntroSentences: 6,
  tourFlightSeconds: 3.8,
  tourReturnSeconds: 4.4,
  tourOrder: order,
  subtitleProtectedPhrases: ["雷州市覃斗镇", "覃斗镇", "北部湾", "覃斗路", "覃斗芒果", "流沙南珠", "流沙港", "黄金贝", ...villageNames],
  facts: {
    area: "行政区域面积104平方千米",
    population: "2020年常住人口39735人",
    physical: "雷州半岛西海岸、北部湾东岸，海岸线长46公里",
    economy: "芒果种植与南珠养殖加工构成两张产业名片",
    culture: "圩市、果园、渔港与珍珠池共同塑造沿海生活",
    modern: "覃斗路、乌石港高速与流沙港串联产地和市场"
  },
  narration: [
    "覃斗镇位于雷州市西南部、北部湾东岸，距雷州市区约六十九千米。",
    "全镇行政区域面积一百零四平方千米，二零二零年常住人口三万九千七百三十五人。",
    "这里冬暖春旱、光照充足，四十六公里海岸线外，是广阔的浅海和滩涂。",
    "覃斗芒果与流沙南珠，是这片土地最鲜明的两张名片。",
    "覃斗路连接果园、养殖基地和流沙港，乌流线、平覃线、英覃线在镇域交织。",
    "接下来，镜头沿着道路与海岸，走进覃斗镇的一个社区和十九个行政村。",
    "覃斗社区是覃斗圩和镇政府所在地，商铺、市场与公共服务聚在一起，赶集日最有烟火气。",
    "讨泗村是覃斗芒果核心产区，台农、蛋芒等品种连成果园，乡贤力量也参与乡村建设。",
    "六高村紧邻讨泗，芒果产业园从传统种植向交易、加工和农旅融合延伸。",
    "凌新村人口较多，八个自然村之间，青枣与芒果铺开连片田园。",
    "英岭村靠海发展，产业由盐场和近海捕捞，转向贝类、对虾与石斑鱼立体养殖。",
    "东港村依港而生，渔船、海水养殖和潮汐，共同安排着村民的日常。",
    "西岸村守着北部湾海岸，海风穿过果园与村舍，留下鲜明的西海岸气息。",
    "后洪村的珍珠养殖池连片分布，珠农劳作与粼粼水面构成寻常风景。",
    "卜立村由多个自然村组成，农田、养殖与老屋保留着传统村落的质朴。",
    "塘边村临近乌石港高速，便利交通让芒果和蔬菜更快运往外地。",
    "铺前村因古驿道商铺得名，如今从救济村成长为蔬果产业与覃斗芒果示范村。",
    "迈克村的多个自然村广泛种植芒果，是覃斗芒果产业的重要组成部分。",
    "那金村里陈、吴等姓氏世代相处，在共同耕作中延续典型农业村落的生活。",
    "山尾村以优质芒果闻名，当地人常说，覃斗芒果上国会，最是有名山尾村。",
    "流沙村被誉为中国南珠第一村，珍珠养殖、加工与流沙深水港，让产品走向五十多个国家和地区。",
    "下海村面向海湾，渔业捕捞与海水养殖，是多个自然村的重要收入来源。",
    "海边村从浅海捕捞转向黄金贝养殖，小小贝类托起越来越稳的沿海生活。",
    "头和村由头罗、和合、外村组成，田园、老树与村道维持着宁静节奏。",
    "提交村的四个自然村普遍种植芒果，果园也是村庄最熟悉的产业景观。",
    "英楠村由英楠与乔木两个自然村组成，芒果和乔木共生，田园绿意绵延。",
    "从覃斗圩到流沙港，从芒果园到珍珠池，二十个村和社区串起雷州半岛西海岸最真实的生活。"
  ],
  pronunciations: [
    { term: "覃斗", pinyin: "tán dǒu" },
    { term: "覃斗圩", pinyin: "tán dǒu xū" },
    { term: "讨泗", pinyin: "tǎo sì" },
    { term: "卜立", pinyin: "bǔ lì" },
    { term: "流沙南珠", pinyin: "liú shā nán zhū" }
  ],
  imagePromptTheme: "雷州半岛西海岸的芒果园、珍珠养殖池、渔港、浅海滩涂与乡村道路，纪实摄影风格",
  sources: [
    { claimId: "440882116-boundary-001", claim: "本地缓存村界覆盖覃斗镇18个旧版单元；现行东港村、西岸村使用从相邻旧版沿海村面拆分的不重叠展示边界，并明确标注非测绘用途。", sourceTitle: "广东省乡镇级与村级行政边界数据（本地缓存）", sourceUrl: "data/regions/01【25096】全国村级行政边界数据/广东村界/广东全省/广东省CJ.shp", publisher: "项目本地数据", publishedAt: "2026-08-16", confidence: "medium", usage: ["timeline", "storyboard", "coverage"] },
    { claimId: "440882116-user-brief-001", claim: "用户稿件提供覃斗镇区位、面积、人口、交通、产业与20个村（社区）的逐段叙事重点。", sourceTitle: "用户提供的覃斗镇视频稿件", sourceUrl: "user://prompt", publisher: "用户提供", publishedAt: "2026-08-16", confidence: "medium", usage: ["script", "storyboard"] },
    { claimId: "440882116-division-001", claim: "覃斗镇现行统计区划代码为440882116，下辖覃斗社区及19个村委会。", sourceTitle: "雷州市行政区划（2025年）", sourceUrl: "https://www.xzqh.org/show/china/2025/44/440882.html", publisher: "区划地名网（据统计区划资料整理）", publishedAt: "2025", confidence: "medium", usage: ["script", "coverage"] },
    { claimId: "440882116-leizhou-001", claim: "雷州是南珠之乡、芒果之乡，流沙南珠和覃斗芒果获国家地理标志保护。", sourceTitle: "雷州概况", sourceUrl: "https://www.leizhou.gov.cn/lzsq/lzjj/content/post_1865125.html", publisher: "雷州市人民政府", publishedAt: "2026", confidence: "high", usage: ["script", "storyboard"] },
    { claimId: "440882116-pearl-001", claim: "流沙村被誉为中国南珠第一村，南珠产业持续获得科研团队支持。", sourceTitle: "良种良法让流沙南珠更璀璨", sourceUrl: "https://www.zhanjiang.gov.cn/zjsfw/bmdh/kjj/zwgk/gzdt/content/mpost_2180697.html", publisher: "湛江市人民政府门户网站", publishedAt: "2026", confidence: "high", usage: ["script", "storyboard"] }
  ]
};
await writeFile(path, JSON.stringify(master, null, 2) + "\n", "utf8");
console.log("Updated 覃斗镇 440882116 content");
