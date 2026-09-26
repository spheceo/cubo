# Cubo — agent notes

## Playback pipeline status: WORKING — do not casually change

Core-owned playback sessions (`/v1/sessions`) are the only playback path. The
streaming, rendering, and playback fixes remain load-bearing; do not refactor
or replace this path without a strong reason and maintainer approval.

1. **Direct-play first.** MP4/WebM rank above remux-needing sources within a
   quality tier (`apps/web/lib/stream-select.ts`). Core decides the mode after
   probing the chosen file.
2. **Remux through hls.js.** Core serves a complete VOD HLS playlist in
   absolute movie time. `video-player.tsx` uses hls.js, including on Safari;
   the player and progress store use full-source absolute seconds.
3. **Seek on the file's own timeline.** MKV keyframes and fMP4 fragments are
   mapped to fixed VOD segments (`mkv_index.rs`, `segment_plan.rs`,
   `remuxer.rs`). Every segment URL always names the same movie interval, so
   seeks and old playlist polls cannot splice different remux jobs together.
4. **Core owns the live file.** Sessions keep the torrent and selected file
   alive, pace conversion from heartbeats, and protect it from cache eviction.
   Closed sessions and failed race candidates release that protection.
5. **Probe and metadata reuse.** A known torrent is reused in rqbit, otherwise
   its saved `.torrent` metadata is loaded from disk. Prefetch and playback
   share probes. Do not re-resolve known magnets from the swarm or serialize
   probe work behind buffer waits.
6. **Resume and fallback.** Intentional seeks persist before async work.
   `raceSessions` gives the top source a head start, launches backups when it
   is not downloading, plays the first ready one, and closes the rest. A
   failed active source advances down the ranked list at the last position;
   healthy sessions recover on the same source.
7. **Cache deletion.** Recorded file paths are the source of truth after a
   restart, when rqbit's torrent IDs change. Reject paths with `..`; deleting
   a torrent's files also removes its saved piece bitfield. Maintenance never
   removes a live session's file or a root still recorded in the cache index.
8. **Downloaded bar.** Core maps verified pieces to movie time using the
   MP4/MKV index. The player draws the contiguous watchable span from the
   playhead, never the browser's constant-bitrate guess for direct MP4.

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
 ports 8765/4200 plus the port this Core actually bound; the Private-Network-Access
 header is only granted to origins passing the allowlist.
4. **Cache deletion refuses `..` components** in recorded file paths (they
 come from untrusted torrent metadata).
5. **Catalog and stream proxies are allowlisted** (`crates/cubo-engine/src/catalog.rs`
 and the Cloudflare Worker in `apps/catalog`): each route only forwards the
 exact request shapes the app makes. Add a pattern when the client grows a
 new endpoint, or it 404s. The TMDB key lives on the Worker, never in the
 CLI. Vite still uses `apps/web/api/*.ts` for `just web`.
6. **ffmpeg sidecars are pinned + checksum-verified**
 (`scripts/fetch-ffmpeg.mjs`): exact upstream build URLs with
 recorded SHA-256 per file. To bump ffmpeg, update URL and hash together.

Protocol note: `POST /v1/library/progress` returns `204 No Content` (not the
library snapshot) — progress ticks are hot-path.

## Repo map

- `apps/web` — Vite + React 19 frontend (TanStack Query cache, lazy routes,
  native scrolling — Lenis was removed on purpose, do not reintroduce
  scroll-hijacking). Release Core embeds `dist`.
- `apps/catalog` — Cloudflare Worker that holds `TMDB_API_KEY` and returns
  allowlisted TMDB JSON. Workers.dev is fine; no custom domain required.
- `crates/cubo-engine` / `crates/cubo-cli` — Cubo Core: axum bridge on port
  8765, rqbit torrent engine, session remux pipeline (`remuxer.rs`),
  embedded UI, catalog/stream proxies, exposed as the `cubo` CLI.
- `apps/site` — standalone marketing site (cubo.spheceo.com, Vercel project
  `cubo-site`). Deliberately has NO workspace dependencies so it deploys in
  isolation.
- `packages/core` — shared TypeScript types + TMDB/Torrentio client.
- `packages/ui` — shared presentational components and theme tokens.

## Releases

The repo is public and MIT licensed; releases are GitHub Releases on this
repo, built by `.github/workflows/release.yml`.

- **Release ritual:** bump `version` in the workspace `Cargo.toml`
  (`[workspace.package]`), commit, then
  `git tag vX.Y.Z && git push origin HEAD && git push origin vX.Y.Z`. CI
  builds the web app, embeds it in the CLI for macOS (Apple Silicon + Intel),
  Windows x64, Linux x64, and Linux arm64, and uploads
  `cubo-cli-<target>.tar.gz` archives with ffmpeg sidecars.
- **ffmpeg sidecars:** `node scripts/fetch-ffmpeg.mjs` downloads static
  ffmpeg/ffprobe into `scripts/binaries/` (gitignored) with target-triple
  names. CI packs them next to the CLI binary, where
  `transcode.rs::find_tool` looks first. Downloads are pinned to exact
  upstream builds and verified against SHA-256 hashes recorded in the
  script (see Security model). The static builds are GPL — fine to
  distribute as separate subprocess executables alongside MIT Cubo, never
  link them.
- **CLI targets:** macOS arm64/x64, Windows x64, Linux x64 (ubuntu-latest)
  and Linux arm64 (ubuntu-24.04-arm runner). install.sh advertises all of
  them, so removing a matrix entry breaks the installer for that platform.

## Parked work

- **Subtitle timing:** session playlists use absolute movie time. Remaining
  validation: compare cues against audio on real remuxed sources with unusual
  keyframe intervals.

## Task runner

Use [just](https://just.systems) from the repo root (`Justfile`). `just`
lists recipes. `just dev` starts Cubo Core (`cargo run -p cubo-cli -- serve
--no-open`). Bun stays for installs and per-package Vite/tsc scripts.

## Verification commands

- `just typecheck` and `just build` (or `bun --filter @cubo/web typecheck` / `build`)
- `just check` and `just test` in the workspace root

## Conventions

- Custom UI over native controls: use `ConfirmDialog` and `Dropdown` from
  `apps/web/components` instead of `window.confirm` / `<select>`.
- No new color tokens without approval; reuse the theme in
  `packages/ui/src/theme.css`.

## Speed, quality, and stability rules

- Successful playback remembers the exact torrent and file per movie/episode
  (`source-affinity.ts`). Reopening tries that source while alternatives load
  in parallel. Seeder-count changes alone must not switch releases. Failed
  sources are forgotten and excluded from further automatic attempts in the
  same session; an explicit retry resets that exclusion.
- Automatic playback and previews exclude positively identified foreign dubs,
  burned-in subtitles, cinema captures, and stereoscopic 3D (SBS/OU) encodes,
  which rank last. Unknown language is still eligible:
  release metadata is heuristic and does not prove the audio track's language.
  Keep direct-play precedence within the established quality tiers.
- Preview startup uses already-buffered footage where a full clip fits, otherwise
  an early scene past the opening titles (roughly 3–7 minutes for typical
  episodes/movies). Do not restore a random seek halfway through a
  cold torrent or make a loader animation delay media attachment.
- Intentional seeks are persisted before the asynchronous seek starts. Keep the
  old-player teardown guards, but never treat an explicit backward seek as an
  accidental rewind. `ProgressWriter` permits one in-flight POST and coalesces
  queued snapshots to the newest, preserving accumulated watch time.
- Progress sends `progressUpdatedAt` and `progressDeviceId`; Core rejects older
  observations from the same browser. `lastWatchedAt` remains server receipt
  time for library recency. Do not compare observation clocks across devices.
  Legacy clients without these optional fields retain their existing behavior.
- Command-line tests cover ordering and selection; they do not establish real
  first-frame latency, browser seek behavior, or actual audio language. Cold
  startup still depends on peer availability. A/V sync, playlist mapping,
  and segment-cache behavior remain load-bearing.

- Session starts race sources (`raceSessions` in `watch-screen.tsx`): the
  top pick runs alone for a few seconds, backups join while nothing is
  visibly downloading, the first ready plays and the rest are closed. Never
  go back to one-at-a-time attempts behind Core's resolve timeout.
- Core never re-resolves a known source from the swarm: a torrent rqbit
  already manages is reused, otherwise saved metadata
  (`<data>/torrent-meta/<hash>.torrent`) is added from disk. rqbit resolves
  magnet metadata from peers *before* checking what it manages, so passing
  a magnet for a known torrent can hang on a fully downloaded file.
- `POST /v1/prefetch` warms the next episode (last 12 minutes of the
  current one) and the title page's play target: metadata, header, probe.
  It then parks the torrent (kept paused by maintenance until a session
  plays it); sources that close without ever serving media are parked too,
  so guesses and race losers never download whole files.
- The player's grey "downloaded" bar comes from Core (heartbeat
  `availableRanges`): torrent pieces on disk mapped to movie time through
  the file's own index (MP4 sample tables, MKV cues). Don't go back to
  `video.buffered` for sessions: for direct MP4s the browser places bytes as
  if the bitrate were constant, minutes away from the playhead. The bar
  draws only the watchable span from the playhead to the first missing
  piece (`lib/download-bar.ts`); raw torrent ranges are islands.
- Titles not made in English ask once per title, before the first play,
  whether to watch the original (with English subtitles, the default) or
  an English dub. The prompt only appears when an English-audio source
  exists (`lib/audio-choice.ts`). The choice drives ranking (dub mode
  prefers named English audio such as "GER-ENG", then 🇬🇧 flags that
  subtitles don't explain, then unlabelled DUAL/MULTI releases) and is
  sent to Core as `audioLanguage`. Core plays that track, or falls back to
  the default track (never the English preference) when the file lacks it.
  In dub mode, a ready file without English is held back while the other
  sources race. It only plays, with a notice, if none of them has English,
  and it is never remembered as that episode's source. MP4s whose chosen
  track is not the first audio track are remuxed. The player's settings
  menu switches audio: the same file restarts when it has both tracks,
  otherwise sources are re-ranked and raced from the current position.
- Foreign-script titles (Cyrillic, CJK, …) and Russian voice-over studios
  are dubs for other-language originals unless the release says it carries
  the original track; Chinese burned-in caption markers (中英双字 …) are
  hardsubs. A 🇬🇧 flag beside other flags proves nothing.

- Featured heroes rotate across eligible catalog titles (last decade only),
  using recent history shared across Home, Movies, and TV. Each page holds
  its choice for several hours across refreshes; never revert to always
  taking item zero.
