#!/usr/bin/env bash
# A separately installed upstream checkout; only its loopback fixture is used.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${CONFORMANCE_DIR:?set CONFORMANCE_DIR to a modelcontextprotocol/conformance checkout with dependencies installed}"
node "$ROOT/build.mjs" --interop || exit 1
cd "$CONFORMANCE_DIR" || exit 1
echo "conformance suite at $(git rev-parse HEAD)"
status=0
for scenario in sep-2640-client-no-prefetch sep-2640-client-verify-digest sep-2640-client-verify-size sep-2640-client-verify-frontmatter; do
  node_modules/.bin/tsx src/index.ts client --command "node $ROOT/test/.build/interop.mjs" --scenario "$scenario" --spec-version draft --force -o "${CONFORMANCE_OUT:-$ROOT/test/.build/conformance}" || status=1
done
exit "$status"
