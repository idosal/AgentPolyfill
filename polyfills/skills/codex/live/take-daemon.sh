#!/usr/bin/env bash
# The plugin on a running app-server daemon, as the terminal UI uses it, in a throwaway HOME
# and CODEX_HOME (only your Codex sign-in, auth.json, is copied in; your own ~/.codex and
# ~/.agents are not read or changed):
#
#   1. the daemon is started and the plugin is installed from this repository's marketplace;
#   2. a session with no turn, so the daemon has run the plugin's server once (and keeps its tool
#      list); then Hugging Face's public server is added to the config;
#   3. session 1: "list the skills my MCP servers serve", then a plain question;
#   4. a marketplace update: the plugin is removed and added again, so Codex copies its folder afresh;
#   5. session 2 on the same daemon: one plain question.
#
# Each session is a client of the daemon's control socket (live/daemon-client.mjs), as the terminal
# UI is, and answers the plugin's question "Load it". Prints what each session saw, then how often
# the plugin's server started and where its stubs are. Everything is deleted at the end.
#
# Usage: live/take-daemon.sh [out-file]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/../../.." && pwd)"
OUT="${1:-}"
BASE="$(cd "$(mktemp -d)" && pwd -P)"
cleanup() {
    CODEX_HOME="$BASE/c" HOME="$BASE/h" codex app-server daemon stop < /dev/null > /dev/null 2>&1 || true
    pkill -f "$BASE/" 2>/dev/null || true # the daemon's updater, if it outlived the daemon
    rm -rf "$BASE"
}
trap cleanup EXIT
mkdir -p "$BASE/h" "$BASE/c" "$BASE/p"
cp "${CODEX_AUTH_FROM:-$HOME/.codex}/auth.json" "$BASE/c/auth.json"; chmod 600 "$BASE/c/auth.json"
export HOME="$BASE/h" CODEX_HOME="$BASE/c"
PROJECT="$BASE/p"; (cd "$PROJECT" && git init -q .)

codex app-server daemon start < /dev/null > /dev/null
codex plugin marketplace add "$REPO" < /dev/null > /dev/null
codex plugin add mcp-skills@agent-polyfill < /dev/null
printf '\nmodel_reasoning_effort = "low"\n\n[projects."%s"]\ntrust_level = "trusted"\n' "$PROJECT" >> "$CODEX_HOME/config.toml"
served() { find "$HOME/.agents/skills/mcp-skills-served" -name SKILL.md 2>/dev/null | wc -l | tr -d ' '; }
starts() { grep -c 'server(s) to look at' "$CODEX_HOME/mcp-skills/mcp-skills.log" 2>/dev/null || echo 0; }

{
    echo "== an earlier session on the daemon, no turn, before Hugging Face's server is in the config"
    node "$ROOT/live/daemon-client.mjs" "$PROJECT" || echo '(the session failed)'
    sleep 3
    echo "-- the plugin's server has started $(starts) time(s)"
    printf '\n[mcp_servers.huggingface]\nurl = "https://huggingface.co/mcp"\n' >> "$CODEX_HOME/config.toml"
    echo "== session 1 (Hugging Face's server now in the config; same daemon)"
    node "$ROOT/live/daemon-client.mjs" "$PROJECT" \
        'List the skills my MCP servers serve.' \
        'Which GGUF quantization should I use to run a 7B model on a 16 GB Mac? Answer in two sentences.' || echo '(the session failed)'
    echo "-- the plugin's server has started $(starts) time(s); stubs in ~/.agents/skills/mcp-skills-served: $(served)"
    echo "== a marketplace update: the plugin's folder is copied afresh"
    codex plugin remove mcp-skills@agent-polyfill < /dev/null
    codex plugin add mcp-skills@agent-polyfill < /dev/null
    echo "-- stubs in ~/.agents/skills/mcp-skills-served after it: $(served)"
    echo "== session 2 (same daemon, no restart)"
    node "$ROOT/live/daemon-client.mjs" "$PROJECT" \
        'How much memory does a 7B model in Q4_K_M need? Answer in two sentences.' || echo '(the session failed)'
    echo "-- the plugin's server has started $(starts) time(s); stubs: $(served)"
    echo "== the plugin's log"
    sed -e "s#$BASE#<tmp>#g" "$CODEX_HOME/mcp-skills/mcp-skills.log" | cut -c1-200
} 2>&1 | sed -e "s#$BASE#<tmp>#g" | tee "${OUT:-/dev/null}"
