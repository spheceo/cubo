# Cache and storage

- Recorded file paths are the source of truth after a restart, when rqbit's
  torrent IDs change. Reject paths with `..` (they come from untrusted
  torrent metadata); deleting a torrent's files also removes its saved
  piece bitfield.
- Maintenance never removes an open session's file (failed ones too: the
  player recovers on the same source) or a root still recorded in the
  cache index.
- Eviction goes least recently used first, with titles the viewer is
  part-way through (in history, started, under 95%, watched in the last
  30 days, matched on the cache entry's media key) last. While Cubo is
  within its own budget, a tight disk filled by something else does not
  evict those unless the volume is critical (512 MiB): on 2026-10-21 it
  took a pack the viewer was 72% into and the resume took two minutes.
- A nearly full disk pauses every torrent and fails only sessions that
  still need to download. A session whose file is complete plays on from
  the paused torrent. Failing it let eviction delete the very season pack
  being watched.
- Only playback sessions and prefetch warm-ups may transfer; cached
  torrents pause when idle. Prefetched and never-played torrents stay
  parked (see [playback.md](playback.md)).
- rqbit answers deleting a torrent it does not manage with a 500, not a
  404. `rqbit_delete` checks the torrent is unknown before treating that as
  done; otherwise pre-restart cache entries can never be evicted and the
  budget falls on the title just watched.
