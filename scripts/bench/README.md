# Playback benchmarks (browser path vs. Cubo Player)

Measures playback of one fixed, fully downloaded episode over a throttled
link, so the browser path (Core re-encodes 1080i → H.264 HLS) and the native
player (plays the original file) can be compared on the same numbers.

Test file: *The Celebrity Traitors* S02E10 (`tv:291431:2:10`),
`The.Celebrity.Traitors.S02E10.Finale.1080p.HDTV.H264-DARKFLiX[EZTVx.to].mkv`,
2 886 258 924 bytes, 4650 s, interlaced H.264 + AC-3, info hash
`83b1ef08bdbacfb458121c677a63c95d788d250a`, file index 0. Runs start at 2500 s.

Nothing here touches the installed Core (8765) or `~/.local/share/cubo`
beyond reading it.

## Pieces

| File | What |
| --- | --- |
| `throttle-proxy.ts` | HTTP forward proxy on `127.0.0.1:8791` (absolute-form + CONNECT). One shared token bucket per direction, default 10 Mbit/s down and up, 64 KB burst. `GET /__stats` → `{bytesDown, bytesUp, byTarget, …}`, `POST /__reset`. |
| `setup-core.sh` | Worktrees + builds of the two benchmark Cores, the scratch HOME, the web build. |
| `start-core.sh` | Starts/stops a benchmark Core on 8764 with `HOME=<scratch>/home`. |
| `serve-web.ts` | Serves the built web app on `127.0.0.1:4200` (the origin a debug Core proxies its UI from). |
| `browser-run.ts` | Headless Chrome over raw CDP: plays the episode, samples, writes the result JSON. |
| `run-browser.sh` | One run end to end (proxy, web, fresh Core, run, stop Core). |

Scratch dir (`BENCH_DIR`, default
`/private/tmp/claude-501/-Users-siphesihlembuyisa-Documents-code-cubo/c9835802-cc92-4cde-9634-eb4bf9197f51/scratchpad/bench`):

```
wt-before/  wt-after/          git worktrees (v0.0.41; HEAD + working-tree Core diff)
target/                        shared cargo target dir
bin/{before,after}/            cubo (built cubo-cli) + ffmpeg/ffprobe (APFS clones of ~/.local/bin sidecars)
home/.local/share/cubo/        scratch Cubo data dir (below)
web-dist/                      vite build of apps/web
chrome/<label>-<ts>/           fresh Chrome profile per run
results/<label>.json           shared-schema result (+ <label>.extra.json diagnostics)
```

## Setup

```sh
scripts/bench/setup-core.sh          # worktrees, both Core builds, scratch HOME, web build
scripts/bench/setup-core.sh home     # just reset the scratch HOME
```

### Benchmark Cores

- `before` = tag `v0.0.41` (fixed 8 Mbps re-encode).
- `after` = HEAD (`v0.0.42`, re-encode follows the source bitrate, ~5 Mbps
  here) plus `git diff HEAD -- crates/cubo-engine crates/cubo-cli` from the
  working tree at setup time (the `native` session flag). Built from a
  worktree so in-progress edits (e.g. `crates/cubo-player`) cannot break it
  and the main tree's `Cargo.lock`/`target` are never touched.
- Built as `dev` profile with `CARGO_PROFILE_DEV_OPT_LEVEL=3
  CARGO_PROFILE_DEV_DEBUG=0`: `debug_assertions` stays on (that is what puts
  Core on the dev slot 8764 and makes it proxy its UI from :4200), but the
  code is optimised like a release so Core CPU is comparable.
- ffmpeg/ffprobe next to the binary are clones of the installed release's
  pinned sidecars (Core looks next to its executable first).

To rebuild `after` from the working tree as it is now (the patch is taken
when the worktree is created):

```sh
git worktree remove --force "$BENCH_DIR/wt-after" && scripts/bench/setup-core.sh build
```

(`--locked` fails if the working tree's Core changes need new crates; drop
it in `setup-core.sh` then.)

### Scratch HOME layout (what Core needs to reuse the file)

`paths::data_dir()` is `$HOME/.local/share/cubo`; `cubo serve` uses
`<data>/downloads` as the rqbit output folder, `cubo-state.json` next to it
is the store/cache index, `piece-state/` the rqbit bitfield folder,
`torrent-meta/` the saved metadata (`session.rs`: `sessions_dir.with_file_name("torrent-meta")`).

```
home/.local/share/cubo/
  downloads/<FILE>                  cp -c clone of the real file (no extra disk)
  downloads/.cubo-cache             cache-claim marker
  torrent-meta/<hash>.torrent       copied: session resolve adds the torrent from disk, never the swarm
  piece-state/<hash>.bitv           copied: rqbit spot-checks it instead of hashing 2.7 GB
  cubo-state.json                   one cacheEntries item for the file (so it is tracked, never reclaimed)
```

A session resolves in milliseconds with
`downloadedBytesAtReady = 2886258924`, `peers = 0`, `finished = true`
(`reused=false lookup_ms=1` on the first session after start). rqbit still
announces the torrent to its trackers/DHT like any Core would; no data is
needed from peers.

## Running

```sh
# (a) proxy (both directions 10 Mbit/s)
bun scripts/bench/throttle-proxy.ts --mbps 10
# (b) a benchmark Core on 8764 (foreground; or `... after --background`, stop with `... stop`)
scripts/bench/start-core.sh after
# web app for the debug Core's UI proxy
bun scripts/bench/serve-web.ts "$BENCH_DIR/web-dist"
# (c) a browser run (300 s from session creation)
bun scripts/bench/browser-run.ts --label browser-after --wall 300
```

or all of it, with a fresh Core per run:

```sh
scripts/bench/run-browser.sh before    # results/browser-before.json
scripts/bench/run-browser.sh after     # results/browser-after.json
```

Run on an otherwise idle machine: the re-encode shares the CPU with
whatever else runs (a parallel `cargo build` at load ~140 made the first
segment take 23 s instead of ~3 s). `browser-run.ts` warns when the 1-minute
load average is above 4 and records it at start and end in the extra JSON.

`WALL`, `MBPS` (only used when run-browser.sh starts the proxy itself) and
`LABEL` override the defaults, e.g. a run on a slower link:

```sh
bun scripts/bench/throttle-proxy.ts --mbps 8.9 &
LABEL=browser-after-8.9mbps scripts/bench/run-browser.sh after
```

### How the browser run works

- Chrome: `--headless=new`, fresh `--user-data-dir`,
  `--proxy-server=http://127.0.0.1:8791 --proxy-bypass-list=<-loopback>`
  (loopback is proxied too), `--autoplay-policy=no-user-gesture-required`,
  `--mute-audio`, background features off (optimization-guide model
  downloads, media keys / Now Playing, translate, media router).
- The proxy refuses `*.googleapis.com`, `*.google.com`, `*.gstatic.com` by
  default (`--deny`): an early run lost 41 MB of the link to Chrome
  downloading an optimization-guide model mid-playback. TMDB images and the
  app's GitHub update check still go through, as they would for a viewer.
- The page is opened at the Core's own origin,
  `http://127.0.0.1:8764/watch/tv/291431?season=2&episode=10`. A debug Core
  proxies non-API paths to :4200 (`serve-web.ts`), and a Core-served page
  talks only to that Core — like the installed Core serving its embedded
  dist to the other Mac. (A page on :4200 would probe 8764 *and* fall back
  to the real Core on 8765.)
- Before the app loads, an injected script seeds `localStorage`: the
  remembered source (`cubo.sources.v1`, the file above as a 1080p Torrentio
  stream) and the playhead (`cubo.playhead`, 2500 s). Core's progress is
  seeded too (`POST /v1/library/progress`). `*/api/torrentio/*` is blocked
  via CDP, so the remembered source is the only candidate: no other torrent
  is raced, nothing touches a swarm.
- The same script watches the `<video>`: every 100 ms it tracks
  `currentTime`; a **stall** is time not advancing while not paused/seeking
  after playback first advanced (250 ms minimum, like the app's
  `playback_stall`). `waiting`/`playing` events are recorded with it.
  Stalls line up with the app's own `playback_stall` events in the scratch
  Core's log (same positions, durations within ~80 ms).
- A pause from outside the page (macOS Now Playing / media keys reach
  headless Chrome too — one run was paused at 2740 s and never resumed) is
  recorded in `.extra.json` → `external_pauses` and resumed after 1 s; it
  is not a stall.
- The driver polls the page every 500 ms, and every 1 s samples the proxy
  (`__stats` delta → link Mbps), Core CPU (Core + ffmpeg children, from
  cumulative `ps` CPU time) and Chrome CPU (the spawned Chrome and all its
  helpers).
- `startup_ms` = from the page's `POST /v1/sessions` (CDP wall time) to the
  first `currentTime` advance. The wall window (`--wall`, default 300 s)
  also starts at that POST, so a native run can use the same t0.
- `bytes_down` = everything the proxy carried downstream from just before
  navigation to the end (web app shell, TMDB images and the media; the
  per-target split is in `.extra.json` → `proxy_by_target`).
- `.extra.json` adds: navigation→session and navigation→first-frame, every
  HLS segment fetch (start, ms, bytes), Core's `readyAheadSeconds` per
  second, the Chrome media pipeline properties (decoder name, platform
  decoder), VTDecoder/VTEncoder service CPU, every 500 ms video sample.

## Result schema (shared with the native player)

```
{ "label", "client": "browser"|"native", "core_version", "link_mbps",
  "wall_seconds", "start_position", "startup_ms", "stall_count", "stall_ms_total",
  "stalls": [{ "at_position", "started_at_s", "ms" }],
  "played_seconds", "bytes_down", "core_cpu_avg", "client_cpu_avg",
  "timeline": [{ "t", "position", "buffer_ahead_s", "link_mbps", "core_cpu", "client_cpu", "stalled" }] }
```

CPU values are percent of one core. `t`/`started_at_s` are seconds since
session creation.

## Native player against the same Core

Start the `after` Core and the proxy as above, then point Cubo Player at
`http://127.0.0.1:8764` through `http://127.0.0.1:8791` (reqwest
`Proxy::all`). Session body:

```json
POST http://127.0.0.1:8764/v1/sessions
Authorization: Bearer <sessionToken from GET /v1/health>
{ "magnet": "magnet:?xt=urn:btih:83b1ef08bdbacfb458121c677a63c95d788d250a",
  "mediaKey": "tv:291431:2:10", "title": "The Celebrity Traitors",
  "fileIndex": 0, "resumeSeconds": 2500, "native": true }
```

Restart the Core between runs (`start-core.sh stop`, then start again) so
every run starts with the torrent not yet managed, like the browser runs.

## Results (2026-11-06, M1 8 GB, 300 s from 2500 s)

| label | link | startup ms | stalls | stall ms | played s | bytes down | seg avg | buffer ahead @60/120/300 s | Core CPU | Chrome CPU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| browser-before (v0.0.41) | 10 | 14141 | 0 | 0 | 286.0 | 356.7 MB | 9.92 MB (7.9 Mbps) | 13.9 / 25.2 / 55.0 | 215% | 24% |
| browser-before, 2nd run (load rose to 73) | 10 | 9555 | 0 | 0 | 290.7 | 360.4 MB | 9.96 MB | 20.4 / 30.4 / 61.6 | 191% | 25% |
| browser-after (v0.0.42+wt) | 10 | 10421 | 0 | 0 | 289.8 | 228.0 MB | 6.28 MB (5.0 Mbps) | 51.3 / 61.1 / 62.4 | 221% | 20% |
| browser-before-8.9mbps | 8.9 | 12531 | 0 | 0 | 287.6 | 330.6 MB | 9.91 MB | 12.2 / 12.8 / 34.5 | 169% | 19% |
| browser-after-8.9mbps | 8.9 | 8795 | 0 | 0 | 291.2 | 228.6 MB | 6.28 MB | 38.6 / 59.3 / 60.6 | 161% | 16% |

- Through a clean token bucket, v0.0.41's ~8 Mbps stream (segments up to
  9.8 Mbps) fits a 10 Mbps — and an 8.9 Mbps — link without stalls, but
  only just: the buffer grows ~0.1–0.2 s per second and was 2–10 s ahead for
  the first 30 s. Any competing traffic tips it over: the first `before`
  run, which lost 41 MB to a Chrome background download mid-run, stalled
  5 times (8.6 s), each matching an app `playback_stall` event. v0.0.42
  reaches hls.js's 60 s goal within a minute and then idles the link.
- Startup (~9–14 s) is one whole 10 s segment: Core encodes segment 250
  (~3 s idle, far longer under load), then it crosses the link (5.7–8.6 MB).
- Core CPU ~160–220% (Core + ffmpeg: software H.264 decode + deinterlace +
  VideoToolbox encode) is noisy: other builds ran on the machine during
  most runs (`load_average_*` in the extra JSON).
