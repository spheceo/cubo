# Development

## Repo map

- `apps/web` — Vite + React 19 frontend (TanStack Query cache, lazy routes,
  native scrolling). Release Core embeds `dist`.
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
- `vendor/librqbit` — rqbit 9.0.1 with Cubo's piece-bitfield extensions
  (`CUBO-PATCH.md`). When upgrading rqbit, port them and run `just soak`.

## Core ports

Two fixed slots, chosen by the build — no port scanning:

- **8765** — release builds: the installed CLI and `cubo persist`.
- **8764** — debug builds: `just dev` (`cargo run -p cubo-cli`).

A Core whose slot is taken refuses to start and says which Core already
holds it, so there is never a third Core on a surprise port. The torrent
peer listener follows the same split (48765 / 48764, falling back to a free
port only if another app holds it). The Vite app on :4200 checks 8764 first
and falls back to 8765; it prefers the Core whose `webUrl` is the page
itself (debug builds advertise `http://127.0.0.1:4200`). Pages served by a
Core talk to that Core.

## Task runner

Use [just](https://just.systems) from the repo root (`Justfile`). `just`
lists recipes. `just dev` starts Cubo Core (`cargo run -p cubo-cli -- serve
--no-open`). Bun stays for installs and per-package Vite/tsc scripts.

## Verification

- `just typecheck` and `just build` (or `bun --filter @cubo/web typecheck` /
  `build`)
- `just check` and `just test` in the workspace root
- Web unit tests: `bun test` in `apps/web`
- `just soak` — playback soak against a local swarm (slow; run after
  touching sessions, the remuxer, or rqbit)

## Debugging production playback

The installed Core logs to `~/.local/share/cubo/logs/` (`cubo.log.<date>`
with timestamps; `boot-service.log` for `cubo persist`). The web app ships
its own events there (`stream_selected`, `session_error`, `source_failed`,
`source_starved`, `playback_stall`, `hls_buffer_error`, …).

Reading a stall:

- `playback_stall` carries Core's state as the stall began. A low
  `core_ready_ahead_seconds` means Core was behind (look for `segment
  request slow or failed` lines around it). A high
  `core_ready_ahead_seconds`, or `core_paused_ahead`, means Core was ahead
  and the problem was in the browser.
- It also carries the player's side: `player_ahead_seconds` buffered
  when the stall began, `buffer_goal_seconds`, `peak_mbps` and
  `refused_appends`. `hls_buffer_error` records each time the browser
  refused media (throttled).
- `playback_startup` records the browser. `playback session closed`
  says why it closed (`no heartbeat`, `page closed`, `source deleted`, …).
  Core also logs whether a source was deleted by the viewer or by cache
  eviction.

To reproduce without touching the
real cache, run a dev Core with `HOME` pointed at a scratch directory (it
uses the dev slot, 8764) and copy the relevant
`torrent-meta/<hash>.torrent` files into it.
