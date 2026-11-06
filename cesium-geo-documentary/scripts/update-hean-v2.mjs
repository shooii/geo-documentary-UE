import { readFile, writeFile } from "node:fs/promises";

const regionId = "440825111";
const contentPath = "content/regions.zh-CN.json";
const content = JSON.parse(await readFile(contentPath, "utf8"));

const narration = [
  "和安镇坐落在徐闻县东北部海岸，是一座陆岛相依的滨海镇；大陆岸线、近海岛屿、曲折港湾和广阔滩涂，共同组成五岛十湾的空间格局。",
  "全镇下辖和安社区与九个行政村，共十个村居；现有村界数据包含九个行政村面，和安社区没有独立可靠边界，因此与和安村合并讲述，不绘制近似边界。",
  "这里气候温暖，潮间带、红树林、虾塘和渔港交织；高位池对虾、近海捕捞和网箱养殖构成海洋支柱，斑斓叶、香兰鸡与沙地杂粮铺开陆上农业。",
  "过去海岛交通更多依靠渡船，冬松岛大桥通车后岛陆往来明显改善；潮起时渔船出港，潮落后人们赶海采贝，海陆两种生活在同一阵海风里相遇。",
  "接下来，镜头从镇墟出发，依次走进和安、云头、水头、公港、后湖、金鸡、佳平、北莉与冬松九个村域，并把和安社区纳入镇墟中心共同介绍。",
  "所有村级产业与风貌描述以用户提供资料为叙事依据；县域实景照片只作徐闻滨海环境语境，不宣称拍摄于具体村庄。",
  "和安社区与和安村共同构成镇墟中心；镇政府、中学、卫生院、市场和码头汇聚在这里，赶圩、客运与海陆物资流转，组织着全镇最热闹的日常。",
  "云头村是和安最有辨识度的香草农业节点；连片斑斓叶田带着清香延伸，采收、加工与香兰鸡等特色农产品，一起构成清新的田园景观。",
  "水头村紧邻内湾，虾塘、鱼塘与平缓滩涂交错；高位池增氧机昼夜运转，浅滩赶海仍在延续，村舍、防护林和养殖水面彼此相邻。",
  "公港村是老牌滨海渔村，也保留革命老区记忆；港湾避风，渔船常年停靠，近海捕捞和小网箱养殖，让渔汛时节的码头格外忙碌。",
  "后湖村以浅湖、塘堰和湿地水面为底色；咸淡水养殖、护岸林木与水鸟栖息地相互嵌合，呈现少见的内湖塘型滨海村落风貌。",
  "金鸡村所在的金鸡岛拥有曲折岸线与宽阔潮间带；传统捕捞、贝类和鱼虾养殖历史悠久，退潮采贝、涨潮出海，是原生态港湾渔村的日常节奏。",
  "佳平村是滨海养殖与外销节点；对虾和海产养殖塘沿岸排布，水产装运连接岛外市场，也为滨海休闲与村庄更新留下新的空间。",
  "北莉村位于北莉岛，四面环海，红树林与潮间滩涂保存着安静的原生气质；近海捕捞、滩涂养殖、赶海与观鸟，共同塑造海岛生活。",
  "冬松村所在的冬松岛，是和安最知名的海岛；大桥连接陆岛，大片滩涂、红树林、渔船群与网箱养殖铺向海面，日出日落也展现出文旅潜力。",
  "从和安墟的码头烟火，到云头村漫野的斑斓清香，从大陆岸线的连片虾塘，到冬松、北莉与金鸡诸岛的潮间滩涂，和安把香草田园与耕海牧渔融在一起；潮起出海，潮落采海，香草伴海风，渔歌伴落日，这就是海陆共生的和安镇。"
];

content[regionId] = {
  ...content[regionId],
  title: "地理图说·徐闻县和安镇",
  voiceRate: "+2%",
  voiceId: "zh-CN-YunyangNeural",
  tourIntroSentences: 6,
  tourFlightSeconds: 3.8,
  tourReturnSeconds: 5,
  tourOrder: [
    "440825111201", "440825111202", "440825111203", "440825111204", "440825111205",
    "440825111206", "440825111207", "440825111208", "440825111209"
  ],
  facts: {
    population: "下辖1个社区、9个行政村，共10个村居",
    economy: "对虾养殖、近海捕捞、网箱渔产与斑斓农业并进",
    physical: "徐闻东北部陆岛相依，港湾、滩涂、红树林与近海岛屿交织",
    history: "镇墟、老区渔村与海岛交通共同塑造地方记忆",
    culture: "潮起出海、潮落采海，香草田园与渔家生活相融",
    modern: "冬松岛大桥改善通行，养殖提质与滨海休闲持续发展"
  },
  narration,
  imagePromptTheme: "",
  sources: [
    ...(content[regionId].sources ?? []).filter((source) => source.claimId !== `${regionId}-user-brief-002`),
    {
      claimId: `${regionId}-user-brief-002`,
      claim: "和安镇整体格局、十个村居名称及逐村产业、生态、交通和风貌描述由用户提供；涉及精确面积、桥梁状态与五岛十湾等表述按用户资料使用。",
      sourceTitle: "用户提供的和安镇视频文案与配图建议",
      sourceUrl: "user://prompt/2026-08-14",
      publisher: "用户提供",
      publishedAt: "2026-08-14",
      confidence: "medium",
      usage: ["script", "storyboard", "subtitles"]
    }
  ]
};

await writeFile(contentPath, JSON.stringify(content, null, 2), "utf8");

const childIds = content[regionId].tourOrder;
const sceneTitles = [
  "陆岛相依的和安", "十个村居与边界说明", "海陆产业与生态", "冬松大桥与潮汐生活", "九村路线", "素材与证据说明",
  "和安社区 + 和安村", "云头村", "水头村", "公港村", "后湖村", "金鸡村", "佳平村", "北莉村", "冬松村", "海陆共生的和安"
];
const scenes = narration.map((line, index) => ({
  sceneId: `${regionId}-scene-${String(index + 1).padStart(2, "0")}`,
  title: sceneTitles[index],
  start: 0,
  end: 0,
  duration: 0,
  narration: line,
  childId: index >= 6 && index <= 14 ? childIds[index - 6] : undefined,
  cameraAction: index === 15 ? "return-to-parent-overview" : (index >= 6 && index <= 14 ? "fly-to-child-and-hold" : "hold-parent-overview"),
  composition: index >= 6 && index <= 14 ? "上方证据卡或标题，下方真实卫星地图与当前村界高亮" : "连续卫星地图总览，低对比悬浮镇域边界",
  subtitle: { mode: "single-line-short-phrase", text: line, safeArea: "bottom" },
  transition: "continuous-map-carrier",
  sources: index === 1 ? [`${regionId}-boundary-001`, `${regionId}-user-brief-002`] : [`${regionId}-user-brief-002`],
  qa: "检查地名、字幕安全区、当前村界高亮与画面说明一致"
}));
await writeFile(`content/storyboards/${regionId}.json`, JSON.stringify({
  regionId,
  title: "地理图说·徐闻县和安镇",
  profile: "portrait",
  duration: 0,
  presentationMode: "parent-child-tour-map-led",
  scenes
}, null, 2), "utf8");

await writeFile(`content/scripts/${regionId}.md`, `# 徐闻县和安镇旁白脚本（2026-08-14 新版）\n\n- 标题：地理图说·徐闻县和安镇\n- 画幅：1080×1920，30fps\n- 结构：镇域总览 + 9 个可核验村界巡游；和安社区与和安村合并讲述\n- 边界限制：现有 GIS 数据不含和安社区独立面，不绘制推测边界\n- 素材策略：真实卫星地图为主；县域实景仅作环境语境并明确标注\n\n${narration.map((line, i) => `${i + 1}. ${line}`).join("\n\n")}\n`, "utf8");

await writeFile(`content/visuals/${regionId}.json`, JSON.stringify({
  regionId,
  profilePriority: "portrait",
  timingMode: "narration-cue-required",
  policy: "Use verified Xuwen regional context photos only; captions explicitly avoid claiming exact village capture.",
  clips: [
    {
      id: "coastal-aquaculture-context",
      path: "assets/source/440825112/11-coastal-aquaculture.jpg",
      label: "徐闻滨海养殖实景（县域语境，非具体村定位）",
      fit: "cover",
      sourceType: "verified-real",
      narrationCueIndex: 2,
      requiredKeywords: ["虾塘", "养殖"],
      leadSeconds: 0.2,
      tailSeconds: 0.2
    },
    {
      id: "shrimp-pond-context",
      path: "assets/source/440825112/12-shrimp-sheds-aerial.jpg",
      label: "徐闻连片养殖区实景（县域语境，非具体村定位）",
      fit: "cover",
      sourceType: "verified-real",
      narrationCueIndex: 8,
      requiredKeywords: ["高位池", "增氧机"],
      leadSeconds: 0.2,
      tailSeconds: 0.2
    },
    {
      id: "mangrove-context",
      path: "assets/source/440825112/03-mangrove-restoration.jpg",
      label: "徐闻红树林实景资料（县域语境，非具体村定位）",
      fit: "cover",
      sourceType: "verified-real",
      narrationCueIndex: 13,
      requiredKeywords: ["红树林", "潮间滩涂"],
      leadSeconds: 0.2,
      tailSeconds: 0.2
    }
  ]
}, null, 2), "utf8");

const research = await readFile(`content/research/${regionId}.md`, "utf8").catch(() => "");
await writeFile(`content/research/${regionId}.md`, `${research.trim()}\n\n## 2026-08-14 用户补充资料\n\n- 用户补充了“五岛十湾、千顷滩涂”、十个村居、冬松岛大桥、斑斓农业、红树林、逐村产业与风貌等叙事信息。\n- 这些内容作为用户提供资料写入旁白，置信度记为 medium；正式商业发布前宜由和安镇政府或村委逐项复核。\n- GIS 仍只展示 9 个行政村面；和安社区没有可靠独立边界，和安社区与和安村在同一镜头合并介绍。\n- 使用的养殖与红树林照片来自徐闻县域公开资料，只说明区域环境语境，不标注为具体村拍摄。\n`, "utf8");

console.log("UPDATED_HEAN_V2", narration.length);
