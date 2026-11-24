#!/bin/sh
# Packs the plugin for release: one zip holding what the plugin runs (mod/'s
# manifest, hooks module, types and README, plus the licenses) and the helper for every
# platform in mod/helper/bin/ (helper-rs/build-into-plugin.sh puts each
# there; the release workflow builds all five). Nothing else goes in: no
# tests, no Node helper, no node_modules. Prints the zip's SHA-256 and writes
# the plugin's entry for the repository's marketplace file
# (.claude-plugin/marketplace.json at the repository's root): an `archive`
# source, pinned by that SHA-256, which Claude Code checks before it unpacks
# anything.
#
#   package/package.sh [--require-all] [--url <the zip's release URL>] [--out <folder>]
#
# Paths here are inside this polyfill's folder (polyfills/apps/claude-code);
# the script runs from any folder.
#
# --require-all fails unless all five platforms are there (the release
# does). Each binary is checked to be what its folder says (its format and
# processor; Linux ones static), so a binary in the wrong folder never ships.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
# The repository's root, which holds the license.
repo=$(cd "$root/../../.." && pwd)
mod="$root/mod"
out="$root/package/dist"
url=""
require_all=""
while [ $# -gt 0 ]; do
  case "$1" in
    --require-all) require_all=1 ;;
    --url) url="$2"; shift ;;
    --out) out="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

version=$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$mod/.claude-plugin/plugin.json" | head -1)
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "no version in mod/.claude-plugin/plugin.json" >&2; exit 1 ;;
esac
name="mcp-apps-cli-$version"
# Releases are tagged mcp-apps-cli-v<version> (.github/workflows/mcp-apps-cli-release.yml).
[ -n "$url" ] || url="https://github.com/idosal/AgentPolyfill/releases/download/mcp-apps-cli-v$version/$name.zip"
case "$url" in https://*) ;; *) echo "the zip's URL must be https (Claude Code takes no other)" >&2; exit 2 ;; esac

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
plugin="$stage/mcp-apps-cli"
mkdir -p "$plugin/.claude-plugin" "$plugin/hooks" "$plugin/types" "$plugin/helper/bin"
cp "$mod/.claude-plugin/plugin.json" "$mod/.claude-plugin/icon.svg" "$plugin/.claude-plugin/"
cp "$mod"/hooks/hooks.json "$mod"/hooks/*.ts "$mod"/hooks/*.tsx "$plugin/hooks/"
cp "$mod/types/index.d.ts" "$plugin/types/"
cp "$mod/README.md" "$plugin/"
cp "$repo/LICENSE" "$root/THIRD_PARTY_LICENSES.txt" "$plugin/"

# What each platform's binary must be, as file(1) says it.
expect() {
  case "$1" in
    # macOS's file(1) says "executable arm64", Linux's "arm64 executable".
    darwin-arm64) echo 'Mach-O 64-bit (executable arm64|arm64 executable)' ;;
    darwin-x64) echo 'Mach-O 64-bit (executable x86_64|x86_64 executable)' ;;
    linux-x64) echo 'ELF 64-bit LSB .*x86-64.*stati' ;;
    linux-arm64) echo 'ELF 64-bit LSB .*ARM aarch64.*stati' ;;
    win32-x64) echo 'PE32\+ executable.*x86-64' ;;
  esac
}
found=""
missing=""
for key in darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64; do
  exe=mcp-apps-cli-helper
  [ "$key" = win32-x64 ] && exe=mcp-apps-cli-helper.exe
  binary="$mod/helper/bin/$key/$exe"
  if [ ! -f "$binary" ]; then
    missing="$missing $key"
    continue
  fi
  kind=$(file -b "$binary")
  if ! printf '%s\n' "$kind" | grep -Eq "$(expect "$key")"; then
    echo "helper/bin/$key/$exe isn't a $key binary: $kind" >&2
    exit 1
  fi
  mkdir -p "$plugin/helper/bin/$key"
  cp "$binary" "$plugin/helper/bin/$key/$exe"
  chmod 755 "$plugin/helper/bin/$key/$exe"
  found="$found $key"
done
[ -n "$found" ] || { echo "no helper in mod/helper/bin/ (helper-rs/build-into-plugin.sh builds one)" >&2; exit 1; }
if [ -n "$missing" ]; then
  if [ -n "$require_all" ]; then echo "missing helpers:$missing" >&2; exit 1; fi
  echo "note: no helper for$missing; the zip works only on$found" >&2
fi

# The same bytes from the same inputs: fixed times, sorted entries, no extra fields.
find "$plugin" -exec touch -t 202001010000 {} +
mkdir -p "$out"
rm -f "$out/$name.zip"
(cd "$stage" && find mcp-apps-cli -type f | LC_ALL=C sort | zip -X -q -9 "$out/$name.zip" -@)
if command -v sha256sum >/dev/null 2>&1; then
  sha=$(sha256sum "$out/$name.zip" | cut -d' ' -f1)
else
  sha=$(shasum -a 256 "$out/$name.zip" | cut -d' ' -f1)
fi
printf '%s  %s\n' "$sha" "$name.zip" > "$out/$name.zip.sha256"

# The plugin's entry in the repository's marketplace file: the release
# workflow sets the `source` of the mcp-apps-cli entry in
# .claude-plugin/marketplace.json to this one and leaves the rest as it is.
cat > "$out/marketplace-entry.json" <<EOF
{
  "name": "mcp-apps-cli",
  "source": { "source": "archive", "url": "$url", "sha256": "$sha" }
}
EOF

if command -v claude >/dev/null 2>&1; then
  claude plugin validate "$plugin" >/dev/null || { echo "claude plugin validate failed on the packed plugin" >&2; exit 1; }
fi
size=$(wc -c < "$out/$name.zip" | tr -d ' ')
echo "$out/$name.zip ($size bytes; helpers:$found)"
echo "sha256 $sha"
