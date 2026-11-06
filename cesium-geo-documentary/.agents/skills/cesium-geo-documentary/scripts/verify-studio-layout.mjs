#!/usr/bin/env node
/**
 * Deterministically verify the Studio layout for horizontal overflow.
 *
 * Two failure modes are checked, because both look fine in a screenshot until
 * you look closely and neither is caught by reading the markup:
 *
 *  1. Escape sweep — a descendant whose border box sticks out past its parent's
 *     padding box while the parent does not clip (overflow:visible). Cards with
 *     a fixed-width action column are the usual offender: the column keeps its
 *     declared width but a `white-space:nowrap` button cannot shrink below its
 *     min-content width, so the button slides out through the card border.
 *
 *  2. Width budget — for a named container, compare its used width against the
 *     min-content width of the widest label the runtime can emit into it. The
 *     live data may happen to hold short labels, which hides the bug entirely;
 *     forcing the widest labels is what makes the check data-independent.
 *
 * Usage (from the repository root, with the Studio reachable):
 *   node .agents/skills/cesium-geo-documentary/scripts/verify-studio-layout.mjs
 *   node .agents/skills/cesium-geo-documentary/scripts/verify-studio-layout.mjs --url http://127.0.0.1:4180
 *   node .agents/skills/cesium-geo-documentary/scripts/verify-studio-layout.mjs --scope .inspector
 *
 * Without --url the script starts its own Studio on STUDIO_PORT (default 4399)
 * and stops it again. An already-running Cesium preview is reused, not fought.
 *
 * Output: tmp/verify-studio-layout/inspector.png plus report.json, and one line
 * per finding on stdout. Exit code 1 when anything overflows, so it can gate CI.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(process.cwd());
const out = resolve(root, "tmp/verify-studio-layout");
await mkdir(out, { recursive: true });

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const scope = argValue("--scope", ".inspector");
const explicitUrl = argValue("--url", "");
const studioPort = Number(argValue("--port", process.env.STUDIO_PORT ?? 4399));
const baseUrl = explicitUrl || `http://127.0.0.1:${studioPort}`;

let server = null;
let logs = "";
if (!explicitUrl) {
  const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
  server = spawn(process.execPath, [tsxCli, "apps/studio/server.ts"], {
    cwd: root,
    env: { ...process.env, STUDIO_PORT: String(studioPort) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const collect = (chunk) => { logs += chunk.toString("utf8"); };
  server.stdout?.on("data", collect);
  server.stderr?.on("data", collect);
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`studio start timeout:\n${logs}`)), 40000);
    if (logs.includes("GEO_VIDEO_STUDIO_READY") || logs.includes("GEO_STUDIO_PORT_IN_USE")) {
      clearTimeout(timer);
      resolvePromise();
      return;
    }
    server.stdout?.on("data", () => {
      if (logs.includes("GEO_VIDEO_STUDIO_READY")) {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    server.stderr?.on("data", () => {
      if (logs.includes("GEO_STUDIO_PORT_IN_USE")) {
        clearTimeout(timer);
        resolvePromise();
      }
    });
  });
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: ["--force-device-scale-factor=1", "--disable-features=CalculateNativeWinOcclusion"]
});

const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1,
  locale: "zh-CN",
  timezoneId: "Asia/Shanghai"
});
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", (error) => consoleErrors.push(String(error?.message || error)));

await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scene-item[data-scene-id], [data-scene-id]", { timeout: 30000 });

/*
 * Selecting a scene is what mounts the inspector body we care about. The first
 * row is often the cover scene, which legitimately has no bound assets, so walk
 * the rows until one actually renders a bound-asset card and stay there. When
 * none does, the width-budget check reports itself as skipped rather than
 * passing silently.
 */
const sceneIds = await page.evaluate(() =>
  [...document.querySelectorAll(".scene-item[data-scene-id]")].map((node) => node.getAttribute("data-scene-id"))
);
let clicked = null;
for (const id of [null, ...sceneIds]) {
  if (id === null) {
    await page.evaluate(() => document.querySelector(".scene-item[data-scene-id], [data-scene-id]")?.click());
  } else {
    await page.evaluate((sceneId) => {
      document.querySelector(`.scene-item[data-scene-id="${CSS.escape(sceneId)}"]`)?.click();
    }, id);
  }
  await page.waitForTimeout(450);
  const hasAssets = await page.evaluate(() => Boolean(document.querySelector("#sceneBoundAssets .scene-bound-asset")));
  if (hasAssets) {
    clicked = id ?? "cover";
    break;
  }
}
if (!clicked) {
  await page.evaluate(() => document.querySelector(".scene-item[data-scene-id], [data-scene-id]")?.click());
  await page.waitForTimeout(450);
  clicked = await page.evaluate(() => document.querySelector("[data-scene-id]")?.getAttribute("data-scene-id"));
}
await page.waitForTimeout(400);

const report = await page.evaluate((scopeSelector) => {
  const scopeRoot = document.querySelector(scopeSelector);
  if (!scopeRoot) return { error: `scope not found: ${scopeSelector}` };

  const describe = (element) => {
    const classes = [...element.classList].slice(0, 3).map((name) => `.${name}`).join("");
    return `${element.tagName.toLowerCase()}${classes}`;
  };
  const styleOf = (element) => getComputedStyle(element);
  const visible = (element) => {
    if (element.closest("[hidden]")) return false;
    const style = styleOf(element);
    return style.display !== "none" && style.visibility !== "hidden";
  };

  /* --- 1. Escape sweep ------------------------------------------------- */
  const escapes = [];
  for (const element of scopeRoot.querySelectorAll("*")) {
    if (!visible(element)) continue;
    const parent = element.parentElement;
    if (!parent || !visible(parent)) continue;
    const parentStyle = styleOf(parent);
    // A clipping ancestor legitimately contains the child; only visible overflow
    // lets it spill out on screen.
    if (parentStyle.overflowX !== "visible") continue;
    const ownStyle = styleOf(element);
    // Out-of-flow elements are positioned against another containing block, so
    // their box says nothing about the parent's box.
    if (ownStyle.position === "absolute" || ownStyle.position === "fixed" || ownStyle.position === "sticky") continue;
    if (parentStyle.display === "contents") continue;
    const box = element.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const parentBox = parent.getBoundingClientRect();
    const paddingRight = parentBox.right - parseFloat(parentStyle.borderRightWidth || "0");
    const paddingLeft = parentBox.left + parseFloat(parentStyle.borderLeftWidth || "0");
    const rightOverflow = box.right - paddingRight;
    const leftOverflow = paddingLeft - box.left;
    if (rightOverflow > 0.5 || leftOverflow > 0.5) {
      escapes.push({
        selector: describe(element),
        label: (element.textContent || "").trim().slice(0, 24),
        parent: describe(parent),
        rightOverflow: Math.round(rightOverflow * 100) / 100,
        leftOverflow: Math.round(leftOverflow * 100) / 100,
        parentClips: parentStyle.overflowX
      });
    }
  }

  /* --- 2. Width budget for the scene-asset action column --------------- */
  let budget = null;
  const actions = scopeRoot.querySelector("#sceneBoundAssets .scene-bound-actions");
  if (actions) {
    const buttons = [...actions.querySelectorAll("button")];
    // The widest strings boundAssetCardHtml can emit, in render order.
    const widest = ["✓ 用于成片", "当前首图", "移除"];
    const saved = buttons.map((button) => button.textContent);
    buttons.forEach((button, index) => { if (widest[index]) button.textContent = widest[index]; });
    const containerWidth = actions.getBoundingClientRect().width;
    const requirements = buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return { text: button.textContent, width: Math.round(box.width * 100) / 100 };
    });
    const card = actions.closest(".scene-bound-asset");
    const cardStyle = styleOf(card);
    const cardBox = card.getBoundingClientRect();
    const limit = cardBox.right - parseFloat(cardStyle.borderRightWidth || "0") - parseFloat(cardStyle.paddingRight || "0");
    const widestRight = Math.max(...buttons.map((button) => button.getBoundingClientRect().right));
    buttons.forEach((button, index) => { button.textContent = saved[index]; });
    budget = {
      containerWidth: Math.round(containerWidth * 100) / 100,
      cardContentRight: Math.round(limit * 100) / 100,
      widestRight: Math.round(widestRight * 100) / 100,
      overflow: Math.round((widestRight - limit) * 100) / 100,
      required: Math.max(...requirements.map((item) => item.width)),
      requirements
    };
  }

  /*
   * 3. Card copy column. Widening the action column takes room away from the
   *    copy column, so this section reports what each line needed against what
   *    it got. The copy rows are single-line, so a tight column ellipsises
   *    rather than wraps, and ellipsis on a variable-length label is fine: the
   *    title attribute still carries the full text. What is never acceptable is
   *    the export badge being pushed out of the row, because it is the only
   *    indicator of whether the asset is in the film and it has no tooltip to
   *    fall back on. That asymmetry is what the pass/fail key is built on.
   */
  const ink = (node) => {
    if (!node) return 0;
    const range = document.createRange();
    range.selectNodeContents(node);
    return Math.round(range.getBoundingClientRect().width * 100) / 100;
  };
  const cards = [...scopeRoot.querySelectorAll("#sceneBoundAssets .scene-bound-asset")];
  const cardBudget = [];
  const clipping = [];
  for (const card of cards) {
    const titleNode = card.querySelector(".scene-bound-asset-title > b");
    const sourceNode = card.querySelector(".scene-bound-asset-title > small");
    const kindNode = card.querySelector(".asset-kind");
    const labelNode = card.querySelector(".asset-kind-text");
    const badgeNode = card.querySelector(".scene-bound-export-badge");
    const kindBox = kindNode.getBoundingClientRect();
    const badgeBox = badgeNode ? badgeNode.getBoundingClientRect() : null;
    // The badge must sit inside the kind row; anything else means it was the
    // text that won the space it needed.
    const badgeVisible = badgeBox ? badgeBox.right <= kindBox.right + 0.5 : true;
    const entry = {
      copy: Math.round(card.querySelector(".scene-bound-asset-copy").getBoundingClientRect().width * 100) / 100,
      title: ink(titleNode),
      source: ink(sourceNode),
      kind: ink(kindNode),
      badge: badgeBox ? Math.round(badgeBox.width * 100) / 100 : 0,
      badgeVisible,
      labelEllipsised: labelNode ? labelNode.scrollWidth - labelNode.clientWidth > 1 : false,
      sourceEllipsised: sourceNode.scrollWidth - sourceNode.clientWidth > 1,
      titleClamped: titleNode.scrollHeight - titleNode.clientHeight > 1
    };
    cardBudget.push(entry);
    if (!badgeVisible) {
      clipping.push({
        selector: ".scene-bound-export-badge",
        label: (badgeNode.textContent || "").trim(),
        lost: Math.round((badgeBox.right - kindBox.right) * 100) / 100
      });
    }
  }

  const panelBox = scopeRoot.getBoundingClientRect();
  return {
    scope: scopeSelector,
    panel: {
      width: Math.round(panelBox.width * 100) / 100,
      scrollWidth: scopeRoot.scrollWidth,
      clientWidth: scopeRoot.clientWidth
    },
    escapes,
    budget,
    cardBudget,
    clipping
  };
}, scope);

const clip = await page.evaluate((scopeSelector) => {
  const box = document.querySelector(scopeSelector).getBoundingClientRect();
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}, scope);
await page.screenshot({
  path: resolve(out, "inspector.png"),
  clip: { x: Math.max(0, clip.x), y: Math.max(0, clip.y), width: clip.width, height: Math.min(clip.height, 1600) }
});

/*
 * 4. Section action row alignment. Page-level, so it is checked whatever `--scope`
 *    is: `.section-title-actions` is a flex row with `align-items:center`, which
 *    centres each child's *margin box*. Any member carrying a vertical margin is
 *    therefore nudged off the shared centre line — a leftover `margin-top:8px` on
 *    `+ 新增场景` (from when it was a standalone child of `.section-title`) put it
 *    4px below `按接壤重排` while the two other items stayed put. Two invariants:
 *    no member may declare a vertical margin, and every member's text line box must
 *    share one centre line.
 */
const actionRow = await page.evaluate(() => {
  const group = document.querySelector(".section-title-actions");
  if (!group) return { skipped: "no .section-title-actions" };
  const members = [...group.children].filter(
    (element) => getComputedStyle(element).display !== "none"
  );
  if (members.length < 2) return { skipped: `only ${members.length} member(s)` };

  const lineBox = (element) => {
    const textNode = [...element.childNodes].find(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()
    );
    if (!textNode) return null;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    return range.getBoundingClientRect();
  };

  const measured = members.map((element) => {
    const style = getComputedStyle(element);
    const box = lineBox(element);
    return {
      label: (element.textContent || "").trim().slice(0, 16),
      id: element.id || "",
      textCenterY: box ? (box.top + box.bottom) / 2 : null,
      marginTop: parseFloat(style.marginTop || "0"),
      marginBottom: parseFloat(style.marginBottom || "0")
    };
  });

  const withText = measured.filter((item) => item.textCenterY !== null);
  const baseline = withText.length ? withText[0].textCenterY : 0;
  return {
    members: measured.map((item) => ({
      ...item,
      delta: item.textCenterY === null ? null : Math.round((item.textCenterY - baseline) * 100) / 100
    }))
  };
});

await context.close();
await browser.close();
if (server) {
  server.kill();
}

report.sceneId = clicked;
report.consoleErrors = consoleErrors.slice(0, 10);
report.actionRow = actionRow;
await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2), "utf8");

let failures = 0;
console.log(`STUDIO ${baseUrl} scope=${scope} selectedScene=${clicked ?? "(none)"}`);
console.log(`PANEL width=${report.panel?.width} scrollWidth=${report.panel?.scrollWidth} clientWidth=${report.panel?.clientWidth}`);

if (report.error) {
  console.log(`ERROR ${report.error}`);
  failures += 1;
} else {
  if (report.escapes.length === 0) {
    console.log("ESCAPES none");
  } else {
    for (const escape of report.escapes) {
      console.log(`ESCAPE ${escape.selector} "${escape.label}" -> right +${escape.rightOverflow}px left +${escape.leftOverflow}px (parent ${escape.parent})`);
      failures += 1;
    }
  }
  if (report.budget) {
    const verdict = report.budget.overflow > 0.5 ? "OVERFLOW" : "ok";
    console.log(`BUDGET actions column=${report.budget.containerWidth}px widest=${report.budget.required}px -> ${verdict} by ${report.budget.overflow}px`);
    report.budget.requirements.forEach((item) => console.log(`  button "${item.text}" ${item.width}px`));
    if (report.budget.overflow > 0.5) failures += 1;
  } else {
    console.log("BUDGET skipped (no bound scene assets in the selected scene)");
  }
  (report.cardBudget || []).forEach((card, index) => {
    const flags = [
      card.badgeVisible ? "badge ok" : "BADGE LOST",
      card.labelEllipsised ? "label ellipsised" : "label full",
      card.sourceEllipsised ? "source ellipsised" : "source full",
      card.titleClamped ? "title clamped" : "title full"
    ].join(", ");
    console.log(`CARD[${index}] copy=${card.copy}px title=${card.title} source=${card.source} kind=${card.kind} badge=${card.badge}  (${flags})`);
  });
  if (report.clipping.length === 0) {
    console.log("LOST none");
  } else {
    for (const item of report.clipping) {
      console.log(`LOST ${item.selector} "${item.label}" pushed out by ${item.lost}px`);
      failures += 1;
    }
  }
}
if (actionRow.skipped) {
  console.log(`ACTIONS skipped (${actionRow.skipped})`);
} else {
  for (const member of actionRow.members) {
    const shape = [
      `center Δ${member.delta === null ? "n/a" : `${member.delta}px`}`,
      `margin ${member.marginTop}/${member.marginBottom}px`
    ].join(" ");
    console.log(`ACTION "${member.label}"${member.id ? ` #${member.id}` : ""} ${shape}`);
  }
  const shifted = actionRow.members.filter((member) => member.delta !== null && Math.abs(member.delta) > 0.5);
  const margined = actionRow.members.filter((member) => member.marginTop !== 0 || member.marginBottom !== 0);
  for (const member of shifted) {
    console.log(`ALIGN "${member.label}" sits ${member.delta}px off the shared centre line`);
    failures += 1;
  }
  for (const member of margined) {
    console.log(`ALIGN "${member.label}" declares a vertical margin (${member.marginTop}/${member.marginBottom}px), which align-items:center turns into an offset`);
    failures += 1;
  }
  if (!shifted.length && !margined.length) console.log(`ALIGN ok (${actionRow.members.length} members on one centre line)`);
}
if (report.consoleErrors.length) {
  report.consoleErrors.forEach((error) => console.log(`CONSOLE ${error}`));
}

console.log(`REPORT tmp/verify-studio-layout/report.json  (failures=${failures})`);
process.exit(failures > 0 ? 1 : 0);
