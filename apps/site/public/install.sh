#!/bin/sh
# Cubo CLI installer — https://cubo.spheceo.com
#
# Usage:   curl -fsSL https://cubo.spheceo.com/install.sh | sh
#
# Downloads the latest cubo CLI (+ bundled ffmpeg/ffprobe) from GitHub
# Releases, verifies the checksum, and installs it into ~/.local/bin (or
# /usr/local/bin with sudo-less fallback logic below).

set -eu

REPO="spheceo/cubo"
PREFIX="${CUBO_INSTALL_DIR:-$HOME/.local/bin}"

echo "Installing Cubo CLI..."

case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) TARGET="aarch64-apple-darwin" ;;
  Darwin/x86_64) TARGET="x86_64-apple-darwin" ;;
  Linux/x86_64) TARGET="x86_64-unknown-linux-gnu" ;;
  Linux/aarch64 | Linux/arm64) TARGET="aarch64-unknown-linux-gnu" ;;
  *)
    echo "Unsupported platform: $(uname -s)/$(uname -m)" >&2
    exit 1
    ;;
esac

BASE_URL="https://github.com/${REPO}/releases/latest/download"
ARCHIVE="cubo-cli-${TARGET}.tar.gz"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading ${ARCHIVE}..."
curl -fsSL --retry 3 -o "${TMP}/${ARCHIVE}" "${BASE_URL}/${ARCHIVE}"
curl -fsSL --retry 3 -o "${TMP}/${ARCHIVE}.sha256" "${BASE_URL}/${ARCHIVE}.sha256"

echo "Verifying checksum..."
EXPECTED="$(cut -d' ' -f1 <"${TMP}/${ARCHIVE}.sha256")"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "${TMP}/${ARCHIVE}" | cut -d' ' -f1)"
else
  ACTUAL="$(shasum -a 256 "${TMP}/${ARCHIVE}" | cut -d' ' -f1)"
fi
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "Checksum mismatch: expected $EXPECTED, got $ACTUAL." >&2
  exit 1
fi

mkdir -p "$PREFIX"
tar xzf "${TMP}/${ARCHIVE}" -C "$TMP"
mv "${TMP}/cubo" "${TMP}/ffmpeg" "${TMP}/ffprobe" "$PREFIX/"
chmod +x "${PREFIX}/cubo" "${PREFIX}/ffmpeg" "${PREFIX}/ffprobe"

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *)
    echo
    echo "NOTE: $PREFIX is not on your PATH."
    echo "Add this to your ~/.zshrc or ~/.bashrc:"
    echo "  export PATH=\"\$PATH:$PREFIX\""
    ;;
esac

echo
echo "Cubo installed. To start streaming:"
echo "  1. Run:            cubo serve"
echo "  2. A browser tab opens app.cubo.spheceo.com automatically."
echo "     (Or open it yourself any time.)"
echo "  3. Search titles:  cubo search \"avengers\""
echo "  4. Update later:   cubo update"
echo
echo "Logs are saved to ~/.local/share/cubo/logs/cubo.log"
