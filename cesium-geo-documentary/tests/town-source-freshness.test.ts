import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sourceFreshness, warnIfSourceDataMovedOn } from "../apps/studio/town-bootstrap.js";

/**
 * 河头镇 (440823114) was edited in the province shapefile on 2026-10-12 and the
 * Studio still built a new scheme from the record imported weeks earlier: a
 * town that already has a record is skipped by `ensureTownPlan`, so nothing ever
 * re-read the source. These tests pin the check that has to fire first — and,
 * just as importantly, the cases where it must stay quiet, because a needless
 * re-import rewrites curated metadata.
 */

const SECOND = 1_000;

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "geo-freshness-"));
  await mkdir(join(root, "data", "regions"), { recursive: true });
  await mkdir(join(root, "data", "normalized"), { recursive: true });
  return root;
}

async function writeRecord(root: string, record: Record<string, unknown>): Promise<string> {
  const path = join(root, "data", "regions", "990001.json");
  await writeFile(path, JSON.stringify(record), "utf8");
  return path;
}

async function touch(path: string, secondsAgo: number): Promise<void> {
  const when = new Date(Date.now() - secondsAgo * SECOND);
  await utimes(path, when, when);
}

test("a source file edited after the record marks the record stale", async () => {
  const root = await makeRoot();
  try {
    await writeFile(join(root, "data", "regions", "source.dbf"), "dbf", "utf8");
    const recordPath = await writeRecord(root, {
      id: "990001",
      name: "测试镇",
      sourceFiles: ["data/regions/source.dbf"]
    });
    await touch(join(root, "data", "regions", "source.dbf"), 60);
    await touch(recordPath, 3_600);

    const freshness = await sourceFreshness(root, "990001");
    assert.equal(freshness.stale, true, "the source is an hour newer than the record");
    assert.ok(freshness.newestSourceAt !== null && freshness.importedAt !== null);
    assert.ok(freshness.newestSourceAt > freshness.importedAt);
    assert.deepEqual(freshness.sourceFiles, ["data/regions/source.dbf"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a record written after its source is not stale", async () => {
  const root = await makeRoot();
  try {
    await writeFile(join(root, "data", "regions", "source.dbf"), "dbf", "utf8");
    const recordPath = await writeRecord(root, {
      id: "990001",
      name: "测试镇",
      sourceFiles: ["data/regions/source.dbf"]
    });
    await touch(join(root, "data", "regions", "source.dbf"), 3_600);
    await touch(recordPath, 60);

    assert.equal((await sourceFreshness(root, "990001")).stale, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timestamp noise inside the slack window does not re-trigger an import", async () => {
  const root = await makeRoot();
  try {
    await writeFile(join(root, "data", "regions", "source.dbf"), "dbf", "utf8");
    const recordPath = await writeRecord(root, {
      id: "990001",
      name: "测试镇",
      sourceFiles: ["data/regions/source.dbf"]
    });
    // A copy that lands a second behind the record must not look like an edit.
    await touch(join(root, "data", "regions", "source.dbf"), 1);
    await touch(recordPath, 0);

    assert.equal((await sourceFreshness(root, "990001")).stale, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a record that does not name its source is left alone", async () => {
  const root = await makeRoot();
  try {
    await writeFile(join(root, "data", "regions", "source.dbf"), "dbf", "utf8");
    const recordPath = await writeRecord(root, { id: "990001", name: "手写记录" });
    await touch(recordPath, 86_400);

    const freshness = await sourceFreshness(root, "990001");
    assert.equal(freshness.stale, false, "provenance is unknown, so nothing can be stale");
    assert.deepEqual(freshness.sourceFiles, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a source file that is gone, or outside the workspace, is not treated as changed", async () => {
  const root = await makeRoot();
  try {
    const recordPath = await writeRecord(root, {
      id: "990001",
      name: "测试镇",
      sourceFiles: ["data/regions/missing.dbf", "../outside.dbf"]
    });
    await touch(recordPath, 86_400);

    const freshness = await sourceFreshness(root, "990001");
    assert.equal(freshness.stale, false);
    assert.deepEqual(freshness.sourceFiles, ["data/regions/missing.dbf", "../outside.dbf"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing record is not stale", async () => {
  const root = await makeRoot();
  try {
    const freshness = await sourceFreshness(root, "990001");
    assert.equal(freshness.stale, false);
    assert.equal(freshness.importedAt, null);
    assert.equal(freshness.newestSourceAt, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creating a plan from a stale record says so on stderr, and stays quiet otherwise", async () => {
  const root = await makeRoot();
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await writeFile(join(root, "data", "regions", "source.dbf"), "dbf", "utf8");
    const recordPath = await writeRecord(root, {
      id: "990001",
      name: "测试镇",
      sourceFiles: ["data/regions/source.dbf"]
    });
    await touch(join(root, "data", "regions", "source.dbf"), 60);
    await touch(recordPath, 3_600);

    await warnIfSourceDataMovedOn(root, "990001");
    assert.equal(written.length, 1, "a stale record produces exactly one note");
    assert.match(written[0]!, /^SOURCE_DATA_STALE 990001 source=/);
    assert.match(written[0]!, /record=/);

    // Same town, now imported after its source: no second note.
    await touch(recordPath, 0);
    await warnIfSourceDataMovedOn(root, "990001");
    assert.equal(written.length, 1, "a fresh record is silent");
  } finally {
    process.stderr.write = original;
    await rm(root, { recursive: true, force: true });
  }
});
