# Cubo rqbit extensions

Based on the published `librqbit` 9.0.1 crate from
https://github.com/ikatson/rqbit (Apache-2.0). The original crate sources
remain under that license.

Cubo exposes each managed torrent's verified piece bitfield for the player's
download bar and can persist that bitfield by info hash without restoring the
whole rqbit session. On restart, Cubo re-adds saved torrent metadata and rqbit
checks representative pieces before trusting the saved bitfield. Deleting a
torrent's files also removes its bitfield.

When upgrading rqbit, port these extensions and run the workspace tests and
the local-swarm playback soak (`just soak`).
