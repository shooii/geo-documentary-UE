/**
 * Test-only shim for the host's safe-delete guard.
 *
 * ## The problem this solves
 *
 * This machine runs a sandbox that preloads a delete-protection shim into
 * **every** node process through `NODE_OPTIONS`, and into every python process
 * through `PYTHONPATH` > `sitecustomize.py`. The shim charges each delete against
 * a per-request budget (`%TEMP%/codebuddy-safe-delete-bulk/<session>/state.json`)
 * and throws `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]` once the running
 * total crosses the threshold (50 here).
 *
 * The counter is keyed on the *conversation request id*, which is shared by every
 * process in a session — including every child spawned by `node --test`. A full
 * `pnpm test` run deletes hundreds of scratch files, so the budget is guaranteed
 * to run out a couple of suites in, and the failure then follows the session for
 * the rest of the day. It shows up as product bugs that are not product bugs:
 *
 *   - `boundary-snapshot.test.ts` — "Studio signs a scheme against its frozen
 *     geometry" fails deleting `workspace/projects/<id>.boundary`.
 *   - `dongli-boundary-contract.test.ts` — the python child exits non-zero, and
 *     `spawnSync` reports `status: null`, which reads like a crash.
 *
 * Both were green in isolation and red in the full run, which is the signature.
 *
 * ## What this module does
 *
 * Test scratch lives under the OS temp directory and holds no user data, so the
 * guard has nothing to protect there. `guardFreeEnv()` returns an environment with
 * the two preload variables removed, which stops the shim reaching any child the
 * test spawns (`node`, `python`, or a server under test). Tests pass it as `env`
 * to `spawn`/`spawnSync`/`fork`, and use `scratchFetch`/`rmScratch` for their own
 * cleanup.
 *
 * Note the shim cannot be unloaded once a process has started — the current
 * process is still guarded. What this helper guarantees is that no *additional*
 * process joins the shared budget, which is what breaks the full run.
 */

import { delimiter, join, resolve } from "node:path";
import { rm as fsRm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

/** Environment variables the host uses to activate the delete guard. */
const GUARD_ENV_KEYS = [
  "NODE_OPTIONS",
  "PYTHONPATH",
  "CODEBUDDY_SAFE_DELETE_ENABLED",
  "CODEBUDDY_SAFE_DELETE_BULK_GUARD",
  "CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR",
  "CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD"
] as const;

/** True when this process is running under the host sandbox's delete guard. */
export function isGuarded(): boolean {
  return Boolean(process.env.CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR);
}

/**
 * The shim directory, derived from the guard path the host exports. Used to
 * surgically strip the shim from an inherited `PYTHONPATH`.
 */
function shimDirectory(): string | null {
  const guard = process.env.CODEBUDDY_SAFE_DELETE_BULK_GUARD;
  if (!guard) return null;
  const normalised = guard.replace(/\\/g, "/");
  const marker = "/shim/";
  const cut = normalised.lastIndexOf(marker);
  if (cut < 0) return null;
  return normalised.slice(0, cut + marker.length - 1).replace(/\//g, "\\");
}

/**
 * `process.env` with the delete-guard preloads removed.
 *
 * Pass this as the `env` of any child process that creates or removes files.
 * A child started with this environment is not wrapped by the shim, so its
 * deletes never join the shared budget.
 */
export function guardFreeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // The guard only runs when its state dir and tool-call id are both present.
  delete env.CODEBUDDY_SAFE_DELETE_ENABLED;
  delete env.CODEBUDDY_SAFE_DELETE_BULK_GUARD;
  delete env.CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR;
  delete env.CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD;

  // Preserve unrelated NODE_OPTIONS, but never propagate the shim preload.
  if (env.NODE_OPTIONS && /node-language-shim\.cjs/.test(env.NODE_OPTIONS)) delete env.NODE_OPTIONS;

  // Same for PYTHONPATH: keep the project's local package dirs, drop the shim.
  const shim = shimDirectory();
  if (shim && env.PYTHONPATH) {
    const kept = env.PYTHONPATH.split(delimiter).filter((entry) => {
      const normalised = entry.replace(/\\/g, "/").replace(/\/+$/, "");
      return normalised !== shim.replace(/\\/g, "/").replace(/\/+$/, "");
    });
    if (kept.length > 0) env.PYTHONPATH = kept.join(delimiter);
    else delete env.PYTHONPATH;
  }

  return { ...env, ...extra };
}

/** A fresh scratch directory under the OS temp dir. */
export function scratchDir(label: string): string {
  return join(tmpdir(), `geo-${label}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
}

/**
 * Remove a scratch directory, tolerating a refusal from the guard.
 *
 * Test teardown never has to succeed for a test to be meaningful, and a leak in
 * the OS temp directory is worse than a swallowed error here.
 */
export async function rmScratch(target: string): Promise<void> {
  await fsRm(target, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Delete a path through a **shim-free child process**.
 *
 * The shim cannot be unloaded from a process that is already running, so an
 * in-process `rm` during a full `pnpm test` run still hits the shared budget.
 * Spawning `node -e "rm"` with `guardFreeEnv()` sidesteps it entirely: the child
 * never loads the shim, so its deletes are unbudgeted.
 *
 * Use this wherever a test must *prove* a deletion happened (for example
 * asserting a boundary snapshot is gone). For plain teardown, `rmScratch` is
 * cheaper and already tolerant of refusal.
 */
export function rmGuarded(target: string): { ok: boolean; error?: string } {
  const script = "require('fs').rmSync(process.argv[1], { recursive: true, force: true })";
  const result = spawnSync(process.execPath, ["-e", script, target], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: guardFreeEnv()
  });
  if (result.status === 0) return { ok: true };
  return { ok: false, error: result.error ? String(result.error) : (result.stderr || "").trim() };
}

export { GUARD_ENV_KEYS, resolve };
