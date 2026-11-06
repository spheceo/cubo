#!/usr/bin/env bash
# One browser benchmark end to end: makes sure the throttle proxy (:8791) and
# the web server (:4200) are up, starts a fresh benchmark Core (before|after)
# on 8764, plays for WALL seconds, stops the Core again.
#
#   scripts/bench/run-browser.sh after            # -> results/browser-after.json
#   WALL=120 MBPS=10 scripts/bench/run-browser.sh before
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BENCH_DIR="${BENCH_DIR:-/private/tmp/claude-501/-Users-siphesihlembuyisa-Documents-code-cubo/c9835802-cc92-4cde-9634-eb4bf9197f51/scratchpad/bench}"
export BENCH_DIR
which="${1:?usage: $0 before|after}"
WALL="${WALL:-300}"
MBPS="${MBPS:-10}"
LABEL="${LABEL:-browser-$which}"

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

if ! listening 8791; then
  nohup bun "$REPO/scripts/bench/throttle-proxy.ts" --mbps "$MBPS" > "$BENCH_DIR/proxy.log" 2>&1 &
  echo $! > "$BENCH_DIR/proxy.pid"
fi
if ! listening 4200; then
  [ -f "$BENCH_DIR/web-dist/index.html" ] || "$REPO/scripts/bench/setup-core.sh" web
  nohup bun "$REPO/scripts/bench/serve-web.ts" "$BENCH_DIR/web-dist" > "$BENCH_DIR/web.log" 2>&1 &
  echo $! > "$BENCH_DIR/web.pid"
fi
sleep 0.5

"$REPO/scripts/bench/start-core.sh" "$which" --background
competitor=""
cleanup() {
  # Children first: once the loop dies its curl is orphaned and pkill -P misses it.
  if [ -n "$competitor" ]; then pkill -P "$competitor" 2>/dev/null; kill "$competitor" 2>/dev/null; fi || true
  "$REPO/scripts/bench/start-core.sh" stop
}
trap cleanup EXIT
# Optional other traffic on the link (see competitor.sh).
if [ -n "${COMPETE_MBPS:-}" ]; then
  "$REPO/scripts/bench/competitor.sh" "${COMPETE_URL:?COMPETE_URL is required with COMPETE_MBPS}" &
  competitor=$!
  sleep 3
fi
sleep 2
bun "$REPO/scripts/bench/browser-run.ts" --label "$LABEL" --wall "$WALL"
