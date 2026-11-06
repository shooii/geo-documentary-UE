import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface PublishingCopy {
  regionId: string;
  douyin: string;
  kuaishou: string;
  hashtags?: string[];
}

interface RegionContent {
  title?: string;
  name: string;
}

const root = resolve(process.cwd());
const args = process.argv.slice(2);
const regionIndex = args.indexOf("--region");
const regionId = regionIndex >= 0 ? args[regionIndex + 1] : undefined;
if (!regionId) throw new Error("--region is required");

const contentIndex = JSON.parse(await readFile(resolve(root, "content/regions.zh-CN.json"), "utf8")) as Record<string, RegionContent>;
const region = contentIndex[regionId];
if (!region) throw new Error(`Unknown region ${regionId}`);
const sourcePath = resolve(root, `content/publishing/${regionId}.json`);
const copy = JSON.parse(await readFile(sourcePath, "utf8")) as PublishingCopy;
if (copy.regionId !== regionId) throw new Error(`Publishing copy regionId mismatch: ${copy.regionId}`);

const visibleLength = (value: string): number => Array.from(value.replace(/\s/g, "")).length;
const banned = ["持续推进", "提质增效", "赋能", "可靠边界", "核验范围", "镜头沿着", "巡游走完", "点赞关注"];
const topicName = region.title?.replace(/^地理乡土情·/, "") ?? region.name;

for (const [platform, value] of [["douyin", copy.douyin], ["kuaishou", copy.kuaishou]] as const) {
  if (typeof value !== "string" || value.includes("\n")) throw new Error(`${platform} description must be one line`);
  const length = visibleLength(value);
  if (length < 42 || length > 60) throw new Error(`${platform} description must be 42-60 visible characters, received ${length}`);
  if (!value.includes(topicName)) throw new Error(`${platform} description must include ${topicName}`);
  const forbidden = banned.find((term) => value.includes(term));
  if (forbidden) throw new Error(`${platform} description contains banned wording: ${forbidden}`);
}

const hashtags = (copy.hashtags ?? []).map((value) => value.startsWith("#") ? value : `#${value}`);
if (hashtags.length < 2 || hashtags.length > 5) throw new Error("Publishing copy needs 2-5 hashtags");
const title = region.title ?? `地理乡土情·${region.name}`;
const safeStem = title.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").trim();
const outputDirectory = resolve(root, "renders/final");
await mkdir(outputDirectory, { recursive: true });

const output = {
  regionId,
  title,
  generatedAt: new Date().toISOString(),
  douyin: { description: copy.douyin, visibleCharacters: visibleLength(copy.douyin) },
  kuaishou: { description: copy.kuaishou, visibleCharacters: visibleLength(copy.kuaishou) },
  hashtags
};
const jsonPath = resolve(outputDirectory, `${safeStem}-发布简介.json`);
const textPath = resolve(outputDirectory, `${safeStem}-发布简介.txt`);
const text = [
  `抖音作品简介（${output.douyin.visibleCharacters}字）`,
  copy.douyin,
  "",
  `快手作品简介（${output.kuaishou.visibleCharacters}字）`,
  copy.kuaishou,
  "",
  "推荐话题",
  hashtags.join(" ")
].join("\n");
await writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
await writeFile(textPath, `${text}\n`, "utf8");
process.stdout.write(`PUBLISH_COPY_READY ${regionId} ${textPath}\n`);
