#!/usr/bin/env bash
# One take for the demo video: a real Claude Code session with the installed mcp-events polyfill,
# against the deployed event-feeds server, and the button page, recorded together.
#
#   1. The server is added the way the front page says: `claude mcp add --transport http feeds <url>/mcp`.
#   2. `claude`: "Give me a demo button and tell me what I type when I press it." Claude makes a
#      button (new_demo_button), watches its channel (watch_event) and goes idle.
#   3. The private page is opened and its button pressed, with a message, in a real browser.
#   4. The idle session wakes by itself, reads the message (read_event_text) and says what was typed.
#
# Usage: live/take.sh <out-dir>
#   BASE          the server (default https://event-feeds.idosalomon.workers.dev)
#   PLUGIN_DIR    the installed polyfill (default: the copy Claude Code installed, newest version)
#   POLYFILL_SRC  the polyfill's source, for tools/pty-drive.py (read, not changed)
#   DEMO_PROJECT  the folder Claude Code runs in (default ~/feeds-demo)
#   PTY_PYTHON    a python3 that has pyte
#   MESSAGE       what is typed next to the button (default "ship it")
#   MODEL         passed to claude as --model (default: the account's default model)
# Output: <out>/session/cast.jsonl (every byte the session wrote to its terminal, with timing),
# <out>/session/transcript.txt, <out>/page/ (photographs of the page with their times, and the
# click), <out>/take.json.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$1"; OUT="$(cd "$1" && pwd)"
BASE="${BASE:-https://event-feeds.idosalomon.workers.dev}"
# The polyfill's source (for tools/pty-drive.py): next to this server in the AgentPolyfill repository, or a checkout.
if [ -z "${POLYFILL_SRC:-}" ] && [ -d "$HERE/../../../polyfills/claude-code/events/tools" ]; then POLYFILL_SRC="$(cd "$HERE/../../../polyfills/claude-code/events" && pwd)"; fi
SRC="${POLYFILL_SRC:-$HOME/mcp-events-plugin}"
PLUGIN_DIR="${PLUGIN_DIR:-$(ls -d "$HOME"/.claude/plugins/cache/mcp-events/mcp-events/*/ | sort -V | tail -1)}"
PLUGIN_DIR="${PLUGIN_DIR%/}"
PY="${PTY_PYTHON:-python3}"
PROJECT="${DEMO_PROJECT:-$HOME/feeds-demo}"; mkdir -p "$PROJECT/.claude"
MESSAGE="${MESSAGE:-ship it}"
CPORT="${CONTROL_PORT:-4021}"
pids=()
cleanup() { curl -fsS -X POST "http://127.0.0.1:$CPORT/stop" >/dev/null 2>&1 || true; for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

# Spinner tips (one names the account's plan) and prompt suggestions (greyed text in an idle prompt
# reads as typed) are turned off for this folder; nothing else about the session is changed.
echo '{ "spinnerTipsEnabled": false, "promptSuggestionEnabled": false }' > "$PROJECT/.claude/settings.json"
(cd "$PROJECT" && claude mcp remove feeds -s local >/dev/null 2>&1 || true)
(cd "$PROJECT" && claude mcp add --transport http feeds "$BASE/mcp") | tee "$OUT/mcp-add.txt"

PLAYWRIGHT="${PLAYWRIGHT:-$SRC/video/node_modules/playwright-core/index.mjs}" node "$HERE/record-button.mjs" "$BASE/" "$OUT/page" --port "$CPORT" >"$OUT/page.log" 2>&1 &
pids+=($!)
for i in $(seq 1 30); do grep -q "controls on" "$OUT/page.log" 2>/dev/null && break; sleep 1; done
grep -q "controls on" "$OUT/page.log" || { echo "the page recorder did not start; see $OUT/page.log" >&2; exit 1; }

# Once the session has set its watch, the channel it watches is in the polyfill's own state.
cat > "$OUT/open-page.sh" <<SH
#!/usr/bin/env bash
ch=\$(find "$OUT/state" -name watches.json -exec cat {} + | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const j of s.split(/(?<=\\})\\s*(?=\\{)/)){try{for(const w of JSON.parse(j).watches)if(w.event==="demo.button"){console.log(w.arguments.channel);return}}catch{}}})')
[ -n "\$ch" ] || { echo "no demo.button watch yet" >&2; exit 1; }
echo "\$ch" > "$OUT/channel.txt"
curl -fsS -X POST "http://127.0.0.1:$CPORT/open?url=$BASE/b/\$ch"
SH
chmod +x "$OUT/open-page.sh"

OUT="$OUT" PROJECT="$PROJECT" CPORT="$CPORT" PLUGIN_DIR="$PLUGIN_DIR" MESSAGE="$MESSAGE" MODEL="${MODEL:-}" python3 - <<'PYEOF'
import json, os, urllib.parse
out, project, cport, plugin, message = (os.environ[k] for k in ("OUT", "PROJECT", "CPORT", "PLUGIN_DIR", "MESSAGE"))
env = {"MCP_EVENTS_SOURCES": "local", "MCP_EVENTS_STATE": out + "/state"}
# The installed polyfill, loaded for this session only; project and local settings only, so the
# session has the server the one-line add put in (local scope) and nothing else of the account's.
cmd = ["claude", "--plugin-dir", plugin, "--setting-sources", "project,local", "--allowedTools", "mcp__mcp-events__*,mcp__feeds__*", *(["--model", os.environ["MODEL"]] if os.environ.get("MODEL") else [])]
quit_ = [{"key": "ctrl-c", "after": 0.5}, {"key": "ctrl-c", "after": 0.5}, {"key": "ctrl-c", "after": 2}]
trust = [{"wait": "trust this folder|❯", "timeout": 40},
         {"when": "trust this folder", "steps": [{"sleep": 1.5}, {"key": "down", "after": 0.8}, {"key": "enter", "after": 3}]}]
press = "curl -fsS -X POST 'http://127.0.0.1:%s/press?message=%s'" % (cport, urllib.parse.quote(message))
session = {"cmd": cmd, "cwd": project, "env": env, "cols": 100, "rows": 34, "steps": [
    *trust, {"wait": "❯", "timeout": 60}, {"sleep": 6}, {"snap": "01-ready"},
    {"keys": "Give me a demo button and tell me what I type when I press it.", "delay": 0.035},
    {"sleep": 0.6}, {"key": "enter", "after": 2},
    {"wait": "unwatch_event w-|/b/b[A-Za-z0-9_-]{8}", "timeout": 150}, {"sleep": 12}, {"snap": "02-watching"},
    {"run": out + "/open-page.sh", "label": "open the button page"}, {"sleep": 4},
    {"run": press, "label": "type a message and press the button"},
    {"wait": "Prompt from the mcp-events", "timeout": 60}, {"sleep": 2}, {"snap": "03-event"},
    {"wait": "Prompt from the mcp-events(.|\\n)*" + message, "timeout": 90}, {"sleep": 8}, {"snap": "04-answered"},
    *quit_]}
json.dump(session, open(out + "/session.json", "w"), indent=1, ensure_ascii=False)
json.dump({"server": os.environ.get("BASE", "https://event-feeds.idosalomon.workers.dev"), "plugin": plugin, "project": project, "message": message, "model": os.environ.get("MODEL") or "default"}, open(out + "/take.json", "w"), indent=1)
PYEOF

"$PY" "$SRC/tools/pty-drive.py" "$OUT/session.json" "$OUT/session" || true
sleep 1
curl -fsS -X POST "http://127.0.0.1:$CPORT/stop" >/dev/null || true
echo "done: $OUT"
