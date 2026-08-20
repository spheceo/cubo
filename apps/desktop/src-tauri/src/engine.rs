use serde_json::json;

// TODO: rqbit is the chosen torrent engine. Plan: resolve magnet/infoHash, then
// serve an HTTP byte-stream on 127.0.0.1 for the player.

pub fn status() -> serde_json::Value {
    json!({
        "state": "idle",
        "engine": null,
        "note": "rqbit integration pending"
    })
}
