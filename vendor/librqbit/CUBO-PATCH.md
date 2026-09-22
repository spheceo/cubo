# Cubo rolling storage extension

Based on the published `librqbit` 9.0.1 crate from
https://github.com/ikatson/rqbit (Apache-2.0). The original crate sources
remain under that license. Cubo modifications are in the storage trait,
piece/chunk tracking, and torrent stream/scheduler code.

Cubo's storage reserves entire pieces before requesting bytes, reports
completed-piece eviction, and downloads only the window needed by readers.
The verified stream-read hook makes a missing piece recoverable without
exposing an incomplete replacement to the player. Pausing releases each
in-flight piece's reservation before the tracker is dismantled. Ordinary
filesystem storage retains its original behaviour through default trait
methods.

When upgrading rqbit, port these hooks and run Cubo's real local-peer test:

    cargo test -p cubo-engine rolling_cache_local_peer -- --ignored --nocapture

Also run the full workspace tests. Do not replace this fork with upstream
until equivalent bounded-storage support is available and verified.
