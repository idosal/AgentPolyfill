#!/usr/bin/env python3
"""Turn one probe's raw host output into the text kept in probe/runs/.

  summarize.py claude <stream-json file>   (claude -p --output-format stream-json --verbose)
  summarize.py codex  <jsonl file>         (codex exec --json)

For each tool call: what was called, and exactly what the host gave the model
back (cut at 600 characters). Then the model's answer. Local paths are replaced
by <home> and <tmp>, so the output is fit to keep in the repository.
"""
import json
import os
import re
import sys

CUT = int(os.environ.get("SUMMARY_CUT", "600"))


def scrub(s: str) -> str:
    s = re.sub(r"/(private/)?(tmp|var/folders)/[^\s\"'\\]*", "<tmp>", s)
    s = s.replace(os.path.expanduser("~"), "<home>")
    s = re.sub(r"(\.claude/projects/)[^/\s\"']+", r"\1<project>", s)
    s = re.sub(r"-Users-[A-Za-z0-9._-]+", "-<project>", s)
    return s


def cut(s: str) -> str:
    return s if len(s) <= CUT else s[:CUT] + f"… [{len(s)} characters in all]"


def claude(path: str) -> None:
    for line in open(path):
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("type") == "assistant":
            for c in m["message"]["content"]:
                if c.get("type") == "tool_use":
                    print(f"CALL   {c['name']} {json.dumps(c['input'])}")
        elif m.get("type") == "user":
            for c in m["message"]["content"]:
                if isinstance(c, dict) and c.get("type") == "tool_result":
                    content = c["content"]
                    if isinstance(content, list):
                        parts = []
                        for b in content:
                            if b.get("type") == "image":
                                parts.append(f"[image block, {b['source'].get('media_type')}, shown to the model as an image]")
                            elif b.get("type") == "tool_reference":
                                parts.append(f"[tool schema loaded: {b['tool_name']}]")
                            else:
                                parts.append(json.dumps(b))
                        text = " ".join(parts)
                    else:
                        text = str(content)
                    print(f"MODEL  {cut(text)}")
        elif m.get("type") == "result":
            print(f"ANSWER {cut(m.get('result', ''))}")


def codex(path: str) -> None:
    for line in open(path):
        try:
            m = json.loads(line)
        except ValueError:
            continue
        it = m.get("item") or {}
        if m.get("type") != "item.completed":
            continue
        kind = it.get("type")
        if kind == "mcp_tool_call":
            print(f"CALL   {it['server']}.{it['tool']} {json.dumps(it.get('arguments'))}")
            print(f"MODEL  {cut(json.dumps(it.get('result') or it.get('error')))}")
        elif kind == "command_execution":
            print(f"SHELL  {cut(str(it.get('command')))}")
        elif kind == "agent_message":
            print(f"ANSWER {cut(it.get('text', ''))}")


if __name__ == "__main__":
    import io
    import contextlib

    host, path = sys.argv[1], sys.argv[2]
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        (claude if host == "claude" else codex)(path)
    sys.stdout.write(scrub(buf.getvalue()))
