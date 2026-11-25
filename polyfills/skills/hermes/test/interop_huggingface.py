"""Interop: mcp-skills in a real Hermes against a Skills server someone else runs.

The server is Hugging Face's public MCP server (https://huggingface.co/mcp, no account), as a
user would add it to Hermes's config.yaml. Run with the pinned Hermes's Python:

    $HERMES_PYTHON test/interop_huggingface.py

It prints one line per check and exits non-zero if any fails. It needs the network.
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parents[2] / "tools" / "hermes"))
from harness import World, wait_for  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name, fn):
    try:
        results.append((name, True, fn() or ""))
    except Exception as exc:  # noqa: BLE001
        results.append((name, False, (str(exc).splitlines() or [repr(exc)])[0][:300]))


def main() -> int:
    w = World({"mcp-skills": ROOT / "plugin"}, mcp_servers={"huggingface": {"url": "https://huggingface.co/mcp"}},
              entries={"mcp-skills": {"settings": {"servers": ["huggingface"]}}})
    state = w.hermes_home / "mcp-skills" / "stubs" / "index.json"
    picked: dict = {}
    try:
        w.start(offline=False)
        sid = w.session()

        def listing():
            w.turn(sid, "hello")
            wait_for(lambda: state.exists() and json.loads(state.read_text()), 90, "the stubs")
            stubs = json.loads(state.read_text())
            assert all(s["server"] == "huggingface" for s in stubs)
            picked.update(next((s for s in stubs if "local-models" in s["name"]), stubs[0]))
            return f"{len(stubs)} skills listed as stubs, e.g. mcp-skills:{picked['name']}"
        check("listing: skills/list over Streamable HTTP; one stub each, nothing of a skill fetched", listing)

        def listed_in_hermes():
            sid2 = w.session()
            w.turn(sid2, "which skills do I have")
            sysmsg = next(str(m.get("content")) for rq in reversed(w.requests()) if rq["tools"]
                          for m in rq["messages"] if m.get("role") == "system")
            assert f"mcp-skills:{picked['name']}" in sysmsg
            return "in the next session's skill list"
        check("Hermes lists them with its own skills", listed_in_hermes)

        def load():
            w.rules({"when": {"last_role": "user", "contains": "use the skill"},
                     "reply": {"tool": "load_skill", "args": {"server": "huggingface", "uri": picked["uri"]}}})
            w.turn(sid, "use the skill please")
            approvals = [p for m, p in w.answers if m == "approval"]
            assert len(approvals) == 1, w.answers
            assert '"huggingface"' in approvals[0]["description"]
            text = w.tool_texts("huggingface")[-1]
            assert "MCP server" in text and "error" not in text[:40].lower(), text[:300]
            return f"approved in Hermes, then {picked['uri']} fetched and checked against its digest"
        check("load: Hermes asks, then the skill is fetched and verified", load)

        def read_file():
            loaded = w.tool_texts("huggingface")[-1]
            m = re.search(r"\b((?:references|scripts|assets)/[\w./-]+)", loaded)
            if not m:
                return "the skill refers to no file; skipped"
            w.rules({"when": {"last_role": "user", "contains": "read its file"},
                     "reply": {"tool": "read_skill_file", "args": {"server": "huggingface", "skill": picked["uri"], "path": m.group(1)}}})
            w.turn(sid, "read its file")
            got = w.tool_texts()[-1]
            assert "could not" not in got[:80], got[:200]
            return m.group(1)
        check("read_skill_file: a file the skill refers to, from its server, verified", read_file)
    finally:
        w.close()
    for name, ok, note in results:
        print(f"{'pass' if ok else 'FAIL'}  {name}{f'  ({note})' if note else ''}")
    return 0 if all(ok for _, ok, _ in results) else 1


if __name__ == "__main__":
    sys.exit(main())
