# Releases

The repo is public and MIT licensed; releases are GitHub Releases on this
repo, built by `.github/workflows/release.yml`.

## Release ritual

Bump `version` in the workspace `Cargo.toml` (`[workspace.package]`),
commit, then:

```sh
git tag vX.Y.Z && git push origin HEAD && git push origin vX.Y.Z
```

CI builds the web app, embeds it in the CLI for macOS (Apple Silicon +
Intel), Windows x64, Linux x64, and Linux arm64, and uploads
`cubo-cli-<target>.tar.gz` archives with ffmpeg sidecars.

## ffmpeg sidecars

`node scripts/fetch-ffmpeg.mjs` downloads static ffmpeg/ffprobe into
`scripts/binaries/` (gitignored) with target-triple names. CI packs them
next to the CLI binary, where `transcode.rs::find_tool` looks first.
Downloads are pinned to exact upstream builds and verified against SHA-256
hashes recorded in the script (see [security.md](security.md)). The static
builds are GPL — fine to distribute as separate subprocess executables
alongside MIT Cubo, never link them.

## CLI targets

macOS arm64/x64, Windows x64, Linux x64 (ubuntu-latest) and Linux arm64
(ubuntu-24.04-arm runner). install.sh advertises all of them, so removing a
matrix entry breaks the installer for that platform.
