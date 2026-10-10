# Playback pipeline

Status: **working — do not casually change.** Core-owned playback sessions
(`/v1/sessions`) are the only playback path. The streaming, rendering, and
playback fixes remain load-bearing; do not refactor or replace this path
without a strong reason and maintainer approval.

## Invariants

1. **Direct-play first.** MP4/WebM rank above remux-needing sources within a
   quality tier (`apps/web/lib/stream-select.ts`). Core decides the mode after
   probing the chosen file.
2. **Remux through hls.js.** Core serves a complete VOD HLS playlist in
   absolute movie time. `video-player.tsx` uses hls.js, including on Safari;
   the player and progress store use full-source absolute seconds.
3. **Seek on the file's own timeline.** MKV keyframes and fMP4 fragments are
   mapped to fixed VOD segments (`mkv_index.rs`, `segment_plan.rs`,
   `remuxer.rs`). Every segment URL always names the same movie interval, so
   seeks and old playlist polls cannot splice different remux jobs together.
4. **Core owns the live file.** Sessions keep the torrent and selected file
   alive, pace conversion from heartbeats, and protect it from cache eviction.
   Closed sessions and failed race candidates release that protection.
5. **Probe and metadata reuse.** A known torrent is reused in rqbit, otherwise
   its saved `.torrent` metadata is loaded from disk. Prefetch and playback
   share probes. Do not re-resolve known magnets from the swarm or serialize
   probe work behind buffer waits.
6. **Resume and fallback.** Intentional seeks persist before async work.
   `raceSessions` gives the top source a head start, launches backups when it
   is not downloading, plays the first ready one, and closes the rest. A
   failed active source advances down the ranked list at the last position;
   healthy sessions recover on the same source.
7. **Cache deletion.** See [storage.md](storage.md).
8. **Downloaded bar.** Core maps verified pieces to movie time using the
   MP4/MKV index. The player draws the contiguous watchable span from the
   playhead, never the browser's constant-bitrate guess for direct MP4.

## Starting a session

- Session starts race sources (`raceSessions` in `watch-screen.tsx`): the
  top pick runs alone for a few seconds, backups join while nothing is
  visibly downloading, the first ready plays and the rest are closed. Never
  go back to one-at-a-time attempts behind Core's resolve timeout.
- Core never re-resolves a known source from the swarm: a torrent rqbit
  already manages is reused, otherwise saved metadata
  (`<data>/torrent-meta/<hash>.torrent`) is added from disk. rqbit resolves
  magnet metadata from peers *before* checking what it manages, so passing
  a magnet for a known torrent can hang on a fully downloaded file.
- `POST /v1/prefetch` warms the next episode (last 12 minutes of the
  current one) and the title page's play target: metadata, header, probe.
  It then parks the torrent (kept paused by maintenance until a session
  plays it); sources that close without ever serving media are parked too,
  so guesses and race losers never download whole files.
- A closed session pauses its torrent only after a grace period with no
  live session on it: recovery and audio switches open a replacement on
  the same torrent, and an immediate pause drops every peer.

## Swarm

- Core listens for incoming peers (TCP + uTP on 48765, falling back to a
  free port) with UPnP. Without a listener, seeders behind NAT never reach
  Core and the same swarm streams far slower than in other clients.
- A source alive but too slow is a failure: when the loading overlay has
  been up for 20 s and the torrent downloads below the file's own byte rate
  (size / duration), an automatic session fails over to the next ranked
  source at the same position (`checkStarved` in `watch-screen.tsx`). Only
  measured throughput decides, never seeders, and only while an untried
  source remains; a manually picked source is never switched.

## Player buffer

hls.js budgets its buffer in seconds, but browsers cap a SourceBuffer in
bytes (Chrome: 150 MB of video). At 4K bitrates a fixed 60 s ahead plus
90 s behind overflows the cap. Each refused append makes hls.js halve its
buffer goal, and it never raises it again. After a few, it buffers ~4 s
and the loader flashes at every segment of a fully downloaded file. So
`fitBufferToBitrate` (`lib/session-hls-config.ts`) sizes the goals from
the measured byte rate of recent fragments (90 MB ahead, 30 MB behind). A
refused append shrinks that byte budget instead, and the goal never drops
below 12 s ahead. Don't go back to fixed second-based goals.

## Decode failures and re-encoding

Some files carry video the browser cannot decode although the codec is
supported (Apple's hardware decoder rejects frames in BBC 50 fps WEB-DLs;
interlaced HDTV captures never decode). A decode error (video element
`MEDIA_ERR_DECODE` or a fatal hls.js media error) restarts the same source
with `transcodeVideo`, which Core re-encodes to H.264 (`h264_videotoolbox`
on macOS, libx264 elsewhere), and the source is remembered
(`decode-fallback.ts`) so later visits re-encode at once. Interlaced sources
always re-encode, deinterlaced. Re-encodes use `-force_key_frames source`,
no B-frames, so segments keep the plan. Restarting such a file unchanged
only loops; never treat it as healthy.

## Downloaded bar

The player's grey "downloaded" bar comes from Core (heartbeat
`availableRanges`): torrent pieces on disk mapped to movie time through the
file's own index (MP4 sample tables, MKV cues). Don't go back to
`video.buffered` for sessions: for direct MP4s the browser places bytes as
if the bitrate were constant, minutes away from the playhead. The bar draws
only the watchable span from the playhead to the first missing piece
(`lib/download-bar.ts`); raw torrent ranges are islands.

## Previews

Preview startup uses already-buffered footage where a full clip fits,
otherwise an early scene past the opening titles (roughly 3–7 minutes for
typical episodes/movies). Do not restore a random seek halfway through a
cold torrent or make a loader animation delay media attachment.

## What tests do and don't prove

Command-line tests cover ordering and selection; they do not establish real
first-frame latency, browser seek behavior, or actual audio language. Cold
startup still depends on peer availability. A/V sync, playlist mapping, and
segment-cache behavior remain load-bearing. `just soak` runs a real Core
against a local swarm with a virtual player (see `soak_tests.rs`).

## Open work

- **Subtitle timing:** session playlists use absolute movie time. Remaining
  validation: compare cues against audio on real remuxed sources with
  unusual keyframe intervals.
