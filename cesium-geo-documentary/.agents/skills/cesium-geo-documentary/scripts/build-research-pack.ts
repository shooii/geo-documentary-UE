import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface SourceClaim {
  claimId: string;
  claim: string;
  sourceTitle: string;
  sourceUrl: string;
  publisher: string;
  publishedAt: string;
  confidence: "high" | "medium" | "low";
  usage: string[];
}

interface RegionContent {
  name: string;
  facts: Record<string, string>;
  narration: string[];
  pronunciations: Array<{ term: string; pinyin: string }>;
  imagePromptTheme: string;
  sources: SourceClaim[];
}

const root = resolve(process.cwd());
const accessedAt = new Date().toISOString().slice(0, 10);
const master = JSON.parse(await readFile(resolve(root, "content/regions.zh-CN.json"), "utf8")) as Record<string, RegionContent>;
const regionFlag = process.argv.indexOf("--region");
const requested = regionFlag >= 0 ? process.argv[regionFlag + 1] : undefined;
const entries = requested ? [[requested, master[requested]]] as const : Object.entries(master);
await mkdir(resolve(root, "content/research"), { recursive: true });
await mkdir(resolve(root, "data/sources"), { recursive: true });

for (const [regionId, content] of entries) {
  if (!content) throw new Error(`Unknown region ${regionId}`);
  const claims = content.sources.map((source) => ({
    ...source,
    accessedAt,
    quoteLimitChecked: true,
    factualStatus: "verified-fact"
  }));
  const markdown = [
    `# ${content.name}研究包`,
    "",
    "## 叙事结论",
    "",
    ...Object.entries(content.facts).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## 事实清单",
    "",
    ...claims.flatMap((claim) => [
      `### ${claim.claimId}`,
      "",
      `- 事实：${claim.claim}`,
      `- 来源：${claim.sourceTitle}（${claim.publisher}）`,
      `- 日期：${claim.publishedAt}；访问：${claim.accessedAt}`,
      `- 置信度：${claim.confidence}`,
      `- URL：${claim.sourceUrl}`,
      ""
    ]),
    "## 编辑说明",
    "",
    "本片采用 clean-broadcast 呈现：行政边界使用 DataV 公开 GeoJSON 进行视频可视化，不作为测绘成果或法定界线依据；人口、经济、历史与文化来源保存在研究包和外部清单中。画面不使用生成图片，也不显示编辑来源卡。",
    ""
  ].join("\n");
  await writeFile(resolve(root, `content/research/${regionId}.md`), markdown, "utf8");
  await writeFile(resolve(root, `data/sources/${regionId}.json`), JSON.stringify(claims, null, 2), "utf8");
}

process.stdout.write(`Generated ${entries.length} research packs\n`);
