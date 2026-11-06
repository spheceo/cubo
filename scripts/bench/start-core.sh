#!/usr/bin/env bash
# Starts a benchmark Core (before|after) on the dev slot 8764 with HOME pointed
# at the scratch HOME from setup-core.sh. Runs in the foreground (Ctrl+C stops
# it); pass --background to detach (pid in $BENCH_DIR/core.pid, stdout in
# $BENCH_DIR/core-<label>.out). Core's own log lands in
# $BENCH_DIR/home/.local/share/cubo/logs/.
#
#   scripts/bench/start-core.sh after
#   scripts/bench/start-core.sh before --background
#   scripts/bench/start-core.sh stop
set -euo pipefail

BENCH_DIR="${BENCH_DIR:-/private/tmp/claude-501/-Users-siphesihlembuyisa-Documents-code-cubo/c9835802-cc92-4cde-9634-eb4bf9197f51/scratchpad/bench}"
label="${1:?usage: $0 before|after|stop [--background]}"

if [ "$label" = stop ]; then
  if [ -f "$BENCH_DIR/core.pid" ] && kill -0 "$(cat "$BENCH_DIR/core.pid")" 2>/dev/null; then
    kill -INT "$(cat "$BENCH_DIR/core.pid")"
    for _ in $(seq 1 50); do kill -0 "$(cat "$BENCH_DIR/core.pid")" 2>/dev/null || break; sleep 0.2; done
  fi
  rm -f "$BENCH_DIR/core.pid"
  exit 0
fi

bin="$BENCH_DIR/bin/$label/cubo"
[ -x "$bin" ] || { echo "no Core build at $bin (run scripts/bench/setup-core.sh build)" >&2; exit 1; }
if lsof -nP -iTCP:8764 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port 8764 is taken (another dev Core?)" >&2
  lsof -nP -iTCP:8764 -sTCP:LISTEN >&2
  exit 1
fi

if [ "${2:-}" = --background ]; then
  HOME="$BENCH_DIR/home" nohup "$bin" --no-update-check serve --no-open \
    > "$BENCH_DIR/core-$label.out" 2>&1 &
  echo $! > "$BENCH_DIR/core.pid"
  for _ in $(seq 1 100); do
    if curl -sf http://127.0.0.1:8764/v1/health >/dev/null 2>&1; then
      echo "Core $label up on 8764 (pid $(cat "$BENCH_DIR/core.pid"))"
      exit 0
    fi
    sleep 0.2
  done
  echo "Core $label did not come up; see $BENCH_DIR/core-$label.out" >&2
  exit 1
fi
exec env HOME="$BENCH_DIR/home" "$bin" --no-update-check serve --no-open
