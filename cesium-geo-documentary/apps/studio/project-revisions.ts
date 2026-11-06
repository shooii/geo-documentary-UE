/**
 * Retention for the immutable per-save snapshots in `workspace/projects`.
 *
 * Every save writes a brand-new `<project>.v000000.json` and nothing ever
 * removed one: this workspace had reached 1415 files / 457 MB, with a single
 * scheme holding 514 revisions. Nothing in the Studio reads an older revision —
 * `readProject` opens the newest one, the scheme list shows the newest one per
 * project, and the editor only uses the revision number as a cache-busting
 * token for the cover preview and the narration audio. The history exists to be
 * safe, not to be browsed.
 *
 * The policy therefore keeps both shapes that safety actually needs: the most
 * recent saves, and the newest save of each of the last few days, so one
 * intensive afternoon cannot evict the only copy of where the project stood
 * yesterday.
 */
/**
 * Whether two snapshots of the same scheme carry the same content, ignoring the
 * two fields every save rewrites (`revision`, `updatedAt`).
 *
 * Used to refuse to mint a revision for a no-op save. That is not just tidiness:
 * every extra snapshot counts against the sandbox's per-turn safe-delete budget
 * when the scheme is later deleted, and a pointless revision bump is what made an
 * operator's exported spreadsheet expire -- revision 28 and 29 on this machine
 * were byte-identical files, so a sheet exported between them was refused on
 * import for no reason at all.
 *
 * Compared through JSON so that a key-order difference reports "not equal": a
 * false negative only means a revision gets written as before, while a false
 * positive would silently drop a real save.
 */
export function sameProjectContent(a: object, b: object): boolean {
  const comparable = (value: object): string => {
    const rest: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    delete rest.revision;
    delete rest.updatedAt;
    return JSON.stringify(rest);
  };
  return comparable(a) === comparable(b);
}

export interface ProjectRevisionEntry {
  /** File name inside `workspace/projects`. */
  name: string;
  /** Revision parsed from the `.v<revision>.json` suffix. */
  revision: number;
  /** File modification time, which anchors the daily archive point. */
  mtimeMs: number;
}

export interface ProjectRevisionRetention {
  /** How many of the newest revisions to keep unconditionally. */
  keepRecent?: number;
  /** How many days of daily archive points to keep. */
  keepDays?: number;
  /** Clock override in epoch milliseconds, so the policy is testable. */
  now?: number;
}

/**
 * How many newest revisions to keep unconditionally.
 *
 * This is a *budget*, not a quality preference: deleting a scheme removes every
 * one of its snapshots plus its boundary directory (a dozen mirrored data
 * files), and the sandbox's safe-delete guard counts each file against a
 * per-turn ceiling (50 here). A scheme that keeps `keepRecent +
 * PROJECT_REVISION_PRUNE_INTERVAL` snapshots can therefore cross that ceiling
 * on its own and make "delete scheme" impossible to complete.
 *
 * 20 recent + the 25-save interval ceiling lands at 45 snapshots, which with a
 * dozen boundary files stays under 50 even in one turn. Deletion safety is the
 * binding constraint; 20 saves of undo history is still far more than the
 * editor ever reads.
 */
/**
 * Order a directory listing so one scheme's newest snapshot comes first.
 *
 * Snapshot names carry the revision they hold (`<id>.v000123.json`), which is the
 * order saving wrote them in, so the current state of a scheme is knowable without
 * opening a single file. Everything that wants "the scheme as it is now" reads the
 * first entry and only walks back when that one turns out to be unreadable.
 *
 * Both the scheme list and the by-id read used to parse EVERY revision of every
 * scheme instead: the busiest scheme here had 315 snapshots of ~370 KB, so opening
 * it parsed ~115 MB of JSON on the event loop (1418 ms measured, on a warm cache)
 * with every other request queued behind it -- the editor simply looked frozen.
 *
 * Revisions are compared as NUMBERS: `v10` sorts before `v9` as text, and a
 * lexicographic "newest" would hand back a two-hundred-revision-old snapshot.
 * A `<id>.json` from an older layout carries no revision at all and goes last.
 */
export function orderProjectSnapshots(names: readonly string[], projectId: string): string[] {
  const prefix = `${projectId}.v`;
  const numbered = names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => ({ name, revision: Number(name.slice(prefix.length, -".json".length)) }))
    .filter((entry) => Number.isFinite(entry.revision))
    .sort((a, b) => b.revision - a.revision)
    .map((entry) => entry.name);
  const plain = names.includes(`${projectId}.json`) ? [`${projectId}.json`] : [];
  return [...numbered, ...plain];
}

export const PROJECT_REVISION_KEEP_RECENT = 20;
export const PROJECT_REVISION_KEEP_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** Which snapshot files the policy no longer needs. Pure: no filesystem, no clock. */
export function selectProjectRevisionsToPrune(entries: ProjectRevisionEntry[], retention: ProjectRevisionRetention = {}): string[] {
  const keepRecent = Math.max(1, Math.floor(retention.keepRecent ?? PROJECT_REVISION_KEEP_RECENT));
  const keepDays = Math.max(0, Math.floor(retention.keepDays ?? PROJECT_REVISION_KEEP_DAYS));
  const now = retention.now ?? Date.now();
  const keep = new Set<string>();
  const newest = [...entries].sort((a, b) => b.revision - a.revision).slice(0, keepRecent);
  for (const entry of newest) keep.add(entry.name);

  // Exclusive at the far edge, so `keepDays` really means "keep one snapshot
  // per day for the last N days" rather than N+1 when a file lands exactly on
  // the boundary.
  const windowStart = now - keepDays * DAY_MS;
  const newestOfDay = new Map<string, ProjectRevisionEntry>();
  for (const entry of entries) {
    if (entry.mtimeMs <= windowStart) continue;
    const day = dayKey(entry.mtimeMs);
    const current = newestOfDay.get(day);
    if (!current || entry.revision > current.revision) newestOfDay.set(day, entry);
  }
  for (const entry of newestOfDay.values()) keep.add(entry.name);

  return entries.filter((entry) => !keep.has(entry.name)).map((entry) => entry.name);
}
