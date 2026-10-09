# Security model

Added 2026-08-21. **Do not weaken.**

## Pairing is currently switched off

Items 1–2 are implemented but **currently switched OFF** by
`pairing::PAIRING_ENABLED = false` (maintainer decision 2026-08-21, to be
re-enabled later). While off, `/v1/health` hands the session token to every
caller (pre-pairing behavior) and `/v1/pair` answers 404. Re-enabling is
that one constant — engine, CLI, tests, and the web app all follow the
server's signal automatically.

Known gap to solve when re-enabling: `tailscale serve` proxies requests to
Core FROM loopback, so its callers would look local and receive the session
token; the loopback check gates only direct :8765 connections.

## Rules

1. **The session token is loopback-only.** `/v1/health` includes
   `sessionToken` only when the TCP peer is loopback; remote callers get
   `pairingRequired: true`. Never expose the session token through any
   unauthenticated response again.
2. **Remote devices pair with offline authenticator codes**
   (`crates/cubo-engine/src/pairing.rs`): a secret in the data dir
   (`pairing.key`, 0600) derives rotating 6-digit codes (HMAC-SHA256, 60 s
   steps); `cubo pair` prints them, `POST /v1/pair` redeems one for a
   persistent device token (`paired-devices.json`). Attempts are throttled
   (5 failures/min). Streaming endpoints accept session or device tokens;
   the HLS playlist rewrite must echo the CALLER's token, never the session
   token.
3. **CORS is port-scoped.** Loopback/own-hostname origins are only trusted
   on ports 8765/4200 plus the port this Core actually bound; the
   Private-Network-Access header is only granted to origins passing the
   allowlist.
4. **Cache deletion refuses `..` components** in recorded file paths (they
   come from untrusted torrent metadata).
5. **Catalog and stream proxies are allowlisted**
   (`crates/cubo-engine/src/catalog.rs` and the Cloudflare Worker in
   `apps/catalog`): each route only forwards the exact request shapes the
   app makes. Add a pattern when the client grows a new endpoint, or it
   404s. The TMDB key lives on the Worker, never in the CLI. Vite still uses
   `apps/web/api/*.ts` for `just web`.
6. **ffmpeg sidecars are pinned + checksum-verified**
   (`scripts/fetch-ffmpeg.mjs`): exact upstream build URLs with recorded
   SHA-256 per file. To bump ffmpeg, update URL and hash together.
