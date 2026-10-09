# Cache and storage

- Recorded file paths are the source of truth after a restart, when rqbit's
  torrent IDs change. Reject paths with `..` (they come from untrusted
  torrent metadata); deleting a torrent's files also removes its saved
  piece bitfield.
- Maintenance never removes a live session's file or a root still recorded
  in the cache index.
- Only playback sessions and prefetch warm-ups may transfer; cached
  torrents pause when idle. Prefetched and never-played torrents stay
  parked (see [playback.md](playback.md)).
- rqbit answers deleting a torrent it does not manage with a 500, not a
  404. `rqbit_delete` checks the torrent is unknown before treating that as
  done; otherwise pre-restart cache entries can never be evicted and the
  budget falls on the title just watched.
