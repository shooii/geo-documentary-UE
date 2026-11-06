import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StudioScene, VideoProject } from "../../packages/project-schema/index.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";

interface DeepSeekSettings {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

function settingsPath(root: string): string {
  return join(root, "workspace", "deepseek-settings.json");
}

async function readSettings(root: string): Promise<DeepSeekSettings> {
  if (!existsSync(settingsPath(root))) return {};
  try {
    return JSON.parse(await readFile(settingsPath(root), "utf8")) as DeepSeekSettings;
  } catch {
    return {};
  }
}

export async function deepSeekKeyConfigured(root: string): Promise<boolean> {
  return Boolean(process.env.DEEPSEEK_API_KEY?.trim() || (await readSettings(root)).apiKey?.trim());
}

export async function deepSeekPublicOptions(root: string): Promise<{ provider: "deepseek"; keyConfigured: boolean; model: string }> {
  const settings = await readSettings(root);
  return {
    provider: "deepseek",
    keyConfigured: Boolean(process.env.DEEPSEEK_API_KEY?.trim() || settings.apiKey?.trim()),
    model: process.env.DEEPSEEK_MODEL?.trim() || settings.model?.trim() || DEFAULT_MODEL
  };
}

async function resolveConfiguration(root: string): Promise<{ apiKey: string; baseUrl: string; model: string }> {
  const settings = await readSettings(root);
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim() || settings.apiKey?.trim();
  if (!apiKey) throw new Error("自动生成文案需要在服务端配置 DEEPSEEK_API_KEY");
  return {
    apiKey,
    baseUrl: (process.env.DEEPSEEK_BASE_URL?.trim() || settings.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/$/, ""),
    model: process.env.DEEPSEEK_MODEL?.trim() || settings.model?.trim() || DEFAULT_MODEL
  };
}

function sceneFacts(project: VideoProject, scene: StudioScene): object {
  const assets = (scene.placements ?? [])
    .map((placement) => project.assets.find((asset) => asset.id === placement.assetId))
    .filter((asset) => Boolean(asset));
  return {
    id: scene.id,
    section: scene.section,
    title: scene.title,
    childName: scene.childName,
    existingNarration: scene.narration,
    verifiedAssets: assets.map((asset) => ({
      name: asset!.name,
      poiName: asset!.poi?.poiName,
      poiType: asset!.poi?.poiType
    }))
  };
}

export function buildCopyPrompt(project: VideoProject, reference = "", scopeSceneId = ""): string {
  const editable = project.scenes
    .filter((scene) => scene.section !== "cover" && (!scopeSceneId || scene.id === scopeSceneId))
    .map((scene) => sceneFacts(project, scene));
  const input = {
    projectName: project.name,
    region: {
      province: project.cover.province,
      city: project.cover.city,
      county: project.cover.county,
      town: project.cover.town
    },
    scenes: editable
  };
  const prompt = [
    "请为行政区短视频生成中文旁白，并且只输出 JSON。",
    "JSON 格式：{\"scenes\":[{\"id\":\"场景ID\",\"narration\":\"完整旁白\"}]}。",
    "规则：每个输入场景必须且只能返回一次；保持原场景顺序和 id；每段 25 至 70 个汉字，1 至 2 个完整句子；语言自然、简洁、适合配音。",
    "只能使用输入中已有的行政层级、原文和已验证素材名称，不得新增数字、历史、产业、人物、地名或其他未经提供的事实。没有具体资料时，仅客观说明该下级行政区隶属关系与镜头展示内容。",
    "若场景已有旁白(existingNarration)，必须在不改变任何事实的前提下，用不同的句式与措辞重写润色，使其更口语、更生动，且不得照抄或几乎照抄原句；若场景无旁白，则按规则从零撰写。",
    "事实铁律（最高优先级，违反任何一条都会被系统拦截并整批拒绝）：不得出现任何输入中不存在的具体数字与统计——包括年份、人口、面积、产值、产业数据、户数、学校医院数量、距离里程等；不得使用“最”“唯一”“首个”“最大”等绝对化表述，除非输入原文明确包含。没有可核实的资料时，宁可只写“隶属关系、方位与镜头画面”，也绝不编造数字或事件；existingNarration 中已有的数字可以原样保留并调整句式，但不得改动其数值，也不得新增其它数字。",
    "严禁出现工程或说明性措辞：不得写“数据”“自动生成”“导出成片”“方案”“村级行政边界”“下辖 N 个”等系统化、说明书式的句子；文案必须是给观众听的地理故事，而不是软件说明。"
  ];
  const trimmedReference = reference.trim();
  if (trimmedReference) {
    prompt.push(
      "用户提供了一段参考文案作为风格样板。必须写出带文学质感的句子：至少使用一种与参考文案相同的手法——以时辰/天气/声音开头、用具象名词加动作营造画面、通过比喻或拟人把景观写活——并让整段口吻像参考文案的“同款笔调”。事实边界不变（参考文案中的地名、数字、行业、人物一律不得采用，只模仿文字感觉与叙事方式），但语言可以更舒展：允许句子略长、更有画面。不得整句或大段复制参考文案中的句子。"
    );
  }
  prompt.push(
    "不要输出标题、序号、Markdown 或解释。字幕将直接采用旁白并由系统自动断句。"
  );
  if (trimmedReference) {
    prompt.push("参考文案（仅作为风格范例，禁止复制其中事实）：\n" + trimmedReference);
  }
  prompt.push(JSON.stringify(input));
  return prompt.join("\n");
}

// ---------------------------------------------------------------------------
// Truth guard. Narration may only repeat facts that already exist in the
// project payload (administrative chain, child names, verified asset names,
// the previous narration itself). Any concrete number or statistic that is not
// grounded in those inputs is treated as invented and the whole batch is
// rejected, so an AI slip can never silently publish fake census/economy data.
// ---------------------------------------------------------------------------

const CHINESE_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 } as const;

function parseAmount(value: string): number {
  if (/^[0-9]+$/.test(value)) return Number(value);
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const char of value) {
    const place = CHINESE_DIGIT[char as keyof typeof CHINESE_DIGIT];
    if (place === undefined) continue;
    if (place === 100000000) { total += (section + digit) * place; section = 0; digit = 0; }
    else if (place === 10000) { section = (section + digit) * place; digit = 0; }
    else if (place === 10 || place === 100 || place === 1000) { section += (digit || 1) * place; digit = 0; }
    else digit = place;
  }
  return total + section + digit;
}

interface UngroundedFact {
  sceneId: string;
  title: string;
  tokens: string[];
}

/** Build the only set of numeric facts we are willing to trust. */
function trustedFactCorpus(project: VideoProject): string {
  const parts: string[] = [project.name];
  for (const key of ["province", "city", "county", "town"] as const) {
    const value = project.cover[key];
    if (value) parts.push(value);
  }
  if (project.cover.administrativeLabel) parts.push(project.cover.administrativeLabel);
  for (const scene of project.scenes) {
    if (scene.childName) parts.push(scene.childName);
    if (scene.title) parts.push(scene.title);
    if (scene.narration) parts.push(scene.narration);
  }
  for (const asset of project.assets) {
    if (asset.name) parts.push(asset.name);
    if (asset.poi?.poiName) parts.push(asset.poi.poiName);
  }
  const childCount = project.scenes.filter((scene) => scene.section === "child").length;
  if (childCount > 0) parts.push(`${childCount}个行政村`, `${childCount}个社区`);
  return parts.map((part) => String(part).replace(/\s+/g, "")).join(" ");
}

interface ParsedFact {
  raw: string;
  kind: "stat" | "year" | "count";
  unit: string;
  value: number;
}

const FACT_STAT_RE = /([0-9][0-9,.]*|[零一二两三四五六七八九十百千万亿]+)([多几])?\s*(万人|人口|亿元|万元|万亩|亿亩|平方公里|平方千米|亩|公顷|吨|人|％|%)/g;
const FACT_YEAR_RE = /(?:19|20)\d{2}\s*年/g;
const FACT_COUNT_RE = /([0-9]+|[零一二两三四五六七八九十百千万亿]+)([多几])?\s*[个条]?\s*(行政村|自然村|社区|村委会|村|庄)/g;

function parseFacts(text: string): ParsedFact[] {
  const facts: ParsedFact[] = [];
  for (const match of String(text).matchAll(FACT_STAT_RE)) {
    const numberText = match[1]!.replace(/,/g, "");
    // A number written with its own 亿/万 already encodes the scale inside the
    // numeral (七亿元 = 7×10^8). Only bare numerals need the unit multiplier.
    const scaleEmbedded = /[万亿]/.test(numberText);
    let value = parseAmount(numberText);
    let unit = match[3]!;
    if (unit === "万人") unit = "人";
    else if (unit === "人口") unit = "人";
    else if (unit === "亿元" || unit === "万元") unit = "元";
    else if (unit === "万亩" || unit === "亿亩") unit = "亩";
    else if (unit === "％") unit = "%";
    if (!scaleEmbedded) {
      if (match[3] === "万元" || match[3] === "万人" || match[3] === "万亩") value *= 10000;
      else if (match[3] === "亿元" || match[3] === "亿亩") value *= 100000000;
    }
    facts.push({ raw: match[0], kind: "stat", unit, value });
  }
  for (const match of String(text).matchAll(FACT_YEAR_RE)) {
    facts.push({ raw: match[0], kind: "year", unit: "年", value: Number(match[0].replace(/\s/g, "").slice(0, 4)) });
  }
  for (const match of String(text).matchAll(FACT_COUNT_RE)) {
    if (!/个|条/.test(match[0]) && (match[1] || "").length < 2) continue;
    facts.push({ raw: match[0], kind: "count", unit: match[3]!, value: parseAmount(match[1]!.replace(/,/g, "")) });
  }
  return facts;
}

function factsCompatible(generated: ParsedFact, trusted: ParsedFact): boolean {
  if (generated.unit !== trusted.unit) return false;
  if (generated.kind !== "stat") return generated.value === trusted.value;
  const distance = Math.abs(generated.value - trusted.value);
  // A rewritten phrase may round or restate the source value (34247人 ->
  // 三万四千多人, 79353万元 -> 七亿九千多万元); allow up to a 15% drift but
  // never accept a materially different figure.
  return distance <= Math.max(1, trusted.value * 0.15);
}

export function flagUngroundedFacts(project: VideoProject, narrations: ReadonlyMap<string, string>): UngroundedFact[] {
  const corpus = trustedFactCorpus(project);
  const childCount = project.scenes.filter((scene) => scene.section === "child").length;
  const trusted = parseFacts(corpus);
  if (childCount > 0) {
    trusted.push({ raw: `${childCount}个行政村`, kind: "count", unit: "行政村", value: childCount });
    trusted.push({ raw: `${childCount}个社区`, kind: "count", unit: "社区", value: childCount });
  }
  const flagged: UngroundedFact[] = [];
  for (const scene of project.scenes) {
    if (scene.section === "cover") continue;
    const narration = narrations.get(scene.id);
    if (!narration) continue;
    const tokens = new Set<string>();
    for (const fact of parseFacts(narration)) {
      if (!trusted.some((candidate) => factsCompatible(fact, candidate))) tokens.add(fact.raw);
    }
    if (tokens.size) flagged.push({ sceneId: scene.id, title: scene.title, tokens: [...tokens].slice(0, 3) });
  }
  return flagged;
}

export function applyGeneratedCopy(project: VideoProject, payload: unknown, scopeSceneId = ""): VideoProject {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { scenes?: unknown }).scenes)) {
    throw new Error("DeepSeek 返回的文案格式不正确");
  }
  const generated = new Map<string, string>();
  for (const row of (payload as { scenes: unknown[] }).scenes) {
    if (!row || typeof row !== "object") continue;
    const id = String((row as { id?: unknown }).id ?? "").trim();
    const narration = String((row as { narration?: unknown }).narration ?? "").replace(/\s+/g, "").trim();
    if (id && narration && narration.length <= 220) generated.set(id, narration);
  }
  // When scoped to one scene only that scene must be present; otherwise every
  // editable scene is required, exactly as before.
  const editable = project.scenes.filter((scene) => scene.section !== "cover" && (!scopeSceneId || scene.id === scopeSceneId));
  if (editable.some((scene) => !generated.has(scene.id))) {
    throw new Error("DeepSeek 未返回全部场景文案，请重试");
  }
  const ungrounded = flagUngroundedFacts(project, generated);
  if (ungrounded.length) {
    const scene = ungrounded[0]!;
    throw new Error(
      `DeepSeek 文案被真实性护栏拦截：${scene.title}中的“${scene.tokens[0]}”等 ${scene.tokens.length} 处数字/统计未在本项目资料中出现（疑似编造），已拒绝保存。请再次点击生成，系统会要求模型只使用已有事实。`
    );
  }
  return {
    ...project,
    scenes: project.scenes.map((scene) => {
      if (scene.section === "cover") return scene;
      const narration = generated.get(scene.id);
      if (narration === undefined) return scene;
      const duration = Math.max(2, [...narration].length / 4);
      return {
        ...scene,
        narration,
        subtitle: narration,
        duration,
        ...(scene.timing ? {
          timing: {
            ...scene.timing,
            actualNarrationSeconds: duration,
            minimumVisualSeconds: Math.max(scene.timing.minimumVisualSeconds, duration)
          }
        } : {})
      };
    })
  };
}

export async function generateProjectCopy(
  root: string,
  project: VideoProject,
  fetchImpl: typeof fetch = fetch,
  options: { reference?: string; sceneId?: string } = {}
): Promise<VideoProject> {
  const configuration = await resolveConfiguration(root);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  const sceneId = String(options.sceneId ?? "").trim();
  let lastError: Error | null = null;
  try {
    // The truth guard rejects a batch the moment it invents a statistic. One
    // automatic retry gives the model a second chance to stick to the known
    // facts before surfacing the error to the caller.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetchImpl(`${configuration.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${configuration.apiKey}`
        },
        body: JSON.stringify({
          model: configuration.model,
          messages: [
            {
              role: "system",
              content: "你是严谨的中文地理纪录片编辑。必须输出有效 JSON，并严格遵守用户提供的事实边界；当用户给出参考文案时，只借鉴其语言风格，不复制其中的事实。"
            },
            { role: "user", content: buildCopyPrompt(project, options.reference ?? "", sceneId) }
          ],
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
          temperature: options.reference?.trim() ? 0.6 : 0.25,
          max_tokens: 5000
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`DeepSeek 文案生成失败（HTTP ${response.status}）`);
      const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = result.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("DeepSeek 未返回文案，请重试");
      try {
        const generated = applyGeneratedCopy(project, JSON.parse(content) as unknown, sceneId);
        return {
          ...generated,
          copyGeneration: {
            provider: "deepseek",
            model: configuration.model,
            generatedAt: new Date().toISOString(),
            sceneCount: generated.scenes.filter((scene) => scene.section !== "cover").length
          }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("真实性护栏拦截") && attempt === 0) {
          lastError = error instanceof Error ? error : new Error(message);
          continue; // retry once with the same strict facts
        }
        throw error;
      }
    }
    throw lastError ?? new Error("DeepSeek 文案生成失败，请重试");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("DeepSeek 文案生成超时，请重试");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
