# Cubo Player (native, macOS)

`crates/cubo-player` — a native player for Cubo Core sources, built as
`Cubo Player.app` (`just player-app` → `target/player`). Mac-only for now;
the window (winit), rendering (wgpu → Metal) and audio (cpal → CoreAudio)
were chosen so Linux can follow without a rewrite.

## Why it exists

The browser path converts what Chrome cannot play (interlaced video, most
MKV audio) on the Core and streams it as HLS, and Chrome keeps at most
~150 MB of media in memory. On a slow link to another device the converted
stream can need as much bandwidth as the link has, and the browser never
gets more than a segment ahead (The Celebrity Traitors over a 10 Mbps
Tailscale link, 2026-11-06). Cubo Player instead:

- asks Core for a **`native` session**: Core serves the original file as
  it is (`Mode::Direct`, `/v1/sessions/{id}/stream`), never remuxes or
  re-encodes it, and still keeps the torrent live from heartbeats;
- **caches the file ahead as fast as the link allows** in a sparse file
  (`cache.rs`), limited only by disk, so quiet scenes bank time for busy
  ones;
- **decodes on the viewing Mac**: ffmpeg sidecars (run, never linked —
  see [security.md](security.md)) with VideoToolbox where the hardware
  takes the stream and software otherwise; interlaced video is
  deinterlaced (yadif) locally.

## Pieces

- `core.rs` — Core API: token, `native` session, heartbeats, progress,
  close.
- `cache.rs` — ranged downloads from the first missing 1 MiB chunk at the
  readers' focus. A read of a chunk the downloader is not heading for
  moves the focus (seeks, the decoder reading the MKV index at the end);
  a running request notices within 64 KB.
- `server.rs` — loopback HTTP that serves the cache to ffmpeg with Range
  support; reads block until bytes arrive.
- `decode.rs` — ffprobe, then one ffmpeg for video (NV12, constant frame
  rate, accurate seek) and one for audio (f32 stereo at the device rate).
  Frame `n` is at `start + n / fps`, audio at `start + samples / rate`.
- `audio.rs` — CoreAudio output and the playback clock (samples the
  device consumed). When audio runs dry the clock stops with it.
- `player.rs` — buffering/playing/paused, stall accounting, frame choice.
- `render.rs` — YUV → RGB (BT.709, BT.601 below 720p) in a shader,
  letterboxing, the progress bar with the cached span.
- `launch.rs` — `cubo-player://play?…` links (macOS delivers them as a
  `GetURL` Apple event) and their parsing.
- `bench.rs` — `--bench-seconds/--bench-out` writes the same JSON as
  `scripts/bench/browser-run.ts`, so the two clients compare directly.

## Web app handoff

Core advertises `nativePlayer: true` in `/v1/health`. On a Mac desktop the
web player shows a "Play in Cubo Player" button next to Episodes; it saves
progress, opens the link (Core address and token, magnet, file index,
position, audio language, and the library entry as base64url JSON) and
leaves the player. Cubo Player opens its own native session at that
position, sends heartbeats every 5 s and saves progress every 10 s in the
web player's `PlaybackUpdate` shape, and closes the session on exit.

## Controls

Space or click: pause. ←/→: 10 s. ↓/↑: 60 s. F or double-click:
full screen. Esc leaves full screen, then quits. Click the bar to seek.

## Open work

- Subtitles, audio-track switching, intro/recap skips, next episode.
- HDR is converted to 8-bit NV12 without tone mapping.
- The cache is unbounded (the whole file at most) and removed on exit.
