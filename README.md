# cubo

Cubo is one React app (Vite) that ships to the browser via Vercel and through
the local Core gateway. The same Vercel project hosts the static UI and the
small serverless API routes that hold the secrets (TMDB key, Torrentio proxy).

```text
Vercel project (apps/web)
├── static React UI (vite build → dist/)
└── serverless functions (apps/web/api/)
    ├── /api/tmdb/*        (holds TMDB_API_KEY)
    ├── /api/torrentio/*
    └── /api/subtitles/*, /api/subtitle-file
        │
        ├── automatic: http://127.0.0.1:8765
        └── configured: https://media.example-tailnet.ts.net
            └── Cubo Core (CLI) + rqbit playback bridge
```

Core is the `cubo` CLI (`cubo persist` or `cubo serve`) and always uses port
`8765`. Startup fails clearly if that port is already occupied. It exposes a
health endpoint for browser discovery and requires a per-launch token for
playback operations. The raw rqbit API remains on a separate ephemeral
loopback port and is not exposed to the frontend.

At startup, Core binds `127.0.0.1:8765` and automatically detects the machine's
Tailscale IPv4 address using `tailscale ip -4`. When Tailscale is available, it
also binds port `8765` on that address without exposing the service on ordinary
LAN interfaces.

Opening `http://127.0.0.1:8765`, a directly bound Tailscale IP such as
`http://100.64.0.10:8765`, or a Tailscale Serve HTTPS hostname loads the Cubo
web interface through the Core, which reverse-proxies the web deployment (the
local Vite server at `http://127.0.0.1:4200` in development, the
`WEB_DEPLOYMENT_URL` constant in release builds). The interface detects that it
is Core-hosted and connects playback to that device automatically.

## Remote Core over Tailscale

The web app's **Core settings** accepts a full remote Core URL and stores it in
that browser. Leave it empty for automatic on-device discovery.

The preferred Tailscale setup keeps Cubo bound to loopback and uses Tailscale
Serve as an HTTPS reverse proxy:

```sh
tailscale serve --bg http://127.0.0.1:8765
```

Tailscale prints an HTTPS URL such as
`https://media.example-tailnet.ts.net`. Enter that URL in Core settings on any
device in the tailnet, or open the URL directly to load the Core-connected Cubo
interface.

Direct Tailscale IP access is automatic when Tailscale is installed — Core
detects the address on its own. Then enter `http://100.64.0.10:8765` (with your
machine's Tailscale IP) in Core settings.

## Setup

1. Install [bun](https://bun.sh), then run `bun install`.
2. Add `TMDB_API_KEY` to `apps/web/.env.local`.
3. Run `bun dev` to start the Vite app and marketing site.

The Vite dev server also serves the `api/` functions locally, so the Vercel
CLI is not needed for development.

Useful commands:

- `bun dev` runs the app (4200) and the marketing site (4300).
- `bun dev:web` starts only the app at `http://localhost:4200`.
- `bun dev:site` starts the marketing site at `http://localhost:4300`.
- `bun dev:core` runs the engine via the CLI.
- `bun typecheck` checks the TypeScript packages and Rust core.
- `bun build` builds the web app and marketing site.

## Deploying to Vercel

Import the repo into Vercel with the root directory set to `apps/web`. The
framework preset is Vite; `vercel.json` rewrites non-API routes to
`index.html` for client-side routing. Set `TMDB_API_KEY` in the project's
environment variables — the functions in `apps/web/api/` pick it up.

## Production builds

The canonical web deployment URL is hardcoded in
`WEB_DEPLOYMENT_URL` in `crates/cubo-engine/src/engine.rs` — the origin Core
proxies for the browser gateway on port `8765`, and the origin it trusts for
cross-origin playback requests. Change that constant if the deployment moves
from `https://app.cubo.spheceo.com`.

Connecting to a direct loopback, LAN, or Tailscale IP may trigger the browser's
Local Network Access permission. An HTTPS Tailscale Serve URL avoids mixed
content restrictions and is the most reliable option for the Vercel-hosted
frontend. Torrent traffic and video bytes still flow directly between the Core
device and the viewing device rather than through Vercel.
