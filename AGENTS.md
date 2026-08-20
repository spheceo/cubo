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
   is `timeOffset` seconds into the source; every displayed/reported/sought
   position adds it back. Progress records must always store absolute
   positions and the full source duration (the `durationHint` from ffprobe),
   never the partial growing-playlist duration.
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

## Repo map

- `apps/web` — Vite + React 19 frontend (TanStack Query cache, lazy routes,
  native scrolling — Lenis was removed on purpose, do not reintroduce
  scroll-hijacking).
- `apps/desktop/src-tauri` — "Cubo Core": Tauri shell, axum bridge on port
  8765, rqbit torrent engine, ffmpeg remux pipeline (`transcode.rs`).
- `packages/core` — shared TypeScript types + TMDB/Torrentio client.
- `packages/ui` — shared presentational components and theme tokens.

## Verification commands

- `pnpm --filter @cubo/web typecheck` and `pnpm --filter @cubo/web build`
- `cargo check` and `cargo test` in `apps/desktop/src-tauri`

## Conventions

- Custom UI over native controls: use `ConfirmDialog` and `Dropdown` from
  `apps/web/components` instead of `window.confirm` / `<select>`.
- No new color tokens without approval; reuse the theme in
  `packages/ui/src/theme.css`.
