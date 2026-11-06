#!/usr/bin/env bash
# Prepares the browser-path benchmark: two benchmark Cores (before = v0.0.41,
# after = HEAD + the working tree's Core changes), a scratch HOME holding the
# Traitors S02E10 file as a fully downloaded cache entry, and a built web app.
#
# Never touches the installed Core (8765) or ~/.local/share/cubo beyond
# reading: the 2.7 GB file is an APFS clone (cp -c), metadata files are copied.
#
#   scripts/bench/setup-core.sh            # everything (worktrees, builds, HOME, web)
#   scripts/bench/setup-core.sh home       # only (re)create the scratch HOME
#   scripts/bench/setup-core.sh web        # only rebuild the web dist
#   scripts/bench/setup-core.sh build      # only worktrees + Core builds
#
# BENCH_DIR overrides the scratch location (default below).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BENCH_DIR="${BENCH_DIR:-/private/tmp/claude-501/-Users-siphesihlembuyisa-Documents-code-cubo/c9835802-cc92-4cde-9634-eb4bf9197f51/scratchpad/bench}"
REAL_DATA="$HOME/.local/share/cubo"
HASH=83b1ef08bdbacfb458121c677a63c95d788d250a
FILE='The.Celebrity.Traitors.S02E10.Finale.1080p.HDTV.H264-DARKFLiX[EZTVx.to].mkv'
MEDIA_KEY='tv:291431:2:10'
BEFORE_REF="${BEFORE_REF:-v0.0.41}"
AFTER_REF="${AFTER_REF:-HEAD}"

step="${1:-all}"
mkdir -p "$BENCH_DIR"

build() {
  # before: the release tag as is.
  if [ ! -d "$BENCH_DIR/wt-before" ]; then
    git -C "$REPO" worktree add --detach "$BENCH_DIR/wt-before" "$BEFORE_REF"
  fi
  # after: HEAD plus the working tree's uncommitted Core changes (engine + CLI
  # only; the in-progress cubo-player crate is not part of the Core).
  if [ ! -d "$BENCH_DIR/wt-after" ]; then
    git -C "$REPO" worktree add --detach "$BENCH_DIR/wt-after" "$AFTER_REF"
    git -C "$REPO" diff HEAD -- crates/cubo-engine crates/cubo-cli > "$BENCH_DIR/after-working-tree.patch"
    if [ -s "$BENCH_DIR/after-working-tree.patch" ]; then
      git -C "$BENCH_DIR/wt-after" apply "$BENCH_DIR/after-working-tree.patch"
    fi
  fi
  # Debug build (debug_assertions picks the dev slot 8764 and the :4200 web
  # origin) but optimised like a release, so Core CPU is comparable. One shared
  # target dir: crates.io deps compile once.
  export CARGO_TARGET_DIR="$BENCH_DIR/target"
  export CARGO_PROFILE_DEV_OPT_LEVEL=3 CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0
  for label in before after; do
    (cd "$BENCH_DIR/wt-$label" && cargo build -p cubo-cli --locked)
    mkdir -p "$BENCH_DIR/bin/$label"
    cp "$CARGO_TARGET_DIR/debug/cubo-cli" "$BENCH_DIR/bin/$label/cubo"
    # Core finds ffmpeg next to its executable first: use the pinned sidecar
    # the installed release ships (h264_videotoolbox).
    for tool in ffmpeg ffprobe; do
      rm -f "$BENCH_DIR/bin/$label/$tool"
      cp -c "$HOME/.local/bin/$tool" "$BENCH_DIR/bin/$label/$tool"
    done
  done
}

home() {
  local data="$BENCH_DIR/home/.local/share/cubo"
  rm -rf "$BENCH_DIR/home"
  mkdir -p "$data/downloads" "$data/torrent-meta" "$data/piece-state" "$data/logs"
  # APFS clone: no extra disk, the original is never written.
  cp -c "$REAL_DATA/downloads/$FILE" "$data/downloads/$FILE"
  : > "$data/downloads/.cubo-cache"
  # Saved metadata: Core adds the torrent from disk, never resolves the magnet.
  cp "$REAL_DATA/torrent-meta/$HASH.torrent" "$data/torrent-meta/$HASH.torrent"
  # rqbit's saved piece bitfield: spot-checked instead of hashing 2.7 GB.
  if [ -f "$REAL_DATA/piece-state/$HASH.bitv" ]; then
    cp "$REAL_DATA/piece-state/$HASH.bitv" "$data/piece-state/$HASH.bitv"
  fi
  # Cache index: the file is a tracked entry (never reclaimed as untracked).
  cat > "$data/cubo-state.json" <<JSON
{
  "version": 1,
  "history": [],
  "watchLater": [],
  "cache": { "maxBytes": 21474836480 },
  "cacheEntries": [
    {
      "torrentId": null,
      "infoHash": "$HASH",
      "mediaKey": "$MEDIA_KEY",
      "title": "The Celebrity Traitors",
      "files": ["$data/downloads/$FILE"],
      "lastAccessedAt": $(($(date +%s) * 1000))
    }
  ]
}
JSON
  echo "scratch HOME ready: $BENCH_DIR/home"
}

web() {
  # The web app is identical in v0.0.41 and v0.0.42 (no apps/web changes
  # between the tags); one build serves both Cores.
  (cd "$REPO/apps/web" && bun x vite build --outDir "$BENCH_DIR/web-dist" --emptyOutDir)
}

case "$step" in
  all) build; home; web ;;
  build) build ;;
  home) home ;;
  web) web ;;
  *) echo "usage: $0 [all|build|home|web]" >&2; exit 2 ;;
esac
