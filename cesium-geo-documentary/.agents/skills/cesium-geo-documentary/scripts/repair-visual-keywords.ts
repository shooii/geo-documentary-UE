#!/usr/bin/env tsx
/**
 * Repair placement keywords that no longer occur in the narration of the scene
 * they anchor to.
 *
 * A placement's `requiredKeywords` is the claim "the sentence that shows this
 * photo contains this text". Two ordinary authoring moves break that claim
 * without deleting anything: renaming a child unit (the Studio now carries the
 * keywords across — this tool repairs the damage done before that fix) and
 * hand-rewriting the narration so the unit's formal name no longer appears
 * ("那澳村" -> "那澳"). The composer never fails on a stale keyword, it keeps the
 * declared cue and prints a VISUAL_WARNING, so the drift survives unnoticed for
 * months.
 *
 * For every drifted keyword the tool looks for a replacement that *is* present in
 * that scene's narration, preferring the scene's current child name, then its
 * title, then the longest prefix of either ("卜立村" -> "卜立"). A replacement is
 * rejected when some *other* scene's narration contains it, because that would
 * re-anchor the photo to the wrong sentence — the one genuinely harmful outcome.
 *
 * Dry-run by default. `--apply` writes each repaired project back through the
 * Studio API, which creates a new revision snapshot.
 *
 *   tsx repair-visual-keywords.ts                      # dry-run, every project
 *   tsx repair-visual-keywords.ts --project id --apply
 *   tsx repair-visual-keywords.ts --all --apply
 */

import { normalizeAnchorText } from "../../../../packages/content-engine/visual-anchoring.js";

interface Placement { requiredKeywords?: string[] }
interface Scene { id: string; title?: string; childName?: string; narration?: string; placements?: Placement[] }
interface Project { id: string; name?: string; revision?: number; scenes?: Scene[] }
interface ProjectSummary { id: string; name?: string; revision?: number }

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const apply = argv.includes("--apply");
const all = argv.includes("--all");
const only = flag("project");
const base = (flag("base") ?? process.env.STUDIO_BASE ?? "http://127.0.0.1:4180").replace(/\/$/, "");

if (!only && !all) {
  process.stdout.write("Dry-run over every project. Pass --project <id> or --all together with --apply to write.\n");
}

const normal = normalizeAnchorText;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

/** Candidate replacements for one keyword, best first. */
function candidates(scene: Scene, otherNarrations: readonly string[]): string[] {
  const own = normal(scene.narration);
  const taken = (value: string) => {
    const needle = normal(value);
    return !needle || !own.includes(needle) || otherNarrations.some((text) => text.includes(needle));
  };
  const ordered: string[] = [];
  const push = (value: string | undefined) => {
    const trimmed = String(value ?? "").trim();
    if (trimmed && !ordered.includes(trimmed) && !taken(trimmed)) ordered.push(trimmed);
  };
  const childName = String(scene.childName ?? "").trim();
  const title = String(scene.title ?? "").trim();
  push(childName);
  push(title);
  // Progressive right-truncation: "卜立村" -> "卜立", "那澳村" -> "那澳".
  // Covers the very common case of a narration that drops the 村/社区/工区 suffix.
  for (const source of [childName, title]) {
    for (let length = source.length - 1; length >= 2; length -= 1) push(source.slice(0, length));
  }
  return ordered;
}

function planProject(project: Project) {
  const scenes = project.scenes ?? [];
  const narrations = scenes.map((scene) => normal(scene.narration));
  const repairs: Array<{ sceneId: string; sceneTitle: string; from: string; to: string; placements: number }> = [];
  const unrepairable: Array<{ sceneId: string; sceneTitle: string; keyword: string; placements: number }> = [];

  for (const [index, scene] of scenes.entries()) {
    const own = narrations[index] ?? "";
    const others = narrations.filter((_, other) => other !== index);
    const counts = new Map<string, number>();
    for (const placement of scene.placements ?? []) {
      for (const keyword of placement.requiredKeywords ?? []) {
        if (!normal(keyword)) continue;
        counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
      }
    }
    for (const [keyword, placements] of counts) {
      if (own.includes(normal(keyword))) continue;
      const replacement = candidates(scene, others)[0];
      const row = { sceneId: scene.id, sceneTitle: scene.title ?? scene.childName ?? scene.id, from: keyword, placements };
      if (replacement) repairs.push({ ...row, to: replacement });
      else unrepairable.push({ ...row, keyword });
    }
  }
  return { repairs, unrepairable };
}

function applyPlan(project: Project, repairs: ReturnType<typeof planProject>["repairs"]): number {
  const byScene = new Map<string, typeof repairs>();
  for (const repair of repairs) byScene.set(repair.sceneId, [...(byScene.get(repair.sceneId) ?? []), repair]);
  let changed = 0;
  for (const scene of project.scenes ?? []) {
    const sceneRepairs = byScene.get(scene.id);
    if (!sceneRepairs) continue;
    const mapping = new Map(sceneRepairs.map((repair) => [repair.from, repair.to]));
    for (const placement of scene.placements ?? []) {
      const keywords = placement.requiredKeywords;
      if (!Array.isArray(keywords)) continue;
      const next = keywords.map((keyword) => mapping.get(keyword) ?? keyword);
      if (next.some((keyword, index) => keyword !== keywords[index])) { placement.requiredKeywords = next; changed += 1; }
    }
  }
  return changed;
}

const list = await api<ProjectSummary[] | { projects?: ProjectSummary[] }>("/api/projects");
const projects = Array.isArray(list) ? list : list.projects ?? [];
const targets = only ? projects.filter((item) => item.id === only) : projects;
if (!targets.length) throw new Error(`No project matched (${projects.length} known)`);

let totalRepairs = 0;
let totalUnrepairable = 0;
let totalApplied = 0;

for (const summary of targets) {
  const project = await api<Project>(`/api/projects/${summary.id}`);
  const { repairs, unrepairable } = planProject(project);
  totalUnrepairable += unrepairable.length;
  if (!repairs.length && !unrepairable.length) continue;
  totalRepairs += repairs.length;
  process.stdout.write(`\n=== ${project.id} ${project.name ?? ""} rev${project.revision ?? summary.revision ?? "?"} — ${repairs.length} repairable, ${unrepairable.length} unresolved\n`);
  for (const repair of repairs) {
    process.stdout.write(`  ${repair.sceneId} [${repair.sceneTitle}] "${repair.from}" -> "${repair.to}"  (${repair.placements} 处)\n`);
  }
  for (const stuck of unrepairable) {
    process.stdout.write(`  ${stuck.sceneId} [${stuck.sceneTitle}] "${stuck.keyword}" 无法自动替换：本场景旁白里找不到该单元名的任何形式  (${stuck.placements} 处)\n`);
  }
  if (!apply || !repairs.length) continue;
  const changed = applyPlan(project, repairs);
  await api(`/api/projects/${project.id}`, { method: "PUT", body: JSON.stringify(project) });
  totalApplied += changed;
  process.stdout.write(`  -> 已提交，${changed} 个 placement 的关键字已更新\n`);
}

process.stdout.write(`\nrepairable ${totalRepairs} · unresolved ${totalUnrepairable}${apply ? ` · placements rewritten ${totalApplied}` : " · 未写入（加 --apply 生效）"}\n`);
process.exit(totalUnrepairable ? 1 : 0);
