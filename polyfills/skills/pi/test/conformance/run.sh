#!/usr/bin/env bash
# Runs the Pi extension against the official MCP conformance suite's SEP-2640
# client scenarios. The suite is not a dependency of this repository: give the
# path of a checkout of github.com/modelcontextprotocol/conformance (with its
# dependencies installed: `npm install --ignore-scripts`) as CONFORMANCE_DIR.
#
#   CONFORMANCE_DIR=~/src/conformance test/conformance/run.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${CONFORMANCE_DIR:?set CONFORMANCE_DIR to a checkout of modelcontextprotocol/conformance}"
cd "$CONFORMANCE_DIR"
echo "conformance suite at $(git rev-parse HEAD) ($(git log -1 --format=%cd --date=short))"
# An extension's scenarios are on no spec revision's list, so the suite asks for --force to run one.
# --spec-version draft is the 2026-07-28 lifecycle (per-request metadata), which the extension is specified for.
status=0
for scenario in sep-2640-client-no-prefetch sep-2640-client-verify-digest sep-2640-client-verify-size sep-2640-client-verify-frontmatter; do
  echo "== $scenario"
  npx tsx src/index.ts client --command "node --no-warnings $ROOT/test/conformance/client.ts" --scenario "$scenario" --spec-version draft --force -o "${CONFORMANCE_OUT:-$ROOT/.test-state/conformance}" || status=1
done
exit $status
