# cubo

Stremio-style media discovery and torrent-streaming app.

```
cubo/
├── apps/
│   ├── web          # Next.js (TMDB / Torrentio proxies)
│   └── desktop      # Vite + Tauri desktop client
└── packages/
    ├── core         # Shared client, types, image helpers
    └── ui           # Shared UI
```

## Setup

1. `pnpm install`
2. Copy `.env.example` and add a TMDB key to `apps/web/.env.local`
3. `pnpm dev:web` or `pnpm dev:desktop`

The torrent engine in `apps/desktop/src-tauri` is the next milestone.
