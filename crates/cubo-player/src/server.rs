//! A loopback HTTP server that hands the cache to the ffmpeg decoders.
//! ffmpeg seeks with Range requests; every read waits on the cache, so the
//! decoders simply block while the link catches up.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

use anyhow::Result;

use crate::cache::Cache;

pub fn serve(cache: Arc<Cache>, extension: &str) -> Result<String> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let url = format!("http://{}/media.{extension}", listener.local_addr()?);
    std::thread::Builder::new().name("media-server".into()).spawn(move || {
        for stream in listener.incoming().flatten() {
            let cache = Arc::clone(&cache);
            let _ = std::thread::Builder::new()
                .name("media-conn".into())
                .spawn(move || {
                    let _ = handle(stream, &cache);
                });
        }
    })?;
    Ok(url)
}

fn handle(stream: TcpStream, cache: &Cache) -> std::io::Result<()> {
    stream.set_nodelay(true)?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut range: Option<(u64, Option<u64>)> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("range:") {
            range = parse_range(value.trim());
        }
    }
    let head = request_line.starts_with("HEAD ");
    let size = cache.size;
    let mut out = stream;
    let (start, end, status) = match range {
        Some((start, _)) if start >= size => {
            write!(
                out,
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{size}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )?;
            return Ok(());
        }
        Some((start, end)) => (start, end.unwrap_or(size - 1).min(size - 1), 206),
        None => (0, size - 1, 200),
    };
    let length = end + 1 - start;
    let mut header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nContent-Length: {length}\r\nConnection: close\r\n",
        status,
        if status == 206 { "Partial Content" } else { "OK" }
    );
    if status == 206 {
        header.push_str(&format!("Content-Range: bytes {start}-{end}/{size}\r\n"));
    }
    header.push_str("\r\n");
    out.write_all(header.as_bytes())?;
    if head {
        return Ok(());
    }
    let mut buffer = vec![0u8; 256 * 1024];
    let mut offset = start;
    while offset <= end {
        let want = ((end + 1 - offset) as usize).min(buffer.len());
        let read = cache.read_at(offset, &mut buffer[..want]);
        if read == 0 {
            break;
        }
        // A decoder that seeks away closes this connection: stop here.
        out.write_all(&buffer[..read])?;
        offset += read as u64;
    }
    Ok(())
}

fn parse_range(value: &str) -> Option<(u64, Option<u64>)> {
    let spec = value.strip_prefix("bytes=")?;
    let (start, end) = spec.split_once('-')?;
    let start = start.trim().parse().ok()?;
    let end = end.trim();
    Some((start, if end.is_empty() { None } else { end.parse().ok() }))
}
