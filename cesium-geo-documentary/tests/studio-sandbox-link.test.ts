import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDirectoryLink } from "../apps/studio/render-engine.js";

test("a sandbox link is re-linked instead of failing with EEXIST", async () => {
  const base = await mkdtemp(join(tmpdir(), "geo-link-"));
  try {
    const source = join(base, "source");
    const target = join(base, "target");
    await mkdir(join(source, "node_modules"), { recursive: true });
    await writeFile(join(source, "node_modules", "tsx.js"), "// tsx\n", "utf8");

    await ensureDirectoryLink(source, target);
    assert.ok(existsSync(join(target, "node_modules", "tsx.js")), "the link must expose the source");

    // The second run of a job finds the link already in place. Linking
    // unconditionally here is what killed two exports with
    // `EEXIST: file already exists, symlink ... node_modules`, and it is what
    // made interrupted-job recovery unusable.
    await ensureDirectoryLink(source, target);
    assert.ok(existsSync(join(target, "node_modules", "tsx.js")), "re-linking an identical link must be a no-op");

    // A stale link (its target cleaned out of the temp directory underneath it)
    // is replaced rather than left dangling.
    const replacement = join(base, "replacement");
    await mkdir(join(replacement, "node_modules"), { recursive: true });
    await writeFile(join(replacement, "node_modules", "hyperframes.js"), "// hf\n", "utf8");
    await ensureDirectoryLink(replacement, target);
    assert.ok(existsSync(join(target, "node_modules", "hyperframes.js")), "a stale link must be repointed");
    assert.ok(existsSync(join(source, "node_modules", "tsx.js")), "repointing must not delete the old source");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a real directory at the sandbox path is never deleted", async () => {
  const base = await mkdtemp(join(tmpdir(), "geo-link-real-"));
  try {
    const target = join(base, "sandbox");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "keep.txt"), "irreplaceable\n", "utf8");
    await ensureDirectoryLink(join(base, "source"), target);
    assert.ok(existsSync(join(target, "keep.txt")), "an unlinked sandbox directory must be left alone");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
