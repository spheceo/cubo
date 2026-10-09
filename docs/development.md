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
`source_starved`, `playback_stall`, …). To reproduce without touching the
real cache, run a dev Core with `HOME` pointed at a scratch directory (it
takes the next free port after 8765) and copy the relevant
`torrent-meta/<hash>.torrent` files into it.
