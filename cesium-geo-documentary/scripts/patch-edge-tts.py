#!/usr/bin/env python3
"""Apply the current edge-tts 403 fix to the vendored `.python-packages` copy.

Edge TTS is the formal narration provider, and its endpoint moved out from under
`edge-tts==7.2.8` (the newest release): since 2026-10 the legacy host
`speech.platform.bing.com` answers the synthesis websocket with
`403 WSServerHandshakeError: Invalid response status`, which is how 河头镇's export
died at the 「生成或复用正式配音」 step on 2026-10-12. Microsoft Edge 155
synthesizes through `api.msedgeservices.com/tts/cognitiveservices/websocket/v1`,
which accepts the legacy token as `Ocp-Apim-Subscription-Key` together with the
legacy `Sec-MS-GEC` headers. Upstream carries the same change in
rany2/edge-tts#491, still unmerged, so the fix ships here as a patch that can be
re-applied after any reinstall.

Because `**/.python-packages/` is gitignored, the patched files themselves cannot
be committed — this script and `requirements.txt` are what make the fix
reproducible. It is idempotent: run it after `pip install -r requirements.txt`,
and it reports `already-patched` instead of rewriting anything.

    python scripts/patch-edge-tts.py                 # patch ./.python-packages
    python scripts/patch-edge-tts.py --check         # exit 1 when unpatched
    python scripts/patch-edge-tts.py --version 146.0.3856.97
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TARGET = PROJECT_ROOT / ".python-packages"

LEGACY_WSS = (
    'WSS_URL = f"wss://{BASE_URL}/edge/v1?TrustedClientToken={TRUSTED_CLIENT_TOKEN}"\n'
)
PATCHED_WSS = '''# Since October 2026 the legacy host refuses speech synthesis with a 403.
# Microsoft Edge 155 synthesizes through api.msedgeservices.com, which also
# accepts the legacy token, given as Ocp-Apim-Subscription-Key. The voice
# list is still served by the legacy host.
WSS_URL = (
    "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1"
    f"?Ocp-Apim-Subscription-Key={TRUSTED_CLIENT_TOKEN}"
)
'''

LEGACY_DATE_PARSE = """        try:
            return (
                dt.strptime(date, "%a, %d %b %Y %H:%M:%S %Z")
                .replace(tzinfo=tz.utc)
                .timestamp()
            )
        except ValueError:
            return None
"""
PATCHED_DATE_PARSE = '''        try:
            parsed = parsedate_to_datetime(date)
        except (TypeError, ValueError, IndexError):
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=tz.utc)
        return parsed.timestamp()
'''

LEGACY_DRM_IMPORT = """from datetime import timezone as tz
from typing import Dict, Optional
"""
PATCHED_DRM_IMPORT = """from datetime import timezone as tz
from email.utils import parsedate_to_datetime
from typing import Dict, Optional
"""


def patch_constants(path: Path, version: str | None) -> str:
    text = path.read_text(encoding="utf-8")
    changed = False
    if "api.msedgeservices.com" not in text:
        if LEGACY_WSS not in text:
            raise SystemExit(f"{path}: expected the legacy WSS_URL line; the package is not 7.2.8-shaped")
        text = text.replace(LEGACY_WSS, PATCHED_WSS)
        changed = True
    if version:
        replaced, count = re.subn(r'CHROMIUM_FULL_VERSION = "[^"]+"', f'CHROMIUM_FULL_VERSION = "{version}"', text)
        if count != 1:
            raise SystemExit(f"{path}: could not find exactly one CHROMIUM_FULL_VERSION")
        changed = changed or replaced != text
        text = replaced
    if changed:
        path.write_text(text, encoding="utf-8")
        return "patched"
    return "already-patched"


def patch_drm(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    if "parsedate_to_datetime" in text:
        return "already-patched"
    if LEGACY_DRM_IMPORT not in text or LEGACY_DATE_PARSE not in text:
        raise SystemExit(f"{path}: expected the 7.2.8 locale-dependent date parsing")
    text = text.replace(LEGACY_DRM_IMPORT, PATCHED_DRM_IMPORT).replace(LEGACY_DATE_PARSE, PATCHED_DATE_PARSE)
    path.write_text(text, encoding="utf-8")
    return "patched"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--target", default=str(DEFAULT_TARGET), help="directory holding the vendored packages")
    parser.add_argument("--version", help="Sec-MS-GEC Chromium/Edge version to pin (default: leave the package's own)")
    parser.add_argument("--check", action="store_true", help="report status and exit non-zero when a patch is missing")
    args = parser.parse_args()

    package = Path(args.target) / "edge_tts"
    constants = package / "constants.py"
    drm = package / "drm.py"
    for path in (constants, drm):
        if not path.exists():
            raise SystemExit(f"edge_tts is not installed at {path}; run: pip install --target {args.target} -r requirements.txt")

    statuses = {"constants.py": patch_constants(constants, args.version), "drm.py": patch_drm(drm)}
    for name, status in statuses.items():
        print(f"{name}: {status}")
    if args.check and "patched" in statuses.values():
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
