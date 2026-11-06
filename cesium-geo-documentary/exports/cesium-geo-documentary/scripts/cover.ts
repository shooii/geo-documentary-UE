import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import sharp from "sharp";

interface RegionRecord {
  id?: string;
  name?: string;
  title?: string;
  parentId?: string;
  cover?: Partial<CoverManifest>;
}

interface RegionContent {
  name?: string;
  title?: string;
}

export interface CoverManifest {
  topic?: string;
  regionPath?: string;
  subtitle?: string;
  editorialTag?: string;
  contentMeta?: string;
  seriesIndex?: string;
  issue?: string;
  footerLabel?: string;
  coverImagePath?: string;
  coverIntroSeconds?: number;
}

export interface CoverOverrides extends CoverManifest {
  manifestPath?: string;
}

export interface CoverDefinition {
  regionId: string;
  topic: string;
  hierarchicalTitle: string;
  regionPath: string;
  subtitle: string;
  editorialTag: string;
  contentMeta: string;
  seriesIndex: string;
  issue: string;
  footerLabel: string;
  coverImagePath: string;
  coverIntroSeconds: number;
  manifestPath: string | null;
}

interface DesignTokens {
  colors?: {
    canvas?: string;
    surface?: string;
    textPrimary?: string;
    textSecondary?: string;
    textAccent?: string;
    boundaryParent?: string;
    boundaryChild?: string;
  };
}

const DEFAULT_SUBTITLE = "看见边界，也看见土地上的生活";
const DEFAULT_EDITORIAL_TAG = "GEOGRAPHY · PEOPLE · TIME";
const DEFAULT_CONTENT_META = "地理 · 人文 · 时代";
const DEFAULT_COVER_INTRO_SECONDS = 1.9;

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function stripBrandPrefix(value: string | undefined): string {
  return (value ?? "").replace(/^地理图说\s*[·・路]\s*/, "").trim();
}

function safeFileStem(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").replace(/\s+/g, " ").trim();
}

function mergeDefined<T extends object>(...records: Array<Partial<T> | null | undefined>): Partial<T> {
  const merged: Partial<T> = {};
  for (const record of records) {
    if (!record) continue;
    for (const [key, value] of Object.entries(record) as Array<[keyof T, T[keyof T] | undefined]>) {
      if (value !== undefined && value !== null && value !== "") merged[key] = value;
    }
  }
  return merged;
}

async function loadRegionChain(root: string, regionId: string): Promise<RegionRecord[]> {
  const chain: RegionRecord[] = [];
  const visited = new Set<string>();
  let currentId: string | undefined = regionId;
  while (currentId && !visited.has(currentId) && chain.length < 12) {
    visited.add(currentId);
    const recordPath = resolve(root, `data/regions/${currentId}.json`);
    const record = await readJsonIfExists<RegionRecord>(recordPath);
    if (!record) break;
    chain.push({ ...record, id: record.id ?? currentId });
    currentId = record.parentId;
  }
  return chain.reverse();
}

function inferTopic(chain: RegionRecord[], current: RegionRecord, content: RegionContent | undefined): string {
  const name = (current.name ?? content?.name ?? current.id ?? "地区").trim();
  const titleTopic = stripBrandPrefix(current.title ?? content?.title);
  if (titleTopic && titleTopic !== name && titleTopic.includes(name)) return titleTopic;
  const parent = chain.at(-2);
  const parentName = parent?.name?.trim() ?? "";
  if (parentName && !name.startsWith(parentName)) return `${parentName}${name}`;
  return titleTopic || name;
}

function normalizeIntroSeconds(value: number | undefined): number {
  const seconds = Number(value ?? DEFAULT_COVER_INTRO_SECONDS);
  if (!Number.isFinite(seconds) || seconds < 0.25 || seconds > 10) {
    throw new Error(`coverIntroSeconds must be between 0.25 and 10 seconds; received ${String(value)}`);
  }
  return Math.round(seconds * 1000) / 1000;
}

export async function resolveCoverDefinition(root: string, regionId: string, overrides: CoverOverrides = {}): Promise<CoverDefinition> {
  const contentIndex = await readJsonIfExists<Record<string, RegionContent>>(resolve(root, "content/regions.zh-CN.json"));
  const chain = await loadRegionChain(root, regionId);
  const current = chain.at(-1);
  if (!current) throw new Error(`Missing region metadata data/regions/${regionId}.json`);
  const defaultManifestPath = resolve(root, `content/covers/${regionId}.json`);
  const requestedManifestPath = overrides.manifestPath ? resolve(root, overrides.manifestPath) : defaultManifestPath;
  const manifest = await readJsonIfExists<CoverManifest>(requestedManifestPath);
  const merged = mergeDefined<CoverManifest>(current.cover, manifest, overrides);
  const topic = (merged.topic ?? inferTopic(chain, current, contentIndex?.[regionId])).trim();
  const hierarchicalTitle = `地理图说·${topic}`;
  const derivedPath = chain.slice(0, -1).map((record) => record.name?.trim()).filter((value): value is string => Boolean(value)).join(" · ");
  const coverImagePath = merged.coverImagePath
    ?? `renders/final/covers/${safeFileStem(hierarchicalTitle)}-cover.png`;
  return {
    regionId,
    topic,
    hierarchicalTitle,
    regionPath: (merged.regionPath ?? (derivedPath || "WORLD TO LOCAL")).trim(),
    subtitle: (merged.subtitle ?? DEFAULT_SUBTITLE).trim(),
    editorialTag: (merged.editorialTag ?? DEFAULT_EDITORIAL_TAG).trim(),
    contentMeta: (merged.contentMeta ?? DEFAULT_CONTENT_META).trim(),
    seriesIndex: (merged.seriesIndex ?? "01").trim().padStart(2, "0"),
    issue: (merged.issue ?? "ISSUE 001 / GEO STORY").trim(),
    footerLabel: (merged.footerLabel ?? topic).trim(),
    coverImagePath,
    coverIntroSeconds: normalizeIntroSeconds(merged.coverIntroSeconds),
    manifestPath: manifest ? requestedManifestPath : null
  };
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function splitByCharacters(value: string, maximum: number): string[] {
  const characters = [...value];
  if (characters.length <= maximum) return [value];
  const lineCount = Math.ceil(characters.length / maximum);
  const target = Math.ceil(characters.length / lineCount);
  return Array.from({ length: lineCount }, (_, index) => characters.slice(index * target, (index + 1) * target).join("")).filter(Boolean);
}

function textLength(value: string): number {
  return [...value].reduce((sum, character) => sum + (/^[\u0000-\u00ff]$/.test(character) ? 0.56 : 1), 0);
}

function coverSvg(definition: CoverDefinition, tokens: DesignTokens, logoDataUrl: string): string {
  const colors = {
    canvas: tokens.colors?.canvas ?? "#06101A",
    surface: tokens.colors?.surface ?? "#111B24",
    textPrimary: tokens.colors?.textPrimary ?? "#F5F8FA",
    textSecondary: tokens.colors?.textSecondary ?? "#B8C5CE",
    accent: tokens.colors?.textAccent ?? "#FFD166",
    turquoise: "#67D5D1",
    boundaryParent: tokens.colors?.boundaryParent ?? "#8B1E1E",
    boundaryChild: tokens.colors?.boundaryChild ?? "#E8F0F5"
  };
  const pathWidth = Math.min(940, Math.max(370, 126 + textLength(definition.regionPath) * 28));
  const topicLines = splitByCharacters(definition.topic, 10).slice(0, 2);
  const longestTopic = Math.max(...topicLines.map((line) => [...line].length));
  const topicFontSize = longestTopic <= 7 ? 98 : longestTopic <= 9 ? 84 : 72;
  const topicLineHeight = topicFontSize * 1.12;
  const subtitleLines = splitByCharacters(definition.subtitle, 22).slice(0, 2);
  const topicStartY = topicLines.length === 1 ? 1377 : 1328;
  const subtitleStartY = topicLines.length === 1 ? 1442 : topicStartY + topicLines.length * topicLineHeight + 28;
  const metaY = Math.min(1500, subtitleStartY + subtitleLines.length * 46 + 20);
  const topicText = topicLines.map((line, index) => `<tspan x="100" y="${(topicStartY + index * topicLineHeight).toFixed(0)}">${escapeXml(line)}</tspan>`).join("");
  const subtitleText = subtitleLines.map((line, index) => `<tspan x="100" y="${subtitleStartY + index * 46}">${escapeXml(line)}</tspan>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <defs>
    <radialGradient id="cyanGlow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${colors.turquoise}" stop-opacity=".95"/><stop offset=".46" stop-color="${colors.turquoise}" stop-opacity=".46"/><stop offset="1" stop-color="${colors.turquoise}" stop-opacity="0"/></radialGradient>
    <radialGradient id="goldGlow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${colors.accent}" stop-opacity=".94"/><stop offset=".5" stop-color="${colors.accent}" stop-opacity=".42"/><stop offset="1" stop-color="${colors.accent}" stop-opacity="0"/></radialGradient>
    <linearGradient id="cardFill" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${colors.canvas}" stop-opacity=".94"/><stop offset=".48" stop-color="${colors.canvas}" stop-opacity=".84"/><stop offset="1" stop-color="${colors.canvas}" stop-opacity=".94"/></linearGradient>
    <clipPath id="globeClip"><circle cx="640" cy="746" r="360"/></clipPath>
  </defs>
  <rect width="1080" height="1920" fill="${colors.canvas}"/>
  <ellipse cx="850" cy="408" rx="520" ry="430" fill="url(#cyanGlow)"/>
  <ellipse cx="42" cy="1595" rx="340" ry="430" fill="url(#goldGlow)"/>

  <image href="${logoDataUrl}" x="60" y="70" width="72" height="72" preserveAspectRatio="xMidYMid meet"/>
  <text x="154" y="105" fill="${colors.textPrimary}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="40" font-weight="700" letter-spacing="4">地理图说</text>
  <text x="155" y="132" fill="${colors.accent}" font-family="Arial, sans-serif" font-size="12" font-weight="700" letter-spacing="3.2">GEOGRAPHY · PEOPLE · PLACE</text>
  <text x="805" y="101" fill="${colors.accent}" font-family="Arial, sans-serif" font-size="16" font-weight="700" letter-spacing="3">PORTRAIT / 9:16</text>

  <rect x="60" y="209" width="${pathWidth.toFixed(0)}" height="54" rx="22" fill="${colors.canvas}" fill-opacity=".82" stroke="${colors.turquoise}" stroke-width="1.5"/>
  <text x="81" y="245" fill="${colors.textPrimary}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="24" font-weight="500" letter-spacing="1.2">层级路径 · ${escapeXml(definition.regionPath)}</text>

  <g clip-path="url(#globeClip)" opacity=".98">
    <circle cx="640" cy="746" r="360" fill="${colors.canvas}" fill-opacity=".86" stroke="${colors.turquoise}" stroke-width="10"/>
    <ellipse cx="640" cy="746" rx="285" ry="360" fill="none" stroke="${colors.turquoise}" stroke-width="4"/>
    <ellipse cx="640" cy="746" rx="154" ry="360" fill="none" stroke="${colors.boundaryChild}" stroke-width="5"/>
    <path d="M275 598 Q640 792 1002 596" fill="none" stroke="${colors.boundaryChild}" stroke-width="5" stroke-linecap="round"/>
    <path d="M278 789 Q640 684 1006 792" fill="none" stroke="${colors.boundaryChild}" stroke-width="5" stroke-linecap="round"/>
    <path d="M289 856 Q640 735 996 858" fill="none" stroke="${colors.turquoise}" stroke-width="8" stroke-linecap="round"/>
    <path d="M342 1003 Q532 879 770 1007" fill="none" stroke="${colors.turquoise}" stroke-width="4" stroke-linecap="round"/>
    <path d="M378 1055 Q548 949 730 1063" fill="none" stroke="${colors.turquoise}" stroke-width="4" stroke-linecap="round"/>
    <path d="M430 1102 Q548 1018 670 1107" fill="none" stroke="${colors.boundaryChild}" stroke-width="4" stroke-linecap="round"/>
  </g>
  <path d="M235 1009 Q642 676 1042 806" fill="none" stroke="${colors.accent}" stroke-width="3" stroke-linecap="round"/>
  <path d="M214 971 Q542 735 867 753" fill="none" stroke="${colors.boundaryParent}" stroke-opacity=".78" stroke-width="3.5" stroke-linecap="round"/>
  <circle cx="876" cy="616" r="20" fill="${colors.canvas}" stroke="${colors.accent}" stroke-width="6"/><circle cx="876" cy="616" r="8" fill="${colors.accent}"/>
  <text x="817" y="1151" fill="${colors.textSecondary}" fill-opacity=".13" font-family="Arial, sans-serif" font-size="170" font-weight="800" letter-spacing="-8">${escapeXml(definition.seriesIndex)}</text>

  <rect x="60" y="1175" width="960" height="365" rx="30" fill="url(#cardFill)" stroke="${colors.boundaryChild}" stroke-opacity=".88" stroke-width="1.2"/>
  <text x="100" y="1234" fill="${colors.accent}" font-family="Arial, sans-serif" font-size="20" font-weight="700" letter-spacing="3.5">${escapeXml(definition.editorialTag)}</text>
  <text fill="${colors.textPrimary}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${topicFontSize}" font-weight="700" letter-spacing="2">${topicText}</text>
  <text fill="${colors.textSecondary}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="34" font-weight="400" letter-spacing="1.2">${subtitleText}</text>
  <text x="100" y="${metaY}" fill="${colors.textSecondary}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="24" font-weight="500" letter-spacing="3">${escapeXml(definition.contentMeta)}</text>

  <circle cx="66" cy="1769" r="6" fill="${colors.accent}"/>
  <text x="84" y="1777" fill="${colors.textSecondary}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="20" font-weight="600" letter-spacing="1.5">地理图说 · ${escapeXml(definition.footerLabel)}</text>
  <text x="789" y="1777" fill="${colors.textSecondary}" font-family="Arial, sans-serif" font-size="16" font-weight="700" letter-spacing="2.5">${escapeXml(definition.issue)}</text>
</svg>`;
}

export async function generateCoverAsset(root: string, definition: CoverDefinition, outputOverride?: string): Promise<string> {
  const outputPath = resolve(root, outputOverride ?? definition.coverImagePath);
  const [tokens, logoPng] = await Promise.all([
    readJsonIfExists<DesignTokens>(resolve(root, "design/tokens.json")),
    readFile(resolve(root, "design/assets/geo-documentary-mark.png"))
  ]);
  const referencePath = resolve(root, "design/assets/video-cover-universal.png");
  const referenceMetadata = await sharp(referencePath).metadata();
  if (referenceMetadata.width !== 1080 || referenceMetadata.height !== 1920) {
    throw new Error(`Figma cover reference must be 1080x1920; received ${referenceMetadata.width}x${referenceMetadata.height}`);
  }
  const logoDataUrl = `data:image/png;base64,${logoPng.toString("base64")}`;
  const svg = coverSvg(definition, tokens ?? {}, logoDataUrl);
  await mkdir(dirname(outputPath), { recursive: true });
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(outputPath);
  await writeFile(`${outputPath}.json`, JSON.stringify({
    ...definition,
    coverImagePath: outputPath,
    width: 1080,
    height: 1920,
    referenceAsset: "design/assets/video-cover-universal.png",
    logoAsset: "design/assets/geo-documentary-mark.png"
  }, null, 2), "utf8");
  return outputPath;
}
