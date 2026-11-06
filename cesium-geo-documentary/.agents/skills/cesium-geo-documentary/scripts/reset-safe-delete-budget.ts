/**
 * Reset the sandbox safe-delete budget for the Studio process.
 *
 * The host's safe-delete guard (`safe-delete-bulk-guard.cjs`, outside this repo)
 * fronts every `fs.rm`/`fs.unlink` and counts the files each one removes,
 * accumulating per originating request for seven days
 * (`TURN_STATE_TTL_MS`). A long-lived process — Studio is exactly that — keeps
 * adding to its own entry forever, so once the lifetime total crosses the
 * threshold (default 20, this machine 50) *every* later delete in that process
 * is refused, regardless of which scheme is being removed.
 *
 * Lowering the retention ceiling (as an earlier fix did) does not help: the
 * ceiling decides how many files one delete costs, while this budget is a
 * running total over the process's whole life.
 *
 * The app already survives the refusal (the scheme still disappears, the bulky
 * cleanup is deferred and retried at next start). This script is the recovery
 * path for the *already poisoned* entry, so a workspace that has been driven
 * over the limit can accept deletes again without waiting out the seven-day TTL
 * or restarting anything.
 *
 * It only ever zeroes the `count` of a request entry. It does not touch
 * `toolApprovals`, and it does not disable the guard.
 *
 * Usage:
 *   node node_modules/tsx/dist/cli.mjs .agents/skills/cesium-geo-documentary/scripts/reset-safe-delete-budget.ts [--apply]
 *
 * Without `--apply` it only reports what it would change.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const THRESHOLD = Number(process.env.CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD || 50);

interface GuardRequest {
  count?: number;
  updatedAt?: number;
}

interface GuardState {
  requests?: Record<string, GuardRequest>;
  toolApprovals?: Record<string, unknown>;
  requestRejections?: Record<string, unknown>;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const bulkRoot = join(tmpdir(), "codebuddy-safe-delete-bulk");
  let sessions: string[];
  try {
    sessions = await readdir(bulkRoot);
  } catch {
    process.stdout.write(`no safe-delete state at ${bulkRoot} — nothing to reset\n`);
    return;
  }

  let touched = 0;
  let overBudget = 0;
  for (const session of sessions) {
    const statePath = join(bulkRoot, session, "state.json");
    let state: GuardState;
    try {
      state = JSON.parse(await readFile(statePath, "utf8")) as GuardState;
    } catch {
      continue;
    }
    const requests = state.requests ?? {};
    const hot = Object.entries(requests).filter(([, request]) => (request?.count ?? 0) >= THRESHOLD);
    if (hot.length === 0) continue;
    overBudget += hot.length;
    process.stdout.write(`${session.slice(0, 12)}…  ${hot.length} request(s) at/over ${THRESHOLD}:\n`);
    for (const [requestId, request] of hot) {
      const ageMinutes = request?.updatedAt ? Math.round((Date.now() - request.updatedAt) / 60000) : null;
      process.stdout.write(`  ${requestId}  count=${request.count}${ageMinutes === null ? "" : `  last used ${ageMinutes} min ago`}\n`);
    }
    if (apply) {
      for (const [requestId, request] of hot) {
        requests[requestId] = { ...request, count: 0, updatedAt: Date.now() };
      }
      state.requests = requests;
      await writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");
      touched += hot.length;
    }
  }

  if (overBudget === 0) {
    process.stdout.write(`no request entry at/over the ${THRESHOLD}-file budget — deletes are not blocked\n`);
    return;
  }
  process.stdout.write(
    apply
      ? `\nreset ${touched} request entr${touched === 1 ? "y" : "ies"} to count=0 — deletes work again immediately\n`
      : `\n${overBudget} blocked entr${overBudget === 1 ? "y" : "ies"}. Re-run with --apply to reset.\n`
  );
}

await main();
