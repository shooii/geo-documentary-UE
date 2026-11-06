import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PYTHON_SPAWN_OPTIONS, projectPythonRuntime } from "./python-runtime.js";

/**
 * 河头镇's export died at 「生成或复用正式配音」 with
 * `WSServerHandshakeError: 403, message='Invalid response status'` on 2026-10-12:
 * Microsoft had moved Edge synthesis to api.msedgeservices.com and the newest
 * `edge-tts` release still pointed at the legacy host. The fix lives in
 * `scripts/patch-edge-tts.py` because the vendored package directory is
 * gitignored, so the patch script — not the patched files — is what has to keep
 * working.
 */

const root = process.cwd();
const script = join(root, "scripts", "patch-edge-tts.py");

const LEGACY_CONSTANTS = `"""Constants for the edge_tts package."""

BASE_URL = "speech.platform.bing.com/consumer/speech/synthesize/readaloud"
TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"

WSS_URL = f"wss://{BASE_URL}/edge/v1?TrustedClientToken={TRUSTED_CLIENT_TOKEN}"
VOICE_LIST = f"https://{BASE_URL}/voices/list?trustedclienttoken={TRUSTED_CLIENT_TOKEN}"

DEFAULT_VOICE = "en-US-EmmaMultilingualNeural"

CHROMIUM_FULL_VERSION = "143.0.3650.75"
CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".", maxsplit=1)[0]
SEC_MS_GEC_VERSION = f"1-{CHROMIUM_FULL_VERSION}"
`;

const LEGACY_DRM = `"""DRM module."""

from datetime import datetime as dt
from datetime import timezone as tz
from typing import Dict, Optional


class DRM:
    @staticmethod
    def parse_rfc2616_date(date: str) -> Optional[float]:
        """Parses an RFC 2616 date string into a Unix timestamp."""
        try:
            return (
                dt.strptime(date, "%a, %d %b %Y %H:%M:%S %Z")
                .replace(tzinfo=tz.utc)
                .timestamp()
            )
        except ValueError:
            return None
`;

async function makePackage(): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), "edge-tts-patch-"));
  await mkdir(join(target, "edge_tts"), { recursive: true });
  await writeFile(join(target, "edge_tts", "constants.py"), LEGACY_CONSTANTS, "utf8");
  await writeFile(join(target, "edge_tts", "drm.py"), LEGACY_DRM, "utf8");
  return target;
}

function runPatch(target: string, extra: string[] = []) {
  const runtime = projectPythonRuntime(root);
  return spawnSync(runtime.command, [script, "--target", target, ...extra], {
    cwd: root,
    env: runtime.env,
    encoding: "utf8",
    windowsHide: true,
    ...PYTHON_SPAWN_OPTIONS
  });
}

test("the patch repoints synthesis at the new host and is idempotent", async () => {
  const target = await makePackage();
  try {
    const first = runPatch(target);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /constants\.py: patched/);
    assert.match(first.stdout, /drm\.py: patched/);

    const constants = await readFile(join(target, "edge_tts", "constants.py"), "utf8");
    assert.match(constants, /wss:\/\/api\.msedgeservices\.com\/tts\/cognitiveservices\/websocket\/v1/);
    assert.match(constants, /Ocp-Apim-Subscription-Key=\{TRUSTED_CLIENT_TOKEN\}/);
    assert.match(constants, /VOICE_LIST = f"https:\/\/\{BASE_URL\}\/voices\/list/, "the voice list stays on the legacy host");
    const drm = await readFile(join(target, "edge_tts", "drm.py"), "utf8");
    assert.match(drm, /from email\.utils import parsedate_to_datetime/);
    assert.doesNotMatch(drm, /strptime\(date, "%a, %d %b %Y/);

    // A reinstall that re-runs the patcher must not rewrite or fail.
    const second = runPatch(target);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already-patched/);
    const again = runPatch(target, ["--check"]);
    assert.equal(again.status, 0, "a patched package passes --check");
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test("--check fails on an unpatched package instead of silently passing", async () => {
  const target = await makePackage();
  try {
    const result = runPatch(target, ["--check"]);
    assert.equal(result.status, 1, "an unpatched package has to fail the check");
    assert.match(result.stdout, /constants\.py: patched/);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test("--version pins the Sec-MS-GEC build when Microsoft raises the floor", async () => {
  const target = await makePackage();
  try {
    const result = runPatch(target, ["--version", "146.0.3856.97"]);
    assert.equal(result.status, 0, result.stderr);
    const constants = await readFile(join(target, "edge_tts", "constants.py"), "utf8");
    assert.match(constants, /CHROMIUM_FULL_VERSION = "146\.0\.3856\.97"/);
    assert.match(constants, /SEC_MS_GEC_VERSION = f"1-\{CHROMIUM_FULL_VERSION\}"/);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test("the vendored copy on this machine is patched, and the failure message names the fix", async () => {
  const vendored = join(root, ".python-packages", "edge_tts", "constants.py");
  if (existsSync(vendored)) {
    const result = runPatch(join(root, ".python-packages"), ["--check"]);
    assert.equal(result.status, 0, `vendored edge_tts is unpatched:\n${result.stdout}${result.stderr}`);
  }
  const narration = await readFile(resolve(root, ".agents/skills/cesium-geo-documentary/scripts/generate-narration.ts"), "utf8");
  assert.match(narration, /function edgeTtsFailureHint/);
  assert.match(narration, /WSServerHandshakeError/);
  assert.match(narration, /scripts\/patch-edge-tts\.py/);
});
