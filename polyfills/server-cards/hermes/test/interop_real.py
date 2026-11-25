"""Interop: mcp-server-cards in a real Hermes against a publisher someone else runs.

neon.com's AI Catalog and its Server Cards, fetched live; then Neon Docs (no sign-in) added after
Hermes's approval, connected with /reload-mcp, and one of its tools reaching the model. Run with
the pinned Hermes's Python; it needs the network:

    $HERMES_PYTHON test/interop_real.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parents[2] / "tools" / "hermes"))
from harness import World  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name, fn):
    try:
        results.append((name, True, fn() or ""))
    except Exception as exc:  # noqa: BLE001
        results.append((name, False, (str(exc).splitlines() or [repr(exc)])[0][:300]))


def main() -> int:
    w = World({"mcp-server-cards": ROOT / "plugin"})
    found: dict = {}
    try:
        w.start(offline=False)
        sid = w.session()

        def discover():
            w.rules({"when": {"last_role": "user", "contains": "neon"}, "reply": {"tool": "discover_mcp_servers", "args": {"domain": "neon.com"}}})
            w.turn(sid, "What MCP servers does neon.com publish?")
            text = w.tool_texts("neon")[-1]
            # The entry whose card says "Neon Docs", and the URL of its first remote.
            m = re.search(r"^\d+\. (\S+)\n(?:   .*\n)*?   title: Neon Docs\n(?:   .*\n)*?   remote #0: \S+ (https://\S+)", text, re.M)
            assert m, text[:1200]
            found.update(identifier=m.group(1), url=m.group(2), remote=0)
            return f"{found['identifier']} at {found['url']}"
        check("discover: neon.com's catalog and cards, fetched and validated", discover)

        def add():
            w.rules({"when": {"last_role": "user", "contains": "add neon docs"},
                     "reply": {"tool": "add_mcp_server", "args": {"domain": "neon.com", **found}}})
            w.turn(sid, "add neon docs")
            approvals = [p for m, p in w.answers if m == "approval"]
            assert approvals and found["url"] in approvals[-1]["description"], w.answers
            cfg = (w.hermes_home / "config.yaml").read_text()
            assert found["url"] in cfg, cfg[-600:]
            return "approved in Hermes, written to config.yaml"
        check("add: Hermes asks, then the entry is written", add)

        def connect():
            r = w.gw.request("reload.mcp", {"session_id": sid, "confirm": True}, timeout=120)
            assert r.get("status") == "reloaded", r
            w.turn(sid, "hello after reload")
            tools = next((rq["tools"] for rq in reversed(w.requests()) if rq["tools"]), [])
            mine = [t for t in tools if t.startswith("mcp__neon")]
            assert mine, sorted(tools)[:40]
            return f"{len(mine)} Neon Docs tool(s) offered to the model after /reload-mcp"
        check("connect: Hermes connects the added server with its own client", connect)
    finally:
        w.close()
    for name, ok, note in results:
        print(f"{'pass' if ok else 'FAIL'}  {name}{f'  ({note})' if note else ''}")
    return 0 if all(ok for _, ok, _ in results) else 1


if __name__ == "__main__":
    sys.exit(main())
