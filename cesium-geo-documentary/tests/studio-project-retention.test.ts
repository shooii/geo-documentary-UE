import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  PROJECT_REVISION_KEEP_DAYS,
  PROJECT_REVISION_KEEP_RECENT,
  orderProjectSnapshots,
  sameProjectContent,
  selectProjectRevisionsToPrune,
  type ProjectRevisionEntry
} from "../apps/studio/project-revisions.js";

const root = resolve(import.meta.dirname, "..");
const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const KEEP_RECENT = PROJECT_REVISION_KEEP_RECENT;
const KEEP_DAYS = PROJECT_REVISION_KEEP_DAYS;

function save(revision: number, ageDays: number): ProjectRevisionEntry {
  return { name: `project-x.v${String(revision).padStart(6, "0")}.json`, revision, mtimeMs: NOW - ageDays * DAY };
}

test("an unbounded day of editing collapses to the recent window", () => {
  // The real shape: one scheme had reached 514 revisions, all written today.
  const saves = Array.from({ length: 514 }, (_, index) => save(index + 1, 0));
  const pruned = selectProjectRevisionsToPrune(saves, { now: NOW });
  const kept = saves.filter((item) => !pruned.includes(item.name));
  assert.equal(kept.length, KEEP_RECENT);
  assert.equal(pruned.length, 514 - KEEP_RECENT);
  // The newest revision is what every reader opens; it must never be a candidate.
  assert.equal(pruned.includes(save(514, 0).name), false);
  assert.equal(pruned.includes(save(1, 0).name), true);
});

test("one archive point per day survives the recent window", () => {
  // One save a day for twenty days, newest first by revision. Only three fall
  // inside the recent window, but the daily archive has to cover every day of
  // the retention period — otherwise a single busy afternoon would erase where
  // the project stood last week.
  const saves = Array.from({ length: 20 }, (_, age) => save(1000 - age, age));
  const pruned = selectProjectRevisionsToPrune(saves, { keepRecent: 3, keepDays: KEEP_DAYS, now: NOW });
  const kept = saves.filter((item) => !pruned.includes(item.name));
  const oldestKeptAge = Math.max(...kept.map((item) => Math.round((NOW - item.mtimeMs) / DAY)));
  assert.equal(oldestKeptAge, KEEP_DAYS - 1, "every day inside the window keeps one snapshot");
  for (const age of [KEEP_DAYS, KEEP_DAYS + 4, 19]) {
    assert.equal(pruned.includes(save(1000 - age, age).name), true, `a ${age}-day-old unique snapshot should expire`);
  }
  assert.equal(kept.length, KEEP_DAYS, "the recent window adds nothing the daily archive does not already keep");
});

test("the newest snapshot of a busy day is the archive point", () => {
  const saves = [
    save(500, 5), save(503, 5), save(501, 5),   // five days ago: three saves, only 503 survives
    save(600, 0), save(601, 0)                  // today: only 601 survives
  ];
  const pruned = selectProjectRevisionsToPrune(saves, { keepRecent: 1, keepDays: 7, now: NOW });
  assert.deepEqual(pruned.sort(), [save(500, 5).name, save(501, 5).name, save(600, 0).name].sort());
  assert.equal(pruned.includes(save(503, 5).name), false, "the day's newest save is the archive point");
  assert.equal(pruned.includes(save(601, 0).name), false, "the overall newest save is always kept");
});

test("retention only ever removes files it can name", () => {
  const saves = [save(1, 400), save(2, 400), save(3, 0)];
  const pruned = selectProjectRevisionsToPrune(saves, { keepRecent: 1, keepDays: 1, now: NOW });
  assert.deepEqual(pruned, [save(1, 400).name, save(2, 400).name]);
});

test("saving prunes on an interval instead of on every keystroke", async () => {
  const server = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");
  // A save is on the interactive path: the scan must not run for each one.
  assert.match(server, /Number\(project\.revision\) % PROJECT_REVISION_PRUNE_INTERVAL === 0/);
  assert.match(server, /await pruneProjectRevisions\(projectId\)/);
});

/**
 * A scheme has to be *deletable*, and the sandbox's safe-delete guard counts
 * every file inside a recursively removed boundary directory against a
 * per-turn budget that is 50 here. The retention ceiling is what keeps the
 * whole of a scheme inside that budget, so pin the arithmetic rather than the
 * individual constants.
 */
test("the retention ceiling leaves a scheme deletable inside the safe-delete budget", async () => {
  const server = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");
  const interval = Number(/const PROJECT_REVISION_PRUNE_INTERVAL = (\d+);/.exec(server)?.[1]);
  assert.ok(Number.isFinite(interval) && interval > 0, "找不到 PROJECT_REVISION_PRUNE_INTERVAL");
  const ceiling = KEEP_RECENT + interval;
  // A dozen mirrored boundary files is the observed snapshot size.
  const boundaryFiles = 12;
  assert.ok(
    ceiling + boundaryFiles < 50,
    `保留上限 ${ceiling} + 边界 ${boundaryFiles} 不应达到安全删除限额 50（实际 ${ceiling + boundaryFiles}）`
  );
});

/**
 * The save path refuses to mint a revision when the stored snapshot already holds
 * the same content. Getting this wrong in the "equal" direction would silently
 * drop a real save, so pin both directions and the exact fields that are ignored.
 */
test("a no-op save is recognised as no-op, and a real change never is", () => {
  const base = { id: "p", name: "方案", revision: 7, updatedAt: "2026-01-01T00:00:00.000Z", scenes: [{ id: "cover" }] };

  // Only the two fields every save rewrites.
  assert.equal(sameProjectContent(base, { ...base, revision: 8 }), true);
  assert.equal(sameProjectContent(base, { ...base, updatedAt: "2026-09-29T00:00:00.000Z" }), true);
  assert.equal(sameProjectContent(base, { ...base, revision: 9, updatedAt: "2026-09-29T00:00:00.000Z" }), true);

  // Anything else is a real change.
  assert.equal(sameProjectContent(base, { ...base, name: "改过的方案" }), false);
  assert.equal(sameProjectContent(base, { ...base, scenes: [{ id: "cover" }, { id: "outro" }] }), false);
  assert.equal(sameProjectContent(base, { ...base, scenes: [{ id: "cover", title: "x" }] }), false);

  // A key-order difference must report "not equal" (fail safe: write the revision).
  const reordered = { updatedAt: base.updatedAt, revision: base.revision, scenes: base.scenes, name: base.name, id: base.id };
  assert.equal(sameProjectContent(base, reordered), false);
});

/**
 * The newest revision must be knowable without opening any file.
 *
 * Both the scheme list and the by-id read rely on this ordering to read ONE
 * snapshot instead of the whole history: the busiest scheme here had 315 of them
 * at ~370 KB, and parsing all of that per request (1418 ms measured, warm cache)
 * on the event loop is what made the editor look frozen. Getting the order wrong
 * is silent and hostile: the editor would open a two-hundred-revision-old state.
 */
test("snapshots are ordered newest-first, by number, for the scheme asked about", () => {
  const listing = [
    "other.v000900.json",
    "mine.v000009.json",
    "mine.v000010.json",
    "mine.v000002.json",
    "mine.JSON",
    "mine.vabc.json",
    "mine.json",
    "mine.boundary.json",
  ];
  const ordered = orderProjectSnapshots(listing, "mine");
  assert.deepEqual(ordered, ["mine.v000010.json", "mine.v000009.json", "mine.v000002.json", "mine.json"],
    "数值序（不是字典序：v10 必须排在 v9 前面）；无版本号的 <id>.json 排最后");

  // Another scheme's snapshots, a wrong-case name, a non-numeric revision and a
  // boundary sidecar are all excluded rather than sorted among them.
  for (const excluded of ["other.v000900.json", "mine.JSON", "mine.vabc.json", "mine.boundary.json"]) {
    assert.ok(!ordered.includes(excluded), `${excluded} 不应出现在 mine 的快照列表里`);
  }

  assert.deepEqual(orderProjectSnapshots(listing, "nobody"), [], "没有该方案的快照时返回空");
  // A scheme with only the legacy plain file still resolves.
  assert.deepEqual(orderProjectSnapshots(["solo.json"], "solo"), ["solo.json"]);
  // Already-sorted input stays sorted, newest first.
  assert.deepEqual(orderProjectSnapshots(["a.v1.json", "a.v2.json", "a.v3.json"], "a"),
    ["a.v3.json", "a.v2.json", "a.v1.json"]);
});
