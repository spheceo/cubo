#!/usr/bin/env bash
# Builds "Cubo Player.app" (macOS, Apple Silicon): the release binary, the
# pinned ffmpeg/ffprobe sidecars in Contents/Resources, and the
# cubo-player:// link handler in Info.plist. Ad-hoc signed.
#
#   scripts/player-app.sh [output-dir]      (default: target/player)
set -euo pipefail
cd "$(dirname "$0")/.."

out="${1:-target/player}"
triple="aarch64-apple-darwin"
version="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"

cargo build --release -p cubo-player
bin="$(cargo metadata --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')/release/cubo-player"

# Sidecars: the pinned downloads (scripts/fetch-ffmpeg.mjs), else the ones an
# installed Cubo Core uses.
sidecar() {
  local name="$1"
  for candidate in "scripts/binaries/$name-$triple" "$HOME/.local/bin/$name"; do
    if [[ -x "$candidate" ]]; then echo "$candidate"; return; fi
  done
  echo "missing $name: run node scripts/fetch-ffmpeg.mjs" >&2
  exit 1
}

app="$out/Cubo Player.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/cubo-player"
cp "$(sidecar ffmpeg)" "$app/Contents/Resources/ffmpeg"
cp "$(sidecar ffprobe)" "$app/Contents/Resources/ffprobe"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Cubo Player</string>
  <key>CFBundleDisplayName</key><string>Cubo Player</string>
  <key>CFBundleIdentifier</key><string>com.spheceo.cubo.player</string>
  <key>CFBundleExecutable</key><string>cubo-player</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.entertainment</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>Cubo Player link</string>
      <key>CFBundleURLSchemes</key><array><string>cubo-player</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$app" >/dev/null
echo "$app"
