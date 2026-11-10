import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

/**
 * Robustness is a property of the seams, not of the happy path: a bad request
 * body, a stray rejection in a background task, a server that stopped answering.
 * These tests pin the guarantees that keep the workbench usable when one of them
 * goes wrong — each one was added after a real failure or an obvious gap.
 */

test("the server survives a stray rejection instead of dying mid-edit", async () => {
  const source = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");
  /* Node terminates on an unhandled rejection by default. This process runs
     every request handler and a pile of fire-and-forget background work, so a
     single unguarded promise used to take the whole Studio down and leave the
     operator with "connection refused" and nothing in the log. */
  assert.match(source, /process\.on\("unhandledRejection"/, "必须兜住未处理的 promise rejection");
  assert.match(source, /process\.on\("uncaughtException"/, "必须兜住未捕获异常");
  // The reporter itself must not throw, or the handler becomes the crash.
  const reporter = source.slice(source.indexOf("function reportProcessFailure"), source.indexOf("process.on(\"unhandledRejection\""));
  assert.match(reporter, /try\s*\{[\s\S]*?\}\s*catch\s*\{/, "上报函数内部必须自带 try/catch");
});

test("no background task is left without a rejection guard", async () => {
  const source = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");
  /* `void someAsync()` silently drops the rejection. Every fire-and-forget call
     must either catch, or chain into one, before the statement ends. Two were
     missed: the delete scheduler, and the preview port probe (`.then` with no
     `.catch`, so a failing probe became an unhandled rejection at startup). */
  for (const match of source.matchAll(/^\s*void\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
    // `match.index` sits at the leading whitespace the pattern swallowed, so the
    // scan must start at the `void` keyword itself — otherwise the very first
    // character is that indentation newline and the walk ends after one byte.
    const start = (match.index ?? 0) + match[0].indexOf("void");
    // Walk to the end of the whole statement. Stopping at the first *balanced*
    // group is wrong: `void probePort(a).then((busy) => { ... })` closes its
    // argument list long before the statement ends, so the scan would return
    // just `void probePort(...)` and never see the trailing `.catch(...)`.
    // Instead, keep going until a statement terminator (`;` or a newline that
    // is not a continuation) appears at depth 0.
    let depth = 0;
    let end = start;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "(" || ch === "{" || ch === "[") depth += 1;
      else if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
      else if (depth === 0) {
        if (ch === ";") { end = i; break; }
        // A line break at depth 0 only ends the statement when the next
        // non-space character cannot continue it — `).catch(...)` continues,
        // a fresh statement does not.
        if (ch === "\n") {
          const rest = source.slice(i + 1).match(/^\s*(\S)/);
          if (!rest || !/[.)\]`+-]/.test(rest[1] as string)) { end = i; break; }
        }
      }
      end = i;
    }
    const statement = source.slice(start, end + 1);
    assert.match(
      statement,
      /\.catch\(/,
      `void ${match[1]}(...) 必须接 .catch，否则抛错会变成 unhandled rejection`
    );
  }
});

test("a malformed request body is a clean 400, never a raw parse error", async () => {
  const source = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");
  const body = source.slice(source.indexOf("async function bodyJson"), source.indexOf("function safeId"));
  /* JSON.parse's SyntaxError ("Unexpected token < at position 0") reaches the
     user verbatim through the top-level handler, which reads like a bug in our
     own code rather than "the body you sent is not JSON". */
  assert.match(body, /if \(!text\.trim\(\)\) return \{\};/, "空请求体应当当作 {}，而不是解析错误");
  assert.match(body, /throw new HttpError\(400, "请求体不是合法 JSON"\)/, "解析失败要给出可读的 400");
  // A client that disconnects mid-upload is not a server fault either.
  assert.match(body, /ECONNRESET|ERR_STREAM_PREMATURE_CLOSE/, "上传中断要转成干净的 400");
  assert.match(body, /HttpError\(413, "请求体超过 20 MB"\)/, "超大请求体应当是 413");
  // The size guard must still exist — it is the only cap on request memory.
  assert.match(body, /20_000_000/, "必须保留请求体大小上限");
});

test("the client reads error bodies that are not JSON", async () => {
  const source = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");
  const api = source.slice(source.indexOf("async function api(path"), source.indexOf("function rememberFocusForModal"));
  /* Calling response.json() blind meant an HTML error page (proxied 502, crashed
     route, truncated body) surfaced as "Unexpected token <" and hid the status. */
  assert.match(api, /await response\.text\(\)/, "必须先读文本，再决定能否当 JSON 解析");
  assert.match(api, /try \{ data = JSON\.parse\(text\); \} catch \{ data = null; \}/, "JSON 解析要容错");
  assert.match(api, /HTTP \$\{response\.status\}/, "拿不到 error 字段时要回落到状态码");
  assert.match(api, /无法连接工作台服务/, "fetch 本身失败要给出可操作的中文提示");
  // The workbook route had the same blind .json() and had to be fixed too.
  assert.doesNotMatch(source, /const data = await response\.json\(\);\s*\n\s*if \(!response\.ok\)/, "工作簿 POST 不能再裸调 .json()");
});

test("a scheme read is materialised once, not once per request", async () => {
  const source = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");
  const read = source.slice(source.indexOf("async function readProject"), source.indexOf("function invalidateProjectCache"));
  /* `readProject` ends in `normalizeProject` -> `makeProject`, which re-reads the
     227 KB region catalog, walks the parent chain and re-merges the whole asset
     library: ~95 ms of synchronous CPU per call (measured on the busiest scheme).
     Every project route went through it, so the UI refreshing several panels at
     once serialised the event loop and inflated latency 8x (83 ms -> 684 ms).
     The fix memoises the materialised project; this pins both halves of the
     contract — that the memo exists, and that its key can actually observe a
     change. A cache that never misses is worse than no cache at all. */
  assert.match(source, /const projectMaterialisationCache = new Map/, "必须存在按方案记忆化已构建结果的结构");
  assert.match(read, /projectMaterialisationCache\.get\(projectId\)/, "readProject 必须查这个缓存");
  assert.match(read, /projectMaterialisationCache\.set\(projectId,/, "命中未就绪时必须写入");
  // Cache key = snapshot filename + asset-library fingerprint. The filename
  // changes on every save; the fingerprint changes on every upload. If either
  // half is dropped, a save or an upload can serve a stale project.
  assert.match(read, /cached\.candidate === name/, "键必须包含快照文件名（保存会换文件名）");
  assert.match(read, /cached\.assetFingerprint === assetFingerprint/, "键必须包含素材库指纹（上传会换指纹）");
});

test("every write path invalidates the materialised scheme", async () => {
  const source = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");
  /* The dangerous half of the memo: stale reads. Invalidation has to be
     structural wherever possible and explicit where it cannot be.
     - `writeProject` mints a new revision, so the key changes by itself; it
       still clears in a `finally` so no early return can leak a stale entry.
     - the delete paths must drop the scheme so reopening it cannot resurrect it.
     - the asset rename/delete routes rewrite snapshots IN PLACE (same filename,
       no revision bump), which the key cannot see — those are the ones an
       explicit `invalidateProjectCache()` has to cover. */
  const write = source.slice(source.indexOf("async function writeProject"), source.indexOf("async function buildProjectList"));
  assert.match(write, /finally \{[\s\S]*?invalidateProjectCache\(projectId\)/, "writeProject 必须在 finally 里失效");
  const del = source.slice(source.indexOf("async function deleteProject"), source.indexOf("function hasProjectTombstone"));
  assert.match(del, /invalidateProjectCache\(id\)/, "删除方案必须丢掉它的记忆化结果");
  // The in-place asset edits are the only ones the key cannot observe.
  const inPlace = source.match(/assetLibraryScan = null; projectListPromise = undefined;\s*\n(?:\s*\/\/[^\n]*\n)*\s*invalidateProjectCache\(\);/g) ?? [];
  assert.ok(inPlace.length >= 2, "就地改写快照的素材改名/删除路由必须显式失效（至少两处）");
});

test("a blocked event loop and a slow request both announce themselves", async () => {
  const source = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");
  /* "The editor froze" has now twice been synchronous CPU on the request path,
     and both times it was diagnosed by hand after the fact — while the process
     was alive, listening, and answering nothing, so there were no log lines at
     all. Two probes make the next occurrence self-reporting:
     - `monitorEventLoopDelay` measures how long the loop failed to schedule its
       own timer; past the threshold it is blocked inside synchronous code.
     - a per-request timer attributes the cost to a route, and separates
       queue-wait from work (the request that finally answers after a freeze is
       not the slow one — it is the first one after the block).
     Both must also be genuinely consistent: the same watchdog that names a
     4-second render-spec is what makes the next freeze diagnosable. */
  assert.match(source, /import \{ monitorEventLoopDelay \} from "node:perf_hooks"/, "要用 perf_hooks 的事件循环延迟采样");
  assert.match(source, /loopDelay\.enable\(\)/, "采样必须真的打开");
  assert.match(source, /STUDIO_EVENT_LOOP_BLOCKED/, "阻塞必须落到日志，否则事后无从归因");
  assert.match(source, /if \(worstMs < BLOCKED_LOOP_MS\) return;/, "阻塞告警要有阈值，不能把正常请求当阻塞");
  // The slow-request log must fire on the response, and must report queue time
  // separately from total time — otherwise a queued request looks like a slow one.
  assert.match(source, /response\.once\("finish"/, "慢请求日志要挂在响应结束时");
  assert.match(source, /if \(totalMs < SLOW_REQUEST_MS\) return;/, "单请求耗时要有阈值");
  assert.match(source, /排队=\$\{queueMs\}ms/, "必须把排队时长与工作时长分开报，否则分不清是谁慢");
  // Both thresholds stay tunable so the probe itself is testable on demand.
  assert.match(source, /process\.env\.STUDIO_SLOW_REQUEST_MS/, "慢请求阈值应可覆盖");
  assert.match(source, /process\.env\.STUDIO_BLOCKED_LOOP_MS/, "阻塞阈值应可覆盖");
  // …and switchable, so a troubleshooting session can silence the noise.
  assert.match(source, /process\.env\.STUDIO_PERF/, "埋点应可整体关闭");
});

test("the save path reads one revision, not the whole history", async () => {
  const source = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");
  const name = source.slice(
    source.indexOf("async function latestStoredProjectName"),
    source.indexOf("async function uniqueProjectName")
  );
  /* The save path asks this twice per PUT -- "did the name change?" and "does
     another scheme already own it?" -- and it used to answer by opening every
     snapshot of the scheme to pick the newest `updatedAt`. Saving keeps ~270
     snapshots of the busiest scheme on this machine, 119 MB of JSON, so a save
     spent **1934 ms parsing history to read one string** (measured), and the
     cost grew by a file on every save. It is the reason the editor felt like it
     was restarting: the operator's own save blocked the event loop for seconds,
     and under real editing traffic the worst observed save was 279 s.
     The newest revision is knowable from its filename, so this must read one
     file and only walk back for the damaged-revision fallback. */
  assert.match(name, /projectSnapshotCandidates\(id\)/, "必须用按版本号排序的候选，而不是列出全部快照");
  assert.doesNotMatch(name, /const candidates = \(await readdir\(projectsRoot\)\)/, "不得再自己列全部快照");
  assert.doesNotMatch(name, /for \(const name of candidates\)[\s\S]*?readJsonResilient/, "不得遍历解析全部快照");
  // The walk-back has to survive: a damaged newest revision must not hide the name.
  assert.match(name, /try \{[\s\S]*?return String\(project\.name/, "读到一个可读的快照就该返回");
  assert.match(name, /catch \{[\s\S]*?A damaged revision is skipped/, "损坏的快照要跳过并回退");
});

test("repeated reads do not re-walk the boundary tree or rebuild a 341 KB fingerprint", async () => {
  const catalog = await readFile(resolve(root, "apps/studio/admin-catalog.ts"), "utf8");
  const server = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");
  /* Two more per-request walks on the interactive path, both found by the
     slow-request log rather than by reading the code:
     - `sourceSignature` lists 538 files in a 15 GB tree and stats each one,
       ~135 ms. The division picker loads all four levels at once, so opening it
       paid that four times (~540 ms, measured 673-861 ms per request). It is
       memoized for a short window now, and stays tunable so a hand-edited .dbf
       is still noticed on the next interaction.
     - the asset-library fingerprint is the sorted name list, 341 KB for 7272
       sidecars, rebuilt and compared on every call **including cache hits**.
       Hashing keeps the same invalidation contract at 64 chars. */
  assert.match(catalog, /cachedSourceSignature/, "边界签名必须走缓存包装");
  assert.match(catalog, /signatureCache/, "必须有签名缓存结构");
  assert.match(catalog, /now - signatureCache\.at < CATALOG_SIGNATURE_TTL_MS/, "缓存必须按 TTL 失效，不能永久");
  assert.match(catalog, /process\.env\.STUDIO_CATALOG_SIGNATURE_TTL_MS/, "TTL 应可覆盖（0 = 退回每次检查）");
  // The call site is what matters: matching the helper's own name is not enough,
  // because the helper keeps existing (and keeping it while every caller goes
  // around it is exactly the regression this must catch). So pin the call
  // *inside* `getAdminCatalog`.
  const getCatalog = catalog.slice(
    catalog.indexOf("export async function getAdminCatalog"),
    catalog.indexOf("export async function markAdminDivisionReady")
  );
  assert.match(getCatalog, /cachedSourceSignature\(sourceRoot\)/, "getAdminCatalog 必须调用缓存版签名");
  assert.doesNotMatch(getCatalog, /await sourceSignature\(sourceRoot\)/, "getAdminCatalog 不得直调未缓存的签名");
  // The TTL must be short: the whole point is noticing a hand-edited boundary file.
  const ttl = Number(/STUDIO_CATALOG_SIGNATURE_TTL_MS \?\? ([\d_]+)/.exec(catalog)?.[1]?.replaceAll("_", "") ?? NaN);
  assert.ok(Number.isFinite(ttl) && ttl > 0 && ttl <= 30_000, `TTL 必须短到能察觉手工改动（实测 ${ttl}）`);
  assert.match(server, /createHash\("sha256"\)\.update\(sidecarNames\.slice\(\)\.sort\(\)\.join\("\\n"\)\)/, "素材库指纹必须哈希，而不是直接比较 341 KB 字符串");
});

test("immutable asset roots stop re-downloading, the UI shell stays fresh", async () => {
  const source = await readFile(resolve(root, "apps/studio/server.ts"), "utf8");
  const stream = source.slice(source.indexOf("function streamFile"), source.indexOf("async function streamSeekableMedia"));
  const serve = source.slice(source.indexOf("async function serveStatic"), source.indexOf("const server = createServer"));
  /* Every static response used to carry `no-store`, so the editor re-downloaded
     each thumbnail on every render -- and the source photos here run 3-5 MB, so
     that is real work competing with the operator's own requests (measured
     0.6-2.6 s per image while the editor was busy).
     Both asset roots are immutable per path: `/workspace-assets/<uuid>.<ext>` is
     written once and a replace mints a new id; `/project-assets/...` is the
     hand-curated source tree. `no-store` was therefore pure waste.
     The UI shell must NOT be cached -- a stale Studio is a bug report. */
  assert.match(source, /const IMMUTABLE_ASSET_CACHE = "public, max-age=31536000, immutable"/, "要有 immutable 常量");
  assert.match(stream, /cacheControl = "no-store, max-age=0"/, "streamFile 的默认必须仍是 no-store");
  // 三个根可以 opt in：两个素材根，加上字幕用的思源黑体（文件名带字重，换字重就换文件名）。
  // 其它任何路径都不许 immutable。
  const immutable = serve.match(/streamFile\(file, response, undefined, IMMUTABLE_ASSET_CACHE\)/g) ?? [];
  assert.equal(immutable.length, 3, "只有 workspace-assets / project-assets / fonts 三个根可以 immutable");
  assert.match(serve, /pathname\.startsWith\("\/fonts\/"\)/, "字体根要显式声明");
  assert.doesNotMatch(serve, /\/fonts\/[\s\S]{0,400}index\.html/, "字体根只能读 assets/fonts");
  assert.doesNotMatch(serve, /serveStatic[\s\S]*?index\.html[\s\S]*?IMMUTABLE_ASSET_CACHE/, "UI 外壳不得 immutable");
  // `existsSync` already answered "is it there" -- the extra `stat` was a second
  // syscall for the same answer on a path the editor hits hundreds of times.
  // (The `public/` branch keeps its `stat().isFile()` on purpose: it serves
  // arbitrary paths, including directories, and must reject those.)
  const projectAssets = serve.slice(
    serve.indexOf('pathname.startsWith("/project-assets/")'),
    serve.indexOf("const relativePath = pathname === \"/\"")
  );
  assert.match(projectAssets, /existsSync\(file\)/, "project-assets 用 existsSync 判定存在");
  assert.doesNotMatch(projectAssets, /stat\(file\)/, "project-assets 不应为同一答案多打一次 stat");
});

test("opening the export panel re-runs the check that gates the button", async () => {
  const source = await readFile(resolve(root, "apps/studio/public/studio.js"), "utf8");
  /* The checklist is the only input to `renderButton.disabled`, and
     `syncProjectState` is its only writer. Three interactive paths null it and
     then depend on a single sync call landing (AI rewrite of the whole copy, AI
     rewrite of one scene, single-village material re-collection). Opening the
     panel used to trust whatever was left in `state.readiness`, so after one of
     those the operator saw a blank list and a dead 添加导出任务 button with no
     error anywhere -- reported as "导出视频不行了". */
  const panel = source.slice(
    source.indexOf("async function openExportPanel"),
    source.indexOf("async function startRender")
  );
  assert.ok(panel.length > 0, "必须能找到 openExportPanel");
  assert.match(panel, /await syncProjectState\(\)/, "打开导出面板必须重新同步导出前检查");
  // It has to be conditional on the checklist being unusable: re-syncing a
  // healthy panel on every open would throw away a good result to fetch it again.
  assert.match(panel, /if\s*\(!state\.readiness\?\.ready\)/, "只在检查结果不可用时才重新同步");

  /* An empty list means "the check has not produced a result", not "there is
     nothing to check". Rendering it as nothing put a blank column beside a
     disabled button, which reads as a broken panel. */
  const readiness = source.slice(
    source.indexOf("function renderReadiness"),
    source.indexOf("function renderInspector")
  );
  assert.match(readiness, /checks\.length/, "空检查结果要有占位分支");
  assert.match(readiness, /readiness-item pending/, "占位行要带 pending 类");
  assert.match(readiness, /readiness-item \$\{statusOf\(item\)\}/, "有结果时仍按状态渲染");

  /* A silent failure here is what makes the zero-information blank list possible:
     the panel showed one terse row and nothing else. */
  const sync = source.slice(
    source.indexOf("async function syncProjectState"),
    source.indexOf("async function saveProject")
  );
  assert.match(sync, /toastError\(/, "导出前检查刷新失败必须告知用户");
});

test("the pending placeholder has a style, so it is not an unstyled ghost row", async () => {
  const css = await readFile(resolve(root, "apps/studio/public/studio-refine.css"), "utf8");
  assert.match(css, /\.readiness-item\.pending>span\{/, "pending 占位行要有自己的标记样式");
});
