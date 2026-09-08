# cubo

Cubo is a local media app. The `cubo` CLI is the engine **and** the web UI:
a release binary serves the Vite app on port `8765`. Catalog metadata (TMDB)
goes through a small Cloudflare Worker so the API key never lives in the
binary. Torrentio, subtitles, torrents, and remux stay on your machine.

```text
Browser  →  http://127.0.0.1:8765  (embedded UI + /v1 + /api)
                ├── /api/tmdb/*     → catalog Worker → TMDB
                ├── /api/torrentio, /api/subtitles  → upstream directly
                └── /v1/*           → torrents, remux, library
```

Core prefers port `8765`. If that port is already taken (for example by
`cubo persist`), a foreground `cubo serve` / `just dev` binds the next free
port instead of stopping the other process. Playback needs a per-launch
session token (or a paired device token). The raw rqbit API remains on a
separate ephemeral loopback port.

At startup, Core binds `127.0.0.1:8765` and automatically detects the
machine's Tailscale IPv4 address using `tailscale ip -4`. When Tailscale is
available, it also binds port `8765` on that address without exposing the
service on ordinary LAN interfaces.

Opening `http://127.0.0.1:8765`, a Tailscale IP, or a Tailscale Serve URL
loads the UI from Core. Debug builds (`just dev`) still proxy the Vite
server at `http://127.0.0.1:4200` for hot reload.

## Remote Core over Tailscale

The web app's **Core settings** accepts a full remote Core URL and stores it
in that browser. Leave it empty for automatic on-device discovery.

The preferred Tailscale setup keeps Cubo bound to loopback and uses Tailscale
Serve as an HTTPS reverse proxy:

```sh
tailscale serve --bg http://127.0.0.1:8765
```

Then open that HTTPS URL on any device in the tailnet.

## Setup

1. Install [just](https://just.systems) and [bun](https://bun.sh), then run `bun install`.
2. Add `TMDB_API_KEY` to `apps/web/.env.local` (Vite dev catalog only).
3. Run `just dev` to start Cubo Core (port 8765, or the next free port) and `just web` for the UI.

Useful commands:

- `just` lists recipes.
- `just dev` runs Cubo Core on port 8765, or the next free port if persist already owns it.
- `just web` starts the app at `http://localhost:4200`.
- `just site` starts the marketing site at `http://localhost:4300`.
- `just apps` runs the app and marketing site together.
- `just typecheck` checks the TypeScript packages.
- `just build` builds the web app and marketing site.
- `just check` / `just test` compile and test the Rust workspace.

A release build embeds `apps/web/dist`. Run `just build` (or
`bun --filter @cubo/web build`) before `cargo build --release`.

Override the catalog Worker with `CUBO_CATALOG_URL`, or skip it entirely
with a personal `TMDB_API_KEY` in the environment.

## Marketing site

The standalone site at [cubo.spheceo.com](https://cubo.spheceo.com) is
`apps/site` (Vercel project `cubo-site`). It has no workspace dependencies
so it deploys in isolation.

Connecting to a loopback, LAN, or Tailscale IP may trigger the browser's
Local Network Access permission. An HTTPS Tailscale Serve URL avoids mixed
content restrictions. Torrent traffic and video bytes stay between the Core
device and the viewing device.
