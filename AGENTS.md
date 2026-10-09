# Cubo — agent notes

Detailed rules live in [`docs/`](docs/README.md). Read the doc for the area
you are touching before changing it.

## Hard rules

- **Playback pipeline is working — do not casually change it.** Core-owned
  sessions (`/v1/sessions`) are the only playback path; do not refactor or
  replace it without a strong reason and maintainer approval.
  → [docs/playback.md](docs/playback.md)
- **Security model — do not weaken.** Pairing is implemented but switched
  off (`pairing::PAIRING_ENABLED = false`); never expose the session token
  through an unauthenticated response, keep proxies allowlisted and ffmpeg
  pinned. → [docs/security.md](docs/security.md)
- Custom UI over native controls (`ConfirmDialog`, `Dropdown`), no new color
  tokens without approval, no scroll-hijacking.
  → [docs/player-and-library.md](docs/player-and-library.md)

## Docs

| Doc | Covers |
| --- | --- |
| [playback.md](docs/playback.md) | Pipeline invariants, source racing, prefetch, swarm/peers, decode fallback and re-encoding, downloaded bar, previews, open work |
| [sources-and-audio.md](docs/sources-and-audio.md) | Source affinity, eligibility filters, original vs. English dub |
| [player-and-library.md](docs/player-and-library.md) | Progress/resume rules, intro/recap/preview skips, player controls, UI conventions, library and browsing |
| [storage.md](docs/storage.md) | Cache deletion and eviction, rqbit quirks |
| [security.md](docs/security.md) | Tokens, pairing, CORS, proxy allowlists, ffmpeg pinning |
| [releases.md](docs/releases.md) | Release ritual, ffmpeg sidecars, CLI targets |
| [development.md](docs/development.md) | Repo map, `just` recipes, verification, debugging production playback |

## Commands

- `just dev` — run Cubo Core; `just web` — Vite app on :4200
- `just typecheck`, `just build`, `just check`, `just test`
- `bun test` in `apps/web`; `just soak` after touching sessions, the
  remuxer, or rqbit

When you add or change a behavior rule, put it in the matching doc, not
here.
