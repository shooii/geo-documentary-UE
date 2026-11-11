import { selectSceneAssetsForNarration } from "./scene-asset-match.js?v=20260918-3";
import { sceneRenderPlacementIndex, selectSceneRenderPlacements } from "./scene-render-placements.js?v=20261021-2";
import { previewOrigin as CESIUM_PREVIEW_ORIGIN } from "./studio-config.js";

const $ = (id) => document.getElementById(id);
const DEFAULT_IMAGERY_PROVIDER = "cesium-ion-world-imagery";
const DEFAULT_MAP_VIEW = Object.freeze({ longitudeOffset: 0, latitudeOffset: 0, zoom: 1, headingOffset: 0, pitchOffset: 0 });
const state = {
  project: null, projects: [], renderSpec: null, renderSpecStale: false, readiness: null, selectedSceneId: null, selectedAssetId: null,
  dirty: false, pollTimer: null, outputJob: null, exportJobs: [], exportJobStates: {}, playTimer: null, subtitleTimers: [], previewUrl: "",
  /** Provider the preview iframe was actually loaded with; imagery switches leave it untouched. */
  previewImagery: null, pendingImagery: null, previewProjectId: null,
  durationDrafts: new Map(), editEpoch: 0, savePromise: null, specRequest: 0,
  exportRequest: 0, exportPollFailures: 0, exportLastUpdated: null,
  assetUploadBatch: null,
  playheadSeconds: 0,
  previewAudio: null, previewAudioProjectId: null, previewAudioErrorShown: false, previewAudioSeekToken: 0, narrationStartTimer: null,
  narrationNotice: null,
  /** ▶ = one scene; ↺ 从头 = the whole film. See `startPlaybackFromSelected`. */
  playbackContinuous: false,
  uploadTargetSceneId: null, sceneAssetPickerOpen: false, sceneAssetPickerReplaceId: null,
  sceneAssetSearch: "", sceneAssetGroup: "all", sceneAssetScope: "current", sceneAssetSort: "relevance", sceneAssetUnboundOnly: false,
  sceneAssetReplaceCandidateId: null, sceneAssetApplyRecommended: false,
  assetLibraryOpen: false, assetLibrarySearch: "", assetLibrarySource: "all", assetLibraryUsage: "all", assetLibrarySort: "recent",
  assetLibrarySelected: new Set(), assetPreviewId: null, assetRenameContext: null,
  assetUndoStack: [], assetTouch: Object.create(null), coverPreviewTimer: null, coverPreviewObjectUrl: "", coverPreviewRequest: 0, previewMode: "actual",
  previewAssetReadySceneId: null, previewAssetRevealTimer: null,
  /** What the stage is currently painting; see `applyPreviewStagePlacement`. */
  previewStageSceneId: null, previewStageAssetId: null,
  /** The picture playback is showing right now (null = follow the selection). */
  playbackStagePlacement: null,
  /* True while ▶ is driving the stage. Distinct from "playbackStagePlacement is
     null": a scene whose pictures are all unmarked legitimately has **no**
     picture to show, and the stage must stay empty instead of falling back to
     whatever card the operator had clicked. */
  playbackStageActive: false,
  renameContext: null, deleteContext: null, confirmState: null, creation: { regionId: null, regionName: "", breadcrumb: "", selectingRegion: false, pendingName: "", nameTouched: false, busy: false }, projectFilter: "", projectListView: "recent", projectListFocusIndex: -1, lastFocused: null,
  admin: { provinces: [], cities: [], counties: [], towns: [], selected: null, searchTimer: null },
  amap: { types: [], selectedTypes: new Set(["110000", "140000", "060000", "170000", "190000"]), keyConfigured: false },
  childCollect: { open: false, busy: false, projectId: null, types: null, keyword: null }
};

const LAST_PROJECT_STORAGE_KEY = "geo-video-studio:last-project-id";
const RENDER_TYPOGRAPHY = Object.freeze({
  portrait: { subtitlePx: 56, assetCaptionPx: 42 },
  square: { subtitlePx: 50, assetCaptionPx: 30 },
  landscape: { subtitlePx: 52, assetCaptionPx: 25 }
});

// Must stay equal to subtitleBottomPercent in compose-hyperframes.ts: the preview and the
// burnt-in film have to put subtitles on the same line, 25% of the frame height above the
// bottom edge, counted from that edge upward. That is a composition choice, not a measurement
// of platform chrome (it used to track the Douyin collect ★ button at 35.9%). Both sides
// anchor the subtitle's CENTRE to that line, so the value is a centre offset, not a
// box-bottom offset. Change one, change the other.
const SUBTITLE_BOTTOM_RATIO = 0.25;

/* Saving is an explicit commit, not a background sync. These labels are the one
   source of truth for the header pill and the save button, so an unsaved scene
   can never be presented as already persisted. */
const SAVE_STATE_VIEWS = Object.freeze({
  saved: { text: "已保存", title: "所有场景修改已保存", aria: "方案已保存", buttonTitle: "保存方案" },
  dirty: { text: "未保存", title: "场景有未保存修改；点击“保存方案”后才会生效", aria: "方案有未保存修改", buttonTitle: "保存场景修改" },
  saving: { text: "保存中…", title: "正在保存场景修改", aria: "正在保存方案", buttonTitle: "正在保存场景修改" },
  error: { text: "保存失败，点击重试", title: "修改仍保留在当前页面，点击重试保存", aria: "方案保存失败", buttonTitle: "重试保存场景修改" }
});
function renderSaveState(status = state.dirty ? "dirty" : "saved") {
  const view = SAVE_STATE_VIEWS[status] || SAVE_STATE_VIEWS.saved;
  const saveState = $("saveState");
  if (saveState) {
    saveState.textContent = view.text;
    saveState.title = view.title;
    saveState.className = `save-state${status === "saved" ? "" : " is-dirty"}${status === "error" ? " has-error" : ""}`;
    if (saveState.dataset) saveState.dataset.saveState = status;
    saveState.setAttribute?.("aria-label", view.aria);
  }
  const saveButton = $("saveProjectButton");
  if (saveButton) {
    saveButton.classList?.toggle("has-unsaved", status !== "saved");
    saveButton.classList?.toggle("has-save-error", status === "error");
    saveButton.title = view.buttonTitle;
  }
}

function syncPreviewTypography() {
  const frame = $("previewFrame");
  const profile = state.project?.output?.profile || "portrait";
  const typography = RENDER_TYPOGRAPHY[profile] || RENDER_TYPOGRAPHY.portrait;
  const outputWidth = Math.max(1, Number(state.project?.output?.width || (profile === "landscape" ? 1920 : 1080)));
  const previewWidth = frame.getBoundingClientRect().width;
  if (!previewWidth) return;
  const scale = previewWidth / outputWidth;
  frame.style.setProperty("--preview-subtitle-font-size", `${(typography.subtitlePx * scale).toFixed(3)}px`);
  frame.style.setProperty("--preview-asset-caption-font-size", `${(typography.assetCaptionPx * scale).toFixed(3)}px`);
  frame.style.setProperty("--preview-subtitle-bottom", `${(SUBTITLE_BOTTOM_RATIO * 100).toFixed(2)}%`);
}

// Keep the editor preview on the same semantic beat as the production player:
// descend through cloud, then start the boundary trace, narration, and
// subtitles together.
const STUDIO_OPENING_PREVIEW_TIMING = Object.freeze({
  revealDelaySeconds: 0.35,
  revealSeconds: 1.4,
  settleSeconds: 0.22,
  labelHoldSeconds: 0.12,
  assetDelayAfterLabelSeconds: 1
});

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { headers: { "content-type": "application/json", ...(options.headers || {}) }, ...options });
  } catch (error) {
    /* fetch only rejects on a transport failure (server restarted, network
       dropped). The raw message is "Failed to fetch", which tells the operator
       nothing about what to do next. */
    throw new Error(`无法连接工作台服务（${error instanceof Error ? error.message : String(error)}），请确认 Studio 仍在运行`);
  }
  /* Read the body as text first: an error response is not guaranteed to be
     JSON. A crashed route, a proxy error page or a truncated body all arrive as
     HTML, and calling .json() on that threw "Unexpected token <" -- a parse
     error that hid the real status and read as a bug in our own code. */
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!response.ok) {
    const detail = data && typeof data === "object" && "error" in data ? String(data.error) : "";
    throw new Error(detail || `请求失败（HTTP ${response.status}）`);
  }
  if (data === null) throw new Error("服务返回了非预期的响应格式");
  return data;
}

function rememberFocusForModal() {
  const active = document.activeElement;
  state.lastFocused = active && active instanceof HTMLElement && active !== document.body ? active : null;
}
function restoreFocusAfterModal() {
  const target = state.lastFocused;
  state.lastFocused = null;
  if (target && target.isConnected) { try { target.focus({ preventScroll: true }); } catch (_) { /* noop */ } }
}
function clampInputValue(input, min, max) {
  const raw = Number(input.value);
  const clamped = Math.min(max, Math.max(min, Number.isFinite(raw) ? raw : min));
  input.value = String(clamped);
  return clamped;
}
function anyModalOpen() {
  return ["projectListModal", "saveProjectModal", "renameProjectModal", "deleteProjectModal", "newProjectModal", "confirmModal", "exportModal", "workbookModal", "assetPreviewModal", "assetLibraryModal", "assetRenameModal"]
    .some((id) => { const el = $(id); return el && !el.hidden; });
}
/* Notices come in three flavours so a failure can never be mistaken for a
   confirmation. Errors stay up long enough to be read, announce themselves to
   assistive tech, and can be dismissed by clicking; info/success keep the old
   brief-confirmation feel. */
const TOAST_DURATION = { info: 2600, success: 2600, error: 7000 };
function toast(message, options = {}) {
  const host = $("toasts");
  if (!host) return;
  const type = options.type || "info";
  const node = document.createElement("div");
  node.className = `toast-item show toast-${type}`;
  node.textContent = String(message);
  if (type === "error") {
    node.setAttribute("role", "alert");
    node.title = "点击关闭";
    node.classList.add("dismissible");
  }
  host.appendChild(node);
  const remove = () => {
    if (!node.isConnected) return;
    node.classList.remove("show");
    setTimeout(() => node.remove(), 260);
  };
  if (type === "error") node.addEventListener("click", remove);
  while (host.children.length > 4) host.firstElementChild?.remove();
  setTimeout(remove, options.duration ?? TOAST_DURATION[type] ?? 2600);
}
function toastError(message, options = {}) { return toast(message, { ...options, type: "error" }); }
function toastSuccess(message, options = {}) { return toast(message, { ...options, type: "success" }); }

/* Self-hosted confirm dialog (keeps destructive prompts inside the editor skin
   instead of the browser's native window.confirm). */
function askConfirm(options = {}) {
  return new Promise((resolve) => {
    if (state.confirmState) state.confirmState.resolve(false); // settle any previous prompt
    state.confirmState = { resolve };
    rememberFocusForModal();
    $("confirmModalTitle").textContent = options.title || "确认操作";
    $("confirmModalMessage").textContent = options.message || "";
    $("confirmModalOk").textContent = options.okText || "确认";
    $("confirmModalOk").className = options.okClass || "danger";
    $("cancelConfirmModal").textContent = options.cancelText || "取消";
    $("confirmModal").hidden = false;
    $("confirmModalOk").focus();
  });
}
function settleConfirm(result) {
  const pending = state.confirmState;
  state.confirmState = null;
  $("confirmModal").hidden = true;
  restoreFocusAfterModal();
  if (pending) pending.resolve(result);
}

let projectBusyTimer = null;
const PROJECT_BUSY_DEFAULT_TITLE = "正在打开方案…";
/**
 * The busy card is one shared overlay, so both of its lines have to be written on
 * every show. Passing a stage without a title used to leave the *previous*
 * request's title on screen: creating a plan while 安铺镇 was open announced
 * "正在打开方案：安铺镇地理图说" over "正在创建新方案…", so the operator read the
 * overlay as reopening the plan they already had.
 */
function setProjectBusy(show, stage = "", title = "") {
  const modal = $("projectBusy");
  if (!modal) return;
  clearTimeout(projectBusyTimer);
  if (show) {
    modal.hidden = false;
    $("projectBusyTitle").textContent = title || PROJECT_BUSY_DEFAULT_TITLE;
    $("projectBusyStage").textContent = stage || "";
    projectBusyTimer = setTimeout(() => { modal.hidden = true; }, 90000); // safety net
  } else {
    modal.hidden = true;
  }
}

function renderPoiTypes() {
  const grid = $("poiTypeGrid"); if (!grid) return;
  grid.innerHTML = state.amap.types.map((item) => `<label class="${state.amap.selectedTypes.has(item.code) ? "selected" : ""}"><input type="checkbox" value="${item.code}" ${state.amap.selectedTypes.has(item.code) ? "checked" : ""}/><span>${escapeHtml(item.name)}</span></label>`).join("");
  grid.querySelectorAll("input").forEach((input) => input.onchange = () => {
    if (input.checked) state.amap.selectedTypes.add(input.value); else state.amap.selectedTypes.delete(input.value);
    renderPoiTypes(); updatePoiImportSummary();
  });
}

function updatePoiImportSummary() {
  if (!$("poiImportSummary")) return;
  const enabled = $("poiAutoImport").checked;
  $("poiImportSummary").textContent = enabled
    ? `${state.amap.selectedTypes.size} 类 · 每个村界独立匹配全部图片`
    : "按村界匹配高德 POI 图片";
}

async function loadAmapMaterialOptions() {
  const options = await api("/api/amap/material-options");
  state.amap.types = options.types || []; state.amap.keyConfigured = Boolean(options.keyConfigured);
  if (state.amap.keyConfigured) $("amapKey").placeholder = "本机已配置，可留空";
  renderPoiTypes(); updatePoiImportSummary();
}

// ---- per-village AMap re-collect -------------------------------------------
// Collection runs once at project creation, before anyone knows which theme a
// village actually needed, so the village editor gets its own entry to that same
// server-side routine scoped to one child boundary.
function childCollectScene() {
  const scene = selectedScene();
  return scene && scene.section === "child" && scene.childId ? scene : null;
}

/** Reset the form inputs whenever the open project changes. */
function syncChildCollectScope() {
  if (state.childCollect.projectId === (state.project?.id ?? null)) return;
  state.childCollect.projectId = state.project?.id ?? null;
  state.childCollect.types = null;
  state.childCollect.keyword = null;
}

/** Start from the types this project was last collected with, not the create-panel defaults. */
function childCollectTypes() {
  if (!state.childCollect.types) {
    const stored = state.project?.poiImport?.typeCodes;
    state.childCollect.types = new Set(Array.isArray(stored) && stored.length ? stored : state.amap.selectedTypes);
  }
  return state.childCollect.types;
}

function childCollectKeyword() {
  if (state.childCollect.keyword === null) state.childCollect.keyword = String(state.project?.poiImport?.keyword || "");
  return state.childCollect.keyword;
}

function childCoverageRow(childId) {
  const rows = state.project?.poiImport?.children;
  if (!Array.isArray(rows)) return undefined;
  return rows.find((row) => String(row.childId) === String(childId));
}

/** What the last collection actually returned for one village. */
function childCoverageText(scene) {
  const row = childCoverageRow(scene.childId);
  if (!row) return "没有这个村的采集记录";
  if (row.error && row.photoCount) return `部分采集：${row.error}`;
  if (row.error) return `采集失败：${row.error}`;
  if (!row.photoCount) return `${row.poiCount} 个 POI，但没有返回图片`;
  return `${row.poiCount} 个 POI · ${row.photoCount} 张图`;
}

function renderChildCollectCoverage(scene) {
  const list = $("childCollectCoverageList"); if (!list) return;
  const scenes = (state.project?.scenes || []).filter((item) => item.section === "child" && item.childId);
  const pending = scenes.filter((item) => { const row = childCoverageRow(item.childId); return !row || row.error || !row.photoCount; });
  $("childCollectCoverageSummary").textContent = scenes.length ? `${scenes.length} 个村 · ${pending.length} 个待补` : "";
  list.innerHTML = scenes.length ? scenes.map((item) => {
    const row = childCoverageRow(item.childId);
    const empty = !row || row.error || !row.photoCount;
    const detail = row?.error && row.photoCount ? `部分采集：${row.error}` : row?.error ? `采集失败：${row.error}` : !row ? "未参与采集" : !row.photoCount ? "没有返回图片，换个类型或关键词再试" : "";
    return `<div class="child-collect-coverage-row${empty ? " is-empty" : ""}${item.id === scene?.id ? " is-current" : ""}" data-collect-scene="${escapeHtml(item.id)}" role="button" tabindex="0">
      <b>${escapeHtml(item.childName || item.title || item.id)}</b>
      <span>${row?.poiCount ?? 0} POI · ${(item.placements || []).length} 张在场景</span>
      ${detail ? `<em>${escapeHtml(detail)}</em>` : ""}
    </div>`;
  }).join("") : `<div class="child-collect-coverage-row"><b>方案里还没有下级行政区场景</b><span>—</span></div>`;
  list.querySelectorAll("[data-collect-scene]").forEach((node) => {
    const jump = () => { state.selectedSceneId = node.dataset.collectScene; state.selectedAssetId = null; render(); };
    node.onclick = jump;
    node.onkeydown = (event) => { if (event.key !== "Enter" && event.key !== " ") return; event.preventDefault(); jump(); };
  });
}

function renderChildCollectPanel() {
  const panel = $("childCollectPanel"); if (!panel) return;
  syncChildCollectScope();
  const scene = childCollectScene();
  panel.hidden = !scene;
  if (!scene) return;
  const intoFilm = sceneAssetDisplayCount(scene);
  const coverage = childCoverageText(scene);
  $("childCollectCoverage").textContent = `${coverage} · 场景 ${(scene.placements || []).length} 张，进成片 ${intoFilm} 张`;
  if (intoFilm < (scene.placements || []).length) {
    $("childCollectCoverage").title = "进成片张数由上方“选择成片图片”决定：勾选“用于成片”的素材才会进成片；一张都不勾，这一场在成片里就没有图片。";
  } else {
    $("childCollectCoverage").title = "";
  }
  const toggle = $("toggleChildCollect");
  toggle.textContent = state.childCollect.open ? "收起" : "重采本村素材";
  toggle.setAttribute("aria-pressed", String(state.childCollect.open));
  toggle.disabled = state.childCollect.busy;
  const form = $("childCollectForm");
  form.hidden = !state.childCollect.open;
  if (state.childCollect.open) {
    $("childCollectKeyword").value = childCollectKeyword();
    const selected = childCollectTypes();
    $("childCollectTypes").innerHTML = state.amap.types.length
      ? state.amap.types
        .map((item) => `<label class="${selected.has(item.code) ? "selected" : ""}"><input type="checkbox" value="${item.code}" ${selected.has(item.code) ? "checked" : ""}/><span>${escapeHtml(item.name)}</span></label>`)
        .join("")
      : `<span>正在读取类型…</span>`;
    // Toggle the class in place: re-rendering the grid on every click would drop focus.
    $("childCollectTypes").querySelectorAll("input").forEach((input) => input.onchange = () => {
      if (input.checked) selected.add(input.value); else selected.delete(input.value);
      input.closest("label")?.classList.toggle("selected", input.checked);
    });
    $("runChildCollect").disabled = state.childCollect.busy;
    $("runChildCollect").textContent = state.childCollect.busy ? "正在采集…" : "开始采集";
  }
  renderChildCollectCoverage(scene);
}

async function runChildCollect() {
  if (!state.project) return;
  if (!(await saveBeforeAction("采集本村素材"))) return;
  const scene = childCollectScene();
  if (!scene || state.childCollect.busy) return;
  const typeCodes = [...childCollectTypes()];
  if (!typeCodes.length) { toastError("请至少选择一种 POI 类型"); return; }
  const keyword = $("childCollectKeyword").value.trim();
  const unbind = $("childCollectUnbind").checked;
  const city = String(scene.childName || scene.title || "本村");
  const status = $("childCollectStatus");
  const before = (scene.placements || []).length;
  state.childCollect.busy = true; state.childCollect.keyword = keyword;
  if (status) status.textContent = `按「${city}」边界检索 ${typeCodes.length} 类 POI…`;
  renderChildCollectPanel();
  try {
    const result = await api(`/api/projects/${state.project.id}/collect-materials`, { method: "POST", body: JSON.stringify({
      typeCodes, keyword, childIds: [String(scene.childId)], mode: unbind ? "unbind" : "append"
    }) });
    const sceneId = scene.id; const assetId = state.selectedAssetId;
    state.project = result.project;
    state.renderSpec = null; state.renderSpecStale = false; state.readiness = null; state.dirty = false;
    renderSaveState("saved");
    state.selectedSceneId = sceneId;
    state.selectedAssetId = assetId;
    const next = selectedScene();
    const after = (next?.placements || []).length;
    toastSuccess(`「${city}」已采集 ${next ? childCoverageText(next) : ""}；场景素材 ${before} → ${after} 张`);
  } catch (error) {
    if (status) status.textContent = "";
    toastError(error.message);
  } finally {
    state.childCollect.busy = false;
    render();
  }
}

function selectedScene() { return state.project?.scenes.find((scene) => scene.id === state.selectedSceneId); }
function selectedPlacement() { return selectedScene()?.placements?.find((placement) => placement.assetId === state.selectedAssetId) || selectedScene()?.placements?.[0]; }

const LEGACY_GENERIC_SCENE_TITLES = new Set(["新增内容场景", "新增内容场景 · 副本"]);
function isLegacyGenericSceneTitle(value) { return LEGACY_GENERIC_SCENE_TITLES.has(String(value || "").trim()); }
function sceneDisplayName(scene, scenes = state.project?.scenes || []) {
  if (!scene) return "未命名场景";
  const raw = String(scene.childName || scene.title || "").trim();
  if (scene.section !== "overview" || !isLegacyGenericSceneTitle(raw)) return raw || "未命名场景";
  const genericIndex = scenes.filter((item) => item.section === "overview" && isLegacyGenericSceneTitle(item.title)).findIndex((item) => item.id === scene.id);
  return `总体补充 ${String(Math.max(0, genericIndex) + 1).padStart(2, "0")}`;
}
function nextOverviewSupplementTitle() {
  return nextContentSceneTitle("overview");
}
/**
 * The next free "总体补充 NN" / "结尾补充 NN" title for the given block. The two
 * blocks number independently, so a closing-block addition does not collide with
 * the opening block's sequence.
 */
function nextContentSceneTitle(section) {
  const prefix = section === "outro-lead" ? "结尾补充" : "总体补充";
  const used = new Set();
  let genericIndex = 0;
  for (const scene of state.project?.scenes || []) {
    if ((scene.section || "overview") !== section) continue;
    if (section === "overview" && isLegacyGenericSceneTitle(scene.title)) used.add(++genericIndex);
    const match = new RegExp(`^${prefix}\\s+(\\d+)$`).exec(String(scene.title || "").trim());
    if (match) used.add(Number(match[1]));
  }
  let next = 1;
  while (used.has(next)) next += 1;
  return `${prefix} ${String(next).padStart(2, "0")}`;
}
function isMapOnlyScene(scene) {
  return Boolean(scene && (scene.type === "map-overview" || scene.type === "region-focus" || scene.type === "outro" || scene.section === "outro"));
}
function sceneAssetStatus(scene) {
  const assetCount = scene?.placements?.length || 0;
  if (scene?.section === "cover") return { label: "封面配置", kind: "cover" };
  if (assetCount) {
    const intoFilm = sceneAssetDisplayCount(scene);
    const clips = (state.renderSpec?.visualTimeline?.clips || []).filter((item) => item.sceneId === scene.id);
    const exact = !state.renderSpecStale && clips.length === intoFilm && intoFilm > 0;
    const windows = exact ? clips.map((clip) => Math.max(0, clip.endSeconds - clip.startSeconds)) : [];
    const minimum = windows.length ? Math.min(...windows) : intoFilm > 0 ? sceneDuration(scene) / intoFilm : 0;
    const maximum = windows.length ? Math.max(...windows) : minimum;
    const seconds = (value) => value >= 10 ? `${Math.round(value)}` : value.toFixed(1);
    const perImageLabel = `${exact ? "" : "约 "}${seconds(minimum)}${maximum - minimum >= 0.1 ? `–${seconds(maximum)}` : ""} 秒`;
    const crowded = intoFilm > 0 && (minimum < 2 || clips.some((clip) => clip.tooShort || clip.clamped));
    return { label: `素材 ${assetCount} · 成片 ${intoFilm}${intoFilm > 0 ? ` · 每张 ${perImageLabel}` : ""}${crowded ? " · 选图偏多，建议减少" : ""}`, kind: "has-assets" };
  }
  if (isMapOnlyScene(scene)) return { label: "地图镜头", kind: "map-only" };
  return { label: "待配素材", kind: "missing-assets" };
}

/* 场景预览画布里的素材：图片用 <img>，视频用 <video>。
   `asset.type` 是上传时按字节定的（见 media-sniff），所以这里可以信任它。
   视频必须走 <video>：把 mp4 塞进 <img src> 在浏览器里什么都不画，
   而预览画布是「成片会长什么样」的权威表面，不能只对图片有效。 */
function previewMediaElement() {
  const video = $("previewAssetVideo");
  return video && !video.hidden ? video : $("previewAsset");
}

function previewMediaReady(media) {
  return media instanceof HTMLVideoElement
    ? media.readyState >= 2 && media.videoWidth > 0
    : media.complete && media.naturalWidth > 0;
}

function setPreviewAssetVisible(visible) {
  const previewAsset = previewMediaElement();
  const previewAssetFrame = $("previewAssetFrame");
  const previewAssetCaption = $("previewAssetCaption");
  const previewShade = $("previewShade");
  previewAssetFrame.classList.toggle("is-visible", visible);
  previewAsset.classList.toggle("is-visible", visible);
  previewAssetCaption.classList.toggle("is-visible", visible);
  previewShade.classList.toggle("is-visible", visible);
  previewAsset.setAttribute("aria-hidden", String(!visible));
  previewAssetCaption.setAttribute("aria-hidden", String(!visible));
  if (previewAsset instanceof HTMLVideoElement) {
    if (visible) {
      previewAsset.currentTime = 0;
      previewAsset.muted = false;
      previewAsset.volume = 0.6;
      previewAsset.play().catch(() => {
        /* 如果非静音自动播放被浏览器拦截，回退到静音播放保留首帧 */
        previewAsset.muted = true;
        previewAsset.play().catch(() => { /* 自动播放被拦时保留首帧 */ });
      });
    } else if (!previewAsset.paused) {
      previewAsset.pause();
    }
  }
  const previewVideo = $("previewAssetVideo");
  if (previewVideo && (!visible || previewAsset !== previewVideo) && !previewVideo.paused) {
    previewVideo.pause();
  }
}

function revealSelectedSceneAsset(placement = state.playbackStageActive ? state.playbackStagePlacement : selectedPlacement()) {
  const scene = selectedScene();
  const asset = placement ? assetById(placement.assetId) : null;
  if (!scene || !asset || scene.section === "cover") return setPreviewAssetVisible(false);
  const waitsForMapReveal = isOpeningScene(scene) || scene.section === "child";
  const cameraLocked = !waitsForMapReveal || state.previewAssetReadySceneId === scene.id;
  setPreviewAssetVisible(cameraLocked && previewMediaReady(previewMediaElement()));
}

function handleCesiumPreviewMessage(event) {
  if (event.source !== $("cesiumPreview").contentWindow || event.origin !== CESIUM_PREVIEW_ORIGIN) return;
  if (event.data?.type !== "geo-video-player") return;
  if (event.data.event === "engine-ready") {
    // A message sent while the iframe was still booting is lost, so replay the
    // requested basemap once the engine reports ready.
    if (state.pendingImagery && state.pendingImagery !== state.previewImagery) {
      $("cesiumPreview").contentWindow?.postMessage(
        { type: "geo-video-studio", action: "switch-imagery", imagery: state.pendingImagery }, CESIUM_PREVIEW_ORIGIN);
    }
    return;
  }
  if (event.data.event === "imagery-changed") {
    state.previewImagery = event.data.provider || state.previewImagery;
    state.pendingImagery = null;
    return;
  }
  const scene = selectedScene();
  const openingLabelVisible = event.data.event === "opening-label-visible" && isOpeningScene(scene);
  const childFlightComplete = event.data.event === "tour-flight-complete"
    && scene?.section === "child"
    && String(scene.childId) === String(event.data.childId);
  if (!openingLabelVisible && !childFlightComplete) return;
  if (openingLabelVisible) {
    const sceneId = scene.id;
    clearTimeout(state.previewAssetRevealTimer);
    state.previewAssetRevealTimer = setTimeout(() => {
      if (selectedScene()?.id !== sceneId) return;
      state.previewAssetReadySceneId = sceneId;
      revealSelectedSceneAsset();
    }, STUDIO_OPENING_PREVIEW_TIMING.assetDelayAfterLabelSeconds * 1000);
    return;
  }
  state.previewAssetReadySceneId = scene.id;
  revealSelectedSceneAsset();
}

function ensurePreviewAudio() {
  if (!state.project) return null;
  if (state.previewAudio && state.previewAudioProjectId === state.project.id) return state.previewAudio;
  state.previewAudio?.pause();
  const audio = new Audio(`/api/projects/${encodeURIComponent(state.project.id)}/narration-audio?revision=${encodeURIComponent(state.project.revision || 0)}`);
  audio.preload = "auto";
  audio.volume = 1;
  audio.addEventListener("error", () => {
    /* A 404 here is not an exceptional state: after any narration or voice-speed
       edit the measured audio stops describing the film, and the server refuses
       to serve it. A toast that fades in 2.4 s left the operator with a silently
       mute play button and no way out, so the transport keeps a visible notice
       with the one action that actually fixes it. */
    if (state.previewAudioErrorShown) return;
    state.previewAudioErrorShown = true;
    void showNarrationMissingNotice();
  });
  state.previewAudio = audio;
  state.previewAudioProjectId = state.project.id;
  state.previewAudioErrorShown = false;
  return audio;
}

/** Why the preview is mute, and the button that generates just the narration. */
async function showNarrationMissingNotice() {
  if (!state.project) return;
  const projectId = state.project.id;
  const project = state.project;
  const sceneId = selectedScene()?.id ?? "";
  try {
    /* The 404 body distinguishes "never generated" from "generated, then the
       narration changed". The second one is the common case after editing a
       paragraph, and saying "还没有生成" there sends the operator looking for a
       missing file when the audio exists and is merely out of date. */
    await api(`/api/projects/${projectId}/narration-audio?revision=${project.revision || 0}`);
    return; // Playable after all (e.g. a transient error): leave the UI alone.
  } catch (error) {
    if (state.project !== project) return;
    const message = String(error?.message || "");
    state.narrationNotice = {
      stale: /改过了/.test(message),
      projectId: state.project.id,
      sceneId,
      busy: false,
      message: /改过了/.test(message)
        ? "旁白文案或语速改过了，预览没有对应音频（导出时会重新生成）"
        : "这个方案还没有旁白音频（导出时才会生成）"
    };
  }
  renderNarrationNotice();
}

function renderNarrationNotice() {
  const host = $("narrationNotice");
  if (!host) return;
  const notice = state.narrationNotice;
  if (!notice || notice.projectId !== state.project?.id) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  host.hidden = false;
  host.innerHTML = `<span>🔇 ${escapeHtml(notice.message)}</span>
    <button type="button" id="generatePreviewNarration" ${notice.busy ? "disabled" : ""}>${notice.busy ? "生成中…" : "生成预览旁白"}</button>
    <button type="button" class="narration-notice-dismiss" id="dismissNarrationNotice" aria-label="关闭提示">✕</button>`;
  $("generatePreviewNarration").onclick = () => void generatePreviewNarration();
  $("dismissNarrationNotice").onclick = () => { state.narrationNotice = null; renderNarrationNotice(); };
}

async function generatePreviewNarration() {
  const notice = state.narrationNotice;
  if (!notice || notice.busy || !state.project) return;
  const project = state.project;
  notice.busy = true;
  renderNarrationNotice();
  try {
    if (!(await saveBeforeAction("生成旁白"))) return;
    if (state.project !== project) return;
    const generationEpoch = state.editEpoch;
    toast("正在生成旁白…");
    const result = await api(`/api/projects/${project.id}/narration-preview`, { method: "POST", body: "{}" });
    if (state.project !== project) return;
    if (state.editEpoch !== generationEpoch || state.dirty) {
      notice.busy = false;
      notice.stale = true;
      notice.message = "生成期间文案或设置已修改，请保存后重新生成旁白";
      renderNarrationNotice();
      renderPreviewTrustStatus();
      return;
    }
    await syncProjectState();
    if (state.project !== project || state.editEpoch !== generationEpoch) return;
    state.narrationNotice = null;
    renderNarrationNotice();
    // Rebuild the element so it refetches the freshly written audio.
    state.previewAudio?.pause();
    state.previewAudio = null;
    state.previewAudioProjectId = null;
    state.previewAudioErrorShown = false;
    toastSuccess(result?.reused ? "旁白已是最新" : `旁白已生成（${result?.seconds ?? 0}s）`);
    if (state.playTimer) startPlaybackFromSelected();
  } catch (error) {
    notice.busy = false;
    if (state.project !== project) return;
    renderNarrationNotice();
    toastError(`旁白生成失败：${error.message}`);
  }
}

function playAudioElement(audio) {
  const attempt = audio.play();
  attempt?.catch(() => {
    if (!state.previewAudioErrorShown) {
      state.previewAudioErrorShown = true;
      toast("浏览器阻止了旁白播放，请再次点击播放");
    }
  });
}

function unlockPreviewAudioFromGesture(scene) {
  const audio = ensurePreviewAudio();
  const previewVideo = $("previewAssetVideo");
  if (previewVideo) {
    previewVideo.muted = false;
    previewVideo.volume = 0.6;
  }
  if (!audio) return null;
  // The opening scene intentionally delays speech until the parent boundary and
  // name are visible. Start the element muted inside the click gesture so the
  // later synchronized unmute is not rejected by browser autoplay policy.
  audio.muted = true;
  const range = sceneNarrationRange(scene);
  if (range && audio.readyState >= 1) {
    try { audio.currentTime = Math.max(0, Number(range.start || 0)); }
    catch { /* The metadata listener in playPreviewNarration will seek again. */ }
  }
  playAudioElement(audio);
  return audio;
}

function sceneNarrationRange(scene) {
  return state.renderSpec?.sceneCueRanges?.find((item) => item.sceneId === scene?.id) || null;
}

// Render-spec cue ranges are measured from the start of the *narration*, and the
// compositor places that narration after two lead-ins: the cover still, then a
// silent gap at the head of the map timeline. That gap is written out as
// `narrationStartSeconds` in `data/regions/<id>.timeline.json` and the render spec
// now carries the same number as `opening.narrationLeadSeconds`; the playhead has
// to add both, or every scene reads its position one gap earlier than the frame the
// export puts it on.
//
// It used to guess the gap from `openingDescentSeconds`, which is 0.35 s short of
// what the child-tour builder writes (it starts speech on the parent boundary pen
// draw, not at the end of the descent). The fallback stays for specs fetched from
// an older server build.
function timelineOffsetSeconds() {
  if (!state.project) return 0;
  const cover = Number(state.renderSpec?.cover?.introSeconds ?? state.project.cover?.introSeconds ?? 0);
  const lead = state.renderSpec?.opening?.narrationLeadSeconds;
  if (typeof lead === "number" && Number.isFinite(lead)) return cover + lead;
  const descent = Number(state.renderSpec?.opening?.descentSeconds ?? state.project.template?.openingDescentSeconds ?? 0);
  return cover + descent;
}

function sceneStartSeconds(scene) {
  if (!scene) return 0;
  if (scene.section === "cover") return 0;
  const offset = timelineOffsetSeconds();
  const cueRange = sceneNarrationRange(scene);
  if (cueRange) return offset + Math.max(0, Number(cueRange.start || 0));
  const sceneIndex = state.project?.scenes?.findIndex((item) => item.id === scene.id) ?? -1;
  if (sceneIndex <= 0) return offset;
  // The cover is scene 0 and `sceneDuration` returns the intro for it, so summing
  // the raw prefix would charge the cover twice on top of the offset.
  return offset + state.project.scenes.slice(0, sceneIndex)
    .filter((item) => item.section !== "cover")
    .reduce((elapsed, item) => elapsed + sceneDuration(item), 0);
}

function updatePlayhead(scene = selectedScene()) {
  state.playheadSeconds = sceneStartSeconds(scene);
  if ($("timecode")) $("timecode").textContent = `${formatTime(state.playheadSeconds)} / ${formatTime(totalDuration())}`;
}

function sceneAnnotationWindows() {
  if (!state.renderSpec || !state.project) return [];
  return state.project.scenes
    .filter((scene) => scene.imageryAnnotation === true)
    .map((scene) => {
      const range = state.renderSpec.sceneCueRanges.find((candidate) => candidate.sceneId === scene.id);
      return range ? { sceneId: scene.id, start: Number(range.start), end: Number(range.end) } : null;
    })
    .filter(Boolean);
}

// The editor preview parks on ONE scene's establishing frame, while the windows
// above are absolute positions on the finished film's clock. Overview scenes sit
// between 29 s and 87 s, but the preview frame is drawn at presentation ≈ 0–5 s
// (the opening replay) or at whatever clock the last tour stop left behind, so a
// window comparison can never match and the 注记 checkbox looked dead. In the
// editor the annotation therefore follows the SELECTED scene's own toggle; the
// film keeps using the precise `sceneCueRanges` windows via `sceneAnnotationWindows`.
function previewAnnotationWindows(scene = selectedScene()) {
  if (!scene) return [];
  return scene.imageryAnnotation === true
    ? [{ sceneId: scene.id, start: 0, end: Number.MAX_SAFE_INTEGER }]
    : [];
}

// Posted on its own so a plain selection change (no replay, no tour message)
// still flips the labels. Ordering matters: tour/opening messages carry the film
// windows, so this has to be sent after them.
function pushPreviewAnnotationWindows() {
  if ($("cesiumPreview").hidden) return;
  $("cesiumPreview").contentWindow?.postMessage({
    type: "geo-video-studio",
    action: "set-annotations",
    annotationWindows: previewAnnotationWindows()
  }, CESIUM_PREVIEW_ORIGIN);
}


function openingPreviewSettings() {
  return {
    ...(state.renderSpec?.opening || {
      descentSeconds: state.project?.template?.openingDescentSeconds,
      startHeightMeters: state.project?.template?.openingStartHeightMeters,
      startPitchDegrees: state.project?.template?.openingStartPitchDegrees,
      cloudDeckHeightMeters: state.project?.template?.cloudDeckHeightMeters,
      cloudAlphaPeak: state.project?.template?.cloudAlphaPeak
    }),
    editorFastPreview: true,
    skipDescent: false,
    revealDelaySeconds: STUDIO_OPENING_PREVIEW_TIMING.revealDelaySeconds,
    revealSeconds: STUDIO_OPENING_PREVIEW_TIMING.revealSeconds,
    settleSeconds: STUDIO_OPENING_PREVIEW_TIMING.settleSeconds,
    annotationWindows: previewAnnotationWindows()
  };
}

function openingNarrationDelaySeconds(scene) {
  if (!isOpeningScene(scene)) return 0;
  const descentSeconds = Math.max(0, Number(openingPreviewSettings().descentSeconds || 0));
  return descentSeconds + STUDIO_OPENING_PREVIEW_TIMING.revealDelaySeconds;
}

function openingSubtitleDelaySeconds(scene) {
  // The first subtitle and narration share the boundary pen-down beat.
  return openingNarrationDelaySeconds(scene);
}

function seekPreviewAudio(audio, target, onReady) {
  const token = ++state.previewAudioSeekToken;
  const finish = () => {
    if (token !== state.previewAudioSeekToken || audio !== state.previewAudio) return;
    onReady();
  };
  const applySeek = () => {
    if (token !== state.previewAudioSeekToken || audio !== state.previewAudio) return;
    const maximum = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : target;
    const expected = Math.max(0, Math.min(maximum, target));
    if (!audio.seeking && Math.abs(audio.currentTime - expected) <= 0.15) return finish();
    const handleSeeked = () => finish();
    audio.addEventListener("seeked", handleSeeked, { once: true });
    try {
      audio.currentTime = expected;
      if (!audio.seeking && Math.abs(audio.currentTime - expected) <= 0.15) {
        audio.removeEventListener("seeked", handleSeeked);
        finish();
      }
    } catch {
      audio.removeEventListener("seeked", handleSeeked);
      audio.addEventListener("canplay", applySeek, { once: true });
    }
  };
  if (audio.readyState >= 1) applySeek();
  else audio.addEventListener("loadedmetadata", applySeek, { once: true });
}

function playPreviewNarration(scene, preserveContinuity = false, delaySeconds = 0) {
  const audio = ensurePreviewAudio();
  if (!audio || !scene) return;
  if (scene.section === "cover") {
    // Keep the click-unlocked element running silently across the cover so the
    // first narrated scene can start automatically and remain synchronized.
    audio.muted = true;
    if (state.playTimer && audio.paused) playAudioElement(audio);
    else if (!state.playTimer) audio.pause();
    return;
  }
  const range = sceneNarrationRange(scene);
  if (!range) return;
  const target = Math.max(0, Number(range.start || 0));
  const start = () => {
    const resume = () => {
      if (selectedScene()?.id !== scene.id || !state.playTimer) return;
      audio.muted = false;
      playAudioElement(audio);
      syncPreviewSubtitlesToAudio(scene, audio);
    };
    if (!preserveContinuity || audio.paused || Math.abs(audio.currentTime - target) > 0.9) seekPreviewAudio(audio, target, resume);
    else resume();
  };
  clearTimeout(state.narrationStartTimer);
  if (delaySeconds > 0) {
    audio.muted = true;
    // The gesture-unlock play call may already have started the media clock.
    // Park it at the cue start so the delayed opening never skips narration.
    audio.pause();
    try { audio.currentTime = target; }
    catch { /* seekPreviewAudio will apply the exact target when metadata is ready. */ }
  }
  state.narrationStartTimer = setTimeout(() => {
    if (selectedScene()?.id !== scene.id || !state.playTimer) return;
    if (audio.readyState >= 1) start();
    else audio.addEventListener("loadedmetadata", start, { once: true });
  }, Math.max(0, delaySeconds) * 1000);
}
function assetById(id) { return state.project?.assets.find((asset) => asset.id === id); }
function assetUrl(asset) { return !asset ? "" : asset.path.startsWith("/") ? asset.path : `/project-assets/${asset.path.split("/").map(encodeURIComponent).join("/")}`; }

/* ---------- Asset library helpers (metadata, search, grouping, undo) ---------- */

const MAX_ASSET_UNDO = 40;
function assetKind(asset) {
  if (asset?.type === "video") return "视频";
  // An animated GIF is a picture to every code path that stores it, but calling
  // it 图片 hides the one thing the operator chose it for.
  return /\.gif$/i.test(String(asset?.path || "")) ? "动图" : "图片";
}
function assetSourceLabel(asset) {
  if (!asset) return "";
  if (asset.poi?.childName) return `POI · ${asset.poi.childName}`;
  if (asset.poi?.poiName) return `POI · ${asset.poi.poiName}`;
  return "上传";
}
function assetSourceGroup(asset) { return asset.poi ? "poi" : "upload"; }
function touchAsset(assetId) { if (assetId) state.assetTouch[assetId] = Date.now(); }
function assetSearchText(asset) {
  if (!asset) return "";
  return [asset.name, asset.alt, asset.poi?.poiName, asset.poi?.poiType, asset.poi?.childName, assetSourceLabel(asset), assetKind(asset)]
    .filter(Boolean).join(" ").toLowerCase();
}
function sceneAssetUsageCount(assetId) {
  return (state.project?.scenes ?? []).reduce((total, scene) => total + (scene.placements?.some((p) => p.assetId === assetId) ? 1 : 0), 0);
}
function sceneAssetUsageList(assetId, limit = 3) {
  return (state.project?.scenes ?? [])
    .filter((scene) => scene.placements?.some((p) => p.assetId === assetId))
    .map((scene) => scene.childName || scene.title || scene.id)
    .slice(0, limit);
}
function assetMatchesScene(asset, scene) {
  if (!asset || !scene || scene.section !== "child") return false;
  const assetChildId = String(asset.scope?.childId || asset.poi?.childId || "");
  const sceneChildId = String(scene.childId || "");
  if (assetChildId && sceneChildId) return assetChildId === sceneChildId;
  const assetChildName = String(asset.poi?.childName || "").trim();
  const sceneChildName = String(scene.childName || scene.title || "").trim();
  return Boolean(assetChildName && sceneChildName && assetChildName === sceneChildName);
}
function assetGroupKey(asset) {
  const poiId = String(asset.poi?.poiId || "").trim();
  if (poiId) return `poi:${asset.poi?.provider || "poi"}:${poiId}`;
  return `name:${asset.type || "image"}:${String(asset.name || "").trim().toLowerCase()}`;
}
function sceneAssetSnapshot(scene) {
  return { assetIds: [...(scene?.assetIds || [])], placements: structuredClone(scene?.placements || []), assetDisplayCount: scene?.assetDisplayCount };
}
function applySceneAssetSnapshot(scene, snapshot) {
  if (!scene) return;
  scene.assetIds = [...(snapshot?.assetIds || [])];
  scene.placements = structuredClone(snapshot?.placements || []);
  scene.assetDisplayCount = snapshot?.assetDisplayCount;
}

/* 只有显式勾了「用于成片」的图才进片子 —— 素材卡片上的 ✓ 是唯一依据。
   旧数据的 `assetDisplayCount`（成片显示前 N 张）不再参与选片：它会让一个在
   编辑器里看着「没有图片」的场景，在成片里硬塞进一张。 */
function sceneAssetDisplayCount(scene) {
  return (scene?.placements || []).filter((placement) => placement.includeInRender === true).length;
}

function sceneAssetIncluded(scene, item, index) {
  return item.includeInRender === true;
}

function materializeSceneAssetSelection(scene) {
  if (!scene) return;
  scene.placements = (scene.placements || []).map((placement) => ({
    ...placement,
    includeInRender: placement.includeInRender === true
  }));
  delete scene.assetDisplayCount;
}

function prioritizeIncludedSceneAssets(scene) {
  if (!scene?.placements?.length) return;
  const included = [];
  const excluded = [];
  for (const placement of scene.placements) {
    (placement.includeInRender === true ? included : excluded).push(placement);
  }
  scene.placements = [...included, ...excluded];
  const orderedIds = scene.placements.map((placement) => placement.assetId);
  scene.assetIds = [...orderedIds, ...(scene.assetIds || []).filter((assetId) => !orderedIds.includes(assetId))];
}

function setSceneAssetIncluded(assetId, included) {
  const scene = selectedScene(); if (!scene) return;
  const placement = (scene.placements || []).find((item) => item.assetId === assetId);
  if (!placement || placement.includeInRender === included) return;
  pushAssetUndo({ kind: "include", sceneId: scene.id, prev: sceneAssetSnapshot(scene) });
  materializeSceneAssetSelection(scene);
  scene.placements.find((item) => item.assetId === assetId).includeInRender = included;
  prioritizeIncludedSceneAssets(scene);
  markDirty(); render();
  toast(included ? "已加入成片" : "已从成片中移出（素材仍保留）");
}

/* ---------------------------------------------------------------------------
   素材播放顺序：拖拽、上移/下移
   ---------------------------------------------------------------------------
   `scene.placements` 的顺序就是成片里图片卡出现的顺序（`selectSceneAssetsForRender`
   按它取 includeInRender 的那些），所以排序只需要重排这个数组。

   两条不能碰的红线：
   1. **不要调 `prioritizeIncludedSceneAssets()`**。它把 included 全部提到前面，
      于是「把未选用的第 3 张移到第 2 张前面」会被它一把推回队尾，用户看到的
      顺序和实际存下来的不一样。那个函数只服务于「切换是否用于成片」。
   2. **assetIds 必须跟着 placements 一起改**，它是同一批素材的另一份顺序记录，
      漂了会让素材库面板按错误顺序回填。 */
function moveSceneAsset(assetId, targetIndex) {
  const scene = selectedScene();
  if (!scene) return false;
  const placements = scene.placements || [];
  const from = placements.findIndex((item) => item.assetId === assetId);
  if (from < 0) return false;
  const to = Math.max(0, Math.min(placements.length - 1, targetIndex));
  if (to === from) return false;
  materializeSceneAssetSelection(scene);
  pushAssetUndo({ kind: "reorder", sceneId: scene.id, assetId, prev: sceneAssetSnapshot(scene) });
  const [moved] = scene.placements.splice(from, 1);
  scene.placements.splice(to, 0, moved);
  const orderedIds = scene.placements.map((placement) => placement.assetId);
  scene.assetIds = [...orderedIds, ...(scene.assetIds || []).filter((id) => !orderedIds.includes(id))];
  state.selectedAssetId = assetId;
  markDirty();
  render();
  return true;
}

/** Relative moves used by the ↑/↓ buttons and Alt+Arrow keys. */
function nudgeSceneAsset(assetId, delta) {
  const scene = selectedScene();
  if (!scene) return;
  const index = (scene.placements || []).findIndex((item) => item.assetId === assetId);
  if (index < 0) return;
  if (!moveSceneAsset(assetId, index + delta)) return;
  const position = index + delta + 1;
  toast(`已移到第 ${position} 位${position === 1 ? "，并成为该场景的首图" : ""}`);
}

/**
 * Wire drag-and-drop reordering on the bound-asset list.
 *
 * Uses the HTML5 drag events rather than pointer events so it composes with the
 * existing scene-list dragging and stays keyboard-free of extra state. The
 * insertion point is decided by whether the pointer is in the top or bottom half
 * of the hovered card, which is what makes "drop onto the 2nd card" mean "become
 * the 2nd card" instead of a coin flip.
 */
function bindSceneAssetReordering(scene) {
  const list = $("sceneBoundAssets");
  if (!list || !scene) return;
  const cards = [...list.querySelectorAll(".scene-bound-asset")];
  const placed = (card) => scene.placements.findIndex((item) => item.assetId === card.dataset.boundAssetId);
  let draggingId = null;
  const clearMarks = () => cards.forEach((card) => card.classList.remove("drop-before", "drop-after", "dragging"));
  for (const card of cards) {
    card.draggable = true;
    // Buttons inside the card would otherwise start a drag of their own text.
    card.querySelectorAll("button").forEach((button) => { button.draggable = false; });
    card.addEventListener("dragstart", (event) => {
      draggingId = card.dataset.boundAssetId;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggingId);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => { draggingId = null; clearMarks(); });
    card.addEventListener("dragover", (event) => {
      if (!draggingId || draggingId === card.dataset.boundAssetId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const box = card.getBoundingClientRect();
      const after = event.clientY > box.top + box.height / 2;
      card.classList.toggle("drop-after", after);
      card.classList.toggle("drop-before", !after);
    });
    card.addEventListener("dragleave", () => card.classList.remove("drop-before", "drop-after"));
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      const sourceId = draggingId || event.dataTransfer.getData("text/plain");
      const targetIndex = placed(card);
      const box = card.getBoundingClientRect();
      const after = event.clientY > box.top + box.height / 2;
      clearMarks();
      draggingId = null;
      if (!sourceId || targetIndex < 0) return;
      const from = scene.placements.findIndex((item) => item.assetId === sourceId);
      if (from < 0) return;
      // Dropping "after" a card that sits below the dragged one lands one slot
      // earlier once the source is lifted out of the list.
      let to = after ? targetIndex + 1 : targetIndex;
      if (from < to) to -= 1;
      if (!moveSceneAsset(sourceId, to)) return;
      toast(`已移到第 ${to + 1} 位${to === 0 ? "，并成为该场景的首图" : ""}`);
    });
  }
}

function setAllSceneAssetsIncluded(included) {
  const scene = selectedScene(); if (!scene) return;
  if (!(scene.placements || []).some((item) => item.includeInRender !== included)) return;
  pushAssetUndo({ kind: "include", sceneId: scene.id, prev: sceneAssetSnapshot(scene) });
  materializeSceneAssetSelection(scene);
  for (const placement of scene.placements || []) placement.includeInRender = included;
  prioritizeIncludedSceneAssets(scene);
  markDirty(); render();
  toast(included ? "当前场景素材已全部加入成片" : "已清空当前场景的成片图片选择");
}

function pushAssetUndo(record) {
  state.assetUndoStack.push({ ...record, projectId: state.project?.id });
  if (state.assetUndoStack.length > MAX_ASSET_UNDO) state.assetUndoStack.shift();
  renderAssetUndoState();
}
function renderAssetUndoState() {
  state.assetUndoStack = state.assetUndoStack.filter((record) => record.projectId === state.project?.id);
  const button = $("undoAssetButton");
  if (!button) return;
  const record = state.assetUndoStack.at(-1);
  const available = Boolean(record && record.projectId === state.project?.id);
  button.disabled = !available;
  button.textContent = available ? "撤销素材操作" : "暂无可撤销操作";
  button.title = available ? `${assetUndoLabel(record)}（Ctrl+Z）` : "当前方案没有可撤销的素材操作";
}
function assetUndoLabel(record) {
  if (record.kind === "bind") return `撤销绑定「${record.assetName || ""}」`;
  if (record.kind === "remove") return `恢复被移除的「${record.assetName || ""}」`;
  if (record.kind === "include") return "恢复之前的成片选图";
  if (record.kind === "primary") return `恢复之前的首图顺序`;
  if (record.kind === "reorder") return `恢复之前的素材播放顺序`;
  if (record.kind === "replace") return `撤销替换（恢复「${record.assetName || ""}」）`;
  if (record.kind === "uploadBind") return `撤销上传并绑定 ${record.assetIds?.length || 0} 个素材`;
  if (record.kind === "removeProject") return `恢复已删除素材 ${record.assetNames?.length ? `「${record.assetNames.slice(0, 2).join("、")}${record.assetNames.length > 2 ? "…" : ""}」` : ""}`;
  return "撤销素材操作";
}
function assetUndoOnce() {
  const record = state.assetUndoStack.pop();
  if (!record) return toast("没有可撤销的素材操作");
  const project = state.project;
  if (!project || record.projectId !== project.id) {
    renderAssetUndoState();
    return toast("该撤销记录属于其它方案，未更改当前方案");
  }
  if (record.kind === "removeProject") {
    // Restore the removed project-library entries and their scene bindings.
    for (const snap of record.sceneSnapshots || []) applySceneAssetSnapshot(project.scenes.find((s) => s.id === snap.sceneId), snap);
    const restored = new Set(record.assets?.map((a) => a.id) || []);
    project.assets = [...(record.assets || []), ...project.assets.filter((a) => !restored.has(a.id))];
  } else if (record.kind === "uploadBind") {
    const scene = project.scenes.find((s) => s.id === record.sceneId);
    applySceneAssetSnapshot(scene, record.prev);
    for (const assetId of record.assetIds || []) {
      const stillUsed = (project.scenes ?? []).some((s) => s.placements?.some((p) => p.assetId === assetId));
      if (!stillUsed) project.assets = project.assets.filter((a) => a.id !== assetId);
    }
  } else {
    applySceneAssetSnapshot(project.scenes.find((s) => s.id === record.sceneId), record.prev);
  }
  state.sceneAssetPickerOpen = false;
  state.sceneAssetPickerReplaceId = null;
  state.sceneAssetReplaceCandidateId = null;
  markDirty(); render();
  toast(assetUndoLabel(record));
}

function pickerAssetsForScene(scene) {
  const query = String(state.sceneAssetSearch || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const boundIds = new Set((scene?.placements || []).map((p) => p.assetId));
  const list = (state.project?.assets || []).filter((asset) => {
    if (state.sceneAssetGroup === "upload" && assetSourceGroup(asset) !== "upload") return false;
    if (state.sceneAssetGroup === "poi" && assetSourceGroup(asset) !== "poi") return false;
    if (state.sceneAssetUnboundOnly && boundIds.has(asset.id)) return false;
    if (state.sceneAssetScope === "current" && scene?.section === "child" && !assetMatchesScene(asset, scene)) return false;
    if (query.length) {
      const text = assetSearchText(asset);
      if (!query.every((part) => text.includes(part))) return false;
    }
    return true;
  });
  list.sort((a, b) => {
    if (state.sceneAssetSort === "name") return String(a.name || "").localeCompare(String(b.name || ""), "zh");
    if (state.sceneAssetSort === "usage") return sceneAssetUsageCount(b.id) - sceneAssetUsageCount(a.id)
      || String(a.name || "").localeCompare(String(b.name || ""), "zh");
    if (state.sceneAssetSort === "recent") return (state.assetTouch[b.id] || 0) - (state.assetTouch[a.id] || 0)
      || String(a.name || "").localeCompare(String(b.name || ""), "zh");
    return Number(assetMatchesScene(b, scene)) - Number(assetMatchesScene(a, scene))
      || Number(!boundIds.has(b.id)) - Number(!boundIds.has(a.id))
      || (state.assetTouch[b.id] || 0) - (state.assetTouch[a.id] || 0)
      || String(a.name || "").localeCompare(String(b.name || ""), "zh");
  });
  return list;
}

function assetMediaTag(asset, { eager = false } = {}) {
  const url = assetUrl(asset);
  if (asset.type === "video") return `<video src="${url}" data-asset-thumb muted playsinline preload="metadata"></video>`;
  return `<img src="${url}" data-asset-thumb alt="${escapeHtml(asset.alt || asset.name || "")}"${eager ? "" : " loading=\"lazy\""} />`;
}
/* A broken thumbnail must never become an unexplained black square. The card in
 * the bound-asset list has no `.spa-media`-style wrapper (its image is a direct
 * child of the card), so the old lookup returned null and the function hid the
 * <img> and bailed out *before* placing anything -- leaving the card's dark
 * background showing, which reads as "the picture went black". Resolve a wrapper
 * first, and only hide the media once there is somewhere to put the notice. */
function showMediaMissing(el) {
  if (!el || el.dataset.broken === "1") return;
  const wrap = el.closest(".spa-media, .lib-media, .asset-preview-media") || el.parentElement;
  if (!wrap) return;
  el.dataset.broken = "1";
  el.style.display = "none";
  if (wrap.querySelector(".media-missing")) return;
  const placeholder = document.createElement("div");
  placeholder.className = "media-missing";
  placeholder.textContent = "素材缺失";
  wrap.appendChild(placeholder);
}
function bindAssetMedia(root = document) {
  root.querySelectorAll("img[data-asset-thumb]").forEach((img) => {
    if (img.dataset.mediaBound === "1") return;
    img.dataset.mediaBound = "1";
    const reportDims = () => {
      const target = img.closest("[data-dims-target]")?.querySelector("[data-dims]");
      if (target && img.naturalWidth > 0) target.textContent = `${img.naturalWidth}×${img.naturalHeight}`;
    };
    img.addEventListener("load", reportDims);
    img.addEventListener("error", () => showMediaMissing(img), { once: true });
    /* Re-rendering the list reassigns `innerHTML`, so a freshly created <img>
       can already report `complete === true` while `naturalWidth` is still 0 --
       the decode has not been committed yet. Treating that as "broken" hid a
       perfectly good picture for the rest of the card's life. Defer the verdict
       to the next task, by which point the load/error listener has run and the
       only images still at width 0 are the genuinely broken ones. */
    if (img.complete && img.naturalWidth > 0) reportDims();
    else if (img.complete) setTimeout(() => { if (img.naturalWidth === 0) showMediaMissing(img); }, 0);
  });
  root.querySelectorAll("video[data-asset-thumb]").forEach((video) => {
    if (video.dataset.mediaBound === "1") return;
    video.dataset.mediaBound = "1";
    const reportDuration = () => {
      const target = video.closest("[data-dims-target]")?.querySelector("[data-dims]");
      if (target && Number.isFinite(video.duration) && video.duration > 0) target.textContent = `${Math.round(video.duration)}s`;
    };
    video.addEventListener("loadedmetadata", reportDuration);
    video.addEventListener("error", () => showMediaMissing(video), { once: true });
  });
}

/* ---------- Bound scene-asset card ---------- */
function boundAssetCardHtml(scene, item, index) {
  const asset = assetById(item.assetId);
  if (!asset) return "";
  const source = item.poi ? `${asset.poi?.childName || "POI"} · 高德` : item.fit && item.animation ? `${item.fit} · ${item.animation}` : item.fit || "";
  const included = sceneAssetIncluded(scene, item, index);
  const exportIndex = included
    ? (scene.placements || []).slice(0, index + 1).filter((placement, placementIndex) => sceneAssetIncluded(scene, placement, placementIndex)).length
    : 0;
  const isPrimary = index === 0;
  /* The kind line mixes a variable-length label (the asset kind and its source,
     which is as long as the place name) with the export badge, which is short
     but the part that actually carries state. Kept in one bare text node, the
     two shared a single nowrap line, so a long place name pushed the badge out
     past the card's clipped edge and the badge vanished first. The label is
     wrapped so it ellipsises on its own and the badge always keeps its room. */
  const kindLabel = `${assetKind(asset)} · ${assetSourceLabel(asset)}`;
  const total = (scene.placements || []).length;
  return `<div class="scene-bound-asset ${state.selectedAssetId === item.assetId ? "selected" : ""} ${included ? "included-in-export" : ""}" data-bound-asset-id="${escapeHtml(item.assetId)}" tabindex="0" role="group" aria-label="素材 ${escapeHtml(asset.name)}，第 ${index + 1} / ${total} 张，拖动可调整播放顺序">
    <span class="scene-bound-order" title="播放顺序；拖动卡片可调整">${index + 1}</span>
    ${asset.type === "video" ? `<video src="${assetUrl(asset)}" data-asset-thumb muted playsinline preload="metadata"></video>` : `<img src="${assetUrl(asset)}" data-asset-thumb loading="lazy" alt="${escapeHtml(item.alt || asset.name)}"/>`}
    <div class="scene-bound-asset-copy">
      <div class="scene-bound-asset-title" title="${escapeHtml(asset.name)}"><b>${escapeHtml(asset.name)}</b><small title="${escapeHtml(source)}">${escapeHtml(source)}</small></div>
      <small class="asset-kind"><span class="asset-kind-text" title="${escapeHtml(kindLabel)}">${escapeHtml(kindLabel)}</span>${included ? `<em class="scene-bound-export-badge">成片 ${exportIndex}</em>` : ""}</small>
    </div>
    <span class="scene-bound-actions">
      <button type="button" class="scene-bound-export-toggle ${included ? "active" : ""}" data-toggle-scene-asset-export="${escapeHtml(item.assetId)}" aria-pressed="${included}" aria-label="${included ? "取消用于成片" : "选择用于成片"}：${escapeHtml(asset.name)}" title="${included ? "✓ 用于成片（点击取消，素材仍保留）" : "用于成片"}">✓</button>
      <button type="button" class="scene-bound-primary-action ${isPrimary ? "active" : ""}" data-set-primary-scene-asset="${escapeHtml(item.assetId)}" aria-label="设为首图：${escapeHtml(asset.name)}" title="${isPrimary ? "当前播放顺序中的第一张" : "设为首图：自动加入成片，并移动到播放顺序第一张"}" ${isPrimary ? "disabled" : ""}>★</button>
      <button type="button" class="scene-bound-remove" data-remove-scene-asset="${escapeHtml(item.assetId)}" aria-label="仅从当前场景移除：${escapeHtml(asset.name)}" title="仅从当前场景移除（Ctrl+Z 可撤销）">✕</button>
    </span>
  </div>`;
}

/* ---------- Picker card ---------- */
function pickerAssetCardHtml(asset, scene) {
  const replaceMode = Boolean(state.sceneAssetPickerReplaceId);
  const isBound = (scene?.placements || []).some((p) => p.assetId === asset.id);
  const isOriginal = replaceMode && state.sceneAssetPickerReplaceId === asset.id;
  const isCandidate = replaceMode && state.sceneAssetReplaceCandidateId === asset.id;
  const badge = isOriginal ? `<span class="spa-badge original">当前素材</span>`
    : isBound ? `<span class="spa-badge">本场景已用</span>` : "";
  return `<div class="scene-picker-asset ${isBound ? "bound" : ""} ${isCandidate ? "candidate" : ""} ${isOriginal ? "original" : ""}"
    data-picker-asset-id="${escapeHtml(asset.id)}" tabindex="0" role="button"
    aria-label="${isOriginal ? "取消替换，保留当前素材" : "选择素材 " + escapeHtml(asset.name)}">
    <div class="spa-media">${assetMediaTag(asset)}
      ${asset.type === "video" ? '<span class="spa-type">视频</span>' : ""}
      ${badge}
      <button type="button" class="spa-zoom" data-preview-from-card="${escapeHtml(asset.id)}" title="查看大图/信息">⤢</button>
    </div>
    <div class="spa-copy" data-dims-target="">
      <b>${escapeHtml(asset.name)}</b>
      <small>${assetKind(asset)} · ${escapeHtml(assetSourceLabel(asset))}</small>
      <small class="spa-meta"><i data-dims="">${isBound ? "本场景已用" : ""}</i></small>
    </div>
  </div>`;
}

function pickerEmptyHtml() {
  const assets = state.project?.assets || [];
  if (!assets.length) return `<div class="spa-empty-filtered">素材库为空。<button type="button" data-open-asset-library-empty>前往素材库上传</button></div>`;
  return `<div class="spa-empty-filtered">没有匹配的素材，试试调整搜索或筛选条件。</div>`;
}

function pickerAssetChosen(picked) {
  const scene = selectedScene(); if (!scene || scene.section === "cover") return;
  if (state.sceneAssetPickerReplaceId) {
    if (picked === state.sceneAssetPickerReplaceId) {
      // Clicking the original asset cancels the whole replace flow.
      state.sceneAssetPickerReplaceId = null;
      state.sceneAssetReplaceCandidateId = null;
      state.sceneAssetApplyRecommended = false;
      state.sceneAssetPickerOpen = false;
      state.selectedAssetId = picked;
      render();
      focusSceneAssetEditor();
      toast("已取消替换");
      return;
    }
    // Fast replace: the Replace button opens the picker and the next material
    // click completes the swap. Ctrl/Cmd+Z and the visible Undo button provide
    // a quick recovery path for accidental selections.
    replaceBoundAsset(state.sceneAssetPickerReplaceId, picked, false);
    return;
  }
  // A card already bound to this scene selects it for editing (fit/animation)
  // instead of adding a duplicate placement.
  const alreadyBound = (scene.placements || []).some((p) => p.assetId === picked);
  if (alreadyBound) {
    state.selectedAssetId = picked;
    state.sceneAssetPickerOpen = false;
    render();
    focusSceneAssetEditor();
    toast("已选中该素材，可在下方“素材画面”调整参数");
    return;
  }
  bindAssetToScene(picked);
}

function renderPickerFooter() {
  const footer = $("sceneAssetPickerFooter");
  if (!footer || footer.hidden) return;
  const replaceMode = Boolean(state.sceneAssetPickerReplaceId);
  if (!replaceMode) {
    const scene = selectedScene();
    const total = state.project?.assets?.length || 0;
    const bound = scene?.placements?.length || 0;
    footer.innerHTML = `<div class="scene-picker-count">本场景已用 <b>${bound}</b> 个素材 · 素材库共 ${total} 个${state.assetUndoStack.length ? ' · <span class="undo-hint">支持 Ctrl+Z 撤销素材操作</span>' : ""}</div>`;
    return;
  }
  const original = assetById(state.sceneAssetPickerReplaceId);
  if (!original) return;
  footer.innerHTML = `<div class="scene-picker-count">点击任意素材即可立即替换「${escapeHtml(original.name)}」，并保留原有裁切与动画。误点可按 <span class="undo-hint">Ctrl+Z</span> 撤销。</div>`;
}

function focusPickerListFirst() {
  const list = $("sceneAssetPickerList");
  const first = list?.querySelector(".scene-picker-asset:not([hidden])");
  if (first) { try { first.focus({ preventScroll: false }); } catch (_) { /* noop */ } return; }
  const search = $("sceneAssetSearch");
  if (search) { try { search.focus({ preventScroll: false }); } catch (_) { /* noop */ } }
}
function focusSceneAssetEditor() {
  const scene = selectedScene();
  const card = scene ? $("sceneBoundAssets")?.querySelector(`[data-bound-asset-id="${CSS.escape(scene.placements?.[0]?.assetId || "")}"]`) : null;
  const fallback = $("toggleSceneAssetPicker");
  if (card) { try { card.focus({ preventScroll: true }); } catch (_) { /* noop */ } }
  else if (fallback) { try { fallback.focus({ preventScroll: true }); } catch (_) { /* noop */ } }
}

/* ---------- Asset library modal ---------- */
function setAssetLibraryOpen(open) {
  if (open) {
    rememberFocusForModal();
    state.assetLibraryOpen = true;
    $("assetLibraryModal").hidden = false;
    $("assetLibraryTitle").textContent = `${state.project?.regionName || state.project?.cover?.town || state.project?.regionId || "当前行政区"} · 素材库`;
    renderAssetLibrary();
    $("closeAssetLibrary").focus();
  } else {
    state.assetLibraryOpen = false;
    state.assetLibrarySelected.clear();
    restoreFocusAfterModal();
    $("assetLibraryModal").hidden = true;
  }
}

function libraryAssetsForSearch() {
  const query = String(state.assetLibrarySearch || "").trim().toLowerCase();
  const list = (state.project?.assets || []).filter((asset) => {
    const usage = sceneAssetUsageCount(asset.id);
    if (query && !assetSearchText(asset).includes(query)) return false;
    if (state.assetLibrarySource !== "all" && assetSourceGroup(asset) !== state.assetLibrarySource) return false;
    if (state.assetLibraryUsage === "unused" && usage !== 0) return false;
    if (state.assetLibraryUsage === "used" && usage === 0) return false;
    if (state.assetLibraryUsage === "multi" && usage < 2) return false;
    return true;
  });
  list.sort((a, b) => {
    if (state.assetLibrarySort === "name") return String(a.name || "").localeCompare(String(b.name || ""), "zh");
    if (state.assetLibrarySort === "usage") return sceneAssetUsageCount(b.id) - sceneAssetUsageCount(a.id)
      || String(a.name || "").localeCompare(String(b.name || ""), "zh");
    if (state.assetLibrarySort === "source") return assetSourceLabel(a).localeCompare(assetSourceLabel(b), "zh")
      || String(a.name || "").localeCompare(String(b.name || ""), "zh");
    return (state.assetTouch[b.id] || 0) - (state.assetTouch[a.id] || 0)
      || String(a.name || "").localeCompare(String(b.name || ""), "zh");
  });
  return list;
}

function libAssetHtml(asset, groupPosition = "") {
  const usage = sceneAssetUsageCount(asset.id);
  const usageList = sceneAssetUsageList(asset.id, 4);
  const usageText = usage
    ? `本方案 ${usage} 个场景使用${usageList.length ? "：" + usageList.join("、") : ""}`
    : "尚未绑定任何场景";
  return `<div class="lib-asset ${state.assetLibrarySelected.has(asset.id) ? "selected" : ""}" data-dims-target data-lib-asset-id="${escapeHtml(asset.id)}">
    <div class="lib-media">${assetMediaTag(asset)}
      <label class="lib-select" title="选择素材"><input type="checkbox" data-lib-select="${escapeHtml(asset.id)}" ${state.assetLibrarySelected.has(asset.id) ? "checked" : ""}/><span></span></label>
      <span class="spa-type">${assetKind(asset)}</span>
      ${groupPosition ? `<span class="lib-group-position">${escapeHtml(groupPosition)}</span>` : ""}
      <button type="button" class="spa-zoom" data-lib-preview="${escapeHtml(asset.id)}" title="预览">⤢</button>
    </div>
    <div class="lib-name" title="${escapeHtml(asset.name)}">${escapeHtml(asset.name)}</div>
    <div class="lib-meta">${escapeHtml(usageText)}<br/>${assetKind(asset)} · ${escapeHtml(assetSourceLabel(asset))} · <i data-dims=""></i></div>
    <div class="lib-actions">
      <button type="button" data-lib-rename="${escapeHtml(asset.id)}" title="重命名素材（同步到素材库与全部方案）">重命名</button>
      <button type="button" class="danger" data-lib-delete="${escapeHtml(asset.id)}" title="永久删除文件并移出所有方案中的场景绑定">永久删除</button>
    </div>
  </div>`;
}

function groupedLibraryHtml(assets) {
  const groups = new Map();
  for (const asset of assets) {
    const key = assetGroupKey(asset);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(asset);
  }
  return [...groups.values()].map((items) => {
    if (items.length === 1) return libAssetHtml(items[0]);
    const first = items[0];
    const usage = new Set(items.flatMap((asset) => sceneAssetUsageList(asset.id, 999))).size;
    return `<details class="lib-group">
      <summary><span class="lib-group-thumb">${assetMediaTag(first)}</span><span class="lib-group-copy"><b>${escapeHtml(first.name)}</b><small>${items.length} 张同一地点照片 · ${usage ? `${usage} 个场景使用` : "尚未使用"}</small></span><span class="lib-group-count">${items.length} 张</span></summary>
      <div class="lib-group-items">${items.map((asset, index) => libAssetHtml(asset, `${index + 1}/${items.length}`)).join("")}</div>
    </details>`;
  }).join("");
}

function renderAssetLibraryBatchState() {
  const selected = state.assetLibrarySelected.size;
  $("clearAssetSelection").hidden = selected === 0;
  $("deleteSelectedAssets").disabled = selected === 0;
  $("deleteSelectedAssets").textContent = selected ? `永久删除（${selected}）` : "永久删除";
}

function renderAssetLibrary() {
  const host = $("assetLibraryList");
  if (!host) return;
  const total = state.project?.assets?.length || 0;
  const list = libraryAssetsForSearch();
  const groupCount = new Set(list.map(assetGroupKey)).size;
  $("assetLibraryCount").textContent = list.length === total ? `${total} 个素材 · ${groupCount} 组` : `${list.length}/${total} 个素材`;
  $("assetLibrarySource").value = state.assetLibrarySource;
  $("assetLibraryUsage").value = state.assetLibraryUsage;
  $("assetLibrarySort").value = state.assetLibrarySort;
  host.innerHTML = list.length
    ? groupedLibraryHtml(list)
    : `<div class="asset-library-empty">${total ? "没有匹配的素材，试试更换关键词。" : "素材库为空。点击右上角“上传素材”，或回到场景编辑点“+ 添加素材”上传。"}</div>`;
  renderAssetLibraryBatchState();
  bindAssetMedia(host);
}

async function removeAssetFromProjectLibrary(assetId) {
  const asset = assetById(assetId);
  if (!asset) return;
  const usageTotal = sceneAssetUsageCount(assetId);
  const usageList = sceneAssetUsageList(assetId, 6);
  const ok = await askConfirm({
    title: "永久删除素材",
    message: usageTotal
      ? `素材「${asset.name}」当前被本方案 ${usageTotal} 个场景使用${usageList.length ? "（" + usageList.join("、") + "）" : ""}。\n永久删除会移除所有方案中的引用和本机文件，无法撤销。若只是不想在当前场景使用，请返回场景选择“移除”。`
      : `确定永久删除素材「${asset.name}」？本机文件及其他方案中的引用也会被移除，无法撤销。`,
    okText: "永久删除"
  });
  if (!ok) return;
  const replaceId = state.sceneAssetPickerReplaceId;
  try {
    const result = await api(`/api/assets/${encodeURIComponent(assetId)}?force=1`, { method: "DELETE" });
    state.project.assets = state.project.assets.filter((item) => item.id !== assetId);
    state.assetLibrarySelected.delete(assetId);
    for (const scene of state.project.scenes) {
      scene.assetIds = (scene.assetIds || []).filter((value) => value !== assetId);
      scene.placements = (scene.placements || []).filter((placement) => placement.assetId !== assetId);
    }
    if (state.selectedAssetId === assetId) state.selectedAssetId = selectedScene()?.placements?.[0]?.assetId || null;
    if (state.assetPreviewId === assetId) setAssetPreviewOpen(false);
    if (replaceId === assetId) { state.sceneAssetPickerReplaceId = null; state.sceneAssetReplaceCandidateId = null; state.sceneAssetPickerOpen = false; }
    markDirty(); render();
    if (state.assetLibraryOpen) renderAssetLibrary();
    const otherCount = (result.detachedFrom || []).filter((id) => id !== state.project.id).length;
    const detached = otherCount ? `（同时移出其他 ${otherCount} 个方案的绑定）` : "";
    toast(`素材「${asset.name}」已删除${detached}`);
  } catch (error) {
    toastError(error.message);
  }
}

async function removeSelectedAssetsFromLibrary() {
  const ids = [...state.assetLibrarySelected].filter((id) => assetById(id));
  if (!ids.length) return;
  const used = ids.filter((id) => sceneAssetUsageCount(id) > 0);
  const ok = await askConfirm({
    title: "永久删除所选素材",
    message: `将永久删除 ${ids.length} 个本机素材文件${used.length ? `，其中 ${used.length} 个正在当前方案中使用` : ""}。所有方案中的相关引用也会被移除，且无法撤销。`,
    okText: `永久删除 ${ids.length} 个`
  });
  if (!ok) return;
  setProjectBusy(true, `正在删除 0/${ids.length} 个素材…`, "清理素材库");
  const deleted = [];
  const failed = [];
  try {
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      try {
        await api(`/api/assets/${encodeURIComponent(id)}?force=1`, { method: "DELETE" });
        deleted.push(id);
      } catch {
        failed.push(assetById(id)?.name || id);
      }
      setProjectBusy(true, `正在删除 ${index + 1}/${ids.length} 个素材…`, "清理素材库");
    }
    const removed = new Set(deleted);
    state.project.assets = state.project.assets.filter((asset) => !removed.has(asset.id));
    for (const scene of state.project.scenes) {
      scene.assetIds = (scene.assetIds || []).filter((id) => !removed.has(id));
      scene.placements = (scene.placements || []).filter((placement) => !removed.has(placement.assetId));
    }
    state.assetLibrarySelected.clear();
    if (removed.has(state.selectedAssetId)) state.selectedAssetId = selectedScene()?.placements?.[0]?.assetId || null;
    markDirty(); render(); renderAssetLibrary();
  } finally {
    // Same rule as openSavedProject: whoever shows the busy card hides it on
    // every exit, or a throw in the tail locks the editor behind the overlay.
    setProjectBusy(false);
  }
  if (failed.length) toastError(`已删除 ${deleted.length} 个，${failed.length} 个删除失败`);
  else toast(`已永久删除 ${deleted.length} 个素材`);
}

/* ---------- Asset rename modal ---------- */
function openAssetRename(assetId) {
  const asset = assetById(assetId);
  if (!asset) return;
  state.assetRenameContext = { id: assetId, name: asset.name };
  setAssetRenameOpen(true);
}
function setAssetRenameOpen(open) {
  if (open) {
    rememberFocusForModal();
    showAssetRenameError("");
    $("assetRenameTitle").textContent = "重命名素材";
    $("assetRenameName").value = state.assetRenameContext?.name || "";
    setTimeout(() => { $("assetRenameName").focus(); $("assetRenameName").select(); }, 0);
  } else {
    state.assetRenameContext = null;
    restoreFocusAfterModal();
  }
  $("assetRenameModal").hidden = !open;
}
function showAssetRenameError(message) {
  const node = $("assetRenameError");
  node.textContent = message; node.hidden = !message;
}
async function confirmAssetRename() {
  const ctx = state.assetRenameContext;
  if (!ctx) return;
  const name = String($("assetRenameName").value ?? "").trim();
  if (!name) { showAssetRenameError("素材名称不能为空"); $("assetRenameName").focus(); return; }
  setAssetRenameOpen(false);
  const local = assetById(ctx.id);
  if (local) {
    local.name = name;
    touchAsset(local.id);
    markDirty();
    render();
    // The global patch may touch many project snapshots and take a few
    // seconds. Update the open library immediately so rename never appears to
    // have been ignored while that durable synchronization is still running.
    if (state.assetLibraryOpen) renderAssetLibrary();
  }
  toast("名称已更新，正在同步全部方案…");
  try {
    await api(`/api/assets/${encodeURIComponent(ctx.id)}`, { method: "PATCH", body: JSON.stringify({ name }) });
    toast("素材已重命名");
  } catch (error) {
    toastError(`已在本方案重命名；素材库全局同步失败：${error.message}`);
  }
  if (state.assetLibraryOpen) renderAssetLibrary();
}

/* ---------- Asset quick-preview modal ---------- */
function setAssetPreviewOpen(open) {
  if (open) rememberFocusForModal();
  else { restoreFocusAfterModal(); $("assetPreviewVideo").pause(); }
  $("assetPreviewModal").hidden = !open;
  if (open) $("closeAssetPreview").focus();
}
function openAssetPreview(assetId, context = "picker") {
  const asset = assetById(assetId);
  if (!asset) return toast("素材不存在");
  state.assetPreviewId = assetId;
  const isVideo = asset.type === "video";
  const imageNode = $("assetPreviewMedia");
  const videoNode = $("assetPreviewVideo");
  videoNode.pause();
  imageNode.hidden = isVideo; videoNode.hidden = !isVideo;
  $("assetPreviewMissing").hidden = true;
  $("assetPreviewMetaName").textContent = asset.name;
  $("assetPreviewTitle").textContent = "素材预览";
  $("assetPreviewMetaDetail").textContent = `${assetKind(asset)} · ${assetSourceLabel(asset)}`;
  const usage = sceneAssetUsageCount(asset.id);
  const note = usage ? `本方案 ${usage} 个场景使用中。` : "尚未绑定到本方案任何场景。";
  $("assetPreviewMetaNote").textContent = `${note}删除请在素材库操作；替换会保留当前的裁切与动画参数。`;
  const replacing = state.sceneAssetPickerOpen && Boolean(state.sceneAssetPickerReplaceId);
  const bound = (selectedScene()?.placements || []).some((p) => p.assetId === asset.id);
  const useButton = $("assetPreviewUse");
  if (replacing) {
    useButton.disabled = state.sceneAssetPickerReplaceId === asset.id;
    useButton.textContent = state.sceneAssetPickerReplaceId === asset.id ? "当前素材" : "立即替换";
    useButton.onclick = () => {
      const originalId = state.sceneAssetPickerReplaceId;
      if (!originalId || originalId === asset.id) return setAssetPreviewOpen(false);
      setAssetPreviewOpen(false);
      replaceBoundAsset(originalId, asset.id, false);
    };
    $("assetPreviewNote").textContent = "替换后保留当前裁切与动画，可随时撤销";
  } else {
    useButton.disabled = bound;
    useButton.textContent = bound ? "已在本场景" : "绑定到当前场景";
    useButton.onclick = () => {
      if (bound) return setAssetPreviewOpen(false);
      setAssetPreviewOpen(false);
      touchAsset(asset.id);
      bindAssetToScene(asset.id);
    };
    $("assetPreviewNote").textContent = bound ? "该素材已绑定到当前场景" : "";
  }
  if (isVideo) {
    videoNode.src = assetUrl(asset);
    const report = () => {
      if (Number.isFinite(videoNode.duration) && videoNode.duration > 0) {
        const d = Math.round(videoNode.duration);
        $("assetPreviewMetaDetail").textContent = `视频 · ${assetSourceLabel(asset)} · ${Math.floor(d / 60)}分${String(d % 60).padStart(2, "0")}秒`;
      }
    };
    videoNode.onloadedmetadata = report;
    videoNode.onerror = () => { $("assetPreviewMissing").hidden = false; videoNode.hidden = true; };
  } else {
    imageNode.src = assetUrl(asset);
    const report = () => {
      if (imageNode.naturalWidth > 0) $("assetPreviewMetaDetail").textContent = `图片 · ${assetSourceLabel(asset)} · ${imageNode.naturalWidth}×${imageNode.naturalHeight}`;
    };
    imageNode.onload = report;
    imageNode.onerror = () => { $("assetPreviewMissing").hidden = false; imageNode.hidden = true; };
    if (imageNode.complete && imageNode.naturalWidth > 0) report();
  }
  setAssetPreviewOpen(true);
}

/* ---------- Picker keyboard navigation ---------- */
function pickerColumnCount() {
  const width = $("sceneAssetPickerList")?.clientWidth || 0;
  return width >= 240 ? 2 : 1;
}
function focusPickerAssetByOffset(delta) {
  const list = $("sceneAssetPickerList");
  const cards = [...(list?.querySelectorAll(".scene-picker-asset:not([hidden])") || [])];
  if (!cards.length) return;
  const active = document.activeElement;
  const currentIndex = active && cards.includes(active) ? cards.indexOf(active) : -1;
  let next = currentIndex;
  if (currentIndex === -1) next = delta > 0 ? 0 : cards.length - 1;
  else {
    const columns = pickerColumnCount();
    if (delta === -1 || delta === 1) next = Math.max(0, Math.min(cards.length - 1, currentIndex + delta));
    else next = Math.max(0, Math.min(cards.length - 1, currentIndex + (delta === -2 ? -columns : columns)));
  }
  const target = cards[next];
  if (target) { try { target.focus({ preventScroll: false }); target.scrollIntoView({ block: "nearest" }); } catch (_) { /* noop */ } }
}
function movePickerFocus(direction) {
  if (direction === "left") focusPickerAssetByOffset(-1);
  else if (direction === "right") focusPickerAssetByOffset(1);
  else if (direction === "up") focusPickerAssetByOffset(-2);
  else if (direction === "down") focusPickerAssetByOffset(2);
}

function escapeHtml(value = "") { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function formatTime(seconds) { const value = Math.max(0, Number(seconds || 0)); return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(Math.floor(value % 60)).padStart(2, "0")}`; }
/* The strip shows a drafted length the moment its narration changes, so the
   headline total has to move with it — otherwise one clip can grow ten seconds
   while 总时长 stands still. A scene created after the stale spec was built is
   absent from it, hence the zero baseline there; the spec replaces the whole
   figure as soon as it lands (within one `Math.ceil` second of the draft). */
function pendingDurationDelta() {
  if (!state.renderSpec) return 0;
  let delta = 0;
  for (const [sceneId, draft] of state.durationDrafts) {
    if (draft.projectId !== state.project?.id) continue;
    const mapped = state.renderSpec.scenes?.find((item) => item.sceneId === sceneId);
    delta += draft.seconds - (mapped?.cueRange ? mapped.cueRange.end - mapped.cueRange.start : 0);
  }
  return delta;
}
function totalDuration() { return state.renderSpec ? Number(state.renderSpec.totalDurationSeconds || 0) + pendingDurationDelta() : (state.project?.cover?.introSeconds || 0) + (state.project?.scenes.filter((scene) => scene.section !== "cover").reduce((sum, scene) => sum + sceneDuration(scene) + Number(scene.timing?.preHoldSeconds || 0) + Number(scene.timing?.postHoldSeconds || 0), 0) || 0) + Number(state.project?.template?.openingDescentSeconds || 0); }

const previewSubtitleLimits = { portrait: 14, landscape: 26, square: 18 };
const previewBreakPunctuation = "，。！？；：、,.!?;:";

function cleanPreviewSubtitle(value) {
  let text = String(value || "").replace(/\s+/g, "").trim();
  while (text && previewBreakPunctuation.includes(text[0])) text = text.slice(1);
  while (text && previewBreakPunctuation.includes(text.at(-1))) text = text.slice(0, -1);
  return text;
}

function splitPreviewSubtitle(value, maximum = 14) {
  const source = String(value || "").replace(/\s+/g, "").trim();
  if (!source) return [];
  const chunks = [];
  let remaining = source;
  while ([...remaining].length > maximum) {
    const characters = [...remaining];
    const target = Math.max(4, Math.round(maximum * 0.78));
    const candidates = [];
    for (let index = 4; index <= Math.min(maximum, characters.length - 1); index += 1) {
      if (previewBreakPunctuation.includes(characters[index - 1] || "")) candidates.push(index);
    }
    const split = candidates.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0] || Math.min(maximum, characters.length - 1);
    const chunk = cleanPreviewSubtitle(characters.slice(0, split).join(""));
    if (chunk) chunks.push(chunk);
    remaining = characters.slice(split).join("");
  }
  const tail = cleanPreviewSubtitle(remaining);
  if (tail) chunks.push(tail);
  if (chunks.length >= 2 && [...chunks.at(-1)].length < 4) {
    const combined = `${chunks.at(-2)}${chunks.at(-1)}`;
    const characters = [...combined];
    const split = Math.ceil(characters.length / 2);
    chunks.splice(chunks.length - 2, 2, cleanPreviewSubtitle(characters.slice(0, split).join("")), cleanPreviewSubtitle(characters.slice(split).join("")));
  }
  return chunks.filter(Boolean);
}

function previewSubtitleEntries(scene) {
  if (!scene || scene.section === "cover") return [];
  const range = state.renderSpec?.sceneCueRanges?.find((item) => item.sceneId === scene.id);
  const timed = range ? (state.renderSpec.subtitleCues || []).filter((cue) => cue.end > range.start && cue.start < range.end) : [];
  if (timed.length) return timed.map((cue) => ({ text: cue.text, start: cue.start, end: cue.end }));
  const maximum = previewSubtitleLimits[state.project?.output?.profile] || 14;
  const chunks = splitPreviewSubtitle(scene.narration, maximum);
  return chunks.map((text, index) => ({ text, start: index, end: index + 1 }));
}

function escapePreviewText(text) {
  return String(text).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// 字幕只显示一行：nowrap 之后如果还超出，就按比例缩字号。
// 量的是 .preview-subtitle-ink 的实际宽度，不能量 p —— 块级元素永远等于容器宽。
function fitPreviewSubtitle(preview) {
  preview.style.fontSize = "";
  const ink = preview.querySelector(".preview-subtitle-ink");
  if (!ink) return;
  const max = preview.clientWidth;
  if (!max) return;
  let size = parseFloat(getComputedStyle(preview).fontSize) || 12;
  const minimum = size * .55;
  for (let guard = 0; guard < 8; guard += 1) {
    const width = ink.getBoundingClientRect().width;
    if (width <= max || size <= minimum) break;
    size = Math.max(minimum, size * Math.min(.98, max / width));
    preview.style.fontSize = size + "px";
  }
}

// 预览字幕由音频时钟驱动；直接发送当前可见文字的实测矩形，避免换算到相机时钟而漂移。
let lastSubtitleBoundsMessage = "";
function syncMapSubtitleBounds() {
  const preview = $("previewSubtitle");
  const ink = preview.querySelector(".preview-subtitle-ink");
  const iframe = $("cesiumPreview");
  const frame = iframe.getBoundingClientRect();
  let bounds = null;
  if (!preview.hidden && ink && frame.width && frame.height && getComputedStyle(preview).display !== "none") {
    const rect = ink.getBoundingClientRect();
    // 将描边和阴影也计入实际占用区域，不预留整条屏幕带。
    const pad = (parseFloat(getComputedStyle(preview).fontSize) || 12) * .12;
    if (rect.width && rect.height) bounds = {
      left: Math.max(0, (rect.left - pad - frame.left) / frame.width),
      top: Math.max(0, (rect.top - pad - frame.top) / frame.height),
      right: Math.min(1, (rect.right + pad - frame.left) / frame.width),
      bottom: Math.min(1, (rect.bottom + pad - frame.top) / frame.height)
    };
  }
  const message = JSON.stringify(bounds);
  if (message === lastSubtitleBoundsMessage) return;
  lastSubtitleBoundsMessage = message;
  iframe.contentWindow?.postMessage({ type: "geo-video-studio", action: "set-subtitle-bounds", bounds }, CESIUM_PREVIEW_ORIGIN);
}
const subtitleLayoutObserver = new MutationObserver(syncMapSubtitleBounds);
subtitleLayoutObserver.observe($("previewSubtitle"), { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "style", "class"] });
new ResizeObserver(syncMapSubtitleBounds).observe($("cesiumPreview"));
$("cesiumPreview").addEventListener("load", () => { lastSubtitleBoundsMessage = ""; syncMapSubtitleBounds(); });
document.fonts?.ready.then(syncMapSubtitleBounds);

function showPreviewSubtitle(scene, index = 0) {
  const entries = previewSubtitleEntries(scene);
  const text = entries[Math.min(index, Math.max(0, entries.length - 1))]?.text || "";
  const preview = $("previewSubtitle");
  const safeArea = $("safeAreaSubtitle");
  // 两层文字：底层白色（还没讲到的部分），上层金色按旁白进度从左向右擦出来。
  const html = escapePreviewText(text);
  preview.innerHTML = text ? `<span class="preview-subtitle-wash" aria-hidden="true">${html}</span><span class="preview-subtitle-ink">${html}</span>` : "";
  preview.style.setProperty("--subtitle-cut", "100%");
  preview.hidden = !text;
  preview.setAttribute("aria-hidden", String(!text));
  fitPreviewSubtitle(preview);
  safeArea.textContent = text;
  safeArea.hidden = !text;
  safeArea.setAttribute("aria-hidden", String(!text));
}

function clearPreviewSubtitleTimers() {
  state.subtitleTimers.forEach(clearTimeout);
  state.subtitleTimers = [];
}

function syncPreviewSubtitlesToAudio(scene, audio) {
  clearPreviewSubtitleTimers();
  const entries = previewSubtitleEntries(scene);
  if (!entries.length) return showPreviewSubtitle(scene);
  const preview = $("previewSubtitle");
  const safeArea = $("safeAreaSubtitle");
  preview.innerHTML = "";
  preview.hidden = true;
  preview.setAttribute("aria-hidden", "true");
  safeArea.textContent = "";
  safeArea.hidden = true;
  safeArea.setAttribute("aria-hidden", "true");
  let displayedIndex = -2;
  const tick = () => {
    if (selectedScene()?.id !== scene.id || !state.playTimer || audio !== state.previewAudio) return;
    const audioTime = Number(audio.currentTime || 0);
    const activeIndex = entries.findIndex((entry) => audioTime + 0.015 >= entry.start && audioTime < entry.end);
    if (activeIndex >= 0) {
      // 正在讲这一句：把已讲比例写进 --subtitle-cut（右侧被裁掉的那部分）。
      const entry = entries[activeIndex];
      const span = Math.max(0.08, Number(entry.end) - Number(entry.start));
      const progress = Math.max(0, Math.min(1, (audioTime - Number(entry.start)) / span));
      preview.style.setProperty("--subtitle-cut", `${((1 - progress) * 100).toFixed(2)}%`);
    }
    if (activeIndex !== displayedIndex) {
      displayedIndex = activeIndex;
      if (activeIndex >= 0) showPreviewSubtitle(scene, activeIndex);
      else {
        preview.innerHTML = "";
        preview.hidden = true;
        preview.setAttribute("aria-hidden", "true");
        safeArea.textContent = "";
        safeArea.hidden = true;
        safeArea.setAttribute("aria-hidden", "true");
      }
    }
    state.subtitleTimers = [setTimeout(tick, 30)];
  };
  tick();
}

async function refreshCoverPreview() {
  const requestId = ++state.coverPreviewRequest;
  try {
    const response = await fetch(`/api/projects/${state.project.id}/cover-preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cover: state.project.cover }), cache: "no-store" });
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || `HTTP ${response.status}`); }
    const blob = await response.blob(); if (requestId !== state.coverPreviewRequest) return;
    const objectUrl = URL.createObjectURL(blob);
    if (state.coverPreviewObjectUrl) URL.revokeObjectURL(state.coverPreviewObjectUrl);
    state.coverPreviewObjectUrl = objectUrl; $("coverPreview").dataset.url = `live:${requestId}`; $("coverPreview").src = objectUrl;
  } catch (error) { if (requestId === state.coverPreviewRequest) toastError(`封面预览更新失败：${error.message}`); }
}

function scheduleCoverPreview() {
  clearTimeout(state.coverPreviewTimer);
  state.coverPreviewTimer = setTimeout(refreshCoverPreview, 250);
}

function isOpeningScene(scene) {
  return Boolean(scene && scene.id === state.project?.scenes.find((item) => item.section !== "cover")?.id);
}

function playSelectedScenePreview() {
  const scene = selectedScene(); if (!isOpeningScene(scene) || $("cesiumPreview").hidden) return;
  // The opening preview is the frame the first village flight leaves from, so it
  // must render at the same overview range the export uses. Install the tour
  // context here rather than only on the scene-selection path: replaying the
  // opening preview (clicking the preview frame, re-opening the panel) also
  // lands on this camera and must not fall back to the raw preset range.
  pushTourContext();
  clearTimeout(state.previewAssetRevealTimer);
  state.previewAssetReadySceneId = null;
  setPreviewAssetVisible(false);
  const opening = openingPreviewSettings();
  $("cesiumPreview").contentWindow?.postMessage({ type: "geo-video-studio", action: "play-opening", opening, mapView: scene.mapView ?? null }, CESIUM_PREVIEW_ORIGIN);
}

// The child-tour payload the preview needs. Studio builds it once and uses it
// both to configure the tour context up front and to drive the per-scene
// preview messages.
function tourPreviewPayload() {
  if (!state.project) return null;
  const childScenes = state.project.scenes.filter((item) => item.section === "child" && item.childId && item.camera);
  // A project that has not produced a render spec yet (no narration audio) still
  // has to preview a village: without ranges the payload used to bail out and a
  // clip click left the camera on the overview. Fall back to cumulative scene
  // durations so the preview keeps the film's slow flight into the village.
  const ranges = state.renderSpec?.sceneCueRanges || null;
  let cursor = 0;
  const tourStops = childScenes.map((item) => {
    const range = ranges?.find((candidate) => candidate.sceneId === item.id);
    const span = range ? Number(range.end) - Number(range.start) : sceneDuration(item);
    const duration = Math.max(0.001, Number(span) || 0.001);
    const start = range ? Number(range.start) || 0 : cursor;
    const end = range ? Number(range.end) || start + duration : start + duration;
    cursor = Math.max(cursor, end);
    return {
      id: item.childId,
      name: item.childName || item.title,
      start,
      end,
      flightDuration: Math.min(4.2, Math.max(3.2, duration - Number(item.timing?.mapHoldSeconds || 0))),
      cameraPreset: item.camera,
      cameraProfiles: { portrait: item.camera }
    };
  });
  if (!tourStops.length) return null;
  // No `openingSeconds` here on purpose. The player owns the descent offset
  // (see `showSelectedTourFrame`); exporting the render spec's descent from
  // Studio as well is what produced a double-counted 3 s seek.
  return {
    tourStops,
    returnDuration: Number(state.project.template.tourReturnSeconds || 4.4),
    annotationWindows: sceneAnnotationWindows()
  };
}

// An export materialises the region as `parent-child-tour`, which is what makes
// the parent overview camera carry the child-tour range scale. The editor region
// stays `parent-topic` until a tour payload arrives, so the parent overview has
// to be reconfigured *before* any preview runs — otherwise the editor parks the
// opening frame on a different range than the export and the first village
// flight reads as a camera jump.
function pushTourContext() {
  if ($("cesiumPreview").hidden) return;
  const payload = tourPreviewPayload();
  if (!payload) return;
  $("cesiumPreview").contentWindow?.postMessage({
    type: "geo-video-studio",
    action: "prepare-tour",
    preview: { tourStops: payload.tourStops, returnDuration: payload.returnDuration, annotationWindows: payload.annotationWindows }
  }, CESIUM_PREVIEW_ORIGIN);
}

// Tour timestamps are *presentation-relative*: the player adds its own opening
// descent before seeking, exactly like the capture run does when it seeks to
// `openingSeconds + stop.start`. Studio used to add the render spec's descent
// here as well, so the player received `descent + start` and then subtracted
// only the descent the loaded region actually carries — 乌石镇 and 西连镇 ship
// without an `openingDescent` block, so every village preview landed 3 s past the
// frame the export puts there. Sending the bare `start`/`end` is correct for
// both region shapes: with a descent the player removes it, without one there is
// nothing to remove.
function showSelectedTourFrame() {
  const scene = selectedScene(); if (!['child', 'outro', 'overview'].includes(scene?.section) || $("cesiumPreview").hidden) return;
  const payload = tourPreviewPayload();
  if (!payload) return;
  const { tourStops, returnDuration, annotationWindows } = payload;
  let time;
  let action = "show-tour-frame";
  if (scene.section === "overview") {
    action = "play-parent-overview";
    time = 0;
  } else if (scene.section === "outro") {
    const last = tourStops.at(-1); if (!last) return;
    action = "play-tour-outro";
    time = last.end;
  } else {
    const active = tourStops.find((item) => String(item.id) === String(scene.childId)); if (!active) return;
    action = "play-tour-segment";
    time = active.start;
    state.previewAssetReadySceneId = null;
    setPreviewAssetVisible(false);
  }
  $("cesiumPreview").contentWindow?.postMessage({
    type: "geo-video-studio",
    action,
    mapView: scene.mapView ?? null,
    preview: { tourStops, time, returnDuration, annotationWindows, targetId: scene.childId, segmentDuration: sceneDuration(scene) }
  }, CESIUM_PREVIEW_ORIGIN);
}

function previewSelectedScene() {
  if (isOpeningScene(selectedScene())) playSelectedScenePreview();
  else showSelectedTourFrame();
  pushMapView();
  // Always last: the messages above restored the film's own windows, which never
  // overlap the frame the editor actually parks on.
  pushPreviewAnnotationWindows();
}

function selectScene(sceneId, preview = false) {
  clearTimeout(state.previewAssetRevealTimer);
  // Clear the outgoing scene's photo before changing selection. In particular,
  // a child-tour photo must never remain visible while the next administrative
  // area is flying into view or waiting for its own photo to load.
  setPreviewAssetVisible(false);
  state.previewAssetReadySceneId = null;
  // The rotation belongs to the scene that was playing; a new scene starts from
  // its own first picture (see `beginPlaybackStage`).
  state.playbackStagePlacement = null;
  state.playbackStageActive = false;
  state.selectedSceneId = sceneId; state.selectedAssetId = selectedScene()?.placements?.[0]?.assetId || null; state.sceneAssetPickerOpen = false;
  state.sceneAssetPickerReplaceId = null; state.sceneAssetReplaceCandidateId = null;
  state.playheadSeconds = sceneStartSeconds(selectedScene());
  render();
  if (preview) setTimeout(previewSelectedScene, 80);
}

function selectSceneFromUi(sceneId) {
  const continuePlaying = Boolean(state.playTimer);
  // Picking a scene while the film is rolling keeps rolling (the operator is
  // skipping ahead, not switching to a one-scene audition).
  const continuous = state.playbackContinuous;
  if (continuePlaying) stopPlayback();
  selectScene(sceneId, false);
  if (continuePlaying) startPlaybackFromSelected({ continuous });
  else previewSelectedScene();
}

function defaultPlacement(asset, scene) {
  /* A video already moves: stacking a push-in on top of it reads as a bug, so a
     freshly uploaded clip starts still (the same rule `replaceBoundAsset`
     applies, and the 素材画面 panel can still change it by hand). */
  return { assetId: asset.id, fit: "cover", crop: { x: 0, y: 0, width: 1, height: 1 }, focalPoint: { x: 0.5, y: 0.5 }, scale: 1, offsetX: 0, offsetY: 0, animation: asset.type === "video" ? "still" : "push-in", leadSeconds: 0.25, tailSeconds: 0.2, minimumDisplaySeconds: scene.timing?.minimumVisualSeconds || 2, requiredKeywords: [], alt: asset.alt || asset.name };
}

function markDirty() {
  /* Every timing in the editor — scene-list seconds, clip widths, subtitle cues,
     the preview playhead — is read from the render spec. `scene.duration`, the
     fallback, is only rewritten when an export regenerates narration, so it
     drifts away from the spec (on a live project it disagreed by 2-3x). Dropping
     the spec on every edit therefore re-measured every clip from those drifted
     values: adding a single scene visibly resized all the others, and whenever
     the follow-up spec fetch failed the strip stayed reshuffled. Keep the last
     spec and let `renderSpecStale` carry the "预览需要刷新" hint instead. */
  state.editEpoch += 1;
  state.dirty = true; state.renderSpecStale = true;
  renderSaveState("dirty");
  $("specBadge").hidden = false; $("specBadge").textContent = "保存后刷新"; $("specBadge").className = "spec-badge pending";
  $("renderButton").disabled = true;
  renderPreviewTrustStatus();
}

async function syncProjectState() {
  const project = state.project;
  const projectId = project?.id;
  if (!projectId) return;
  const requestId = ++state.specRequest;
  if (state.dirty) return;
  /* Drafts written after this point describe edits the response cannot know
     about yet (its PUT has not been sent), so only older ones may be released. */
  const requestEpoch = state.editEpoch;
  try {
    const [spec, readiness] = await Promise.all([api(`/api/projects/${projectId}/render-spec`), api(`/api/projects/${projectId}/validate`, { method: "POST", body: "{}" })]);
    if (state.project !== project || state.specRequest !== requestId || state.editEpoch !== requestEpoch || state.dirty) return;
    if (spec.projectRevision !== undefined && spec.projectRevision !== project.revision) {
      state.renderSpecStale = true;
      state.readiness = { ready: false, checks: [{ id: "revision", name: "方案版本", pass: false, detail: "时序仍属于旧版本，请点击保存状态刷新" }] };
      render();
      return;
    }
    releaseSettledDrafts(requestEpoch);
    state.renderSpec = spec; state.renderSpecStale = false; state.readiness = readiness;
    // The spec carries the film's exact length and whether the map video is
    // already cached, so the estimate is refreshed with it. The same response
    // carries the planned picture track, which the timeline panel draws.
    refreshExportEstimate();
    renderExportTimeline();
    render();
  } catch (error) {
    if (state.project !== project || state.specRequest !== requestId || state.editEpoch !== requestEpoch) return;
    /* A failed refresh must not reshuffle the strip: keep the last usable spec
       and let the badge report that the timings now trail the edit. */
    state.renderSpecStale = true;
    state.readiness = { ready: false, checks: [{ id: "spec", name: "RenderSpec", pass: false, detail: error.message }] }; render();
    /* The checklist is why the export button is disabled, so a silent failure
       here leaves the operator staring at a grey button with one terse row. */
    toastError(`导出前检查未能刷新：${error.message}`);
  }
}

async function saveProject() {
  const project = state.project;
  if (!project) return;
  if (state.savePromise) {
    await state.savePromise;
    if (state.project !== project) return;
    if (state.dirty) return saveProject();
    return;
  }
  const pending = (async () => {
    try {
      do {
      while (state.project === project && state.dirty) {
        const requestEpoch = state.editEpoch;
        const previousRevision = project.revision;
        renderSaveState("saving");
        const saved = await api(`/api/projects/${project.id}`, { method: "PUT", body: JSON.stringify(project) });
        if (state.project !== project) return;
        // 无新编辑时接受规范化结果且保留对象身份；否则仅合并元数据。
        state.dirty = state.editEpoch !== requestEpoch;
        if (!state.dirty) Object.assign(project, saved);
        else { project.revision = saved.revision; project.updatedAt = saved.updatedAt; }
        renderSaveState(state.dirty ? "saving" : "saved");
        upsertProjectList(project);
        if (project.revision !== previousRevision) {
          state.previewAudio?.pause();
          state.previewAudio = null;
          state.previewAudioProjectId = null;
          state.previewAudioErrorShown = false;
        }
      }
      if (state.project === project) await syncProjectState();
      } while (state.project === project && state.dirty);
    } catch (error) {
      if (state.project === project) {
        state.dirty = true;
        renderSaveState("error");
        toastError(error.message);
      }
      throw error;
    }
  })();
  state.savePromise = pending;
  try { await pending; }
  finally { if (state.savePromise === pending) state.savePromise = null; }
}

/* Persistence is explicit: edits stay local until the operator saves. Actions
   that need the disk snapshot ask first, so they can never silently write or
   discard a draft. Returns false when the operator chooses to keep editing. */
async function saveBeforeAction(actionLabel = "继续") {
  if (!state.project || !state.dirty) return true;
  const ok = await askConfirm({
    title: "有未保存的修改",
    message: `当前场景有未保存的修改。\n只有点击“保存方案”后，场景修改才会生效。\n\n是否先保存，再${actionLabel}？`,
    okText: `保存并${actionLabel}`,
    cancelText: "继续编辑",
    okClass: "primary"
  });
  if (!ok) return false;
  await saveProject();
  return !state.dirty;
}

/* A scene's length follows its narration. The authoritative number comes from
   the render spec, but that only lands after an explicit save and a spec
   rebuild — typing therefore left the clip, its seconds and the total on
   the *previous* text for seconds. Estimate with the very formula the server
   falls back to whenever the narration no longer lines up with the TTS cues
   (`max(2, 字数 / 4.1)`, see `estimatedProjectCues`) at the moment the text
   changes, so the strip keeps up with the cursor; the spec replaces the
   estimate as soon as it arrives, and drafts older than the request are dropped
   so an in-flight refresh can never overwrite an edit made while it ran. */
const NARRATION_CHARS_PER_SECOND = 4.1;
function estimatedNarrationSeconds(narration) {
  return Math.max(2, [...String(narration ?? "")].length / NARRATION_CHARS_PER_SECOND);
}
function draftSceneDuration(scene) {
  if (!scene || scene.section === "cover") return;
  state.durationDrafts.set(scene.id, { seconds: estimatedNarrationSeconds(scene.narration), epoch: ++state.editEpoch, projectId: state.project?.id });
}
function pendingSceneDuration(scene) {
  const draft = state.durationDrafts.get(scene.id);
  return draft && draft.projectId === state.project?.id ? draft.seconds : null;
}
function releaseSettledDrafts(requestEpoch) {
  for (const [sceneId, draft] of state.durationDrafts) if (draft.epoch <= requestEpoch) state.durationDrafts.delete(sceneId);
}
function sceneDuration(scene) {
  if (scene.section === "cover") return state.project.cover.introSeconds;
  const draft = pendingSceneDuration(scene);
  if (draft !== null) return draft;
  const mapped = state.renderSpec?.scenes?.find((item) => item.sceneId === scene.id);
  return mapped?.cueRange ? mapped.cueRange.end - mapped.cueRange.start : Number(scene.duration || 0);
}

function sceneCanReorder(scene) {
  return Boolean(scene && (scene.section === "overview" || scene.section === "child" || scene.section === "outro-lead"));
}

function sceneCanManage(scene) {
  return Boolean(scene && (scene.section === "overview" || scene.section === "outro-lead"));
}

function sceneCanDelete(scene) {
  if (!scene || !state.project) return false;
  if (scene.section === "overview") return state.project.scenes.filter((item) => item.section === "overview").length > 1;
  if (scene.section === "child") return state.project.scenes.filter((item) => item.section === "child").length > 1;
  // outro-lead is free-standing content, so its last row is as deletable as any
  // of its siblings — unlike cover/outro, which the template requires.
  if (scene.section === "outro-lead") return true;
  return false;
}

function reorderScene(sourceId, targetId, placeAfter = false) {
  const scenes = state.project?.scenes;
  if (!scenes || sourceId === targetId) return;
  const source = scenes.find((scene) => scene.id === sourceId);
  const target = scenes.find((scene) => scene.id === targetId);
  if (!sceneCanReorder(source) || !sceneCanReorder(target) || source.section !== target.section) {
    return toast("只能在同一场景分组内排序，封面和片尾位置保持锁定");
  }
  const sourceIndex = scenes.findIndex((scene) => scene.id === sourceId);
  const [moved] = scenes.splice(sourceIndex, 1);
  let targetIndex = scenes.findIndex((scene) => scene.id === targetId);
  if (placeAfter) targetIndex += 1;
  scenes.splice(targetIndex, 0, moved);
  state.selectedSceneId = moved.id;
  state.selectedAssetId = moved.placements?.[0]?.assetId || null;
  markDirty(); render();
  toast(`已调整“${moved.childName || moved.title}”顺序，旁白、字幕、素材和镜头将同步移动`);
}

function moveSceneByOffset(sceneId, offset) {
  const scene = state.project?.scenes.find((item) => item.id === sceneId);
  if (!sceneCanReorder(scene)) return;
  const siblings = state.project.scenes.filter((item) => item.section === scene.section);
  const index = siblings.findIndex((item) => item.id === sceneId);
  const target = siblings[index + offset];
  if (target) reorderScene(sceneId, target.id, offset > 0);
}

/**
 * Reorder the child scenes so each one follows a village it shares a boundary
 * with. Dragging scenes can produce any order; only the map knows which orders
 * are continuous, so the server plans it and this applies the result through
 * the same dirty/render path as a drag.
 */
async function planTourRoute() {
  if (!state.project) return;
  if (!(await saveBeforeAction("按接壤关系重排"))) return;
  const button = $("planTourRoute");
  const childScenes = state.project.scenes.filter((scene) => scene.section === "child" && scene.childId);
  if (childScenes.length < 2) return toast("至少要有两个下级行政区场景，才能判断接壤顺序");
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "计算中…";
  try {
    const result = await api(`/api/projects/${state.project.id}/tour-route`, { method: "POST" });
    if (!result.changeNeeded) {
      toast(`巡游顺序已经合规：开场为“${childScenes[0].childName || childScenes[0].title}”，${result.touchingAfter}/${result.flights} 段全部与上一个行政区接壤`);
      return;
    }
    const scenes = state.project.scenes;
    const firstChild = scenes.findIndex((scene) => scene.section === "child");
    const lastChild = scenes.reduce((last, scene, index) => (scene.section === "child" ? index : last), -1);
    const sceneByChild = new Map(childScenes.map((scene) => [String(scene.childId), scene]));
    const ordered = result.childIds.map((id) => sceneByChild.get(String(id))).filter(Boolean);
    if (ordered.length !== childScenes.length) throw new Error("排序结果与场景数量不一致，未做改动");
    state.project.scenes = [
      ...scenes.slice(0, firstChild),
      ...ordered,
      ...scenes.slice(lastChild + 1)
    ];
    markDirty();
    render();
    const opening = ordered[0].childName || ordered[0].title;
    const summary = [`已按接壤关系重排：${result.touchingBefore}/${result.flights} → ${result.touchingAfter}/${result.flights} 段与上一个行政区接壤`];
    if (result.editedStops) summary.push(`移动 ${result.editedStops} 个场景，其余顺序不变`);
    if (result.startMoved) {
      // Only reachable if a future caller stops pinning the opening. The first
      // village is an editorial choice the editor should never be surprised by.
      summary.push(`原开场无法作为接壤巡游的起点，开场改为“${opening}”`);
    } else if (result.strategy === "searched") {
      summary.push(`开场固定为“${opening}”，中段顺序按接壤关系重新编排`);
    } else if (result.strategy === "hopped") {
      summary.push(`开场固定为“${opening}”，其余村庄按接壤就近推进`);
    }
    if (result.breaks.length) {
      summary.push(result.strategy === "hopped"
        ? `${result.breaks.length} 段无法接壤，只能跨接（开场保持不动）`
        : `${result.breaks.length} 段无共同边界，属真实地理限制`);
    }
    toast(summary.join("；"));
  } catch (error) {
    toast(`按接壤重排失败：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function bindSceneSorting() {
  let draggedSceneId = null;
  document.querySelectorAll("[data-scene-id]").forEach((node) => {
    const scene = state.project.scenes.find((item) => item.id === node.dataset.sceneId);
    node.draggable = sceneCanReorder(scene);
    node.classList.toggle("scene-sortable", sceneCanReorder(scene));
    node.ondragstart = (event) => {
      if (!sceneCanReorder(scene)) return event.preventDefault();
      draggedSceneId = scene.id;
      node.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", scene.id);
    };
    node.ondragover = (event) => {
      const source = state.project.scenes.find((item) => item.id === draggedSceneId);
      if (!source || source.section !== scene?.section || source.id === scene.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      node.classList.add("drag-over");
    };
    node.ondragleave = () => node.classList.remove("drag-over");
    node.ondrop = (event) => {
      event.preventDefault();
      node.classList.remove("drag-over");
      const sourceId = draggedSceneId || event.dataTransfer.getData("text/plain");
      const box = node.getBoundingClientRect();
      const placeAfter = node.classList.contains("timeline-clip")
        ? event.clientX > box.left + box.width / 2
        : event.clientY > box.top + box.height / 2;
      reorderScene(sourceId, scene.id, placeAfter);
    };
    node.ondragend = () => {
      draggedSceneId = null;
      document.querySelectorAll(".dragging,.drag-over").forEach((item) => item.classList.remove("dragging", "drag-over"));
    };
  });
  document.querySelectorAll("[data-move-scene]").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      moveSceneByOffset(button.dataset.sceneId, Number(button.dataset.moveScene));
    };
  });
  // Each block's heading carries its own "+", so the target block is explicit: the
  // author clicks the heading of the block they want the row in. The debounce lives
  // in `addSceneSafely` because a fast double click otherwise mints two rows.
  document.querySelectorAll("[data-add-closing]").forEach((button) => {
    button.onclick = (event) => { event.stopPropagation(); addSceneSafely("outro-lead"); };
  });
  document.querySelectorAll("[data-add-overview]").forEach((button) => {
    button.onclick = (event) => { event.stopPropagation(); addSceneSafely("overview"); };
  });
}

function editSceneFromList(sceneId) {
  selectScene(sceneId, true);
  requestAnimationFrame(() => {
    $("sceneTitle").focus();
    $("sceneTitle").select();
    $("sceneTitle").scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function duplicateScene(sceneId) {
  const scenes = state.project?.scenes;
  const sourceIndex = scenes?.findIndex((scene) => scene.id === sceneId) ?? -1;
  const source = scenes?.[sourceIndex];
  if (!sceneCanManage(source)) return toast("封面、下级行政区和结尾由模板统一管理，不能复制");
  const duplicate = structuredClone(source);
  duplicate.id = `overview-${source.type || "scene"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  duplicate.title = `${sceneDisplayName(source, scenes)} · 副本`;
  scenes.splice(sourceIndex + 1, 0, duplicate);
  draftSceneDuration(duplicate);
  state.selectedSceneId = duplicate.id;
  state.selectedAssetId = duplicate.placements?.[0]?.assetId || null;
  markDirty(); render();
  toast("已复制场景，旁白、字幕、素材和镜头同步复制");
}

async function deleteScene(sceneId) {
  const scenes = state.project?.scenes;
  const sceneIndex = scenes?.findIndex((scene) => scene.id === sceneId) ?? -1;
  const scene = scenes?.[sceneIndex];
  if (!scene || scene.section === "cover" || scene.section === "outro") return toast("封面和结尾是模板必需结构，不能删除");
  if (!sceneCanDelete(scene)) return toast(scene.section === "child" ? "至少保留一个下级行政区巡游场景" : "至少保留一个总体介绍场景");
  const ok = await askConfirm({
    title: "删除场景",
    message: `确定删除场景「${sceneDisplayName(scene, scenes)}」？\n相关旁白、字幕、素材绑定和镜头设置也会一并删除，无法恢复。`,
    okText: "删除"
  });
  if (!ok) return;
  const nextScene = scenes[sceneIndex + 1] || scenes[sceneIndex - 1];
  scenes.splice(sceneIndex, 1);
  state.selectedSceneId = nextScene?.id || scenes[0]?.id || null;
  state.selectedAssetId = selectedScene()?.placements?.[0]?.assetId || null;
  markDirty(); render();
  toast("场景及其关联内容已删除；点击“保存方案”后生效");
}

function bindSceneManagement() {
  document.querySelectorAll("[data-edit-scene]").forEach((button) => button.onclick = (event) => {
    event.stopPropagation();
    editSceneFromList(button.dataset.editScene);
  });
  document.querySelectorAll("[data-duplicate-scene]").forEach((button) => button.onclick = (event) => {
    event.stopPropagation();
    duplicateScene(button.dataset.duplicateScene);
  });
  document.querySelectorAll("[data-delete-scene]").forEach((button) => button.onclick = (event) => {
    event.stopPropagation();
    deleteScene(button.dataset.deleteScene).catch((error) => toastError(error.message));
  });
}

function renderPreviewTrustStatus() {
  const host = $("previewTrustStatus");
  if (!host) return;
  const unsaved = state.dirty;
  const stale = unsaved || state.renderSpecStale || state.narrationNotice?.projectId === state.project?.id && state.narrationNotice?.stale;
  const measured = state.renderSpec?.narrationTimingSource === "measured";
  host.classList.toggle("is-warning", Boolean(stale));
  host.classList.toggle("is-synced", !stale && measured);
  host.dataset.state = stale ? "stale" : measured ? "measured" : "estimated";
  host.textContent = unsaved
    ? "场景修改未保存 · 点击“保存方案”后，预览与导出才会更新"
    : stale ? "文案或设置待更新 · 预览时序仅供参考"
      : measured ? "实测旁白时序 · 画面为编辑器预览，以导出成片为准"
        : "估算时序 · 生成旁白后可更新实测时长";
}

function render() {
  const project = state.project; if (!project) return;
  renderAssetUndoState();
  renderAssetUploadStatus();
  renderPreviewTrustStatus();
  $("currentRegionName").textContent = project.regionName || project.cover?.town || project.regionId || "未选择地区";
  $("currentRegionPath").textContent = [project.cover?.province, project.cover?.city, project.cover?.county, project.regionId].filter(Boolean).join(" / ");
  $("projectName").value = project.name; $("profileSelect").value = project.output.profile; $("qualitySelect").value = project.output.quality === "draft" ? "draft" : "high"; syncPresetUI(); refreshExportEstimate();
  const imageryProvider = project.imagery?.provider || DEFAULT_IMAGERY_PROVIDER;
  $("imageryProviderSelect").value = imageryProvider;
  const imageryProviderForHint = imageryProvider;
  $("imageryProviderHint").textContent = imageryProviderForHint === "bing-aerial"
    ? "必应需在 config/project.yaml 配置 bing_maps_key，或设置 BING_MAPS_KEY。"
    : imageryProviderForHint === "tianditu-imagery"
      ? "天地图影像与注记已配置；在右侧场景编辑中逐场勾选“天地图影像注记”。"
      : imageryProviderForHint === DEFAULT_IMAGERY_PROVIDER
        ? "Cesium ion 资产 2 · Bing Maps 航拍，预览和导出共用。"
        : "预览与导出共用此影像源；切换立即生效，不会重连像素流。";
  $("voiceId").value = project.voice.voiceId; $("voiceSpeed").value = project.voice.speed;
  $("previewFrame").className = `preview-frame ${project.output.profile}`;
  requestAnimationFrame(syncPreviewTypography);
  renderMapView();
  // `boundary` pins the preview to this scheme's frozen boundary. Without it the
  // player would read `data/`, so re-importing the region would silently redraw
  // a scheme that was already authored against the previous boundary.
  // The iframe only carries the provider it was *loaded* with. Switching the basemap
  // afterwards is a postMessage away, so the URL stays stable and the iframe (and its
  // pixel-stream session) is never reloaded.
  if (state.previewProjectId !== project.id) {
    state.previewProjectId = project.id;
    state.previewImagery = imageryProvider;
    state.pendingImagery = null;
  }
  const loadedImagery = state.previewImagery || imageryProvider;
  const previewUrl = `${CESIUM_PREVIEW_ORIGIN}/?region=${encodeURIComponent(project.regionId)}&profile=${encodeURIComponent(project.output.profile)}&studioPreview=2&imagery=${encodeURIComponent(loadedImagery)}&boundary=${encodeURIComponent(project.id)}&parentOrigin=${encodeURIComponent(location.origin)}`;
  if (state.previewUrl !== previewUrl) { state.previewUrl = previewUrl; state.previewImagery = loadedImagery; $("cesiumPreview").src = previewUrl; }
  const sectionLabels = { cover: "1 · 统一封面", overview: "2-3 · 穿云与总体介绍", child: "4 · 下级行政区巡游", outro: "5 · 拉回上级区域结尾" };
  // 结尾补充 shares the pull-back's heading instead of owning a separate group: the
  // two sections read as one 结尾 area, with the 结尾补充 rows simply listed under the
  // 拉回上级区域结尾 row. That is what the author expects after clicking the button
  // there — a new row beneath the pull-back, not a new block above it.
  //
  // Adding is offered on each block's OWN heading rather than as one button in the
  // panel header: the header button gave no clue which block a new row would join,
  // and it silently filed overview rows when the author was looking at the ending.
  const groupAddButton = (section) => {
    if (section === "overview") {
      return `<button type="button" class="scene-group-add" data-add-overview="1" title="在「总体介绍」块内新增一个场景（插在封面之后、第一个行政区巡游之前）">+ 新增场景</button>`;
    }
    if (section === "outro") {
      return `<button type="button" class="scene-group-add" data-add-closing="1" title="新增结尾补充场景（排在拉回上级区域结尾之后）">+ 新增场景</button>`;
    }
    return "";
  };
  let lastGroup = "";
  $("sceneList").innerHTML = project.scenes.map((scene, index) => {
    const section = scene.section || "overview";
    const group = section === "outro-lead" ? "outro" : section;
    const groupButton = groupAddButton(group);
    const heading = group !== lastGroup
      ? `<div class="scene-group-title">${sectionLabels[group]}${groupButton}</div>`
      : "";
    lastGroup = group;
    const sceneLabel = sceneDisplayName(scene, project.scenes);
    const orderActions = sceneCanReorder(scene) ? `<span class="scene-order-actions"><button type="button" data-move-scene="-1" data-scene-id="${scene.id}" title="上移场景" aria-label="上移${escapeHtml(sceneLabel)}">↑</button><button type="button" data-move-scene="1" data-scene-id="${scene.id}" title="下移场景" aria-label="下移${escapeHtml(sceneLabel)}">↓</button></span>` : "";
    const manageActions = scene.id === state.selectedSceneId ? `<span class="scene-inline-actions"><button type="button" data-edit-scene="${scene.id}">编辑</button>${sceneCanManage(scene) ? `<button type="button" data-duplicate-scene="${scene.id}">复制</button>` : ""}${sceneCanDelete(scene) ? `<button type="button" class="scene-delete-action" data-delete-scene="${scene.id}">删除</button>` : ""}</span>` : "";
    const sceneActive = scene.id === state.selectedSceneId;
    return `${heading}<div class="scene-item ${sceneActive ? "active" : ""}" data-scene-id="${scene.id}" tabindex="0" role="button" aria-current="${sceneActive ? "true" : "false"}" aria-label="场景 ${index + 1}：${escapeHtml(sceneLabel)}，${sceneDuration(scene).toFixed(1)} 秒" title="${sceneCanReorder(scene) ? "拖动可调整顺序" : "模板锁定位置"}"><span class="scene-index">${String(index + 1).padStart(2, "0")}</span><b>${escapeHtml(sceneLabel)}</b><small class="kind">${sceneDuration(scene).toFixed(1)}s</small>${orderActions}${manageActions}</div>`;
  }).join("");
  $("timelineScenes").innerHTML = project.scenes.map((scene) => {
    const assetStatus = sceneAssetStatus(scene);
    const annotationMark = scene.imageryAnnotation === true ? " · 注记" : "";
    const title = sceneCanReorder(scene) ? "点击定位到此场景；拖动可调整顺序" : "点击定位到此场景";
    const clipActive = scene.id === state.selectedSceneId;
    const sceneLabel = sceneDisplayName(scene, project.scenes);
    return `<div class="timeline-clip ${clipActive ? "active" : ""} ${assetStatus.kind}" data-scene-id="${scene.id}" tabindex="0" role="button" aria-current="${clipActive ? "true" : "false"}" aria-label="${escapeHtml(sceneLabel)}，${sceneDuration(scene).toFixed(1)} 秒，${escapeHtml(assetStatus.label)}${annotationMark}" title="${title}" style="width:${Math.max(112, Math.round(sceneDuration(scene) * 13))}px"><b class="clip-title">${escapeHtml(sceneLabel)}</b><span>${sceneDuration(scene).toFixed(1)}s · ${assetStatus.label}${annotationMark}</span></div>`;
  }).join("");
  /* Clips keep a width proportional to their duration, so the strip is wider
     than the viewport. Bring the selected clip into view — but only when the
     selection actually changed, so the periodic re-render never fights the
     user's own scrolling. */
  const strip = $("timelineScenes");
  if (strip && state.selectedSceneId && state.selectedSceneId !== state.revealedSceneId) {
    state.revealedSceneId = state.selectedSceneId;
    const clip = strip.querySelector(`.timeline-clip[data-scene-id="${CSS.escape(state.selectedSceneId)}"]`);
    if (clip) {
      const box = strip.getBoundingClientRect();
      const rect = clip.getBoundingClientRect();
      if (rect.left < box.left) strip.scrollLeft -= box.left - rect.left + 12;
      else if (rect.right > box.right) strip.scrollLeft += rect.right - box.right + 12;
    }
  }
  const cues = state.renderSpec?.narrationCues || [];
  const duration = Math.max(1, state.renderSpec?.narrationDurationSeconds || 1);
  $("cueTrack").innerHTML = cues.map((cue) => `<i title="cue ${cue.index + 1} · ${escapeHtml(cue.text)}" style="left:${cue.start / duration * 100}%;width:${Math.max(.35, (cue.end - cue.start) / duration * 100)}%"></i>`).join("");
  $("visualTrack").innerHTML = (state.renderSpec?.assets || []).map((asset) => `<i title="${escapeHtml(asset.alt)} · cue ${asset.cueStartIndex + 1}" style="left:${(cues[asset.cueStartIndex]?.start || 0) / duration * 100}%;width:${Math.max(1, ((cues[asset.cueEndIndex]?.end || 0) - (cues[asset.cueStartIndex]?.start || 0)) / duration * 100)}%"></i>`).join("");
  $("totalDuration").textContent = `${totalDuration().toFixed(1)} 秒`; $("cueSummary").textContent = `${project.scenes.length} 个场景`; $("timecode").textContent = `${formatTime(state.playheadSeconds)} / ${formatTime(totalDuration())}`;
  // Say which of the two transports the ▶ button means, since they no longer
  // both mean "play from here onwards".
  $("playScope").textContent = selectedScene() ? `只播「${selectedScene().title}」` : "只播当前场景";
  const specFresh = Boolean(state.renderSpec) && !state.renderSpecStale;
  $("specBadge").hidden = specFresh;
  $("specBadge").textContent = "保存后刷新";
  $("specBadge").className = `spec-badge ${specFresh ? "ok" : "pending"}`;
  const cover = project.cover;
  $("coverContentMeta").value = cover.contentMeta ?? "";
  $("coverAdministrativeLabel").value = cover.administrativeLabel; $("coverSubtitle").value = cover.subtitle; $("coverIntro").value = cover.introSeconds; $("coverFadeOut").value = cover.fadeOutSeconds; $("coverOverlay").value = cover.overlayOpacity;
  /* Scene rows and timeline clips are focusable controls, not mouse-only divs:
     Enter/Space selects, ↑/↓ walks the list. Key events coming from the
     buttons nested inside a row are left to those buttons. */
  document.querySelectorAll(".scene-item[data-scene-id], .timeline-clip[data-scene-id]").forEach((node) => {
    node.onclick = () => selectSceneFromUi(node.dataset.sceneId);
    /* Selecting a scene re-renders both lists, which destroys the row that had
       focus. Every keyboard action therefore re-acquires the freshly rendered
       row for the same scene — otherwise the second arrow press would land on
       <body> and navigation would stop after one step. */
    const rowSelector = node.classList.contains("scene-item") ? ".scene-item" : ".timeline-clip";
    const focusSceneRow = (sceneId) => {
      const pick = () => document.querySelector(`${rowSelector}[data-scene-id="${CSS.escape(sceneId)}"]`)?.focus();
      pick();
      requestAnimationFrame(pick);
    };
    node.onkeydown = (event) => {
      if (event.target !== node) return;
      if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        selectSceneFromUi(node.dataset.sceneId);
        focusSceneRow(node.dataset.sceneId);
        return;
      }
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const siblings = [...(node.parentElement?.querySelectorAll(":scope > [data-scene-id]") || [])];
      const next = siblings[siblings.indexOf(node) + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      selectSceneFromUi(next.dataset.sceneId);
      focusSceneRow(next.dataset.sceneId);
    };
  });
  bindSceneSorting();
  bindSceneManagement();
  renderInspector(); renderReadiness();
}

function renderReadiness() {
  const unsavedCheck = state.dirty
    ? [{ id: "unsaved", name: "方案保存", pass: false, detail: "场景修改尚未保存；点击“保存方案”后才会生效" }]
    : [];
  const checks = [...unsavedCheck, ...(state.readiness?.checks || [])];
  // An advisory check reports authoring drift the export self-heals, so it stays
  // visible without turning the whole checklist red.
  const statusOf = (item) => (item.pass ? "pass" : item.advisory ? "warn" : "fail");
  const markerOf = (item) => (item.pass ? "✓" : item.advisory ? "•" : "!");
  /* An empty list means "the check has not run", not "there is nothing to
     check". Rendering it blank next to a disabled button reads as a broken
     panel, so say what is actually happening. */
  $("readinessList").innerHTML = checks.length
    ? checks.map((item) => `<div class="readiness-item ${statusOf(item)}" title="${escapeHtml(item.detail)}"><span>${markerOf(item)}</span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.detail)}</small></div>`).join("")
    : `<div class="readiness-item pending"><span>…</span><b>正在检查</b><small>导出前检查重新运行中，稍候即可添加任务</small></div>`;
  $("renderButton").disabled = state.dirty || !state.readiness?.ready;
}

function renderInspector() {
  const scene = selectedScene(); $("emptyInspector").hidden = Boolean(scene); $("sceneInspector").hidden = !scene; if (!scene) return;
  $("sceneTitle").value = sceneDisplayName(scene); $("narration").value = scene.narration;
  $("sceneImageryAnnotation").checked = scene.imageryAnnotation === true;
  $("sceneAnnotationControl").hidden = scene.section === "cover";
  $("deleteScene").hidden = !sceneCanDelete(scene);
  const isCoverScene = scene.section === "cover";
  const tools = $("sceneCopyTools");
  if (tools) {
    tools.hidden = isCoverScene;
    const regenButton = $("regenerateSceneCopy");
    if (regenButton && !isCoverScene) { regenButton.disabled = false; regenButton.textContent = scene.section === "child" ? "AI 重写本村旁白" : "AI 重写本场景旁白"; }
    const splitButton = $("splitOverviewCopy");
    if (splitButton) { splitButton.disabled = scene.section !== "overview"; }
  }
  $("narrationCount").textContent = `${[...scene.narration].length} 字`;
  const timing = scene.timing || {}; $("preHold").value = timing.preHoldSeconds || 0; $("postHold").value = timing.postHoldSeconds || 0; $("mapHold").value = timing.mapHoldSeconds || 0;
  $("longitude").value = scene.camera?.longitude ?? ""; $("latitude").value = scene.camera?.latitude ?? ""; $("height").value = scene.camera?.height ?? "";
  const cameraEditable = scene.section === "child"; ["longitude", "latitude", "height"].forEach((id) => $(id).disabled = !cameraEditable); $("lockedCameraNote").hidden = cameraEditable;
  const isCover = scene.section === "cover";
  showPreviewSubtitle(scene);
  $("cesiumPreview").hidden = isCover; $("coverPreview").hidden = !isCover;
  const openingPreview = !isCover && isOpeningScene(scene);
  $("previewFrame").classList.toggle("opening-preview", openingPreview);
  $("previewFrame").title = "";
  $("previewFrame").tabIndex = openingPreview ? 0 : -1;
  $("previewFrame").setAttribute("aria-label", "场景预览");
  if (isCover) {
    const coverUrl = `/api/projects/${state.project.id}/cover-preview?v=${state.project.revision}`;
    if ((!state.dirty || !$("coverPreview").src) && $("coverPreview").dataset.url !== coverUrl) { $("coverPreview").dataset.url = coverUrl; $("coverPreview").src = coverUrl; }
  }
  const scenePlacements = scene.placements || [];
  $("sceneAssetsEditor").hidden = isCover; $("coverAssetNote").hidden = !isCover;
  if (isCover) $("childCollectPanel").hidden = true;
  if (!isCover) {
    $("sceneAssetCount").textContent = `${scenePlacements.length} 个素材`;
    $("sceneAssetSelectionSummary").textContent = `已选 ${sceneAssetDisplayCount(scene)} / ${scenePlacements.length}`;
    $("selectAllSceneAssets").disabled = scenePlacements.length === 0;
    $("clearSceneAssetsSelection").disabled = scenePlacements.length === 0;
    $("sceneAssetEmpty").hidden = scenePlacements.length > 0;
    /* Removing the last asset of a scene is allowed and simply leaves an empty
       scene, so the empty state also says how to undo it: the removal then reads
       as done instead of as a button that quietly did nothing. */
    $("sceneAssetEmpty").textContent = isMapOnlyScene(scene)
      ? "当前场景使用地图镜头，无需配图；如需叠加实景素材，请点击“选择素材”。"
      : `尚未选择素材。点击“选择素材”从素材库绑定到当前场景。${state.assetUndoStack.length ? "也可按 Ctrl+Z 撤销上一步素材操作。" : ""}`;
    $("sceneBoundAssets").innerHTML = scenePlacements.map((item, index) => boundAssetCardHtml(scene, item, index)).join("");
    $("sceneAssetPicker").hidden = !state.sceneAssetPickerOpen;
    const replaceMode = Boolean(state.sceneAssetPickerReplaceId);
    $("sceneAssetPickerTitle").textContent = replaceMode ? "选择替换素材" : "选择素材";
    $("sceneAssetPickerTitle").title = replaceMode ? "点击素材卡片立即替换；点击黄色“当前素材”卡可取消" : "点击素材即绑定到当前场景，可连续添加多个";
    $("sceneAssetPickerActions").classList.toggle("replace-mode", replaceMode);
    document.querySelectorAll(".scene-asset-filter-chips .chip").forEach((chip) => chip.classList.toggle("active", chip.dataset.assetGroup === state.sceneAssetGroup));
    $("sceneAssetSearch").value = state.sceneAssetSearch;
    $("sceneAssetScope").value = state.sceneAssetScope;
    $("sceneAssetSort").value = state.sceneAssetSort;
    $("sceneAssetUnboundOnly").checked = state.sceneAssetUnboundOnly;
    const candidates = pickerAssetsForScene(scene);
    $("sceneAssetPickerList").innerHTML = candidates.length ? candidates.map((asset) => pickerAssetCardHtml(asset, scene)).join("") : pickerEmptyHtml();
    $("sceneAssetPickerList").classList.toggle("no-results", !candidates.length);
    const footer = $("sceneAssetPickerFooter");
    footer.hidden = false;
    renderPickerFooter();
    // Bind interactions for the freshly rendered assets.
    $("sceneBoundAssets").querySelectorAll("[data-bound-asset-id]").forEach((node) => node.onclick = () => { state.selectedAssetId = node.dataset.boundAssetId; render(); });
    $("sceneBoundAssets").querySelectorAll("[data-set-primary-scene-asset]").forEach((button) => button.onclick = (event) => { event.stopPropagation(); setPrimarySceneAsset(button.dataset.setPrimarySceneAsset); });
    $("sceneBoundAssets").querySelectorAll("[data-toggle-scene-asset-export]").forEach((button) => button.onclick = (event) => { event.stopPropagation(); setSceneAssetIncluded(button.dataset.toggleSceneAssetExport, button.getAttribute("aria-pressed") !== "true"); });
    $("sceneBoundAssets").querySelectorAll("[data-remove-scene-asset]").forEach((button) => button.onclick = (event) => { event.stopPropagation(); removeAssetFromScene(button.dataset.removeSceneAsset); });
    bindSceneAssetReordering(scene);
    $("sceneBoundAssets").querySelectorAll(".scene-bound-asset").forEach((card) => card.onkeydown = (event) => {
      /* The card wraps real buttons (用于成片 / 当前首图 / 移除) and their keydown
         bubbles up to here. Swallowing it cancelled the button's own Enter/Space
         activation, so 移除 never fired from the keyboard and the scene kept its
         assets no matter how many it had. Only the card itself selects. */
      if (event.target !== card) return;
      // Alt+↑/↓ reorders without a mouse; the plain arrow keys stay free for
      // scrolling the list.
      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        nudgeSceneAsset(card.dataset.boundAssetId, event.key === "ArrowUp" ? -1 : 1);
        document.querySelector(`.scene-bound-asset[data-bound-asset-id="${CSS.escape(card.dataset.boundAssetId)}"]`)?.focus();
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault(); card.click();
    });
    $("sceneAssetPickerList").querySelectorAll("[data-picker-asset-id]").forEach((card) => card.onclick = () => pickerAssetChosen(card.dataset.pickerAssetId));
    $("sceneAssetPickerList").querySelectorAll("[data-preview-from-card]").forEach((button) => button.onclick = (event) => { event.stopPropagation(); openAssetPreview(button.dataset.previewFromCard, "picker"); });
    $("sceneAssetPickerList").querySelector("[data-open-asset-library-empty]")?.addEventListener("click", () => setAssetLibraryOpen(true));
    bindAssetMedia($("sceneAssetPickerList")); bindAssetMedia($("sceneBoundAssets"));
    renderChildCollectPanel();
  }
  const placement = selectedPlacement(); const asset = placement ? assetById(placement.assetId) : null;
  $("previewShade").hidden = isCover || !asset; $("previewCopy").hidden = isCover; $("safeArea").hidden = state.previewMode !== "safe";
  $("placementPanel").hidden = !placement || isCover;
  /* While the film rolls the stage shows the picture the export would be showing
     at that instant, which is not necessarily the operator's selection; the
     panels below keep describing the selection. A scene with nothing marked
     用于成片 has no picture in the film, so the stage stays empty — falling back
     to the panel's card here is what made the preview promise a picture the
     export would not deliver. */
  applyPreviewStagePlacement(scene, state.playbackStageActive ? state.playbackStagePlacement : placement);
  if (asset && placement && !isCover) {
    $("assetFit").value = placement.fit; $("assetAnimation").value = placement.animation; $("focalX").value = placement.focalPoint.x; $("focalY").value = placement.focalPoint.y; $("assetScale").value = placement.scale; $("assetMinimum").value = placement.minimumDisplaySeconds; $("assetLead").value = placement.leadSeconds; $("assetTail").value = placement.tailSeconds; $("assetAlt").value = placement.alt;
  }
}

/* Paint ONE placement on the preview stage: which <img>/<video> is live, its
 * source, framing, motion and caption.
 *
 * `render()` calls this with the operator's selection; playback calls it with the
 * picture the export would be showing at that moment. Only the stage is touched —
 * the 素材画面 inputs stay in `render()` — so a picture rotating under the playhead
 * can never rewrite the panel the operator is editing.
 *
 * Re-assigning `src` for the picture that is already on screen is skipped: every
 * `render()` used to reload it, which hid the frame for a beat and restarted the
 * push-in mid-playback.
 */
function applyPreviewStagePlacement(scene, placement) {
  const asset = placement ? assetById(placement.assetId) : null;
  const isCover = scene?.section === "cover";
  const previewAssetNode = $("previewAsset");
  const previewVideoNode = $("previewAssetVideo");
  const previewIsVideo = asset?.type === "video";
  $("previewAssetFrame").hidden = !asset || isCover;
  $("previewAssetCaption").hidden = !asset || isCover;
  previewAssetNode.hidden = !asset || isCover || previewIsVideo;
  previewVideoNode.hidden = !asset || isCover || !previewIsVideo;
  if (previewVideoNode.hidden && !previewVideoNode.paused) previewVideoNode.pause();
  if (!asset || !placement || isCover) { state.previewStageSceneId = null; state.previewStageAssetId = null; return; }
  const previewAsset = previewIsVideo ? previewVideoNode : previewAssetNode;
  const idleAsset = previewIsVideo ? previewAssetNode : previewVideoNode;
  const previewAssetCaption = $("previewAssetCaption");
  const previewSceneId = scene.id;
  const previewAssetId = asset.id;
  const painted = state.previewStageSceneId === previewSceneId && state.previewStageAssetId === previewAssetId;
  const revealLoadedAsset = () => {
    if (selectedScene()?.id !== previewSceneId || state.previewStageAssetId !== previewAssetId) return;
    revealSelectedSceneAsset();
  };
  if (!painted) {
    state.previewStageSceneId = previewSceneId;
    state.previewStageAssetId = previewAssetId;
    setPreviewAssetVisible(false);
    // 另一条通道要彻底停掉并清源，否则换素材后旧画面会留着（视频尤其明显）。
    if (idleAsset instanceof HTMLVideoElement) {
      idleAsset.pause();
      idleAsset.removeAttribute("src");
      idleAsset.load();
    } else {
      idleAsset.removeAttribute("src");
    }
    const mediaFailed = () => {
      if (selectedScene()?.id !== previewSceneId || state.previewStageAssetId !== previewAssetId) return;
      setPreviewAssetVisible(false);
    };
    if (previewAsset instanceof HTMLVideoElement) {
      previewAsset.onloadeddata = revealLoadedAsset;
      previewAsset.onerror = mediaFailed;
      previewAsset.muted = false;
      previewAsset.volume = 0.6;
      previewAsset.src = assetUrl(asset);
    } else {
      previewAsset.onload = revealLoadedAsset;
      previewAsset.onerror = mediaFailed;
      previewAsset.src = assetUrl(asset);
    }
  }
  if (previewMediaReady(previewAsset)) revealLoadedAsset();
  /* `fullscreen` is a layout, not an object-fit keyword: handing it straight to
     the canvas would be an invalid value and the browser would keep whatever
     object-fit was set last. It fills the frame, so it crops like `cover`. */
  const previewFullscreen = placement.fit === "fullscreen";
  previewAsset.style.objectFit = placement.fit === "fill" ? "fill" : previewFullscreen ? "cover" : placement.fit;
  previewAsset.style.objectPosition = `${placement.focalPoint.x * 100}% ${placement.focalPoint.y * 100}%`;
  const previewAssetFrame = $("previewAssetFrame");
  previewAssetFrame.classList.toggle("is-fullscreen", previewFullscreen);
  previewAssetCaption.classList.toggle("is-fullscreen", previewFullscreen);
  previewAssetFrame.style.setProperty("--asset-scale", String(placement.scale));
  previewAssetFrame.style.setProperty("--asset-offset-x", `${placement.offsetX}px`);
  previewAssetFrame.style.setProperty("--asset-offset-y", `${placement.offsetY}px`);
  previewAssetFrame.style.setProperty("--asset-motion-duration", `${Math.max(2, Number(scene.duration) || 8)}s`);
  const motionClasses = ["motion-push-in", "motion-pull-out", "motion-pan-left", "motion-pan-right"];
  previewAsset.classList.remove(...motionClasses);
  if (!painted) void previewAsset.offsetWidth;
  previewAsset.classList.toggle("motion-push-in", placement.animation === "push-in");
  previewAsset.classList.toggle("motion-pull-out", placement.animation === "pull-out");
  previewAsset.classList.toggle("motion-pan-left", placement.animation === "pan-left");
  previewAsset.classList.toggle("motion-pan-right", placement.animation === "pan-right");
  previewAssetCaption.textContent = asset.name;
  previewAssetCaption.title = asset.name;
}


function renderMapView() {
  const scene = selectedScene();
  const panel = $("mapViewControls");
  panel.hidden = state.previewMode !== "actual" || !scene || scene.section === "cover";
  if (panel.hidden) panel.open = false;
  const view = scene?.mapView ?? DEFAULT_MAP_VIEW;
  for (const input of panel.querySelectorAll("input[name]")) input.value = view[input.name];
  $("resetMapView").disabled = !scene?.mapView;
}

function pushMapView() {
  if ($("cesiumPreview").hidden) return;
  $("cesiumPreview").contentWindow?.postMessage({
    type: "geo-video-studio", action: "set-map-view", mapView: selectedScene()?.mapView ?? null
  }, CESIUM_PREVIEW_ORIGIN);
}

function updateMapView(input) {
  const scene = selectedScene();
  if (!scene || scene.section === "cover") return;
  if (input) {
    const value = Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : DEFAULT_MAP_VIEW[input.name];
    scene.mapView = { ...DEFAULT_MAP_VIEW, ...scene.mapView, [input.name]: Math.min(Number(input.max), Math.max(Number(input.min), value)) };
  } else delete scene.mapView;
  markDirty();
  renderMapView();
  pushMapView();
}

function setPreviewMode(mode) {
  state.previewMode = mode === "safe" ? "safe" : "actual";
  $("actualViewTab").classList.toggle("active", state.previewMode === "actual");
  $("safeAreaTab").classList.toggle("active", state.previewMode === "safe");
  $("actualViewTab").setAttribute("aria-pressed", String(state.previewMode === "actual"));
  $("safeAreaTab").setAttribute("aria-pressed", String(state.previewMode === "safe"));
  $("safeArea").hidden = state.previewMode !== "safe";
  renderMapView();
}

function bindAssetToScene(id) {
  const scene = selectedScene(); const asset = assetById(id); if (!scene || !asset) return toast("请先选择场景");
  if (scene.section === "cover") return toast("封面请在左侧封面设置中配置");
  scene.placements ||= []; scene.assetIds ||= [];
  const existing = scene.placements.find((item) => item.assetId === id);
  if (existing) { state.selectedAssetId = id; render(); return toast("该素材已在当前场景"); }
  pushAssetUndo({ kind: "bind", sceneId: scene.id, assetId: id, assetName: asset.name, prev: sceneAssetSnapshot(scene) });
  scene.placements.push(defaultPlacement(asset, scene));
  if (!scene.assetIds.includes(id)) scene.assetIds.push(id);
  state.selectedAssetId = id; touchAsset(id); markDirty(); render();
}

function removeAssetFromScene(id) {
  const scene = selectedScene(); if (!scene) return;
  const asset = assetById(id);
  if (!(scene.placements || []).some((item) => item.assetId === id)) return;
  pushAssetUndo({ kind: "remove", sceneId: scene.id, assetId: id, assetName: asset?.name || "", prev: sceneAssetSnapshot(scene) });
  scene.placements = (scene.placements || []).filter((item) => item.assetId !== id);
  scene.assetIds = (scene.assetIds || []).filter((value) => value !== id);
  if (state.selectedAssetId === id) state.selectedAssetId = scene.placements[0]?.assetId || null;
  markDirty(); render();
  toast(scene.placements.length
    ? `已从“${scene.title}”移除素材`
    : `已从“${scene.title}”移除素材，该场景已无素材（Ctrl+Z 可恢复）`);
  const addButton = $("toggleSceneAssetPicker");
  if (addButton) addButton.focus({ preventScroll: true });
}

async function setPrimarySceneAsset(id) {
  const scene = selectedScene(); if (!scene) return;
  const placementIndex = (scene.placements || []).findIndex((item) => item.assetId === id);
  if (placementIndex < 0) return toast("该素材已不在当前场景");
  materializeSceneAssetSelection(scene);
  const targetPlacement = scene.placements[placementIndex];
  const needsPersist = placementIndex !== 0 || scene.assetIds?.[0] !== id || targetPlacement.includeInRender !== true;
  if (needsPersist) {
    pushAssetUndo({ kind: "primary", sceneId: scene.id, assetId: id, prev: sceneAssetSnapshot(scene) });
    const [placement] = scene.placements.splice(placementIndex, 1);
    placement.includeInRender = true;
    scene.placements.unshift(placement);
    scene.assetIds = [id, ...(scene.assetIds || []).filter((assetId) => assetId !== id)];
  }
  state.selectedAssetId = id;
  state.sceneAssetPickerOpen = false;
  state.sceneAssetPickerReplaceId = null;
  state.sceneAssetReplaceCandidateId = null;
  touchAsset(id);
  if (needsPersist) markDirty();
  render();
  toastSuccess(needsPersist ? "已设为首图并加入成片；点击“保存方案”后生效" : "已设为首图并加入成片");
}

function openSceneAssetReplace(id) {
  const scene = selectedScene(); if (!scene) return;
  const placement = (scene.placements || []).find((item) => item.assetId === id);
  if (!placement) return;
  state.sceneAssetPickerReplaceId = id;
  state.sceneAssetReplaceCandidateId = null;
  state.sceneAssetApplyRecommended = false;
  state.selectedAssetId = id;
  state.sceneAssetPickerOpen = true;
  render();
}

function replaceBoundAsset(originalId, nextId, applyRecommended = false) {
  const scene = selectedScene(); if (!scene || originalId === nextId) return;
  const asset = assetById(nextId); if (!asset) return toast("目标素材不存在");
  const placement = (scene.placements || []).find((item) => item.assetId === originalId);
  if (!placement) return toast("原素材已不在当前场景");
  pushAssetUndo({ kind: "replace", sceneId: scene.id, assetId: originalId, assetName: asset.name, prev: sceneAssetSnapshot(scene) });
  const oldAlt = String(placement.alt || "").trim();
  const oldWasVideo = assetById(originalId)?.type === "video";
  placement.assetId = nextId;
  // Keep the manually written alt text; only fill it in when it was empty.
  if (!oldAlt) placement.alt = asset.alt || asset.name || "";
  if (applyRecommended) {
    const isVideo = asset.type === "video";
    placement.fit = "cover";
    placement.animation = isVideo ? "still" : "push-in";
    placement.scale = 1; placement.offsetX = 0; placement.offsetY = 0;
    placement.focalPoint = { x: 0.5, y: 0.5 };
    if (asset.type === "image" && oldWasVideo) placement.minimumDisplaySeconds = Math.max(2, scene.timing?.minimumVisualSeconds || 2);
  } else if (asset.type === "video" && placement.animation !== "still") {
    // A moving image animation over a playing video reads as a bug; switch it
    // silently only here and make the change explicit in the toast.
    placement.animation = "still";
    toast("替换为视频，动画已自动设为静止（可在素材画面面板再调整）");
  } else if (asset.type === "image" && !applyRecommended) {
    const note = placement.animation === "still" ? "图片建议搭配推近/平移动画，可在“素材画面”中调整" : "";
    if (note) toast(note);
  }
  scene.assetIds = [...new Set([...(scene.assetIds || []).filter((value) => value !== originalId), nextId])];
  state.selectedAssetId = nextId;
  state.sceneAssetPickerReplaceId = null;
  state.sceneAssetReplaceCandidateId = null;
  state.sceneAssetApplyRecommended = false;
  state.sceneAssetPickerOpen = false;
  touchAsset(nextId);
  markDirty(); render();
  toast(applyRecommended ? "已替换，并按新素材类型应用了推荐参数" : "已替换当前场景素材（保留原有裁切与动画）");
  focusSceneAssetEditor();
}

function replaceSceneNameReference(text, previousName, nextName) {
  if (!previousName || !nextName || previousName === nextName) return text;
  return String(text || "").split(previousName).join(nextName);
}

/**
 * A placement's `requiredKeywords` is the claim "the sentence that shows this
 * photo contains this text". Renaming a child unit rewrites the narration, so it
 * has to rewrite the keywords in exactly the same way — otherwise the claim goes
 * stale the moment the unit is renamed, and the composer silently re-anchors (or
 * warns about) every photo in the scene. Renaming `西连村` to `西连社区` this way
 * left 79 placements pointing at a name that no longer existed anywhere.
 */
function replaceSceneKeywordReference(placements, previousName, nextName) {
  if (!previousName || !nextName || previousName === nextName) return 0;
  let changed = 0;
  for (const placement of placements || []) {
    const keywords = placement?.requiredKeywords;
    if (!Array.isArray(keywords) || !keywords.length) continue;
    const next = keywords.map((keyword) => replaceSceneNameReference(keyword, previousName, nextName));
    if (next.some((keyword, index) => keyword !== keywords[index])) { placement.requiredKeywords = next; changed += 1; }
  }
  return changed;
}

function pushChildLabelOverrides() {
  const labels = state.project?.scenes
    .filter((scene) => scene.section === "child" && scene.childId && scene.childName)
    .map((scene) => ({ id: scene.childId, name: scene.childName })) || [];
  $("cesiumPreview").contentWindow?.postMessage({
    type: "geo-video-studio",
    action: "update-tour-labels",
    labels
  }, CESIUM_PREVIEW_ORIGIN);
}

function editScene(key, value) {
  const scene = selectedScene(); if (!scene) return;
  if (key === "title" && scene.section === "child") {
    const previousName = String(scene.childName || scene.title || "").trim();
    const nextName = String(value || "").trim();
    scene.title = value;
    if (nextName) {
      scene.childName = nextName;
      scene.narration = replaceSceneNameReference(scene.narration, previousName, nextName);
      scene.subtitle = scene.narration;
      replaceSceneKeywordReference(scene.placements, previousName, nextName);
    }
    draftSceneDuration(scene);
    markDirty(); render();
    pushChildLabelOverrides();
    return;
  }
  if (key === "narration") {
    scene.narration = value;
    // Subtitle text has one source of truth. Line breaking is generated from
    // the narration later, using the final voice timing and output profile.
    scene.subtitle = value;
    draftSceneDuration(scene);
    markDirty(); render();
    return;
  }
  scene[key] = value; markDirty(); render();
}
function editTiming(key, value) { const scene = selectedScene(); if (!scene) return; scene.timing ||= { actualNarrationSeconds: scene.duration, preHoldSeconds: 0, postHoldSeconds: 0, minimumVisualSeconds: Math.max(2, scene.duration), mapHoldSeconds: 0 }; scene.timing[key] = Math.max(0, Number(value)); markDirty(); render(); }
function editPlacement(key, value) { const placement = selectedPlacement(); if (!placement) return; if (key === "focalX" || key === "focalY") placement.focalPoint[key === "focalX" ? "x" : "y"] = Number(value); else placement[key] = value; markDirty(); render(); }
function editCamera() { const scene = selectedScene(); if (!scene || scene.section !== "child") return; scene.camera = { ...(scene.camera || {}), longitude: Number($("longitude").value), latitude: Number($("latitude").value), height: Number($("height").value), heading: scene.camera?.heading || 0, pitch: scene.camera?.pitch || -64, roll: scene.camera?.roll || 0, transition: "fly" }; markDirty(); }

const contentSceneDefaults = {
  type: "image-card",
  title: "总体补充 01",
  narration: "请填写这一场景的完整旁白。",
  mapHoldSeconds: 0
};

function addScene(forceSection) {
  const scenes = state.project.scenes;
  const currentIndex = scenes.findIndex((item) => item.id === state.selectedSceneId);
  const current = currentIndex >= 0 ? scenes[currentIndex] : null;
  // Which block the new row joins. An explicit request (the "+ 新增场景" button on a
  // the closing group heading) always wins. Otherwise either closing-block row keeps the
  // author working in place: an existing outro-lead scene, but ALSO the outro itself —
  // the closing block starts out EMPTY, so without the outro case there would be no way
  // to create the very first outro-lead scene (nothing to select → always landed in
  // overview, which reads as "结尾加不了"). Anything else lands in the opening block.
  const inClosingBlock = forceSection
    ? forceSection === "outro-lead"
    : (current?.section === "outro-lead" || current?.section === "outro");
  const section = inClosingBlock ? "outro-lead" : "overview";
  const defaults = contentSceneDefaults;
  const id = section === "outro-lead"
    ? `outro-lead-${Date.now().toString(36)}`
    : `overview-content-${Date.now().toString(36)}`;
  const duration = 4;
  const scene = {
    id, type: defaults.type, section, title: nextContentSceneTitle(section),
    narration: defaults.narration, subtitle: defaults.narration, duration,
    assetIds: [], placements: [],
    timing: { actualNarrationSeconds: duration, preHoldSeconds: 0, postHoldSeconds: 0, minimumVisualSeconds: duration, mapHoldSeconds: defaults.mapHoldSeconds }
  };
  let insertIndex;
  if (inClosingBlock) {
    // 结尾补充 plays after the pull-back, so it is the last thing on the tape —
    // append to the very end rather than slotting anything in before the outro.
    insertIndex = scenes.length;
  } else if (current?.section === "overview") {
    insertIndex = currentIndex + 1;
  } else {
    const firstLockedIndex = scenes.findIndex((item) => item.section === "child" || item.section === "outro-lead" || item.section === "outro");
    insertIndex = firstLockedIndex < 0 ? scenes.length : firstLockedIndex;
  }
  scenes.splice(insertIndex, 0, scene);
  draftSceneDuration(scene);
  state.selectedSceneId = id; state.selectedAssetId = null;
  markDirty(); render();
  requestAnimationFrame(() => {
    $("sceneTitle")?.focus();
    $("sceneTitle")?.select();
  });
  toast(section === "outro-lead" ? "已新增结尾补充场景" : "已新增总体补充场景");
}

// The block "+" buttons sit in a heading the author may click twice in quick
// succession; without a floor each click mints another scene. Kept here rather than
// inside the render wiring so both block buttons share one clock.
let lastAddSceneAt = 0;
function addSceneSafely(forceSection) {
  const now = Date.now();
  if (now - lastAddSceneAt < 350) return;
  lastAddSceneAt = now;
  addScene(forceSection);
}

const adminLevelName = { province: "省级", city: "市级", county: "区县级", town: "乡镇级" };

function setAdminOptions(id, items, placeholder = "请选择") {
  const select = $(id);
  select.innerHTML = `<option value="">${placeholder}</option>${items.map((item) => `<option value="${item.code}">${escapeHtml(item.name)} · ${item.code}</option>`).join("")}`;
  select.disabled = items.length === 0;
}

async function loadAdminChildren(level, parent) {
  if (!parent) return [];
  return api(`/api/admin-divisions?level=${level}&parent=${encodeURIComponent(parent)}`);
}

function updateRegionSelection(node = state.admin.selected) {
  state.admin.selected = node?.level === "town" ? node : null;
  const meta = $("regionSelectionMeta"); const button = $("applyRegion"); const summary = $("regionSummary");
  const selectionAction = state.creation.selectingRegion ? "选择此地区并继续" : "使用所选乡镇新建项目";
  if (!node) {
    meta.className = "region-selection-meta"; meta.textContent = "请选择到乡镇/街道；边界目录与视频内容项目相互独立。"; summary.textContent = "选择乡镇/街道"; button.textContent = selectionAction; button.disabled = true; return;
  }
  if (node.level !== "town") {
    meta.className = "region-selection-meta"; meta.textContent = `${node.breadcrumb} · 请选择下级乡镇/街道`; summary.textContent = node.name; button.textContent = selectionAction; button.disabled = true; return;
  }
  summary.textContent = `${node.name} · ${node.villageCount} 个村级区`;
  meta.className = `region-selection-meta ${node.productionReady ? "ready" : "pending"}`;
  meta.textContent = node.productionReady
    ? `${node.breadcrumb} · ${node.villageCount} 个村级边界 · 已具备视频制作配置`
    : `${node.breadcrumb} · ${node.villageCount} 个村级边界 · 点击下方可自动生成初始方案`;
  button.textContent = state.creation.selectingRegion
    ? "选择此地区并继续"
    : node.productionReady
      ? "使用所选乡镇新建项目"
      : "自动生成初始方案";
  button.disabled = node.villageCount <= 0;
}

async function selectProvince(code, preferredCity = "") {
  state.admin.cities = code ? await loadAdminChildren("city", code) : [];
  state.admin.counties = []; state.admin.towns = []; state.admin.selected = null;
  setAdminOptions("citySelect", state.admin.cities, "请选择市"); setAdminOptions("countySelect", [], "请选择区县"); setAdminOptions("townSelect", [], "请选择乡镇/街道");
  if (preferredCity) $("citySelect").value = preferredCity;
  updateRegionSelection(state.admin.provinces.find((item) => item.code === code));
}

async function selectCity(code, preferredCounty = "") {
  state.admin.counties = code ? await loadAdminChildren("county", code) : [];
  state.admin.towns = []; state.admin.selected = null;
  setAdminOptions("countySelect", state.admin.counties, "请选择区县"); setAdminOptions("townSelect", [], "请选择乡镇/街道");
  if (preferredCounty) $("countySelect").value = preferredCounty;
  updateRegionSelection(state.admin.cities.find((item) => item.code === code));
}

async function selectCounty(code, preferredTown = "") {
  state.admin.towns = code ? await loadAdminChildren("town", code) : [];
  state.admin.selected = null; setAdminOptions("townSelect", state.admin.towns, "请选择乡镇/街道");
  if (preferredTown) $("townSelect").value = preferredTown;
  updateRegionSelection(state.admin.counties.find((item) => item.code === code));
}

function selectTown(code) { updateRegionSelection(state.admin.towns.find((item) => item.code === code)); }

async function locateRegion(code) {
  const location = await api(`/api/admin-divisions/locate?code=${encodeURIComponent(code)}`);
  const province = location.chain.find((item) => item.level === "province");
  const city = location.chain.find((item) => item.level === "city");
  const county = location.chain.find((item) => item.level === "county");
  const town = location.chain.find((item) => item.level === "town");
  if (province) { $("provinceSelect").value = province.code; await selectProvince(province.code, city?.code); }
  if (city) { $("citySelect").value = city.code; await selectCity(city.code, county?.code); }
  if (county) { $("countySelect").value = county.code; await selectCounty(county.code, town?.code); }
  if (town) { $("townSelect").value = town.code; selectTown(town.code); } else updateRegionSelection(location.node);
  $("regionSearchResults").hidden = true;
}

function renderSearchResults(results) {
  const panel = $("regionSearchResults"); panel.hidden = false;
  if (!results.length) { panel.innerHTML = `<div class="region-search-empty">未找到匹配的行政区，请尝试完整名称或区划代码。</div>`; return; }
  panel.innerHTML = results.map((node) => `<button class="region-result ${node.productionReady ? "ready" : ""}" data-admin-code="${node.code}"><b>${escapeHtml(node.name)} · ${node.code}</b><small>${escapeHtml(node.breadcrumb)} · ${adminLevelName[node.level]}</small><em>${node.productionReady ? "可制作" : "边界数据"}</em></button>`).join("");
  panel.querySelectorAll("[data-admin-code]").forEach((button) => button.onclick = async () => { try { await locateRegion(button.dataset.adminCode); } catch (error) { toastError(error.message); } });
}

async function searchRegions() {
  const query = $("regionSearch").value.trim();
  if (query.length < 2) { $("regionSearchResults").hidden = true; return; }
  try { renderSearchResults(await api(`/api/admin-divisions/search?q=${encodeURIComponent(query)}`)); }
  catch (error) { toastError(error.message); }
}

async function createProject(regionId = state.admin.selected?.code) {
  if (!(await saveBeforeAction("创建新方案"))) return;
  if (!regionId) {
    updateRegionSelection();
    throw new Error("请先选择乡镇/街道，再创建方案");
  }
  const selectedNode = state.admin.selected?.code === regionId ? state.admin.selected : null;
  // Both lines name the plan being created. The node has to be resolved first:
  // `selectedNode` is a `const` in this scope, so naming it a line earlier is a
  // temporal-dead-zone ReferenceError that aborts the whole creation, not a
  // stale label.
  setProjectBusy(true, "正在创建项目…", `正在创建方案：${selectedNode?.name || regionId}`);
  const wasGenerated = Boolean(selectedNode && !selectedNode.productionReady);
  try {
    const poiEnabled = $("poiAutoImport")?.checked;
    if (poiEnabled && !state.amap.selectedTypes.size) throw new Error("请至少选择一种 POI 类型");
    const suppliedKey = $("amapKey")?.value.trim();
    if (poiEnabled && !suppliedKey && !state.amap.keyConfigured) throw new Error("请填写高德 Web 服务 Key");
    $("applyRegion").disabled = true; $("applyRegion").textContent = poiEnabled ? "正在按村界采集并绑定素材…" : wasGenerated ? "正在提取边界并生成方案…" : "正在创建项目…";
    stopPlayback();
    const project = await api("/api/projects", { method: "POST", body: JSON.stringify({
      regionId,
      poiImport: poiEnabled ? { enabled: true, typeCodes: [...state.amap.selectedTypes], keyword: $("poiKeyword").value.trim(), ...(suppliedKey ? { apiKey: suppliedKey } : {}) } : { enabled: false }
    }) });
    if (suppliedKey) { $("amapKey").value = ""; state.amap.keyConfigured = true; $("amapKey").placeholder = "本机已配置，可留空"; }
    if (selectedNode) selectedNode.productionReady = true;
    state.project = project;
    upsertProjectList(project);
    rememberCurrentProject();
    state.selectedSceneId = project.scenes[0]?.id || null;
    state.selectedAssetId = project.scenes[0]?.placements?.[0]?.assetId || null;
    state.renderSpec = null; state.renderSpecStale = false; state.readiness = null; state.dirty = false;
    renderSaveState("saved");
    state.previewAudio?.pause(); state.previewAudio = null; state.previewAudioProjectId = null;
    showOutputLocation(null);
    render();
    setProjectBusy(true, "正在生成场景与导出检查（约 10-30 秒）…", `正在创建：${project.name || ""}`);
    try { await locateRegion(project.regionId); }
    catch (error) { toastError(`项目已创建，选区面板刷新失败：${error.message}`); }
    await syncProjectState();
    ensurePreviewAudio();
    await loadLatestExport().catch(() => showOutputLocation(null));
    setProjectBusy(false);
    toast(project.poiImport
      ? `项目已创建：按村界匹配 ${project.poiImport.totalPois} 个 POI，绑定 ${project.poiImport.totalPhotos} 张图片`
      : wasGenerated ? "初始方案已生成，可继续补充真实素材与文案" : `新项目已创建：${project.name}`);
  } catch (error) { toastError(error.message); updateRegionSelection(selectedNode); setProjectBusy(false); }
}

async function regenerateProjectCopy() {
  if (!state.project) return;
  if (!(await saveBeforeAction("生成文案"))) return;
  const button = $("regenerateProjectCopy");
  const status = $("aiCopyStatus");
  const originalLabel = button ? button.textContent : "";
  const beforeCopy = new Map(state.project.scenes.map((scene) => [scene.id, scene.narration || ""]));
  const reference = String($("copyReference")?.value ?? "").trim();
  const usedReference = reference.length > 0;
  if (button) { button.disabled = true; button.textContent = "正在生成文案…"; }
  if (status) status.textContent = usedReference
    ? "正在按参考文案风格调用 DeepSeek 重新生成旁白与字幕（约 8-20 秒）…"
    : "正在调用 DeepSeek 重新生成旁白与字幕（约 5-15 秒）…";
  try {
    const saved = await api(`/api/projects/${state.project.id}/generate-copy`, { method: "POST", body: JSON.stringify(usedReference ? { reference } : {}) });
    const changedScenes = saved.scenes.filter((scene) => scene.section !== "cover" && (scene.narration || "") !== beforeCopy.get(scene.id));
    state.project = saved;
    state.renderSpec = null;
    state.renderSpecStale = false;
    state.readiness = null;
    state.dirty = false;
    renderSaveState("saved");
    upsertProjectList(saved);
    render();
    await syncProjectState();
    if (!changedScenes.length) {
      if (status) status.textContent = "已调用 DeepSeek，但返回内容与当前文案几乎一致，可再次点击重试";
      toast("生成完成：文案与当前几乎一致，如需改动可手动编辑");
      return;
    }
    const firstChanged = changedScenes[0];
    state.selectedSceneId = firstChanged.id;
    state.selectedAssetId = firstChanged.placements?.[0]?.assetId || null;
    render();
    const sample = String(firstChanged.narration || "").slice(0, 22);
    const scopeLabel = usedReference ? "已按参考文案风格重写" : "已重新生成";
    if (status) status.textContent = `${scopeLabel}：${changedScenes.length} 个场景有更新，已定位到「${firstChanged.childName || firstChanged.title || ""}」`;
    toast(`${scopeLabel} ${changedScenes.length}/${saved.scenes.filter((s) => s.section !== "cover").length} 个场景，示例：“${sample}…”`);
  } catch (error) {
    toastError(error.message);
    if (status) status.textContent = `生成失败：${error.message}`;
  } finally {
    if (button) { button.disabled = false; button.textContent = originalLabel || "重新生成当前项目文案"; }
  }
}
async function regenerateSceneCopy() {
  if (!state.project) return;
  if (!(await saveBeforeAction("生成本场景文案"))) return;
  const project = state.project; const scene = selectedScene();
  if (!project || !scene || scene.section === "cover") return;
  const button = $("regenerateSceneCopy");
  const previous = scene.narration || "";
  if (button) { button.disabled = true; button.textContent = "生成中…"; }
  const reference = String($("copyReference")?.value ?? "").trim();
  try {
    const saved = await api(`/api/projects/${project.id}/generate-copy`, {
      method: "POST",
      body: JSON.stringify({ sceneId: scene.id, ...(reference ? { reference } : {}) })
    });
    const updated = saved.scenes.find((item) => item.id === scene.id);
    const next = updated?.narration || "";
    state.project = saved;
    state.renderSpec = null;
    state.renderSpecStale = false;
    state.readiness = null;
    state.dirty = false;
    renderSaveState("saved");
    upsertProjectList(saved);
    render();
    await syncProjectState();
    if (!next || next === previous) toast("本场景文案与当前几乎一致，可再试一次或手动润色");
    else toast("已重写本场景旁白（不影响其他场景）");
  } catch (error) {
    toastError(error.message);
  } finally {
    if (button) { button.disabled = false; button.textContent = scene.section === "child" ? "AI 重写本村旁白" : "AI 重写本场景旁白"; }
  }
}

// Overview splitter: break one long overview narration into several scenes of
// at most two sentences each, then bind verified project photos to a group only
// when the group's own words name the place they show. The matching rules live
// in `scene-asset-match.js` so the browser and the tests share one copy.
function splitSentences(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return [];
  const parts = cleaned.split(/(?<=[。！？；…!?;])/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : [cleaned];
}
function defaultPlacementForAsset(asset, scene, duration, keyword) {
  const imageSeconds = Math.max(2.4, Number(duration) || 4);
  return {
    assetId: asset.id,
    fit: "cover",
    crop: { x: 0, y: 0, width: 1, height: 1 },
    focalPoint: { x: 0.5, y: 0.5 },
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    animation: "push-in",
    leadSeconds: 0.15,
    tailSeconds: 0.25,
    minimumDisplaySeconds: imageSeconds,
    // The word that puts this photo on the sentence naming its subject. Without
    // it the clip keeps its declared cue and drifts onto whatever is playing.
    requiredKeywords: keyword ? [keyword] : [],
    alt: asset.alt || asset.name || ""
  };
}
function autoMatchAssetsForText(narration) {
  const project = state.project; if (!project) return [];
  const cover = project.cover || {};
  return selectSceneAssetsForNarration({
    assets: project.assets, narration, regionId: project.regionId, limit: 2,
    // The region's own chain, so a POI named after its town or county ("乌石"
    // under 乌石镇, "雷州" under 雷州市) cannot pass as evidence about a photo.
    regionNames: [cover.province, cover.city, cover.county, cover.town],
    // Amap material names carry the village in `poi.childName`; web-manifest
    // photos have no `poi`, so fall back to the scene that owns the photo.
    childNameOf: (asset) => asset.poi?.childName
      ?? project.scenes.find((scene) => scene.childId && scene.childId === asset.scope?.childId)?.childName
  });
}
function splitOverviewScene() {
  const project = state.project; const scene = selectedScene();
  if (!project || !scene || scene.section !== "overview") return toast("仅总体介绍场景可拆分");
  const sentences = splitSentences(scene.narration);
  if (sentences.length <= 2) return toast("本场景文案只有 " + sentences.length + " 句，无需拆分");
  const groups = [];
  for (let index = 0; index < sentences.length; index += 2) groups.push(sentences.slice(index, index + 2).join(""));
  const stamp = Date.now().toString(36);
  const originalIndex = project.scenes.findIndex((item) => item.id === scene.id);
  const replaceWith = [];
  const keepCamera = scene.camera; const keepType = scene.type;
  const keptFirstTiming = scene.timing ? { ...scene.timing } : null;
  const firstDuration = Math.max(2, [...groups[0]].length / 4);
  const firstTitle = scene.title || `总体介绍`;
  let unboundGroups = 0;
  groups.forEach((text, groupIndex) => {
    const duration = Math.max(2, [...text].length / 4);
    const isOriginal = groupIndex === 0;
    const matches = isOriginal ? [] : autoMatchAssetsForText(text);
    if (!isOriginal && !matches.length) unboundGroups += 1;
    const id = isOriginal ? scene.id : `overview-ai-${stamp}-${groupIndex + 1}`;
    const title = isOriginal ? firstTitle : `总体介绍 ${project.scenes.filter((item) => item.section === "overview" && item.id !== scene.id).length + groupIndex + 1}`;
    replaceWith.push({
      id,
      // No photo could be tied to this group, so it stays a map scene rather
      // than an image card with nothing in it.
      type: isOriginal ? keepType : (matches.length ? "image-card" : "map-overview"),
      section: "overview",
      title,
      narration: text,
      subtitle: text,
      duration,
      assetIds: isOriginal ? (scene.assetIds || []) : matches.map((match) => match.asset.id),
      placements: isOriginal ? (scene.placements || []) : matches.map((match) => defaultPlacementForAsset(match.asset, scene, duration, match.keyword)),
      ...(isOriginal && keepCamera ? { camera: keepCamera } : {}),
      ...(isOriginal && keptFirstTiming ? { timing: { ...keptFirstTiming, actualNarrationSeconds: firstDuration, minimumVisualSeconds: Math.max(keptFirstTiming.minimumVisualSeconds ?? firstDuration, firstDuration) } }
        : { timing: { actualNarrationSeconds: duration, preHoldSeconds: 0, postHoldSeconds: 0, minimumVisualSeconds: duration, mapHoldSeconds: 0 } })
    });
  });
  project.scenes.splice(originalIndex, 1, ...replaceWith);
  for (const item of replaceWith) draftSceneDuration(item);
  state.selectedSceneId = scene.id;
  state.selectedAssetId = null;
  markDirty();
  render();
  const matchedCount = replaceWith.reduce((sum, item) => sum + (item.placements?.length || 0), 0);
  const addedCount = replaceWith.length - 1;
  const skipped = unboundGroups ? `，${unboundGroups} 个场景没有找到能对上的图（留作地图镜头）` : "";
  toast(`已按文案拆成 ${replaceWith.length} 个场景（新增 ${addedCount} 个），配图 ${matchedCount} 张${skipped}；保存后生效`);
}

function showOutputLocation(job) {
  const belongsToCurrentProject = Boolean(job && state.project && job.projectId === state.project.id);
  state.outputJob = belongsToCurrentProject && job?.output && job.status === "completed" ? job : null;
}

async function loadLatestExport() {
  try { await loadExportHistory(); }
  catch { showOutputLocation(null); }
}

function syncPresetUI() {
  const project = state.project; if (!project) return;
  const profile = project.output?.profile;
  const quality = project.output?.quality;
  document.querySelectorAll(".profile-preset").forEach((button) => button.classList.toggle("active", button.dataset.profile === profile));
  document.querySelectorAll(".quality-preset").forEach((button) => button.classList.toggle("active", button.dataset.quality === quality));
}
function estimateVideoSeconds() {
  const spec = state.renderSpec;
  // The spec's own total is what the encoder is told to produce; the per-scene
  // cue ends are only a fallback for a spec that predates that field.
  const specTotal = Number(spec?.totalDurationSeconds);
  if (specTotal > 0) return specTotal;
  if (spec && Array.isArray(spec.scenes)) {
    const maxEnd = spec.scenes.reduce((max, scene) => Math.max(max, Number(scene.cueRange?.end) || 0), 0);
    if (maxEnd > 0) return maxEnd;
  }
  const project = state.project; if (!project) return 0;
  const cover = Number(project.cover?.introSeconds) || 0;
  return cover + project.scenes.filter((scene) => scene.section !== "cover").reduce((sum, scene) => sum + (Number(scene.duration) || 0), 0);
}

/**
 * Fallbacks for a workspace that has not finished an export since the render
 * engine started recording measurements.
 *
 * Taken from this machine's own completed portrait exports. The three that ran on
 * the current encoder (2026-10-12, `--workers 4`, at 7.8 / 8.9 / 9.4 wall minutes
 * per finished minute) are the relevant band; the 2026-09-14 … 09-22 runs were
 * 12–15.6 because they encoded on a single worker, and every finished MP4 lands at
 * 97–132 MB per finished minute regardless. A cache-reusing run drops the map
 * recording, which is roughly 40% of a cold one. The panel replaces these with the
 * workspace's own medians as soon as it has three measured samples.
 */
const EXPORT_ESTIMATE_FALLBACK = Object.freeze({
  coldMinutesPerMinute: 9.5,
  warmMinutesPerMinute: 6,
  megabytesPerMinute: 115
});

function medianOf(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Median rates from this workspace's finished exports of the same profile/quality.
 *
 * `videoDurationSeconds` and `outputBytes` are recorded by the render engine when a
 * job completes, so the estimate stops drifting the moment a couple of exports have
 * run. Jobs from before that was recorded are skipped rather than guessed at.
 */
function measuredExportRates(profile, quality) {
  // Newest first, then the eight most recent: the encoder's own settings move
  // (2026-10-12 took it from one capture worker to four, which is the difference
  // between the 12–15.6 minutes/minute runs of September and today's 7.8–9.4), so
  // an all-history median would describe a machine that no longer exists.
  const jobs = [...(state.exportJobs || [])]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .filter((job) => job.status === "completed"
    && job.profile === profile
    && (job.quality === "draft" ? "draft" : "high") === quality
    && Number(job.videoDurationSeconds) > 0
    && Number(job.outputBytes) > 0)
    .slice(0, 8);
  const wallMinutes = (job) => (new Date(job.updatedAt || job.createdAt).getTime() - new Date(job.createdAt).getTime()) / 60000;
  const videoMinutes = (job) => Number(job.videoDurationSeconds) / 60;
  const cold = [], warm = [], megabytes = [];
  for (const job of jobs) {
    const minutes = videoMinutes(job);
    if (minutes <= 0) continue;
    megabytes.push((Number(job.outputBytes) / 1024 / 1024) / minutes);
    const rate = wallMinutes(job) / minutes;
    if (!Number.isFinite(rate) || rate <= 0) continue;
    // A stage timing of zero seconds means the map video was copied out of
    // `workspace/render-cache` instead of being recorded again.
    (job.timings?.mapCacheHit ? warm : cold).push(rate);
  }
  const enough = (values) => values.length >= 3;
  return {
    samples: jobs.length,
    cold: enough(cold) ? medianOf(cold) : null,
    warm: enough(warm) ? medianOf(warm) : null,
    megabytesPerMinute: enough(megabytes) ? medianOf(megabytes) : null
  };
}

function refreshExportEstimate() {
  const el = $("exportEstimate"); if (!el) return;
  const project = state.project;
  const totalSec = estimateVideoSeconds();
  if (!project || totalSec <= 0) { el.hidden = true; return; }
  const minutes = totalSec / 60;
  const draft = project.output?.quality === "draft";
  const quality = draft ? "draft" : "high";
  const videoMin = minutes < 1 ? 1 : Math.round(minutes * 10) / 10;
  const measured = measuredExportRates(project.output?.profile || "portrait", quality);
  // The map cache is the difference between the fast and the slow band, and only
  // the server can see it; `mapCacheAvailable` rides along with the render spec.
  const reusesMap = Boolean(state.renderSpec?.mapCacheAvailable);
  const perMinute = (reusesMap ? measured.warm : measured.cold)
    ?? (reusesMap ? EXPORT_ESTIMATE_FALLBACK.warmMinutesPerMinute : EXPORT_ESTIMATE_FALLBACK.coldMinutesPerMinute);
  const estimateMin = Math.max(2, minutes * perMinute);
  // Measured spreads here are ±25% on a dozen samples and wider on a couple, so
  // the range widens with how little this workspace has actually run.
  const spread = measured.samples >= 6 ? 0.25 : measured.samples >= 3 ? 0.3 : 0.3;
  const renderLow = Math.max(2, Math.round(estimateMin * (1 - spread)));
  const renderHigh = Math.max(renderLow + 2, Math.round(estimateMin * (1 + spread)));
  const megabytesPerMinute = measured.megabytesPerMinute ?? (draft ? 60 : EXPORT_ESTIMATE_FALLBACK.megabytesPerMinute);
  const sizeMid = Math.max(5, minutes * megabytesPerMinute);
  const sizeLow = Math.round(sizeMid * 0.85);
  const sizeHigh = Math.round(sizeMid * 1.2);
  const source = measured.samples
    ? `按本机最近 ${measured.samples} 次成片实测${reusesMap ? "，将复用已录地图" : ""}`
    : "按本机历史经验估算";
  el.hidden = false;
  el.innerHTML = `<span class="est-dot"></span>成片约 <b>${videoMin} 分钟</b> · 预计渲染约 <b>${renderLow}–${renderHigh} 分钟</b> · 体积约 <b>${sizeLow}–${sizeHigh} MB</b><small>${source}</small>`;
}

/**
 * The film's picture track, drawn from the numbers the export will actually use.
 *
 * Every "这版怎么和我想的不一样" bug so far had the same shape: the editor knew
 * which pictures were ticked, the compositor knew where they landed, and the gap
 * between those two was only observable by rendering the film and watching it.
 * `visualTimeline` closes that gap — the server plans the clips with the same
 * helpers the export uses (`planVisualClip` / `resolveVisualClipWindow`), so a
 * card that leaves its scene, a scene that ships no picture, or a window too
 * short for its pictures is visible here, before a two-hour render.
 */
function renderExportTimeline() {
  const host = $("exportTimeline");
  if (!host) return;
  const timeline = state.renderSpec?.visualTimeline;
  if (!timeline || !Array.isArray(timeline.scenes) || timeline.scenes.length === 0) { host.hidden = true; return; }
  host.hidden = false;
  const total = Math.max(1, Number(timeline.totalSeconds) || 0);
  const percent = (seconds) => Math.max(0, Math.min(100, (Number(seconds) || 0) / total * 100));
  const clipsByScene = new Map();
  for (const clip of timeline.clips || []) {
    if (!clipsByScene.has(clip.sceneId)) clipsByScene.set(clip.sceneId, []);
    clipsByScene.get(clip.sceneId).push(clip);
  }
  const counts = timeline.counts || {};
  const summaryEl = $("exportTimelineSummary");
  if (summaryEl) {
    const parts = [`${timeline.scenes.length} 场`, `${counts.clips ?? 0} 张图`];
    if (counts.imageScenesWithoutPictures) parts.push(`${counts.imageScenesWithoutPictures} 场无图`);
    if (counts.clamped) parts.push(`${counts.clamped} 张被压短`);
    if (counts.tooShort) parts.push(`${counts.tooShort} 张不足 0.5 秒`);
    if (counts.overflows) parts.push(`${counts.overflows} 张越界`);
    summaryEl.textContent = parts.join(" · ");
    summaryEl.className = counts.overflows || counts.tooShort ? "is-warning" : "";
  }
  const rows = timeline.scenes.map((scene) => {
    const clips = clipsByScene.get(scene.id) || [];
    const left = percent(scene.startSeconds);
    const width = Math.max(0.25, percent(scene.endSeconds) - left);
    const bars = clips.map((clip) => {
      const clipLeft = percent(clip.startSeconds);
      const clipWidth = Math.max(0.4, percent(clip.endSeconds) - clipLeft);
      const tip = `${clip.label} · ${clip.startSeconds.toFixed(1)}–${clip.endSeconds.toFixed(1)} 秒（${(clip.endSeconds - clip.startSeconds).toFixed(1)} 秒）`;
      const clampedTip = clip.clamped ? ` · 最短展示由 ${clip.configuredMinimumSeconds} 秒压到 ${clip.minimumDisplaySeconds.toFixed(1)} 秒` : "";
      const className = `tl-clip${clip.overflowsScene ? " is-overflow" : ""}${clip.tooShort ? " is-short" : ""}`;
      return `<i class="${className}" style="left:${clipLeft}%;width:${clipWidth}%" title="${escapeHtml(tip + clampedTip)}"></i>`;
    }).join("");
    const empty = clips.length === 0 && scene.expectsImages;
    const rowTip = `${scene.title} · 旁白 ${scene.startSeconds.toFixed(1)}–${scene.endSeconds.toFixed(1)} 秒 · 绑定 ${scene.boundCount} 张 / 进片 ${scene.imageCount} 张`;
    return `<div class="tl-row${empty ? " is-empty" : ""}" title="${escapeHtml(rowTip)}"><span class="tl-name">${escapeHtml(scene.title)}</span><span class="tl-track"><i class="tl-narration" style="left:${left}%;width:${width}%"></i>${bars}</span><span class="tl-flag">${empty ? "无图" : ""}</span></div>`;
  }).join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map((ratio) => `<span style="left:${ratio * 100}%">${timelineClock(total * ratio)}</span>`)
    .join("");
  const body = $("exportTimelineBody");
  if (body) body.innerHTML = `<div class="tl-axis"><span class="tl-name"></span><span class="tl-ticks">${ticks}</span><span class="tl-flag"></span></div>${rows}`;
}

function timelineClock(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function exportStatusLabel(job) {
  if (job.status === "completed") return "已完成";
  if (job.status === "failed") return "失败";
  if (job.status === "cancelled") return "已取消";
  if (job.status === "queued") return job.queuePosition ? `排队第 ${job.queuePosition} 个` : "排队中";
  return `${job.stage} · ${job.progress}%`;
}

function exportProfileLabel(profile) {
  return profile === "landscape" ? "横屏 16:9" : profile === "square" ? "方形 1:1" : "竖屏 9:16";
}

function exportQualityLabel(quality) {
  return quality === "draft" ? "快速预览" : "正式成片";
}

function renderExportConnectionStatus(interrupted = false, delay = 0) {
  const host = $("exportConnectionStatus");
  if (!host) return;
  const updated = state.exportLastUpdated ? new Date(state.exportLastUpdated).toLocaleTimeString("zh-CN") : "尚未成功更新";
  host.hidden = false;
  host.classList.toggle("is-warning", interrupted);
  host.dataset.state = interrupted ? "interrupted" : "connected";
  host.textContent = `${interrupted ? `连接中断，${Math.ceil(delay / 1000)} 秒后自动重试` : "连接正常"} · 上次更新：${updated}`;
}

async function loadExportHistory() {
  if (!state.project) return [];
  const project = state.project;
  const projectId = project.id;
  const requestId = ++state.exportRequest;
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  try {
  /* Exports run on the Studio service, not in this tab, and the queue is global
     rather than per-project. So the panel also tracks in-flight jobs that belong
     to *other* projects: otherwise switching projects made a running export
     disappear from the list (and silently dropped its completion toast), which
     looked exactly like the export had been interrupted. */
  const isTerminal = (job) => ["completed", "failed", "cancelled"].includes(job.status);
  const [jobs, globalActive, measuredJobs] = await Promise.all([
    api(`/api/jobs?projectId=${encodeURIComponent(projectId)}&limit=50`),
    api("/api/jobs?active=1&limit=100").catch(() => []),
    // Rates are a property of this machine and its encoder settings, not of one
    // scheme, so the estimate samples the whole workspace: a scheme's own first
    // export would otherwise have nothing to learn from.
    api("/api/jobs?limit=40").catch(() => [])
  ]);
  if (state.project !== project || state.exportRequest !== requestId) return [];
  state.exportPollFailures = 0;
  state.exportLastUpdated = Date.now();
  renderExportConnectionStatus();
  /* Filter to non-terminal here as well: `active=1` is applied server-side, but
     re-checking keeps a browser running newer JS against an older service from
     listing finished history as if it were still running. */
  const foreignActive = globalActive.filter((job) => job.projectId !== projectId && !isTerminal(job));
  const running = jobs.filter((job) => !isTerminal(job) && job.status !== "queued");
  const queued = jobs.filter((job) => job.status === "queued");
  const foreignRunning = foreignActive.filter((job) => job.status !== "queued");
  const foreignQueued = foreignActive.filter((job) => job.status === "queued");
  const completedJobs = jobs.filter((job) => job.status === "completed" && job.output);
  // Keep the finished exports around: `refreshExportEstimate` medians their
  // measured wall time and MP4 size instead of showing a constant.
  const finished = measuredJobs.filter((job) => job.status === "completed" && Number(job.videoDurationSeconds) > 0);
  state.exportJobs = finished.length ? finished : jobs.filter((job) => job.status === "completed");
  const runningTotal = running.length + foreignRunning.length;
  const queuedTotal = queued.length + foreignQueued.length;
  const activeTotal = runningTotal + queuedTotal;
  $("exportRunningCount").textContent = String(runningTotal);
  $("exportQueuedCount").textContent = String(queuedTotal);
  $("exportCompletedCount").textContent = String(completedJobs.length);
  $("exportFooterHint").textContent = activeTotal
    ? `${runningTotal} 个处理中，${queuedTotal} 个等待${foreignActive.length ? `（含其它方案 ${foreignActive.length} 个，切换方案不会中断）` : ""}`
    : "任务会在后台继续运行";
  /* Keep a running export discoverable from the toolbar even after the user has
     switched to a project whose own list no longer holds it. The `.is-exporting`
     and `--export-progress` hooks already existed in the stylesheet but had
     never been driven from JS. */
  const statusBadge = $("exportButtonStatus");
  if (statusBadge) {
    statusBadge.hidden = activeTotal === 0;
    statusBadge.textContent = activeTotal ? `${activeTotal} 个任务进行中` : "";
  }
  const exportEntry = $("openExportPanel");
  if (exportEntry) {
    exportEntry.classList.toggle("is-exporting", activeTotal > 0);
    const lead = [...running, ...foreignRunning][0];
    exportEntry.style.setProperty("--export-progress", `${Math.round(Math.max(0, Math.min(100, Number(lead?.progress) || 0)) * 3.6)}deg`);
  }
  if (completedJobs[0]) showOutputLocation(completedJobs[0]);
  refreshExportEstimate();
  const priority = (job) => job.status === "queued" ? 1 : isTerminal(job) ? 2 : 0;
  const byQueueOrder = (a, b) => priority(a) - priority(b) || (a.status === "queued" ? Number(a.queuePosition || 999) - Number(b.queuePosition || 999) : b.createdAt.localeCompare(a.createdAt));
  const ordered = [...jobs].sort(byQueueOrder);
  function exportElapsed(job) {
    if (!job.createdAt) return "";
    const end = ["completed", "failed", "cancelled"].includes(job.status) ? new Date(job.updatedAt || job.createdAt) : new Date();
    const ms = Math.max(0, end.getTime() - new Date(job.createdAt).getTime());
    const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
    return `${m}分${String(s).padStart(2, "0")}秒`;
  }
  function exportDiagnostics(job) {
    const count = Array.isArray(job.diagnosticsFiles) ? job.diagnosticsFiles.length : 0;
    return job.diagnosticsDir && count > 0 ? `<button data-export-action="diagnostics" data-job-id="${job.id}">诊断文件 ${count}</button>` : "";
  }
  function exportDetailLine(job) {
    if (job.status === "completed" && job.output) return `${job.output} · 用时 ${exportElapsed(job)}`;
    // A one-line error is all a failed export used to keep; the capture report
    // now survives the sandbox prune, so say so instead of leaving the operator
    // with "timed out" and no next step.
    if (job.status === "failed") {
      const saved = Array.isArray(job.diagnosticsFiles) ? job.diagnosticsFiles.length : 0;
      return `${job.error || job.stage || "导出失败"}${saved > 0 ? ` · 已保存 ${saved} 份诊断文件` : ""}`;
    }
    if (job.status === "cancelled") return `已取消 · 用时 ${exportElapsed(job)}`;
    return `${job.stage || "处理中"} · 已运行 ${exportElapsed(job)} · 服务端更新时间 ${job.updatedAt ? new Date(job.updatedAt).toLocaleTimeString("zh-CN") : "未知"} · 任务在服务端运行`;
  }
  function exportCard(job, foreign) {
    const completed = job.status === "completed" && job.output;
    const retryable = ["failed", "cancelled"].includes(job.status);
    const terminal = isTerminal(job);
    const statusClass = completed ? "complete" : ["failed", "cancelled"].includes(job.status) ? "failed" : "running";
    /* A foreign job carries its own profile/quality; falling back to the open
       project's settings would mislabel it. */
    const profile = job.profile || (foreign ? "landscape" : state.project.output.profile);
    const quality = job.quality || (foreign ? "high" : state.project.output.quality);
    const title = `${foreign ? `${job.projectTitle || "其它方案"} · ` : ""}${exportProfileLabel(profile)} · ${exportQualityLabel(quality)}`;
    const detail = exportDetailLine(job);
    /* Only cancel is project-agnostic. Download, reveal-in-folder and delete all
       require the export to belong to the project open in the editor, so a
       foreign job offers cancel only instead of buttons that would 403. */
    const deleteAction = !foreign && terminal ? `<button class="delete-export" data-export-action="delete" data-job-id="${job.id}">删除</button>` : "";
    const actions = completed
      ? `<button data-export-action="copy" data-job-id="${job.id}">复制路径</button><button data-export-action="open" data-job-id="${job.id}">打开文件夹</button><a href="/api/jobs/${job.id}/download?projectId=${encodeURIComponent(projectId)}">下载 MP4</a>${deleteAction}`
      : !terminal ? `<button class="cancel-export" data-export-action="cancel" data-job-id="${job.id}">取消</button>`
      : foreign ? deleteAction
      : retryable ? `<button class="retry-export" data-export-action="retry" data-job-id="${job.id}">按当前方案重试</button>${!foreign ? exportDiagnostics(job) : ""}${deleteAction}` : `${!foreign ? exportDiagnostics(job) : ""}${deleteAction}`;
    return `<article class="export-history-item ${statusClass}${foreign ? " foreign" : ""}"><div class="export-history-main"><b>${escapeHtml(title)}</b><small>${escapeHtml(new Date(job.createdAt).toLocaleString("zh-CN"))} · ${escapeHtml(job.id.slice(0, 8))}</small></div><span class="export-history-state">${escapeHtml(exportStatusLabel(job))}</span>${!terminal ? `<div class="export-task-progress"><i style="width:${Math.max(2, Number(job.progress || 0))}%"></i></div>` : ""}<code class="export-task-detail">${escapeHtml(detail)}</code><div class="export-history-actions">${actions}</div></article>`;
  }
  const sections = ordered.length
    ? ordered.map((job) => exportCard(job, false))
    : [`<div class="export-history-empty">当前项目还没有导出记录</div>`];
  if (foreignActive.length) {
    sections.push(`<div class="export-history-divider">其它方案正在后台导出 · 切换方案不会中断它们</div>`);
    sections.push(...[...foreignActive].sort(byQueueOrder).map((job) => exportCard(job, true)));
  }
  $("exportHistory").innerHTML = sections.join("");
  for (const job of [...jobs, ...foreignActive]) {
    const previous = state.exportJobStates[job.id];
    if (previous && previous !== job.status && job.status === "completed") toastSuccess(`一个导出任务已完成，MP4 已保存${job.projectId === projectId ? "" : `（${job.projectTitle || "其它方案"}）`}`);
    if (previous && previous !== job.status && job.status === "failed") toastError(`导出失败：${job.error || job.stage}`);
    state.exportJobStates[job.id] = job.status;
  }
  clearTimeout(state.pollTimer);
  /* Keep polling while any project still has work, so switching projects can
     never strand a running export without progress or a completion notice. */
  if (activeTotal) state.pollTimer = setTimeout(() => loadExportHistory().catch(() => undefined), 1500);
  return jobs;
  } catch (error) {
    if (state.project !== project || state.exportRequest !== requestId) return [];
    state.exportPollFailures += 1;
    const delay = Math.min(30000, 1500 * 2 ** Math.min(state.exportPollFailures, 5));
    renderExportConnectionStatus(true, delay);
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(() => loadExportHistory().catch(() => undefined), delay);
    throw error;
  }
}

function setExportPanel(open) {
  if (open) rememberFocusForModal();
  else restoreFocusAfterModal();
  $("exportModal").hidden = !open;
  document.body.classList.toggle("export-open", open);
  if (open) $("closeExportPanel").focus();
}

/* ---- Scheme <-> spreadsheet round-trip ----------------------------------
   The editor owns the parts a human should not touch (camera, timing, voice,
   imagery); a `.xlsx` carries only title / narration / subtitle / asset
   binding plus whole new overview scenes. Export streams the workbook the
   server writes; import uploads the edited file, gets row-level validation
   back, and only writes when the operator confirms. */
const workbookState = { fileName: "", base64: "", result: null };
let workbookObjectUrl = "";

function setWorkbookPanel(open) {
  if (open) { rememberFocusForModal(); syncWorkbookPanel(); }
  else restoreFocusAfterModal();
  $("workbookModal").hidden = !open;
  if (open) $("closeWorkbookPanel").focus();
}
function syncWorkbookPanel() {
  const project = state.project;
  $("workbookSceneCount").textContent = String(project?.scenes?.length ?? 0);
  $("workbookAssetCount").textContent = String(project?.assets?.length ?? 0);
  $("workbookExport").disabled = !project;
}
async function openWorkbookPanel() {
  if (!state.project) return toast("请先打开方案再导出表格");
  if (!(await saveBeforeAction("导出表格"))) return;
  setWorkbookPanel(true);
  syncWorkbookPanel();
}
async function exportWorkbook() {
  const project = state.project;
  if (!project) return;
  const button = $("workbookExport");
  // Write the label span, never the button's textContent: replacing the button's
  // children would delete its icon, and the restore would not put it back.
  const label = button.querySelector(".wb-label");
  button.disabled = true; label.textContent = "正在导出…";
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/workbook`);
    if (!response.ok) throw new Error(`导出失败（HTTP ${response.status}）`);
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const match = /filename="?([^";]+)"?/.exec(disposition);
    const name = match && match[1] ? match[1] : `${project.id}-workbook.xlsx`;
    if (workbookObjectUrl) URL.revokeObjectURL(workbookObjectUrl);
    workbookObjectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = workbookObjectUrl; link.download = name;
    document.body.appendChild(link); link.click(); link.remove();
    toastSuccess("表格已导出，可用 Excel 打开编辑");
  } catch (error) { toastError(error.message); }
  finally { button.disabled = false; label.textContent = "导出"; }
}
function workbookBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
async function selectWorkbookFile(file) {
  if (!file) return;
  if (!state.project) return toast("请先打开方案");
  if (!/\.xlsx$/i.test(file.name)) return toastError("请选择 .xlsx 表格（CSV 请先用 Excel 另存为 .xlsx）");
  workbookState.fileName = file.name; workbookState.base64 = ""; workbookState.result = null;
  $("workbookFileName").hidden = false;
  $("workbookFileName").textContent = `已选择：${file.name}`;
  $("workbookResult").hidden = true;
  $("workbookCommit").disabled = true;
  try {
    workbookState.base64 = workbookBufferToBase64(await file.arrayBuffer());
    await runWorkbookCheck(false);
  } catch (error) { toastError(error.message); }
}
function renderWorkbookResult(data) {
  const host = $("workbookResult");
  host.hidden = false;
  const errors = data.errors || [], warnings = data.warnings || [];
  /* "预校验通过" on its own is a lie when the sheet asks for nothing: an operator
     who edited pictures in a sheet that cannot carry them saw "通过" and concluded
     the import was broken. Count the actual effect and say it. */
  // 素材库 rows count too: renaming an asset used to apply silently while this
  // headline claimed the sheet was identical.
  const changedAssets = Number(data.changedAssets || 0);
  const effect = (data.addedScenes || []).length + (data.deletedScenes || []).length + (data.changedScenes || []).length + changedAssets;
  const headline = data.ok
    ? (effect === 0
      ? (data.committed ? "已保存，但这份表格与当前方案没有任何差异。" : "预校验通过，但这份表格与当前方案没有任何差异 —— 保存也不会改变任何内容。")
      : (data.committed ? "已保存为新版本。" : "预校验通过，可以保存为新版本。"))
    : `预校验未通过：${errors.length} 条错误，未写入任何内容。`;
  const parts = [
    `<div class="workbook-result-summary ${data.ok ? "ok" : "blocked"}">${escapeHtml(headline)}</div>`,
    `<div class="workbook-counts"><span>新增 ${(data.addedScenes || []).length}</span><span>删除 ${(data.deletedScenes || []).length}</span><span>修改 ${(data.changedScenes || []).length}</span>${changedAssets ? `<span>素材 ${changedAssets}</span>` : ""}<span>警告 ${warnings.length}</span></div>`
  ];
  if (errors.length) parts.push(`<ul class="workbook-issues">${errors.map((issue) => `<li class="error">${escapeHtml(issue.row ? `第${issue.row}行 ` : "")}${escapeHtml(issue.message)}</li>`).join("")}</ul>`);
  if (warnings.length) parts.push(`<ul class="workbook-issues">${warnings.map((warning) => `<li class="warning">${escapeHtml(warning)}</li>`).join("")}</ul>`);
  if (data.ok && data.needsNarrationRegen) parts.push(`<div class="workbook-counts">旁白有改动或新增了场景，需要重新生成旁白音频，否则成片配音不会更新。</div>`);
  host.innerHTML = parts.join("");
}
function applyWorkbookCommit(data) {
  const project = data.project;
  if (!project) return;
  const previousRevision = state.project?.revision;
  state.project = project;
  state.dirty = false; renderSaveState("saved");
  upsertProjectList(project);
  if (project.revision !== previousRevision) {
    state.previewAudio?.pause(); state.previewAudio = null; state.previewAudioProjectId = null; state.previewAudioErrorShown = false;
  }
  state.selectedSceneId = project.scenes.some((scene) => scene.id === state.selectedSceneId) ? state.selectedSceneId : project.scenes[0]?.id;
  workbookState.result = { ...data, committed: true };
  // The workbook now trails the saved revision; force a fresh export before any
  // further import so the optimistic-lock check can never be bypassed.
  workbookState.base64 = "";
  render();
  renderWorkbookResult(workbookState.result);
  toastSuccess(`表格已导入并保存为 revision ${project.revision}`);
  if (data.needsNarrationRegen) toast("旁白有改动或新增了场景，请重新生成旁白音频", { duration: 9000 });
  syncProjectState().catch(() => {});
}
async function runWorkbookCheck(commit) {
  const project = state.project;
  if (!project || !workbookState.base64) return;
  const commitButton = $("workbookCommit");
  // Same rule as the export button: touch the label span, not the children.
  const commitLabel = commitButton.querySelector(".wb-label");
  if (commit) { commitButton.disabled = true; commitLabel.textContent = "正在保存…"; }
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/workbook${commit ? "?commit=1" : ""}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workbook: workbookState.base64 })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `请求失败（HTTP ${response.status}）`);
    // The workbook POST answers with a structured verdict the panel renders row
    // by row; a non-JSON body means the route never ran, so say so rather than
    // letting `data` stay null and crash the renderer below.
    if (!data || typeof data !== "object") throw new Error("服务返回了非预期的响应格式");
    workbookState.result = data;
    if (commit && data.ok && data.committed) { applyWorkbookCommit(data); return; }
    renderWorkbookResult(data);
  } catch (error) { toastError(error.message); }
  finally {
    commitLabel.textContent = "保存为新版本";
    commitButton.disabled = !(workbookState.result?.ok && !workbookState.result?.committed);
  }
}
function bindWorkbookPanel() {
  $("openWorkbookPanel").onclick = () => openWorkbookPanel().catch((error) => toastError(error.message));
  $("closeWorkbookPanel").onclick = () => setWorkbookPanel(false);
  $("closeWorkbookPanelFooter").onclick = () => setWorkbookPanel(false);
  $("workbookBackdrop").onclick = () => setWorkbookPanel(false);
  $("workbookExport").onclick = () => exportWorkbook();
  $("workbookFile").onchange = (event) => { const file = event.target.files?.[0] || null; event.target.value = ""; selectWorkbookFile(file).catch((error) => toastError(error.message)); };
  $("workbookCommit").onclick = () => runWorkbookCheck(true);
}

async function openExportPanel() {
  if (!(await saveBeforeAction("继续导出"))) return;
  setExportPanel(true);
  await loadExportHistory();
  /* The checklist is the only thing that decides whether 添加导出任务 is
     clickable, and `syncProjectState` is its sole writer. Opening the panel used
     to trust whatever the last sync had left behind — so a preceding AI copy
     rewrite (which nulls `readiness` and relies on one sync call landing) left a
     blank list and a disabled button with no explanation. Re-check on open. */
  if (!state.readiness?.ready) await syncProjectState();
}

async function startRender() {
  const project = state.project;
  if (!project) return;
  try {
  if (!(await saveBeforeAction("继续导出"))) return;
  if (!state.readiness?.ready) return toast("导出前检查未通过，请查看右侧清单");
  if (state.project !== project) return;
  const projectId = project.id;
    $("renderButton").disabled = true; $("renderButton").textContent = "正在添加…";
    const job = await api(`/api/projects/${projectId}/render`, { method: "POST", body: "{}" });
    if (job.projectId !== projectId) throw new Error("渲染任务与当前项目不一致，已阻止导出");
    if (state.project !== project) return;
    state.exportJobStates[job.id] = job.status;
    await loadExportHistory();
    toast(job.queuePosition > 1 ? `已加入导出队列，前面还有 ${job.queuePosition - 1} 个任务` : "导出任务已添加，可继续编辑或再次添加");
  } catch (error) { toastError(error.message); }
  finally { $("renderButton").disabled = false; $("renderButton").textContent = "＋ 添加导出任务"; }
}

function renderAssetUploadStatus() {
  const batch = state.assetUploadBatch;
  const host = $("assetUploadStatus");
  const retry = $("retryAssetUploads");
  if (!host || !retry) return;
  host.hidden = !batch;
  retry.hidden = !batch || !batch.items.some((item) => item.status === "failed");
  retry.disabled = !batch || batch.busy || batch.projectId !== state.project?.id;
  retry.title = batch?.projectId !== state.project?.id ? "请回到原方案后重试失败项" : "仅重试失败项，已成功的素材不会重复上传";
  if (!batch) return;
  const labels = { pending: "等待上传", uploading: "上传中", success: "上传成功", failed: "失败" };
  host.textContent = `${batch.projectId !== state.project?.id ? "原方案上传记录 · " : ""}${batch.items.map((item) => `${item.file.name}：${labels[item.status]}${item.error ? `（${item.error}）` : ""}`).join("；")}${batch.saveError ? `；绑定保存失败：${batch.saveError}，请点击顶部保存状态重试（无需重新上传成功项）` : ""}`;
}

async function uploadFiles(files, targetSceneId = null, retryBatch = null) {
  const project = state.project;
  if (!project) return toast("请先打开方案再上传素材");
  if (state.assetUploadBatch?.busy) return toast("请等待本批素材上传完成");
  const batch = retryBatch || { projectId: project.id, targetSceneId, items: [...files].map((file) => ({ file, status: "pending", error: "" })) };
  if (batch.projectId !== project.id) return toastError("请回到原方案后重试上传");
  state.assetUploadBatch = batch;
  batch.busy = true;
  batch.saveError = "";
  const items = batch.items.filter((item) => item.status === (retryBatch ? "failed" : "pending"));
  let succeeded = 0;
  try {
    for (const item of items) {
      if (state.project !== project) {
        item.status = "failed"; item.error = "方案已切换，未上传";
        continue;
      }
      const file = item.file;
      const displayName = file.name.replace(/\.[^.]+$/, "") || file.name;
      item.status = "uploading"; item.error = "";
      renderAssetUploadStatus();
      let asset;
      try {
        const query = new URLSearchParams({ projectId: project.id, name: file.name, alt: displayName });
        asset = await api(`/api/assets/binary?${query.toString()}`, { method: "POST", body: file, headers: { "content-type": file.type || "application/octet-stream" } });
      } catch (error) {
        item.status = "failed"; item.error = error.message;
        renderAssetUploadStatus();
        continue;
      }
      item.status = "success"; succeeded += 1;
      if (state.project !== project) {
        item.error = "已存入原方案所属素材库，未绑定到当前方案";
        continue;
      }
      if (!project.assets.some((entry) => entry.id === asset.id)) project.assets.push(asset);
      const targetScene = batch.targetSceneId ? project.scenes.find((scene) => scene.id === batch.targetSceneId) : null;
      if (targetScene && targetScene.section !== "cover") {
        targetScene.placements ||= []; targetScene.assetIds ||= [];
        if (!targetScene.placements.some((entry) => entry.assetId === asset.id)) {
          pushAssetUndo({ kind: "uploadBind", sceneId: targetScene.id, assetIds: [asset.id], prev: sceneAssetSnapshot(targetScene) });
          targetScene.placements.push(defaultPlacement(asset, targetScene));
        }
        if (!targetScene.assetIds.includes(asset.id)) targetScene.assetIds.push(asset.id);
        state.selectedSceneId = targetScene.id; state.selectedAssetId = asset.id;
      }
      touchAsset(asset.id);
      markDirty(); render();
      if (state.assetLibraryOpen) renderAssetLibrary();
      renderAssetUploadStatus();
    }
  } finally {
    batch.busy = false;
    renderAssetUploadStatus();
  }
  const failed = batch.items.filter((item) => item.status === "failed").length;
  const message = `本次上传成功 ${succeeded} 项${failed ? `，失败 ${failed} 项，可仅重试失败项` : ""}${succeeded ? "；场景绑定尚未保存，点击“保存方案”后生效" : ""}`;
  if (failed) toastError(message); else toastSuccess(message);
}

async function retryAssetUploads() {
  const batch = state.assetUploadBatch;
  if (!batch || batch.busy) return;
  await uploadFiles([], batch.targetSceneId, batch);
}

function bind() {
  if ($("undoAssetButton")) $("undoAssetButton").onclick = assetUndoOnce;
  if ($("retryAssetUploads")) $("retryAssetUploads").onclick = () => retryAssetUploads().catch((error) => toastError(error.message));
  $("saveState").onclick = () => saveProject().catch(() => undefined);
  window.addEventListener("message", handleCesiumPreviewMessage);
  window.addEventListener("resize", syncPreviewTypography);
  new ResizeObserver(syncPreviewTypography).observe($("previewFrame"));
  /* Unsaved scene edits only live in this tab. Warn before the page unloads so
     closing it cannot silently discard them. */
  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty || !state.project) return;
    event.preventDefault();
    event.returnValue = "";
  });
  $("actualViewTab").onclick = () => setPreviewMode("actual");
  $("safeAreaTab").onclick = () => setPreviewMode("safe");
  for (const input of $("mapViewControls").querySelectorAll("input[name]")) input.onchange = () => updateMapView(input);
  $("resetMapView").onclick = () => updateMapView();
  $("projectName").onclick = () => setSaveProjectOpen(true);
  $("projectName").onfocus = () => { $("projectName").blur(); setSaveProjectOpen(true); };
  $("provinceSelect").onchange = async (event) => { try { await selectProvince(event.target.value); } catch (error) { toastError(error.message); } };
  $("citySelect").onchange = async (event) => { try { await selectCity(event.target.value); } catch (error) { toastError(error.message); } };
  $("countySelect").onchange = async (event) => { try { await selectCounty(event.target.value); } catch (error) { toastError(error.message); } };
  $("townSelect").onchange = (event) => selectTown(event.target.value);
  $("applyRegion").onclick = () => {
    if (state.creation.selectingRegion) {
      const node = state.admin.selected;
      if (!node || node.level !== "town" || node.villageCount <= 0) return toast("请先选择具有村级边界的乡镇/街道");
      state.creation.regionId = node.code; state.creation.regionName = node.name; state.creation.breadcrumb = node.breadcrumb; state.creation.selectingRegion = false;
      document.querySelector(".region-picker")?.removeAttribute("open");
      setNewProjectOpen(true, true);
      state.creation.nameTouched = Boolean(state.creation.pendingName);
      $("newProjectName").value = state.creation.pendingName || suggestProjectName(node.name);
      state.creation.pendingName = "";
      updateNewProjectContext();
      // The picker has done its job, so the panel button has to say what a click
      // now does - create 港门镇. Leaving it on "选择此地区并继续" told the operator
      // they were still choosing a region while the very next click created the
      // plan, under the server's default name instead of the one in the modal.
      updateRegionSelection(node);
      return;
    }
    createProject(state.admin.selected?.code).catch((error) => toastError(error.message));
  };
  $("poiAutoImport").onchange = updatePoiImportSummary;
  $("poiSelectAll").onclick = () => { state.amap.selectedTypes = new Set(state.amap.types.map((item) => item.code)); renderPoiTypes(); updatePoiImportSummary(); };
  $("poiClearTypes").onclick = () => { state.amap.selectedTypes.clear(); renderPoiTypes(); updatePoiImportSummary(); };
  $("toggleChildCollect").onclick = () => { state.childCollect.open = !state.childCollect.open; renderChildCollectPanel(); };
  $("runChildCollect").onclick = () => { runChildCollect().catch((error) => toastError(error.message)); };
  $("childCollectAll").onclick = () => { const types = childCollectTypes(); state.amap.types.forEach((item) => types.add(item.code)); renderChildCollectPanel(); };
  $("childCollectClear").onclick = () => { childCollectTypes().clear(); renderChildCollectPanel(); };
  $("childCollectKeyword").oninput = () => { state.childCollect.keyword = $("childCollectKeyword").value; };
  $("regionSearch").oninput = () => { clearTimeout(state.admin.searchTimer); state.admin.searchTimer = setTimeout(searchRegions, 280); };
  $("regionSearch").onfocus = () => { if ($("regionSearch").value.trim().length >= 2) searchRegions(); };
  document.addEventListener("click", (event) => { if (!event.target.closest(".region-picker")) $("regionSearchResults").hidden = true; });
  $("profileSelect").onchange = (event) => { const profile = event.target.value; state.project.output.profile = profile; Object.assign(state.project.output, profile === "portrait" ? { width: 1080, height: 1920 } : profile === "square" ? { width: 1080, height: 1080 } : { width: 1920, height: 1080 }); markDirty(); render(); };
  $("qualitySelect").onchange = (event) => { state.project.output.quality = event.target.value; markDirty(); };
  function setPresetFromCard() {
    document.querySelectorAll(".profile-preset").forEach((button) => button.onclick = () => {
      const select = $("profileSelect");
      if (select.value === button.dataset.profile) return;
      select.value = button.dataset.profile;
      select.dispatchEvent(new Event("change"));
      syncPresetUI();
    });
    document.querySelectorAll(".quality-preset").forEach((button) => button.onclick = () => {
      const select = $("qualitySelect");
      if (select.value === button.dataset.quality) return;
      select.value = button.dataset.quality;
      select.dispatchEvent(new Event("change"));
      syncPresetUI();
    });
  }
  setPresetFromCard();
  $("imageryProviderSelect").onchange = (event) => {
    const provider = event.target.value;
    state.project.imagery = { provider };
    if (provider === "bing-aerial") toast("必应卫星需先配置 Bing Maps Key");
    markDirty();
    // Tell the running player to swap its tile source in place. Reloading the iframe
    // here would restart WebRTC and drop the whole scene.
    if (state.previewImagery && provider !== state.previewImagery) {
      state.pendingImagery = provider;
      $("cesiumPreview").contentWindow?.postMessage(
        { type: "geo-video-studio", action: "switch-imagery", imagery: provider }, CESIUM_PREVIEW_ORIGIN);
    }
    render();
  };
  $("voiceId").onchange = (event) => { state.project.voice.voiceId = event.target.value; markDirty(); }; $("voiceSpeed").onchange = (event) => { const speed = clampInputValue(event.target, 0.7, 1.3); state.project.voice.speed = speed; markDirty(); };
  $("sceneTitle").oninput = (event) => editScene("title", event.target.value); $("narration").oninput = (event) => editScene("narration", event.target.value);
  $("sceneImageryAnnotation").onchange = (event) => { editScene("imageryAnnotation", event.target.checked); setTimeout(previewSelectedScene, 40); };
  [["preHold", "preHoldSeconds"], ["postHold", "postHoldSeconds"], ["mapHold", "mapHoldSeconds"]].forEach(([id, key]) => $(id).onchange = (event) => editTiming(key, event.target.value));
  ["longitude", "latitude", "height"].forEach((id) => $(id).onchange = editCamera);
  [["assetFit", "fit"], ["assetAnimation", "animation"], ["focalX", "focalX"], ["focalY", "focalY"], ["assetScale", "scale"], ["assetMinimum", "minimumDisplaySeconds"], ["assetLead", "leadSeconds"], ["assetTail", "tailSeconds"], ["assetAlt", "alt"]].forEach(([id, key]) => $(id).onchange = (event) => editPlacement(key, ["fit", "animation", "alt"].includes(key) ? event.target.value : Number(event.target.value)));
  $("renderButton").onclick = startRender; $("openExportPanel").onclick = () => openExportPanel().catch((error) => toastError(error.message));
  bindWorkbookPanel();
  $("saveProjectButton").onclick = () => setSaveProjectOpen(true);
  $("closeSaveProject").onclick = () => setSaveProjectOpen(false);
  $("cancelSaveProject").onclick = () => setSaveProjectOpen(false);
  $("confirmSaveProject").onclick = () => confirmSaveProject().catch(() => undefined);
  $("saveProjectBackdrop").onclick = () => setSaveProjectOpen(false);
  $("saveProjectName").onkeydown = (event) => { if (event.key === "Enter") confirmSaveProject().catch(() => undefined); };
  $("openProjectList").onclick = () => setProjectListOpen(true);
  $("closeProjectList").onclick = () => setProjectListOpen(false);
  $("projectListBackdrop").onclick = () => setProjectListOpen(false);
  $("openNewProject").onclick = () => setNewProjectOpen(true);
  $("newProjectFromList").onclick = () => { setProjectListOpen(false); setNewProjectOpen(true); };
  $("changeNewProjectRegion").onclick = () => {
    state.creation.pendingName = state.creation.nameTouched ? String($("newProjectName").value || "").trim() : "";
    state.creation.selectingRegion = true;
    setNewProjectOpen(false);
    const picker = document.querySelector(".region-picker");
    if (picker) picker.setAttribute("open", "");
    $("applyRegion").textContent = "选择此地区并继续";
    $("regionSearch").focus();
  };
  $("closeNewProject").onclick = closeNewProjectToList;
  $("cancelNewProject").onclick = closeNewProjectToList;
  $("newProjectBackdrop").onclick = closeNewProjectToList;
  $("confirmNewProject").onclick = () => confirmNewProject();
  $("newProjectName").onkeydown = (event) => { if (event.key === "Enter") confirmNewProject(); };
  $("newProjectName").oninput = () => { state.creation.nameTouched = true; };
  $("projectListSearch").oninput = (event) => { state.projectFilter = event.target.value; renderProjectList(); };
  $("projectListSearch").onkeydown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); moveProjectListFocus(event.key === "ArrowDown" ? 1 : -1); }
    else if (event.key === "Enter" && state.projectListFocusIndex >= 0) { event.preventDefault(); openFocusedProject(); }
  };
  document.querySelectorAll(".project-list-views button").forEach((button) => button.onclick = () => {
    state.projectListView = button.dataset.listView || "recent";
    state.projectListFocusIndex = -1;
    renderProjectList();
    const search = $("projectListSearch");
    if (search && search.value.trim()) search.focus();
  });
  $("closeConfirmModal").onclick = () => settleConfirm(false);
  $("cancelConfirmModal").onclick = () => settleConfirm(false);
  $("confirmBackdrop").onclick = () => settleConfirm(false);
  $("confirmModalOk").onclick = () => settleConfirm(true);
  $("closeRenameProject").onclick = () => setRenameProjectOpen(false);
  $("cancelRenameProject").onclick = () => setRenameProjectOpen(false);
  $("confirmRenameProject").onclick = () => confirmRenameProject();
  $("renameProjectBackdrop").onclick = () => setRenameProjectOpen(false);
  $("renameProjectName").onkeydown = (event) => { if (event.key === "Enter") confirmRenameProject(); };
  $("closeDeleteProject").onclick = () => setDeleteProjectOpen(false);
  $("cancelDeleteProject").onclick = () => setDeleteProjectOpen(false);
  $("confirmDeleteProject").onclick = () => confirmDeleteProject();
  $("deleteProjectBackdrop").onclick = () => setDeleteProjectOpen(false);
  $("projectListItems").onclick = (event) => {
    const rename = event.target.closest("[data-rename-project]");
    if (rename) { setRenameProjectOpen(true, projectsById(rename.dataset.renameProject), rename.dataset.renameProject === state.project?.id); return; }
    const del = event.target.closest("[data-delete-project]");
    if (del) { setDeleteProjectOpen(true, projectsById(del.dataset.deleteProject), del.dataset.deleteProject === state.project?.id); return; }
    const open = event.target.closest("[data-open-project]");
    if (open) openSavedProject(open.dataset.openProject).catch((error) => { toastError(error.message); setProjectBusy(false); });
  };
  $("closeExportPanel").onclick = () => setExportPanel(false); $("closeExportPanelFooter").onclick = () => setExportPanel(false); $("exportBackdrop").onclick = () => setExportPanel(false);
  document.addEventListener("keydown", (event) => {
    if ($("projectListModal").hidden || event.key !== "/") return;
    const target = event.target;
    const tag = (target && target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || (target && target.isContentEditable)) return;
    event.preventDefault();
    const search = $("projectListSearch");
    if (search) { search.focus(); search.select(); }
  });
  document.addEventListener("keydown", (event) => {
    if (anyModalOpen() || !state.project) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("#sceneAssetPicker")) return; // picker owns its keys
    const tag = (target && target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (target && target.isContentEditable)) return;
    if (event.key === " ") {
      event.preventDefault();
      if (isOpeningScene(selectedScene())) playSelectedScenePreview();
      else togglePlayback();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      selectAdjacent(-1, !state.playTimer);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      selectAdjacent(1, !state.playTimer);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // Dialogs stacked above the scheme list close first (delete/rename/new),
    // then the list itself — Esc should never shut a lower layer first.
    if (!$("assetPreviewModal").hidden) setAssetPreviewOpen(false);
    else if (!$("assetLibraryModal").hidden) setAssetLibraryOpen(false);
    else if (!$("assetRenameModal").hidden) setAssetRenameOpen(false);
    else if (!$("confirmModal").hidden) settleConfirm(false);
    else if (!$("deleteProjectModal").hidden) setDeleteProjectOpen(false);
    else if (!$("renameProjectModal").hidden) setRenameProjectOpen(false);
    else if (!$("newProjectModal").hidden) closeNewProjectToList();
    else if (!$("saveProjectModal").hidden) setSaveProjectOpen(false);
    else if (!$("projectListModal").hidden) setProjectListOpen(false);
    else if (!$("exportModal").hidden) setExportPanel(false);
    else if (!$("workbookModal").hidden) setWorkbookPanel(false);
    else if (state.sceneAssetPickerOpen) { state.sceneAssetPickerOpen = false; state.sceneAssetPickerReplaceId = null; state.sceneAssetReplaceCandidateId = null; render(); }
  });
  $("exportHistory").onclick = async (event) => {
    const button = event.target.closest("[data-export-action]"); if (!button) return;
    const project = state.project;
    if (!project) return;
    const jobId = button.dataset.jobId;
    try {
    const jobs = await api(`/api/jobs?projectId=${encodeURIComponent(project.id)}&limit=30`);
    /* A job owned by another project is listed so that switching projects cannot
       hide a running export, but it can never appear in the project-scoped list
       above — so resolve it by id, otherwise its cancel button would do nothing. */
    const job = jobs.find((item) => item.id === jobId) ?? await api(`/api/jobs/${jobId}`).catch(() => null);
    if (!job || state.project !== project) return;
    if (button.dataset.exportAction === "cancel") { await api(`/api/jobs/${job.id}/cancel`, { method: "POST", body: "{}" }); await loadExportHistory(); toast("任务已取消"); return; }
    if (button.dataset.exportAction === "retry") {
      try {
        const ok = await askConfirm({ title: "按当前方案重新导出", message: "将保存并按当前方案的文案、素材和输出设置新建导出任务，不会还原失败任务的旧设置。", okText: "保存并导出" });
        if (!ok || state.project !== project) return;
        await saveProject();
        if (state.project !== project) return;
        if (!state.readiness?.ready || state.renderSpecStale) return toastError("当前方案导出前检查未通过，请先修复清单中的问题");
        const next = await api(`/api/projects/${encodeURIComponent(project.id)}/render`, { method: "POST", body: "{}" });
        if (state.project !== project) return;
        if (next.projectId !== project.id) throw new Error("导出任务与当前方案不一致");
        state.exportJobStates[next.id] = next.status;
        await loadExportHistory();
        toast(next.queuePosition > 1 ? `已重新提交导出，排队第 ${next.queuePosition} 个` : "已重新提交导出任务");
      } catch (error) { toastError(error.message); }
      return;
    }
    if (button.dataset.exportAction === "delete") {
      const hasOutput = Boolean(job.output);
      const ok = await askConfirm({
        title: "删除导出记录",
        message: hasOutput ? "确认删除这条导出记录？该次导出已生成的 MP4 文件将一并删除，且无法恢复。" : "确认删除这条导出记录？",
        okText: "删除",
        okClass: "danger"
      });
      if (!ok) return;
      try {
        await api(`/api/jobs/${job.id}?projectId=${encodeURIComponent(state.project.id)}`, { method: "DELETE" });
        delete state.exportJobStates[job.id];
        await loadExportHistory();
        toast("已删除导出记录");
      } catch (error) { toastError(error.message); }
      return;
    }
    if (button.dataset.exportAction === "diagnostics") {
      await api(`/api/jobs/${job.id}/open-diagnostics?projectId=${encodeURIComponent(project.id)}`, { method: "POST", body: "{}" });
      toast("已打开本次导出的诊断文件夹");
      return;
    }
    if (!job.output) return;
    if (button.dataset.exportAction === "copy") { await navigator.clipboard.writeText(job.output); toast("该次导出路径已复制"); }
    if (button.dataset.exportAction === "open") { await api(`/api/jobs/${job.id}/open-output?projectId=${encodeURIComponent(project.id)}`, { method: "POST", body: "{}" }); toast("已定位该次导出的 MP4"); }
    } catch (error) { toastError(error.message); }
  };
  $("deleteScene").onclick = () => deleteScene(state.selectedSceneId);
  $("regenerateProjectCopy").onclick = () => regenerateProjectCopy();
  $("regenerateSceneCopy").onclick = () => regenerateSceneCopy();
  $("splitOverviewCopy").onclick = splitOverviewScene;
  // Adding a scene is offered on each block's heading (see render), not from a header
  // button, so there is nothing to wire here — the per-heading buttons bind in render.
  $("planTourRoute").onclick = planTourRoute;
  const coverFields = { coverAdministrativeLabel: "administrativeLabel", coverSubtitle: "subtitle", coverContentMeta: "contentMeta" };
  Object.entries(coverFields).forEach(([id, key]) => $(id).oninput = (event) => { state.project.cover[key] = event.target.value; markDirty(); render(); scheduleCoverPreview(); });
  $("coverIntro").onchange = (event) => { const value = clampInputValue(event.target, 0.25, 10); state.project.cover.introSeconds = value; const coverScene = state.project.scenes.find((scene) => scene.section === "cover"); if (coverScene) coverScene.duration = value; markDirty(); render(); scheduleCoverPreview(); };
  $("coverFadeOut").onchange = (event) => { state.project.cover.fadeOutSeconds = clampInputValue(event.target, 0, 3); markDirty(); }; $("coverOverlay").oninput = (event) => { const v = clampInputValue(event.target, 0, 1); state.project.cover.overlayOpacity = v; markDirty(); };
  $("toggleSceneAssetPicker").onclick = () => { const opening = state.sceneAssetPickerOpen === false; if (opening) state.sceneAssetPickerReplaceId = null; state.sceneAssetPickerOpen = !state.sceneAssetPickerOpen; render(); if (state.sceneAssetPickerOpen) focusPickerListFirst(); };
  $("closeSceneAssetPicker").onclick = () => { state.sceneAssetPickerOpen = false; state.sceneAssetPickerReplaceId = null; state.sceneAssetReplaceCandidateId = null; render(); focusSceneAssetEditor(); };
  $("assetInput").onchange = async (event) => {
    try { await uploadFiles([...event.target.files], state.uploadTargetSceneId); }
    catch (error) { toastError(`上传素材失败：${error.message || error}`); }
    finally { state.uploadTargetSceneId = null; event.target.value = ""; }
  };
  $("openAssetLibrary").onclick = () => setAssetLibraryOpen(true);
  $("selectAllSceneAssets").onclick = () => setAllSceneAssetsIncluded(true);
  $("clearSceneAssetsSelection").onclick = () => setAllSceneAssetsIncluded(false);
  $("sceneAssetSearch").oninput = (event) => {
    clearTimeout(state.assetSearchTimer);
    state.assetSearchTimer = setTimeout(() => { state.sceneAssetSearch = event.target.value; render(); }, 160);
  };
  $("sceneAssetScope").onchange = (event) => { state.sceneAssetScope = event.target.value; render(); };
  $("sceneAssetSort").onchange = (event) => { state.sceneAssetSort = event.target.value; render(); };
  document.querySelectorAll(".scene-asset-filter-chips .chip").forEach((chip) => chip.onclick = () => { state.sceneAssetGroup = chip.dataset.assetGroup; render(); });
  $("sceneAssetUnboundOnly").onchange = (event) => { state.sceneAssetUnboundOnly = event.target.checked; render(); };
  $("assetLibrarySearch").oninput = (event) => {
    clearTimeout(state.assetLibrarySearchTimer);
    state.assetLibrarySearchTimer = setTimeout(() => { state.assetLibrarySearch = event.target.value; renderAssetLibrary(); }, 160);
  };
  $("assetLibrarySource").onchange = (event) => { state.assetLibrarySource = event.target.value; renderAssetLibrary(); };
  $("assetLibraryUsage").onchange = (event) => { state.assetLibraryUsage = event.target.value; renderAssetLibrary(); };
  $("assetLibrarySort").onchange = (event) => { state.assetLibrarySort = event.target.value; renderAssetLibrary(); };
  $("selectUnusedAssets").onclick = () => {
    state.assetLibrarySelected = new Set((state.project?.assets || []).filter((asset) => sceneAssetUsageCount(asset.id) === 0).map((asset) => asset.id));
    state.assetLibraryUsage = "unused";
    renderAssetLibrary();
    toast(`已选择 ${state.assetLibrarySelected.size} 个未使用素材，请确认后再永久删除`);
  };
  $("clearAssetSelection").onclick = () => { state.assetLibrarySelected.clear(); renderAssetLibrary(); };
  $("deleteSelectedAssets").onclick = () => removeSelectedAssetsFromLibrary();
  $("assetLibraryUpload").onclick = () => { state.uploadTargetSceneId = null; $("assetInput").click(); };
  $("closeAssetLibrary").onclick = () => setAssetLibraryOpen(false); $("assetLibraryBackdrop").onclick = () => setAssetLibraryOpen(false);
  $("assetLibraryList").onclick = (event) => {
    const select = event.target.closest("[data-lib-select]");
    if (select) {
      const id = select.dataset.libSelect;
      if (select.checked) state.assetLibrarySelected.add(id); else state.assetLibrarySelected.delete(id);
      select.closest(".lib-asset")?.classList.toggle("selected", select.checked);
      renderAssetLibraryBatchState();
      return;
    }
    const preview = event.target.closest("[data-lib-preview]");
    if (preview) { openAssetPreview(preview.dataset.libPreview, "library"); return; }
    const rename = event.target.closest("[data-lib-rename]");
    if (rename) { openAssetRename(rename.dataset.libRename); return; }
    const remove = event.target.closest("[data-lib-delete]");
    if (remove) removeAssetFromProjectLibrary(remove.dataset.libDelete);
  };
  $("closeAssetPreview").onclick = () => setAssetPreviewOpen(false); $("assetPreviewBackdrop").onclick = () => setAssetPreviewOpen(false); $("assetPreviewCancel").onclick = () => setAssetPreviewOpen(false);
  $("closeAssetRename").onclick = () => setAssetRenameOpen(false); $("cancelAssetRename").onclick = () => setAssetRenameOpen(false); $("assetRenameBackdrop").onclick = () => setAssetRenameOpen(false);
  $("assetRenameName").onkeydown = (event) => { if (event.key === "Enter") confirmAssetRename(); };
  $("confirmAssetRename").onclick = () => confirmAssetRename();
  $("previousScene").onclick = () => selectAdjacent(-1); $("nextScene").onclick = () => selectAdjacent(1); $("playButton").onclick = togglePlayback; $("playFromStart").onclick = playFromBeginning;
  $("previewFrame").onclick = () => { if (isOpeningScene(selectedScene())) playSelectedScenePreview(); };
  $("cesiumPreview").onload = () => setTimeout(previewSelectedScene, 120);

  /* Undo for the last asset operation (Ctrl/Cmd+Z). Text inputs keep their own undo. */
  document.addEventListener("keydown", (event) => {
    if ((!event.ctrlKey && !event.metaKey) || event.shiftKey || event.key.toLowerCase() !== "z") return;
    if (anyModalOpen()) return;
    const target = event.target;
    const tag = (target && target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (target && target.isContentEditable)) return;
    event.preventDefault();
    assetUndoOnce();
  });
  /* Keyboard navigation inside the asset picker. */
  document.addEventListener("keydown", (event) => {
    if (!state.sceneAssetPickerOpen || anyModalOpen()) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.closest("#sceneAssetPicker")) return;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (target.id === "sceneAssetSearch" && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        movePickerFocus(event.key === "ArrowDown" ? "down" : "up");
      }
      return;
    }
    if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      const direction = event.key.slice(5).toLowerCase();
      movePickerFocus(direction);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && target.closest("[data-picker-asset-id]")) {
      event.preventDefault();
      target.closest("[data-picker-asset-id]").click();
    }
  });
}

function selectAdjacent(delta, preview = true, automatic = false) { const index = state.project.scenes.findIndex((scene) => scene.id === state.selectedSceneId); const next = state.project.scenes[Math.max(0, Math.min(state.project.scenes.length - 1, index + delta))]; if (next) { if (automatic) selectScene(next.id, preview); else selectSceneFromUi(next.id); } }
function playFromBeginning() {
  if (state.playTimer) stopPlayback();
  const first = state.project?.scenes?.[0];
  if (!first) return;
  selectScene(first.id, false);
  // The only entry point that rolls through the whole film. ▶ previews one scene.
  startPlaybackFromSelected({ continuous: true });
}
/* Stop playback. `completed` distinguishes "the scene finished" from "the
 * operator pressed pause": a finished single-scene preview should keep the last
 * subtitle line it ended on, while pausing rewinds the caption to the scene's
 * first line so the frame reads as "not playing yet". */
function stopPlayback({ completed = false } = {}) { clearTimeout(state.playTimer); clearTimeout(state.narrationStartTimer); clearPreviewSubtitleTimers(); state.previewAudio?.pause(); if (state.previewAudio) state.previewAudio.muted = false; $("previewAssetVideo")?.pause(); state.playTimer = null; $("playButton").textContent = "▶"; if (state.playbackStageActive) { /* The rotation only exists while the film rolls: drop it and put the operator's own selection back on the stage. */ state.playbackStageActive = false; state.playbackStagePlacement = null; applyPreviewStagePlacement(selectedScene(), selectedPlacement()); revealSelectedSceneAsset(); } if (!completed) showPreviewSubtitle(selectedScene()); }
/* The export splits a scene's narration window equally between the pictures the
 * operator marked 用于成片, walking `placements` in saved order (`render-engine`).
 * The still preview used to show whichever picture the right-hand panel was on,
 * so a five-photo village sat on a single photo for the whole paragraph.
 *
 * `selectSceneRenderPlacements()` is the export's own answer, kept in one shared
 * module so the preview rotation and the film can never disagree. */
function playbackScenePlacements(scene) {
  return selectSceneRenderPlacements(scene);
}

/** Put the scene's first film picture on stage (and hold it there until the
 *  camera finishes its descent/flight — the reveal handler picks it up). A scene
 *  with no picture marked 用于成片 stages nothing: the film has no picture there
 *  either, so the preview must not borrow the operator's card. */
function beginPlaybackStage(scene) {
  const pool = playbackScenePlacements(scene);
  state.playbackStageActive = true;
  state.playbackStagePlacement = pool[0] || null;
  applyPreviewStagePlacement(scene, state.playbackStagePlacement);
}

/** Where the playhead sits inside the scene, 0 → 1. */
function playbackProgress(range, audio, startedAt, estimatedMs) {
  const start = Number(range?.start || 0);
  const span = Math.max(0.5, Number(range?.end ?? 0) - start);
  const position = Number(audio?.currentTime || 0);
  if (audio && !audio.error && position > start) return Math.min(1, (position - start) / span);
  // Narration that never loads (404 until it is regenerated) still has to move
  // the pictures, otherwise the preview freezes on photo one and reads as broken.
  return Math.min(1, Math.max(0, (Date.now() - startedAt) / Math.max(1, estimatedMs)));
}

function syncPlaybackStage(scene, progress) {
  const pool = playbackScenePlacements(scene);
  if (!pool.length) return;
  const placement = pool[sceneRenderPlacementIndex(pool.length, progress)];
  if (state.playbackStagePlacement === placement) return;
  state.playbackStagePlacement = placement;
  applyPreviewStagePlacement(scene, placement);
  // The camera may still be flying (opening descent, child tour): the picture
  // appears when the flight reports completion, and that handler reveals
  // whatever `playbackStagePlacement` holds by then.
  revealSelectedSceneAsset(placement);
}

function schedulePlaybackAdvance() {
  const scene = selectedScene(); if (!scene) return stopPlayback();
  const narrationDelay = openingNarrationDelaySeconds(scene);
  const range = sceneNarrationRange(scene);
  const advance = () => {
    // Single-scene preview stops on the last frame of this scene. The editor's
    // actual loop is "play the scene, hear the paragraph, fix the text, play it
    // again", and rolling on into the next village forced a stop-and-reselect
    // after every take. Continuous playback is still available from ↺ 从头.
    if (!state.playbackContinuous) return stopPlayback({ completed: true });
    const index = state.project.scenes.findIndex((item) => item.id === state.selectedSceneId);
    if (index >= state.project.scenes.length - 1) return stopPlayback({ completed: true });
    selectAdjacent(1, true, true);
    const nextScene = selectedScene();
    beginPlaybackStage(nextScene);
    playPreviewNarration(nextScene, true, openingNarrationDelaySeconds(nextScene));
    schedulePlaybackAdvance();
  };
  if (!range || scene.section === "cover") {
    state.playTimer = setTimeout(advance, Math.max(1.6, sceneDuration(scene) + narrationDelay) * 1000);
    return;
  }
  // Audio that never starts would otherwise poll forever: the button stays on Ⅱ,
  // the preview never ends, and the next ▶ only restarts it. That is the normal
  // state right after a narration edit — the measured mp3 no longer matches the
  // text, so `narration-audio` answers 404 until it is regenerated. Fall back to
  // the scene's estimated duration so a mute preview still runs to its end.
  const estimatedMs = Math.max(1.6, sceneDuration(scene) + narrationDelay) * 1000;
  const startedAt = Date.now();
  let muteFallbackArmed = false;
  const pollAudioClock = () => {
    if (selectedScene()?.id !== scene.id || !state.playTimer) return;
    const audio = state.previewAudio;
    if (audio && !audio.error && Number(audio.currentTime || 0) + 0.02 >= Number(range.end || 0)) return advance();
    syncPlaybackStage(scene, playbackProgress(range, audio, startedAt, estimatedMs));
    const stalled = !audio
      || Boolean(audio.error)
      || audio.readyState === 0
      || (Number(audio.currentTime || 0) === 0 && Date.now() - startedAt >= 2500);
    if (stalled && !muteFallbackArmed) {
      muteFallbackArmed = true;
      // Give the visual side the remaining time, not a fresh copy of it.
      const remaining = Math.max(800, estimatedMs - (Date.now() - startedAt));
      state.playTimer = setTimeout(advance, remaining);
      return;
    }
    state.playTimer = setTimeout(pollAudioClock, 30);
  };
  state.playTimer = setTimeout(pollAudioClock, 30);
}
/* Playback is a *still preview* on purpose: the map parks on the scene's
 * establishing frame and only the narration and subtitles advance.
 *
 * **▶ previews exactly one scene and stops there.** That is the loop the editor
 * is used for — play the scene, hear the paragraph, decide whether the text and
 * the photo timing are right, fix it, play again. Rolling on into the next
 * village meant stopping and reselecting after every take. The whole film still
 * plays end to end from ↺ 从头 (`continuous: true`).
 *
 * Continuous camera motion was tried (the player grew a `play-scene-range`
 * message for it) and reverted: it is the right thing for a final look, but it
 * makes that same loop several times slower and keeps the GPU busy throughout.
 * The player still exposes the capability, so a "动效" toggle can bring it back
 * without touching runtime.js.
 */
function startPlaybackFromSelected({ continuous = false } = {}) {
  const scene = selectedScene(); if (!scene) return;
  state.playbackContinuous = continuous;
  updatePlayhead(scene);
  unlockPreviewAudioFromGesture(scene);
  $("playButton").textContent = "Ⅱ";
  // Before the camera message: `previewSelectedScene()` resets the reveal latch,
  // and the flight-complete handler reveals whatever is on stage by then.
  beginPlaybackStage(scene);
  previewSelectedScene();
  state.playTimer = true;
  playPreviewNarration(scene, false, openingNarrationDelaySeconds(scene));
  schedulePlaybackAdvance();
}
function togglePlayback() { if (state.playTimer) return stopPlayback(); startPlaybackFromSelected(); }

async function boot() {
  try {
    setProjectBusy(true, "正在启动工作台并加载最近方案…");
    const [provinces] = await Promise.all([api("/api/admin-divisions?level=province"), loadAmapMaterialOptions()]);
    state.admin.provinces = provinces; setAdminOptions("provinceSelect", provinces, "请选择省份");
    const projects = await api("/api/projects"); state.projects = projects;
    const lastId = getLastProjectId();
    const remembered = lastId ? projects.find((p) => p.id === lastId) : null;
    const fallback = projects.sort(byUpdatedAtDesc)[0];
    if (remembered) state.project = remembered;
    else if (fallback) state.project = fallback;
    else {
      // Never invent a production area on first launch. Let the user choose it
      // through the same region picker used by the existing creation flow.
      state.project = null;
      bind();
      setProjectBusy(false);
      setNewProjectOpen(true);
      return;
    }
    if (state.project) rememberCurrentProject();
    if (state.project) upsertProjectList(state.project);
    state.selectedSceneId = state.project.scenes[0]?.id; state.selectedAssetId = state.project.scenes[0]?.placements?.[0]?.assetId || null; bind(); renderSaveState("saved"); await locateRegion(state.project.regionId); await syncProjectState(); ensurePreviewAudio(); await loadLatestExport();
    setProjectBusy(false);
  } catch (error) { toastError(`启动失败：${error.message}`); setProjectBusy(false); }
}


/**
 * Newest save first — the ordering every scheme list uses.
 *
 * It exists because `(b.updatedAt || 0) - (a.updatedAt || 0)` looks like a
 * comparison and is not: updatedAt is an ISO **string**, so the subtraction is
 * NaN, and a comparator that returns NaN leaves the array in whatever order the
 * engine happens to hold. Restoring an undeleted scheme therefore dropped it
 * wherever, while the two other list sites compared strings properly. One
 * function, so the three cannot drift apart again.
 */
function byUpdatedAtDesc(a, b) { return (b.updatedAt || "").localeCompare(a.updatedAt || ""); }

function projectNameKey(name) { return String(name ?? "").trim().toLowerCase(); }
function isDuplicateProjectName(name, excludeId) {
  const key = projectNameKey(name);
  if (!key) return false;
  return state.projects.some((p) => p.id !== excludeId && projectNameKey(p.name) === key);
}
function projectsById(id) { return state.projects.find((p) => p.id === id); }
/**
 * Suggest the plan name the creation form opens with.
 *
 * The picker's default is `${region}地理图说`, which is exactly the name the
 * already-open plan of that region carries - so opening 新建方案 pre-filled a
 * name the operator's next click rejected with 已存在同名方案, and the only way
 * forward was to invent a name by hand. Take the same suffix the server applies
 * to a duplicate (`…（2）`), so the suggested default is always one click away.
 */
function suggestProjectName(region) {
  const base = `${String(region || "").trim() || "未命名"}地理图说`;
  if (!isDuplicateProjectName(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}（${index}）`;
    if (!isDuplicateProjectName(candidate)) return candidate;
  }
}
function showSaveProjectError(message) {
  const node = $("saveProjectError");
  node.textContent = message; node.hidden = !message;
}
function showRenameProjectError(message) {
  const node = $("renameProjectError");
  node.textContent = message; node.hidden = !message;
}
function showNewProjectError(message) {
  const node = $("newProjectError");
  node.textContent = message; node.hidden = !message;
}
function updateNewProjectContext() {
  const id = state.creation.regionId;
  const selected = state.admin.selected?.code === id ? state.admin.selected : null;
  const project = state.project?.regionId === id ? state.project : null;
  const name = state.creation.regionName || selected?.name || project?.regionName || project?.cover?.town || id || "请选择乡镇/街道";
  const path = state.creation.breadcrumb || (project ? [project.cover?.province, project.cover?.city, project.cover?.county, id].filter(Boolean).join(" / ") : selected?.breadcrumb || "");
  $("newProjectRegionName").textContent = name;
  $("newProjectRegionPath").textContent = path ? `${path} · ${id}` : "名称不决定地区，必须明确选择行政区。";
  $("newProjectImpact").textContent = id
    ? `按${name}基础数据创建独立方案，共享${name}素材库；其他行政区素材不可见。不复制当前方案的编辑内容，也不修改当前方案。`
    : "选择行政区后将展示创建范围；不会默认使用其他乡镇数据。";
  const input = $("newProjectName");
  if (id && !input.value) { input.value = suggestProjectName(name); state.creation.nameTouched = false; }
  $("confirmNewProject").disabled = state.creation.busy || !id;
  $("confirmNewProject").textContent = state.creation.busy ? "正在创建…" : "创建方案";
  $("cancelNewProject").disabled = state.creation.busy;
  $("changeNewProjectRegion").disabled = state.creation.busy;
}
function setNewProjectOpen(open, preserveCreationRegion = false) {
  // A failed request must be closable/retryable; only block reopening while busy.
  if (state.creation.busy && open) return;
  if (open) {
    rememberFocusForModal();
    if (!preserveCreationRegion) {
      state.creation.selectingRegion = false;
      state.creation.regionId = state.project?.regionId || state.admin.selected?.code || null;
      state.creation.regionName = state.project?.regionName || state.project?.cover?.town || state.admin.selected?.name || "";
      state.creation.breadcrumb = state.admin.selected?.code === state.creation.regionId ? state.admin.selected.breadcrumb : "";
      state.creation.pendingName = "";
      state.creation.nameTouched = false;
      $("newProjectName").value = "";
    }
    showNewProjectError("");
    updateNewProjectContext();
    setTimeout(() => { $("newProjectName").focus(); $("newProjectName").select(); }, 0);
  } else restoreFocusAfterModal();
  $("newProjectModal").hidden = !open;
}
async function confirmNewProject() {
  if (state.creation.busy) return;
  const regionId = state.creation.regionId;
  if (!regionId) return showNewProjectError("请先选择乡镇/街道，再创建方案");
  const name = String($("newProjectName").value ?? "").trim() || suggestProjectName(state.creation.regionName || regionId);
  if (isDuplicateProjectName(name)) {
    showNewProjectError(`已存在同名方案「${name}」，请更换名称`);
    $("newProjectName").focus(); $("newProjectName").select();
    return;
  }
  state.creation.pendingName = name;
  state.creation.busy = true; updateNewProjectContext();
  setNewProjectOpen(false);
  try {
    state.creation.regionId = regionId;
    await createProjectFromList(name);
  } catch (error) {
    state.creation.busy = false;
    setNewProjectOpen(true, true);
    $("newProjectName").value = name;
    updateNewProjectContext();
    showNewProjectError(error.message);
  }
}
function closeNewProjectToList() {
  if (state.creation.busy) return;
  setNewProjectOpen(false);
  setProjectListOpen(true);
}
async function loadProjects() {
  try {
    state.projects = await api("/api/projects");
    renderProjectList();
  } catch (error) { /* list is a side panel; ignore */ }
}
function upsertProjectList(project) {
  if (!project) return;
  const index = state.projects.findIndex((p) => p.id === project.id);
  if (index >= 0) state.projects[index] = { ...state.projects[index], ...project };
  else state.projects.unshift(project);
  renderProjectList();
}
function rememberCurrentProject() {
  if (!state.project) return;
  try { localStorage.setItem(LAST_PROJECT_STORAGE_KEY, state.project.id); } catch (_) { /* private mode */ }
}
function getLastProjectId() {
  try { return localStorage.getItem(LAST_PROJECT_STORAGE_KEY) || ""; } catch (_) { return ""; }
}
function shortProjectTime(iso) {
  if (!iso) return "尚未保存";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "尚未保存";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function projectListItemHtml(project, dupTotal, seen) {
  const active = project.id === state.project?.id;
  const safeName = escapeHtml(project.name || "未命名方案");
  const region = escapeHtml(project.regionName || project.regionId || "未选择地区");
  const scenes = project.scenes?.length || 0;
  const dupKey = projectNameKey(project.name);
  let dupBadge = "";
  if ((dupTotal.get(dupKey) || 0) > 1) {
    const seq = (seen.get(dupKey) || 0) + 1;
    seen.set(dupKey, seq);
    dupBadge = `<i class="dup-badge">同名 ${seq}/${dupTotal.get(dupKey)}</i>`;
  }
  const current = active ? '<i class="pl-current">当前方案</i>' : "";
  const meta = `${region} · ${scenes} 个场景 · ${shortProjectTime(project.updatedAt)}`;
  return `<div class="project-list-item${active ? " active" : ""}" data-project-id="${escapeHtml(project.id)}">
    <button class="project-list-open" type="button" data-open-project="${escapeHtml(project.id)}">
      <span class="pl-title"><b>${safeName}</b>${current}${dupBadge}</span>
      <span class="pl-meta">${meta}</span>
    </button>
    <span class="project-list-actions">
      <button type="button" class="project-action" data-rename-project="${escapeHtml(project.id)}" title="重命名方案">改名</button>
      <button type="button" class="project-action danger" data-delete-project="${escapeHtml(project.id)}" title="删除方案">删除</button>
    </span>
  </div>`;
}
function regionLabelOf(project) {
  return escapeHtml(project.regionName || project.regionId || "未选择地区");
}
function renderProjectList() {
  const host = $("projectListItems");
  if (!host) return;
  const countNode = $("projectListCount");
  const query = String(state.projectFilter ?? "").trim().toLowerCase();
  const sorted = [...state.projects].sort(byUpdatedAtDesc);
  const dupTotal = new Map();
  for (const p of sorted) { const key = projectNameKey(p.name); dupTotal.set(key, (dupTotal.get(key) || 0) + 1); }
  const seen = new Map();
  let list = query ? sorted.filter((project) => {
    const hay = `${project.name || ""} ${project.regionName || ""} ${project.regionId || ""}`.toLowerCase();
    return query.split(/\s+/).every((part) => hay.includes(part));
  }) : sorted;
  const view = state.projectListView || "recent";
  if (view === "dup") list = list.filter((p) => (dupTotal.get(projectNameKey(p.name)) || 0) > 1);
  if (countNode) countNode.textContent = list.length === sorted.length ? `${sorted.length} 个方案` : `${list.length}/${sorted.length} 项`;
  document.querySelectorAll(".project-list-views button").forEach((button) => button.classList.toggle("active", button.dataset.listView === view));
  if (!list.length) {
    host.innerHTML = `<div class="project-list-empty">${sorted.length ? "没有匹配的方案" : "还没有保存的方案"}</div>`;
    state.projectListFocusIndex = -1;
    return;
  }
  let html;
  if (view === "region") {
    const groups = new Map();
    for (const project of list) {
      const key = project.regionId || project.regionName || "unknown";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(project);
    }
    const groupRows = [...groups.entries()].map(([key, projects]) => {
      const label = regionLabelOf(projects[0]);
      return `<div class="project-list-group-title">${label} · ${projects.length} 个</div>${projects.map((p) => projectListItemHtml(p, dupTotal, seen)).join("")}`;
    });
    html = groupRows.join("");
  } else {
    html = list.map((project) => projectListItemHtml(project, dupTotal, seen)).join("");
  }
  host.innerHTML = html;
  const focusIndex = state.projectListFocusIndex;
  const items = host.querySelectorAll(".project-list-item");
  if (focusIndex >= 0 && focusIndex < items.length) {
    items[focusIndex].classList.add("kb-focus");
    items[focusIndex].scrollIntoView({ block: "nearest" });
  }
}
function moveProjectListFocus(delta) {
  const host = $("projectListItems");
  const items = host ? [...host.querySelectorAll(".project-list-item")] : [];
  if (!items.length) return;
  state.projectListFocusIndex = (state.projectListFocusIndex + delta + items.length) % items.length;
  host.querySelectorAll(".kb-focus").forEach((el) => el.classList.remove("kb-focus"));
  const target = items[state.projectListFocusIndex];
  target.classList.add("kb-focus");
  target.scrollIntoView({ block: "nearest" });
}
function openFocusedProject() {
  const host = $("projectListItems");
  if (!host) return;
  const items = host.querySelectorAll(".project-list-item");
  const item = items[state.projectListFocusIndex >= 0 ? state.projectListFocusIndex : 0];
  const open = item?.querySelector("[data-open-project]");
  if (open) openSavedProject(open.dataset.openProject).catch((error) => { toastError(error.message); setProjectBusy(false); });
}
function setProjectListOpen(open) {
  if (open) { rememberFocusForModal(); loadProjects(); state.projectListFocusIndex = -1; }
  else restoreFocusAfterModal();
  $("projectListModal").hidden = !open;
}
function setSaveProjectOpen(open) {
  if (open) {
    rememberFocusForModal();
    showSaveProjectError("");
    $("saveProjectName").value = state.project?.name || "";
    setTimeout(() => { $("saveProjectName").focus(); $("saveProjectName").select(); }, 0);
  } else restoreFocusAfterModal();
  $("saveProjectModal").hidden = !open;
}
async function confirmSaveProject() {
  if (!state.project) return;
  const input = $("saveProjectName");
  const name = String(input.value ?? "").trim();
  if (!name) { showSaveProjectError("方案名称不能为空"); input.focus(); return; }
  if (isDuplicateProjectName(name, state.project.id)) {
    showSaveProjectError(`已存在同名方案「${name}」，请更换名称`);
    input.focus(); input.select();
    return;
  }
  const nameChanged = name !== (state.project.name || "");
  /* This dialog is the explicit commit point for scene edits. Read the flag
     BEFORE saving: saveProject() clears it, and the message below must know
     whether anything was actually written. */
  const pendingChanges = state.dirty;
  if (nameChanged) {
    state.project.name = name;
    markDirty();
    $("projectName").value = name;
  }
  setSaveProjectOpen(false);
  await saveProject();
  /* Say what happened, not what the dialog happened to collect. A dialog that
     was asked to save and had nothing to save stays quiet: the header already
     carries 已保存, and announcing "nothing happened" every time is noise. */
  if (state.dirty) return;                       // the save failed and already reported it
  if (nameChanged || pendingChanges) toast("方案已保存");
}
function setRenameProjectOpen(open, project = null, isCurrent = false) {
  if (open) {
    rememberFocusForModal();
    state.renameContext = { project, isCurrent };
    showRenameProjectError("");
    $("renameProjectName").value = project?.name || "";
    $("renameProjectTitle").textContent = isCurrent ? "重命名当前方案" : "重命名方案";
    setTimeout(() => { $("renameProjectName").focus(); $("renameProjectName").select(); }, 0);
  } else {
    state.renameContext = null;
    restoreFocusAfterModal();
  }
  $("renameProjectModal").hidden = !open;
}
async function confirmRenameProject() {
  const ctx = state.renameContext;
  if (!ctx || !ctx.project) return;
  const input = $("renameProjectName");
  const name = String(input.value ?? "").trim();
  if (!name) { showRenameProjectError("方案名称不能为空"); input.focus(); return; }
  if (isDuplicateProjectName(name, ctx.project.id)) {
    showRenameProjectError(`已存在同名方案「${name}」，请更换名称`);
    input.focus(); input.select();
    return;
  }
  setRenameProjectOpen(false);
  try {
    if (ctx.isCurrent && state.project?.id === ctx.project.id) {
      state.project.name = name;
      markDirty();
      $("projectName").value = name;
      await saveProject();
      toast(`方案已重命名为「${name}」`);
      return;
    }
    const full = await api(`/api/projects/${ctx.project.id}`);
    full.name = name;
    const saved = await api(`/api/projects/${ctx.project.id}`, { method: "PUT", body: JSON.stringify(full) });
    upsertProjectList(saved);
    toast(`方案已重命名为「${saved.name}」`);
  } catch (error) {
    toastError(error.message);
    setRenameProjectOpen(true, ctx.project, ctx.isCurrent);
  }
}
function setDeleteProjectOpen(open, project = null, isCurrent = false) {
  if (open) {
    rememberFocusForModal();
    state.deleteContext = { project, isCurrent };
    const savedAt = project?.updatedAt ? new Date(project.updatedAt).toLocaleString() : "尚未保存";
    const regionName = project?.regionName || project?.regionId || "未选择地区";
    const sceneCount = project?.scenes?.length || 0;
    $("deleteProjectMessage").textContent = `确认删除方案「${project?.name || ""}」？\n所属地区：${regionName} · ${sceneCount} 个场景 · 保存于 ${savedAt}\n该方案所有场景、文案、素材和成片设置都会被永久移除，无法恢复。`;
  } else {
    state.deleteContext = null;
    restoreFocusAfterModal();
  }
  $("deleteProjectModal").hidden = !open;
}
async function confirmDeleteProject() {
  const ctx = state.deleteContext;
  if (!ctx || !ctx.project) return;
  const wasCurrent = ctx.isCurrent;
  const deletedId = ctx.project.id;
  const deletedName = ctx.project.name || "";
  // Optimistic: the server's authoritative step is unlinking a handful of JSON
  // snapshots, so the scheme is gone as soon as the request lands. Waiting for
  // the round trip before updating the list made the click feel stalled, so the
  // list and dialog now settle first and the request is confirmed after.
  state.projects = state.projects.filter((p) => p.id !== deletedId);
  setDeleteProjectOpen(false);
  if (wasCurrent) {
    const next = state.projects[0];
    if (next) {
      /* Opening the next scheme can fail (a slow or failing project fetch), and
         this await sits outside the try below. An uncaught rejection here left
         the operator with a stuck overlay, no message, and a list that no longer
         names the open scheme. */
      try { await openSavedProject(next.id); }
      catch (error) { toastError(`方案已删除，但打开下一个方案失败：${error.message}`); renderProjectList(); setProjectListOpen(true); }
    } else { setProjectListOpen(false); setNewProjectOpen(true); }
  } else {
    renderProjectList();
  }
  try {
    await api(`/api/projects/${deletedId}`, { method: "DELETE" });
    if (!wasCurrent) toast("方案已删除");
  } catch (error) {
    // Put it back rather than leave the list lying about what is on disk.
    const restored = ctx.project;
    if (!state.projects.some((p) => p.id === deletedId)) {
      state.projects = [...state.projects, restored].sort(byUpdatedAtDesc);
    }
    renderProjectList();
    toastError(`${deletedName ? `「${deletedName}」` : "方案"}删除失败：${error.message}`);
  }
}
async function openSavedProject(id) {
  /* The busy card covers the whole viewport, so whatever shows it has to hide it
     on EVERY exit path. It used to be hidden on the last line alone, and this
     function has several awaits that can fail (the project fetch, the region
     lookup, the spec refresh, the audio probe): one failure left the editor
     showing 「正在打开方案…」 until the 90-second safety net expired, with no error
     anywhere -- to the operator the whole app just froze. */
  try {
    if (!(await saveBeforeAction("切换方案"))) return;
    setProjectBusy(true, "正在获取方案内容…");
    const project = await api(`/api/projects/${id}`);
    state.project = project;
    state.renderSpec = null;
    state.renderSpecStale = false;
    state.readiness = null;
    state.dirty = false;
    renderSaveState("saved");
    state.previewAudio?.pause(); state.previewAudio = null; state.previewAudioProjectId = null;
    showOutputLocation(null);
    state.selectedSceneId = project.scenes[0]?.id || null;
    state.selectedAssetId = project.scenes[0]?.placements?.[0]?.assetId || null;
    rememberCurrentProject();
    upsertProjectList(project);
    setProjectListOpen(false);
    render();
    setProjectBusy(true, "正在生成场景与导出检查（约 10-30 秒）…", `正在打开方案：${project.name || ""}`);
    await locateRegion(project.regionId);
    await syncProjectState();
    ensurePreviewAudio();
    await loadLatestExport().catch(() => showOutputLocation(null));
  } finally {
    setProjectBusy(false);
  }
}
async function createProjectFromList(name) {
  const regionId = state.creation.regionId;
  if (!(await saveBeforeAction("创建新方案"))) return;
  if (!regionId) throw new Error("请先选择乡镇/街道，不能使用默认地区创建方案");
  setProjectBusy(true, "正在创建新方案…", `正在创建方案：${name || state.creation.regionName || ""}`);
  try {
    const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ regionId, ...(name ? { name } : {}) }) });
    state.project = project;
    state.renderSpec = null;
    state.renderSpecStale = false;
    state.readiness = null;
    state.dirty = false;
    renderSaveState("saved");
    state.previewAudio?.pause(); state.previewAudio = null; state.previewAudioProjectId = null;
    showOutputLocation(null);
    state.selectedSceneId = project.scenes[0]?.id || null;
    state.selectedAssetId = project.scenes[0]?.placements?.[0]?.assetId || null;
    upsertProjectList(project);
    rememberCurrentProject();
    render();
    try { await locateRegion(project.regionId); }
    catch (error) { toastError(`项目已创建，选区面板刷新失败：${error.message}`); }
    await syncProjectState();
    ensurePreviewAudio();
    await loadLatestExport().catch(() => showOutputLocation(null));
    toast(`新项目已创建：${project.name}`);
  } finally {
    state.creation.busy = false;
    setProjectBusy(false);
  }
}

boot();
