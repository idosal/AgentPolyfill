#!/usr/bin/env bash
# What Claude Code and Codex do today when a tool returns a `resource_link`, with no
# polyfill installed: the probes behind ../docs/findings.md.
#
# Two copies of the fixture server (../core/test/fixture-links-server.ts) run as the
# MCP servers "docs" and "other". Each case asks the model to call one tool of "docs"
# and follow the link it returns, then keeps what the host gave the model.
#
# Each host runs in a throwaway folder made here and deleted at the end:
#   Claude Code  --strict-mcp-config with only the two fixture servers, --setting-sources
#                project, a fresh project folder; the fixture's tools are allowed by rule
#                (--allowedTools), Claude Code's own resource tools are left to its defaults.
#   Codex        a throwaway HOME and CODEX_HOME with only your Codex sign-in (auth.json)
#                copied in, never read; `codex exec -s read-only`.
# Your own ~/.claude settings, ~/.codex config and MCP servers are not used.
#
# Usage: probe/run.sh <out-dir> [claude|codex|both]
#   NODE22   a Node 22.18+ binary for the fixture (default: node on PATH)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FIXTURE="$HERE/../core/test/fixture-links-server.ts"
mkdir -p "$1"; OUT="$(cd "$1" && pwd)"
WHICH="${2:-both}"
NODE="${NODE22:-$(command -v node)}"
BASE="$(cd "$(mktemp -d)" && pwd -P)"
trap 'pkill -f "$BASE/" 2>/dev/null || true; rm -rf "$BASE"' EXIT

FOLLOW="Call the docs server's TOOL tool once, then follow the resource link it returns and read the linked resource, using whatever tools you have. Do not run shell commands, code or scripts, and do not decode anything yourself. Then report: the tools you called, exactly what each returned to you (verbatim, abbreviate anything over 300 characters), and what the linked resource contains (if it is an image, which colours are where; if you cannot actually see an image, say so)."
RAW="Call the docs server's text_link tool once. Then reply with the exact raw tool result you received, verbatim, and say whether you can see a URI, name, title, description, MIME type, size and annotations for a linked resource. Do not call any other tool."
CASES="text_link image_link binary_link user_only_link peer_link big_link missing_link image_inline embedded_image"
prompt() { if [ "$1" = raw ]; then echo "$RAW"; else echo "${FOLLOW/TOOL/$1}"; fi; }

if [ "$WHICH" != codex ]; then
    D="$BASE/claude"; mkdir -p "$D/project"
    cat > "$D/mcp.json" <<JSON
{"mcpServers":{
 "docs":{"type":"stdio","command":"$NODE","args":["$FIXTURE"],"env":{"FIXTURE_NAME":"docs","FIXTURE_PEER":"other","FIXTURE_LOG":"$D/server.log"}},
 "other":{"type":"stdio","command":"$NODE","args":["$FIXTURE"],"env":{"FIXTURE_NAME":"other","FIXTURE_PEER":"docs","FIXTURE_LOG":"$D/server.log"}}}}
JSON
    for c in raw $CASES; do
        tool=$([ "$c" = raw ] && echo text_link || echo "$c")
        (cd "$D/project" && claude -p "$(prompt "$c")" --mcp-config ../mcp.json --strict-mcp-config --setting-sources project \
            --permission-mode default --allowedTools "mcp__docs__$tool" --output-format stream-json --verbose \
            > "$D/$c.jsonl" 2>&1 || true) &
    done
    wait
    claude --version > "$OUT/claude-version.txt"
    for c in raw $CASES; do python3 "$HERE/summarize.py" claude "$D/$c.jsonl" > "$OUT/claude-$c.txt"; done
    python3 -c "import json,sys; [print(m['server'], m['method'], (m.get('params') or {}).get('uri') or (m.get('params') or {}).get('name') or '') for m in map(json.loads, open(sys.argv[1])) if m['method'] in ('tools/call','resources/read','resources/list')]" "$D/server.log" > "$OUT/claude-server-log.txt"
fi

if [ "$WHICH" != claude ]; then
    D="$BASE/codex"; mkdir -p "$D/home" "$D/codex" "$D/project"
    cp "${CODEX_AUTH_FROM:-$HOME/.codex}/auth.json" "$D/codex/auth.json"; chmod 600 "$D/codex/auth.json"
    cat > "$D/codex/config.toml" <<TOML
model_reasoning_effort = "low"

[mcp_servers.docs]
command = "$NODE"
args = ["$FIXTURE"]
env = { FIXTURE_NAME = "docs", FIXTURE_PEER = "other", FIXTURE_LOG = "$D/server.log" }

[mcp_servers.other]
command = "$NODE"
args = ["$FIXTURE"]
env = { FIXTURE_NAME = "other", FIXTURE_PEER = "docs", FIXTURE_LOG = "$D/server.log" }

[projects."$D/project"]
trust_level = "trusted"
TOML
    (cd "$D/project" && git init -q .)
    for c in raw $CASES; do
        (cd "$D/project" && HOME="$D/home" CODEX_HOME="$D/codex" codex exec --json -s read-only "$(prompt "$c")" \
            < /dev/null > "$D/$c.jsonl" 2>/dev/null || true) &
    done
    wait
    codex --version > "$OUT/codex-version.txt"
    for c in raw $CASES; do python3 "$HERE/summarize.py" codex "$D/$c.jsonl" > "$OUT/codex-$c.txt"; done
    python3 -c "import json,sys; [print(m['server'], m['method'], (m.get('params') or {}).get('uri') or (m.get('params') or {}).get('name') or '') for m in map(json.loads, open(sys.argv[1])) if m['method'] in ('tools/call','resources/read','resources/list')]" "$D/server.log" > "$OUT/codex-server-log.txt"
fi
echo "kept in $OUT"
