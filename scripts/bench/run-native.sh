#!/usr/bin/env bash
# One Cubo Player benchmark end to end, the native counterpart of
# run-browser.sh: proxy up, fresh `after` Core on 8764, the release player
# plays a native session through the proxy for WALL seconds, Core stops.
#
#   scripts/bench/run-native.sh                  # -> results/native.json
#   WALL=120 MBPS=10 LABEL=native-x scripts/bench/run-native.sh
#   COMPETE_MBPS=3 COMPETE_URL=http://… scripts/bench/run-native.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BENCH_DIR="${BENCH_DIR:-/private/tmp/claude-501/-Users-siphesihlembuyisa-Documents-code-cubo/c9835802-cc92-4cde-9634-eb4bf9197f51/scratchpad/bench}"
export BENCH_DIR
WALL="${WALL:-300}"
MBPS="${MBPS:-10}"
LABEL="${LABEL:-native}"
CORE="${CORE:-after}"

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
if ! listening 8791; then
  nohup bun "$REPO/scripts/bench/throttle-proxy.ts" --mbps "$MBPS" > "$BENCH_DIR/proxy.log" 2>&1 &
  echo $! > "$BENCH_DIR/proxy.pid"
  sleep 0.5
fi

player="$(cargo metadata --manifest-path "$REPO/Cargo.toml" --format-version 1 --no-deps \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')/release/cubo-player"
[ -x "$player" ] || cargo build --release -p cubo-player --manifest-path "$REPO/Cargo.toml"

"$REPO/scripts/bench/start-core.sh" "$CORE" --background
competitor=""
cleanup() {
  # Children first: once the loop dies its curl is orphaned and pkill -P misses it.
  if [ -n "$competitor" ]; then pkill -P "$competitor" 2>/dev/null; kill "$competitor" 2>/dev/null; fi || true
  "$REPO/scripts/bench/start-core.sh" stop
}
trap cleanup EXIT
if [ -n "${COMPETE_MBPS:-}" ]; then
  "$REPO/scripts/bench/competitor.sh" "${COMPETE_URL:?COMPETE_URL is required with COMPETE_MBPS}" &
  competitor=$!
  sleep 3
fi
sleep 2
"$player" \
  --core http://127.0.0.1:8764 \
  --magnet "magnet:?xt=urn:btih:83b1ef08bdbacfb458121c677a63c95d788d250a" \
  --file-index 0 --media-key "tv:291431:2:10" --title "The Celebrity Traitors" \
  --start 2500 --proxy http://127.0.0.1:8791 --mute \
  --bench-seconds "$WALL" --bench-label "$LABEL" --bench-link-mbps "$MBPS" \
  --bench-core-pid "$(cat "$BENCH_DIR/core.pid")" \
  --bench-out "$BENCH_DIR/results/$LABEL.json"
