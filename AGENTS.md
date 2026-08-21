# Cubo — agent notes

## Playback pipeline status: WORKING — do not casually change

As of 2026-08-20 the streaming, rendering, and playback pipeline works well
across all media that previously had problems: A/V sync, seeking, resume,
source fallback, and remux warm-up speed are all verified good. This state is
the result of several hard-won, empirically debugged fixes. Do not refactor,
"simplify", or swap out parts of this pipeline without a strong reason and
explicit approval from the maintainer.

### Load-bearing invariants

Each of these fixed a real, user-visible bug. Breaking any of them
reintroduces it.

1. **Direct-play first.** MP4/WebM sources rank above remux-needing sources
   within the same quality tier (`apps/web/lib/stream-select.ts`). The ffmpeg
   remux is a fallback for titles with no direct-playable source, never the
   default.
2. **Remuxed sources always play through hls.js, never native HLS**
   (`apps/web/components/video-player.tsx`). Native players (Safari, the
   desktop WKWebView) treat Core's growing EVENT playlist as a live broadcast:
   play() snaps to the live edge and seeking collapses to a sliding window.
3. **The player thinks in absolute movie time.** A remux playlist's time zero
   is where ffmpeg's input seek ACTUALLY landed — the keyframe at/before the
   requested `-ss` target, measured by Core via ffprobe and reported in the
   `X-Cubo-Start` response header. Clients must use that value (never the
   requested start) as their absolute offset; every displayed/reported/sought
   position adds it back, and the gap up to the requested spot is closed by a
   playlist-local jump (`startTimeLocal`). Progress records must always store
   absolute positions and the full source duration (the `durationHint` from
   ffprobe), never the partial growing-playlist duration.
4. **Seeks outside the converted window restart ffmpeg** at the target via
   `-noaccurate_seek -ss` (`apps/desktop/src-tauri/src/transcode.rs`).
   `-noaccurate_seek` is load-bearing for lip-sync: without it, transcoded
   audio is trimmed to the exact seek target while copied video starts at the
   earlier keyframe, and players shift audio to close the gap — a constant
   ~1 s A/V desync on every resume/seek.
5. **Segment URLs are unique per conversion job** (per-job nonce query param,
   plus `no-store`) in `apps/desktop/src-tauri/src/engine.rs`. Seek restarts
   reuse segment filenames for different content; without the nonce the
   browser HTTP cache splices audio from one offset over video from another.
6. **Probe results are prewarmed and cached.** Core starts ffprobe in the
   background the moment an MKV torrent is added, with tight analysis caps
   (`-probesize 5M -analyzeduration 10M`) and `-hls_init_time 2`. This is what
   keeps remux warm-up fast; raising the caps or serializing the probe brings
   back multi-second start delays.
7. **Cache deletion works against recorded file paths, not just rqbit**
   (`store.rs` / `engine.rs`). rqbit forgets its torrents on every restart, so
   deletion driven only through its API silently removes nothing.
8. **Auto stream fallback.** A mid-play source failure advances down the
   ranked list and resumes at the last reported position; the manual source
   picker stays hidden.

## Security model (added 2026-08-21) — do not weaken

Items 1–2 are implemented but **currently switched OFF** by
`pairing::PAIRING_ENABLED = false` (maintainer decision 2026-08-21, to be
re-enabled later). While off, `/v1/health` hands the session token to every
caller (pre-pairing behavior) and `/v1/pair` answers 404. Re-enabling is that
one constant — engine, CLI, tests, and the web app all follow the server's
signal automatically. Known gap to solve when re-enabling: `tailscale serve`
proxies requests to Core FROM loopback, so its callers would look local and
receive the session token; the loopback check gates only direct :8765
connections.

1. **The session token is loopback-only.** `/v1/health` includes
 `sessionToken` only when the TCP peer is loopback; remote callers get
 `pairingRequired: true`. Never expose the session token through any
 unauthenticated response again.
2. **Remote devices pair with offline authenticator codes**
 (`crates/cubo-engine/src/pairing.rs`): a secret in the data dir
 (`pairing.key`, 0600) derives rotating 6-digit codes (HMAC-SHA256, 60 s
 steps); `cubo pair` prints them, `POST /v1/pair` redeems one for a
 persistent device token (`paired-devices.json`). Attempts are throttled
 (5 failures/min). Streaming endpoints accept session or device tokens; the
 HLS playlist rewrite must echo the CALLER's token, never the session token.
3. **CORS is port-scoped.** Loopback/own-hostname origins are only trusted on
 ports 8765/4200/1420 (`ALLOWED_ORIGIN_PORTS`); the Private-Network-Access
 header is only granted to origins passing the allowlist.
4. **Cache deletion refuses `..` components** in recorded file paths (they
 come from untrusted torrent metadata).
5. **The deployed API proxies are allowlisted** (`apps/web/api/*.ts`): each
 route only forwards the exact request shapes the app makes. Add a pattern
 when the client grows a new endpoint, or it 404s.
6. **ffmpeg sidecars are pinned + checksum-verified**
 (`apps/desktop/scripts/fetch-ffmpeg.mjs`): exact upstream build URLs with
 recorded SHA-256 per file. To bump ffmpeg, update URL and hash together.

Protocol note: `POST /v1/library/progress` returns `204 No Content` (not the
library snapshot) — progress ticks are hot-path.

## Repo map

- `apps/web` — Vite + React 19 frontend (TanStack Query cache, lazy routes,
  native scrolling — Lenis was removed on purpose, do not reintroduce
  scroll-hijacking).
- `apps/desktop/src-tauri` — "Cubo Core": Tauri shell, axum bridge on port
  8765, rqbit torrent engine, ffmpeg remux pipeline (`transcode.rs`).
- `apps/site` — standalone marketing site (cubo.spheceo.com, Vercel project
  `cubo-site`). Deliberately has NO workspace dependencies so it deploys in
  isolation.
- `packages/core` — shared TypeScript types + TMDB/Torrentio client.
- `packages/ui` — shared presentational components and theme tokens.

## Releases and auto-updates

The repo is public and MIT licensed; releases are GitHub Releases on this
repo, built by `.github/workflows/release.yml`.

- **Release ritual:** bump `version` in
  `apps/desktop/src-tauri/tauri.conf.json`, `Cargo.toml`, and
  `apps/desktop/package.json` (keep them identical), commit, then
  `git tag vX.Y.Z && git push origin vX.Y.Z`. CI builds macOS (Apple Silicon +
  Intel) and Windows installers, signs updater artifacts, publishes the
  release with `latest.json`, and uploads stable-named download aliases
  (`cubo-macos-apple-silicon.dmg`, `cubo-macos-intel.dmg`,
  `cubo-windows-x64-setup.exe`) that the marketing site links to.
- **Auto-updater:** `tauri-plugin-updater` polls
  `releases/latest/download/latest.json` (endpoint + pubkey in
  tauri.conf.json). The private signing key lives outside the repo
  (`~/.tauri/cubo_updater.key` on the maintainer machine) and in the Actions
  secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
  Losing it means shipped apps can never update again — guard it. The in-app
  UI is `apps/web/components/update-banner.tsx` (desktop runtime only).
- **ffmpeg sidecars:** `node apps/desktop/scripts/fetch-ffmpeg.mjs` downloads
 static ffmpeg/ffprobe into `src-tauri/binaries/` (gitignored) with
 target-triple names; `bundle.externalBin` packs them next to the app binary,
 where `transcode.rs::find_tool` looks first. Run it before any local
 `tauri build`. Downloads are pinned to exact upstream builds and verified
 against SHA-256 hashes recorded in the script (see Security model). The
 static builds are GPL — fine to distribute as separate subprocess
 executables alongside MIT Cubo, never link them.
- **CLI targets:** macOS arm64/x64, Windows x64, Linux x64 (ubuntu-latest)
 and Linux arm64 (ubuntu-24.04-arm runner). install.sh advertises all of
 them, so removing a matrix entry breaks the installer for that platform.

## Parked work

- **Caption styling/UX shipped; timing alignment fixed** (2026-08-21):
  remuxed HLS playlists begin at the keyframe ffmpeg lands on, not the
  requested seek offset — Core now measures that landing point and reports it
  via `X-Cubo-Start` (see invariant 3), which keeps external subtitle cues
  aligned across seek restarts. Remaining validation: compare cue timings
  against audio on real remuxed sources with unusual keyframe intervals.

## Verification commands

- `bun --filter @cubo/web typecheck` and `bun --filter @cubo/web build`
- `cargo check` and `cargo test` in `apps/desktop/src-tauri` (or the workspace root)

## Conventions

- Custom UI over native controls: use `ConfirmDialog` and `Dropdown` from
  `apps/web/components` instead of `window.confirm` / `<select>`.
- No new color tokens without approval; reuse the theme in
  `packages/ui/src/theme.css`.
