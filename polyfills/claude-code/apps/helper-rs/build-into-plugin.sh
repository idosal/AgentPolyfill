#!/bin/sh
# Builds the Rust helper (release) and puts it where the plugin looks for it:
# mod/helper/bin/<os>-<arch>/mcp-apps-cli-helper. The plugin runs the one
# for the machine (mod/hooks/helper.ts, helperArgv); package/package.sh
# packs every one there into the plugin's zip. This machine's platform
# by default; `--target <triple>` builds for another one that rustup and a
# linker can (`--mac` builds both Mac ones, which any Mac can). Linux ships
# static musl builds (`--target <arch>-unknown-linux-musl`, which needs
# musl-gcc: Debian's and Ubuntu's musl-tools), so one binary runs on any
# distribution, whatever its C library. CARGO_TARGET_DIR is honored.
# Paths here are inside this polyfill's folder (polyfills/claude-code/apps);
# the script runs from any folder.
set -eu
cd "$(dirname "$0")"
PATH="$HOME/.cargo/bin:$PATH"
# Source paths go into the binary (panic locations): none of this machine's
# own, so a published binary names no person or folder.
RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=~ --remap-path-prefix=$HOME/.cargo/registry/src=crates --remap-path-prefix=$(pwd)=helper-rs"
export RUSTFLAGS
target=""
if [ "${1:-}" = "--mac" ]; then
  "$0" --target aarch64-apple-darwin
  exec "$0" --target x86_64-apple-darwin
fi
if [ "${1:-}" = "--target" ]; then target="$2"; fi
built="${CARGO_TARGET_DIR:-target}"
if [ -n "$target" ]; then
  case "$target" in
    # aws-lc (rustls' crypto) is C: built with musl's own compiler wrapper.
    *-linux-musl) export "CC_$(echo "$target" | tr '-' '_')=${MUSL_CC:-musl-gcc}" ;;
  esac
  cargo build --release --target "$target"
  binary="$built/$target/release/mcp-apps-cli-helper"
  case "$target" in
    aarch64-apple-darwin) key=darwin-arm64 ;;
    x86_64-apple-darwin) key=darwin-x64 ;;
    aarch64-unknown-linux-*) key=linux-arm64 ;;
    x86_64-unknown-linux-*) key=linux-x64 ;;
    x86_64-pc-windows-*) key=win32-x64; binary="$binary.exe" ;;
    *) echo "unknown target $target" >&2; exit 1 ;;
  esac
else
  cargo build --release
  binary="$built/release/mcp-apps-cli-helper"
  os=$(uname -s); machine=$(uname -m)
  case "$machine" in arm64|aarch64) arch=arm64 ;; *) arch=x64 ;; esac
  case "$os" in Darwin) key="darwin-$arch" ;; *) key="linux-$arch" ;; esac
fi
mkdir -p "../mod/helper/bin/$key"
cp "$binary" "../mod/helper/bin/$key/"
# Apple Silicon runs only signed code; the linker signs arm64 builds itself.
# Intel ones get the same ad-hoc signature, so both verify alike.
case "$key" in
  darwin-*) codesign --force --sign - "../mod/helper/bin/$key/mcp-apps-cli-helper" 2>/dev/null || true ;;
esac
echo "mod/helper/bin/$key/$(basename "$binary") ($(wc -c < "$binary" | tr -d ' ') bytes)"
