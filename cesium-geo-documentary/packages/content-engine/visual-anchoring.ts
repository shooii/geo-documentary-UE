/**
 * One definition of "does this placement keyword actually occur in the narration
 * it is supposed to anchor to".
 *
 * The compositor uses it to re-anchor or warn about a visual; the Studio uses it
 * to tell the author about drifted keywords *before* an export. Sharing one
 * implementation is the point: the two sides disagreeing is exactly how
 * `西连村` survived 79 placements after the unit had been renamed to `西连社区`,
 * and how `那澳村` / `雷州市盐场那沃工区(乌石镇)` survived a hand-rewritten
 * narration that no longer contains them.
 *
 * A keyword that is simply absent is soft: the composer keeps the declared cue
 * and prints a warning. A keyword that turns up in a *different* scene is worse —
 * the composer re-anchors the photo to that scene's cue, moving it out of the
 * scene the author bound it to.
 */

export interface AnchorPlacement {
  requiredKeywords?: string[];
}

export interface AnchorScene {
  id: string;
  title?: string;
  narration?: string;
  placements?: AnchorPlacement[];
}

export interface VisualAnchorIssue {
  sceneId: string;
  sceneTitle: string;
  keyword: string;
  /** How many placements in this scene carry the keyword. */
  placementCount: number;
  reason: "absent-from-scene" | "matches-another-scene";
  /** Scenes whose narration does contain the keyword. */
  otherSceneIds: string[];
}

/**
 * Folding for keyword/cue comparison: Unicode-compatibility normalise, drop
 * everything that is not a letter or a digit, and lower-case. Punctuation and
 * spacing differences must never decide whether a photo finds its sentence.
 */
export function normalizeAnchorText(value: string | null | undefined): string {
  return String(value ?? "").normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

export function findVisualAnchorIssues(scenes: readonly AnchorScene[]): VisualAnchorIssue[] {
  const narrationByScene = new Map(scenes.map((scene) => [scene.id, normalizeAnchorText(scene.narration)]));
  const issues: VisualAnchorIssue[] = [];
  for (const scene of scenes) {
    const ownNarration = narrationByScene.get(scene.id) ?? "";
    const placementCounts = new Map<string, number>();
    for (const placement of scene.placements ?? []) {
      for (const keyword of placement.requiredKeywords ?? []) {
        if (!normalizeAnchorText(keyword)) continue;
        placementCounts.set(keyword, (placementCounts.get(keyword) ?? 0) + 1);
      }
    }
    for (const [keyword, placementCount] of placementCounts) {
      const needle = normalizeAnchorText(keyword);
      if (ownNarration.includes(needle)) continue;
      const otherSceneIds = scenes
        .filter((other) => other.id !== scene.id && (narrationByScene.get(other.id) ?? "").includes(needle))
        .map((other) => other.id);
      issues.push({
        sceneId: scene.id,
        sceneTitle: scene.title ?? scene.id,
        keyword,
        placementCount,
        reason: otherSceneIds.length ? "matches-another-scene" : "absent-from-scene",
        otherSceneIds
      });
    }
  }
  return issues;
}
