# cubo

Cubo is one React app (Vite) that ships to three places: the browser via Vercel,
the desktop app via Tauri (bundled, works offline from Vercel), and the local
Core gateway. The same Vercel project hosts the static UI and the small
serverless API routes that hold the secrets (TMDB key, Torrentio proxy).

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
            └── Tauri + rqbit playback bridge
```

The Core starts automatically with Cubo Desktop and always uses port `8765`.
Startup fails clearly if that port is already occupied. It exposes a health
endpoint for browser discovery and requires a per-launch token for playback
operations. The raw rqbit API remains on a separate ephemeral loopback port and
is not exposed to the frontend.

At startup, Core binds `127.0.0.1:8765` and automatically detects the machine's
Tailscale IPv4 address using `tailscale ip -4`. When Tailscale is available, it
also binds port `8765` on that address without exposing the service on ordinary
LAN interfaces.

Opening `http://127.0.0.1:8765`, a directly bound Tailscale IP such as
`http://100.64.0.10:8765`, or a Tailscale Serve HTTPS hostname loads the Cubo
web interface through the Core, which reverse-proxies the web deployment (the
local Vite server at `http://127.0.0.1:3000` in development, the
`WEB_DEPLOYMENT_URL` constant in release builds). The interface detects that it
is Core-hosted and connects playback to that device automatically. The desktop
app itself never needs this, because production builds bundle the UI from
`apps/web/dist`.

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

1. Run `pnpm install`.
2. Add `TMDB_API_KEY` to `apps/web/.env.local`.
3. Run `pnpm dev` to start the Vite dev server and Tauri together.

The Vite dev server also serves the `api/` functions locally, so the Vercel
CLI is not needed for development.

Useful commands:

- `pnpm dev:web` starts only the website at `http://localhost:3000`.
- `pnpm dev:desktop` starts Tauri, which also starts the website automatically.
- `pnpm typecheck` checks the TypeScript packages and Rust core.
- `pnpm build` builds the web app and desktop bundle.

## Deploying to Vercel

Import the repo into Vercel with the root directory set to `apps/web`. The
framework preset is Vite; `vercel.json` rewrites non-API routes to
`index.html` for client-side routing. Set `TMDB_API_KEY` in the project's
environment variables — the functions in `apps/web/api/` pick it up.

## Production builds

Desktop builds bundle the UI, so the app always has its interface. The only
configuration is the canonical deployment URL, hardcoded in two places (change
both if the deployment ever moves from `https://app.cubo.spheceo.com`):

- `DEPLOYED_SITE_URL` in `apps/web/lib/api.ts` — where the bundled desktop UI
  sends API requests, since its `tauri://localhost` origin has no functions.
- `WEB_DEPLOYMENT_URL` in `apps/desktop/src-tauri/src/engine.rs` — the
  deployment Core proxies for the browser gateway on port `8765`, and the web
  origin it trusts for cross-origin playback requests.

Then just run `pnpm build`.

Connecting to a direct loopback, LAN, or Tailscale IP may trigger the browser's
Local Network Access permission. An HTTPS Tailscale Serve URL avoids mixed
content restrictions and is the most reliable option for the Vercel-hosted
frontend. Torrent traffic and video bytes still flow directly between the Core
device and the viewing device rather than through Vercel.
