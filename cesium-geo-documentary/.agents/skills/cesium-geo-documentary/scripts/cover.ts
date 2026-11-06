import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import sharp from "sharp";

interface RegionRecord {
  id?: string;
  name?: string;
  title?: string;
  parentId?: string;
  labelPoint?: [number, number];
  center?: [number, number];
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
  locator: { longitude: number; latitude: number } | null;
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
const DEFAULT_EDITORIAL_TAG = "地理乡土情";
const DEFAULT_CONTENT_META = "地理 · 人文 · 时代";
const DEFAULT_COVER_INTRO_SECONDS = 1.6;

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function stripBrandPrefix(value: string | undefined): string {
  return (value ?? "").replace(/^(?:地理乡土情|地理图说)\s*[·・路]\s*/, "").trim();
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
  const hierarchicalTitle = `地理乡土情·${topic}`;
  const derivedPath = chain.slice(0, -1).map((record) => record.name?.trim()).filter((value): value is string => Boolean(value)).join(" · ");
  const coverImagePath = merged.coverImagePath
    ?? `renders/final/covers/${safeFileStem(hierarchicalTitle)}-cover.png`;
  return {
    regionId,
    topic,
    hierarchicalTitle,
    regionPath: (merged.regionPath ?? (derivedPath || "世界")).trim(),
    subtitle: (merged.subtitle ?? DEFAULT_SUBTITLE).trim(),
    editorialTag: (merged.editorialTag ?? DEFAULT_EDITORIAL_TAG).trim(),
    contentMeta: (merged.contentMeta ?? DEFAULT_CONTENT_META).trim(),
    seriesIndex: (merged.seriesIndex ?? "01").trim().padStart(2, "0"),
    issue: (merged.issue ?? "地理乡土情").trim(),
    footerLabel: (merged.footerLabel ?? topic).trim(),
    locator: current.labelPoint || current.center
      ? { longitude: (current.labelPoint ?? current.center)![0], latitude: (current.labelPoint ?? current.center)![1] }
      : null,
    coverImagePath,
    coverIntroSeconds: normalizeIntroSeconds(merged.coverIntroSeconds),
    manifestPath: manifest ? requestedManifestPath : null
  };
}

function projectGlobeLocator(locator: CoverDefinition["locator"]): { x: number; y: number } | null {
  if (!locator) return null;
  const radians = Math.PI / 180;
  const longitude = locator.longitude * radians;
  const latitude = locator.latitude * radians;
  const centerLongitude = 103 * radians;
  const centerLatitude = 29 * radians;
  const deltaLongitude = longitude - centerLongitude;
  const visibility = Math.sin(centerLatitude) * Math.sin(latitude)
    + Math.cos(centerLatitude) * Math.cos(latitude) * Math.cos(deltaLongitude);
  if (visibility <= 0.08) return null;
  const radius = 372;
  const x = 552 + radius * Math.cos(latitude) * Math.sin(deltaLongitude);
  const y = 797 - radius * (
    Math.cos(centerLatitude) * Math.sin(latitude)
    - Math.sin(centerLatitude) * Math.cos(latitude) * Math.cos(deltaLongitude)
  );
  if (x < 190 || x > 930 || y < 420 || y > 1175) return null;
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
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

function coverOverlaySvg(definition: CoverDefinition, tokens: DesignTokens, logoDataUrl: string): string {
  const colors = {
    canvas: tokens.colors?.canvas ?? "#04101D",
    textPrimary: tokens.colors?.textPrimary ?? "#FFF8EA",
    textSecondary: tokens.colors?.textSecondary ?? "#EAD7B4",
    accent: tokens.colors?.textAccent ?? "#E9B96E"
  };
  const topicLines = splitByCharacters(definition.topic, 9).slice(0, 2);
  const longestTopic = Math.max(...topicLines.map((line) => [...line].length));
  const topicFontSize = longestTopic <= 7 ? 108 : longestTopic <= 9 ? 94 : 82;
  const topicLineHeight = topicFontSize * 1.08;
  const topicStartY = topicLines.length === 1 ? 1425 : 1368;
  const subtitleLines = splitByCharacters(definition.subtitle, 20).slice(0, 2);
  const subtitleStartY = topicLines.length === 1 ? 1503 : topicStartY + topicLines.length * topicLineHeight + 24;
  const dividerY = Math.min(1575, subtitleStartY + subtitleLines.length * 43 + 24);
  const metaY = dividerY + 61;
  const topicText = topicLines.map((line, index) => `<tspan x="540" y="${(topicStartY + index * topicLineHeight).toFixed(0)}">${escapeXml(line)}</tspan>`).join("");
  const subtitleText = subtitleLines.map((line, index) => `<tspan x="540" y="${subtitleStartY + index * 43}">${escapeXml(line)}</tspan>`).join("");
  const locator = projectGlobeLocator(definition.locator);
  const locatorMarkup = locator ? `
  <g filter="url(#locatorGlow)">
    <circle cx="${locator.x}" cy="${locator.y}" r="19" fill="#071521" fill-opacity=".78" stroke="#F4C675" stroke-width="4"/>
    <circle cx="${locator.x}" cy="${locator.y}" r="6" fill="#FFD784"/>
  </g>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <defs>
    <linearGradient id="titleGold" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#FFF9EE"/><stop offset=".42" stop-color="#FFF4DF"/><stop offset="1" stop-color="#E8B867"/>
    </linearGradient>
    <linearGradient id="cardFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#061523" stop-opacity=".70"/><stop offset="1" stop-color="#020B14" stop-opacity=".82"/>
    </linearGradient>
    <linearGradient id="cardStroke" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#F7D697"/><stop offset=".52" stop-color="#C78738"/><stop offset="1" stop-color="#F0C983"/>
    </linearGradient>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="5" result="blur"/><feOffset dy="4" result="offset"/>
      <feColorMatrix in="offset" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 .48 0"/>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="locatorGlow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="1.8" result="glow"/><feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <clipPath id="logoClip"><circle cx="112" cy="111" r="54"/></clipPath>
  </defs>
  <rect width="1080" height="1920" fill="${colors.canvas}" fill-opacity=".05"/>

  <g filter="url(#softShadow)">
    <circle cx="112" cy="111" r="57" fill="#061626" fill-opacity=".88" stroke="#E6B767" stroke-width="2.2"/>
    <image href="${logoDataUrl}" x="58" y="57" width="108" height="108" preserveAspectRatio="xMidYMid slice" clip-path="url(#logoClip)"/>
    <text x="192" y="125" fill="url(#titleGold)" font-family="STZhongsong, Source Han Serif SC, Noto Serif CJK SC, SimSun, serif" font-size="54" font-weight="600" letter-spacing="9">地理乡土情</text>
    <line x1="193" y1="153" x2="328" y2="153" stroke="#C78A3D" stroke-width="2"/>
  </g>
  ${locatorMarkup}

  <rect x="66" y="1248" width="948" height="420" rx="30" fill="url(#cardFill)" stroke="url(#cardStroke)" stroke-width="1.6"/>
  <rect x="79" y="1261" width="922" height="394" rx="23" fill="none" stroke="#E9C17B" stroke-opacity=".18" stroke-width="1"/>
  <text text-anchor="middle" fill="url(#titleGold)" font-family="STZhongsong, Source Han Serif SC, Noto Serif CJK SC, SimSun, serif" font-size="${topicFontSize}" font-weight="700" letter-spacing="4" filter="url(#softShadow)">${topicText}</text>
  <text text-anchor="middle" fill="${colors.textSecondary}" font-family="STZhongsong, Source Han Serif SC, Noto Serif CJK SC, SimSun, serif" font-size="34" font-weight="400" letter-spacing="5">${subtitleText}</text>
  <line x1="347" y1="${dividerY}" x2="494" y2="${dividerY}" stroke="#B97A32" stroke-width="1.6"/>
  <path d="M540 ${dividerY - 10} L546 ${dividerY - 2} L556 ${dividerY} L546 ${dividerY + 2} L540 ${dividerY + 10} L534 ${dividerY + 2} L524 ${dividerY} L534 ${dividerY - 2} Z" fill="#F1C77E"/>
  <line x1="586" y1="${dividerY}" x2="733" y2="${dividerY}" stroke="#B97A32" stroke-width="1.6"/>
  <text x="540" y="${metaY}" text-anchor="middle" fill="#E8CAA0" font-family="Microsoft YaHei, Source Han Sans SC, Noto Sans CJK SC, sans-serif" font-size="27" font-weight="500" letter-spacing="12">${escapeXml(definition.contentMeta)}</text>
</svg>`;
}

export async function generateCoverAsset(root: string, definition: CoverDefinition, outputOverride?: string): Promise<string> {
  const outputPath = resolve(root, outputOverride ?? definition.coverImagePath);
  const backgroundPath = resolve(root, "design/generated/midnight-globe-cover-background.png");
  const logoPath = resolve(root, "design/generated/midnight-globe-emblem.png");
  const [tokens, logoPng] = await Promise.all([
    readJsonIfExists<DesignTokens>(resolve(root, "design/tokens.json")),
    readFile(logoPath)
  ]);
  const logoDataUrl = `data:image/png;base64,${logoPng.toString("base64")}`;
  const overlay = coverOverlaySvg(definition, tokens ?? {}, logoDataUrl);
  await mkdir(dirname(outputPath), { recursive: true });
  await sharp(backgroundPath)
    .resize(1080, 1920, { fit: "cover", position: "centre" })
    .composite([{ input: Buffer.from(overlay), left: 0, top: 0 }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outputPath);
  await writeFile(`${outputPath}.json`, JSON.stringify({
    ...definition,
    coverImagePath: outputPath,
    width: 1080,
    height: 1920,
    referenceAsset: "design/references/midnight-globe-cover-reference.png",
    backgroundAsset: "design/generated/midnight-globe-cover-background.png",
    logoAsset: "design/generated/midnight-globe-emblem.png",
    languagePolicy: "Chinese-only visible typography; no hierarchy path, English labels, or aspect-ratio badges"
  }, null, 2), "utf8");
  return outputPath;
}
