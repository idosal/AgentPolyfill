"""Interop: ard-discovery in a real Hermes against a publisher someone else runs.

buildkite.com's /.well-known/ard.json, read through the ard_discover tool. No registry search
is sent (that would send the user's words to a third party). Run with the pinned Hermes's Python;
it needs the network:

    $HERMES_PYTHON test/interop_real.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parents[2] / "tools" / "hermes"))
from harness import World  # noqa: E402


def main() -> int:
    w = World({"ard-discovery": ROOT / "plugin"})
    ok = False
    try:
        w.start(offline=False)
        sid = w.session()
        w.rules({"when": {"last_role": "user", "contains": "buildkite"}, "reply": {"tool": "ard_discover", "args": {"domain": "buildkite.com"}}})
        w.turn(sid, "What does buildkite.com list in its ard.json?")
        text = (w.tool_texts("buildkite") or [""])[-1]
        print(text[:1500])
        ok = "ard.json" in text and "https://" in text and not [p for m, p in w.answers if m == "approval"]
    finally:
        w.close()
    print(f"{'pass' if ok else 'FAIL'}  discovery: buildkite.com's ard.json read and validated through Hermes, with no question (it sends nothing of the user's)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
