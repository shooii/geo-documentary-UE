import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface RegionContent {
  name: string;
  narration: string[];
  pronunciations: Array<{ term: string; pinyin: string }>;
  sources: Array<{ claimId: string }>;
}

const root = resolve(process.cwd());
const master = JSON.parse(await readFile(resolve(root, "content/regions.zh-CN.json"), "utf8")) as Record<string, RegionContent>;
const regionFlag = process.argv.indexOf("--region");
const requested = regionFlag >= 0 ? process.argv[regionFlag + 1] : undefined;
const entries = requested ? [[requested, master[requested]]] as const : Object.entries(master);
await mkdir(resolve(root, "content/scripts"), { recursive: true });
await mkdir(resolve(root, "content/pronunciations"), { recursive: true });

for (const [regionId, content] of entries) {
  if (!content) throw new Error(`Unknown region ${regionId}`);
  const fullText = content.narration.join("");
  const sourceIds = content.sources.map((source) => source.claimId).join(", ");
  const markdown = [
    `# ${content.name}旁白脚本`,
    "",
    `- 目标时长：45–60 秒`,
    `- 字符数：${fullText.length}`,
    "- 语气：克制、电影纪录片、非旅游广告腔",
    `- 来源事实：${sourceIds}`,
    "",
    ...content.narration.flatMap((paragraph, index) => [
      `## paragraph-${String(index + 1).padStart(2, "0")}`,
      "",
      `状态：${index === content.narration.length - 1 ? "editorial-summary" : "verified-fact"}`,
      "",
      paragraph,
      ""
    ])
  ].join("\n");
  await writeFile(resolve(root, `content/scripts/${regionId}.md`), markdown, "utf8");
  await writeFile(resolve(root, `content/scripts/${regionId}.txt`), fullText, "utf8");
  await writeFile(resolve(root, `content/pronunciations/${regionId}.json`), JSON.stringify({ regionId, language: "zh-CN", terms: content.pronunciations }, null, 2), "utf8");
}

process.stdout.write(`Generated ${entries.length} narration scripts\n`);
