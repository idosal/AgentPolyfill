#!/usr/bin/env bash
# Sets up the Hermes the Hermes forms' tests run against: a source checkout of the pinned release
# tag and its locked dependencies, in tools/hermes/.hermes-test/ (git-ignored). This is not the
# curl installer, and it writes nothing outside that folder: Hermes's own home is made per test run.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="$here/.hermes-test"
tag="v0.23.4"
commit="8fc0374447313e276f6b9a2764bfc750190c966a"
command -v uv >/dev/null || { echo "uv is needed (https://docs.astral.sh/uv/)"; exit 1; }
if [ ! -d "$dest/src/.git" ]; then
  mkdir -p "$dest"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" https://github.com/NousResearch/hermes-agent.git "$dest/src"
fi
got="$(git -C "$dest/src" rev-parse HEAD)"
[ "$got" = "$commit" ] || { echo "the checkout is at $got, not $tag ($commit)"; exit 1; }
# Locked dependencies, as the release pins them, into a venv of its own.
( cd "$dest/src" && UV_PROJECT_ENVIRONMENT="$dest/venv" uv sync --quiet --frozen --extra mcp --python 3.14 )
echo "Hermes $tag ready: HERMES_PYTHON=$dest/venv/bin/python HERMES_SRC=$dest/src"
