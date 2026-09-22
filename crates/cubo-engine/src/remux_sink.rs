//! Write-time quota for ffmpeg's private HTTP output. Source timestamps and
//! the EVENT playlist stay unchanged; expired footage is remuxed on demand.
//!
//! ffmpeg's HLS-over-HTTP output is fire-and-forget: it writes each PUT and
//! closes the connection without waiting for the response. A general HTTP
//! stack (hyper/axum) drops in-flight handlers when the peer disconnects,
//! which silently discards any request still being read. The sink therefore
//! listens on a raw TCP socket and drains each body itself: bytes already in
//! flight survive ffmpeg's close, and stalling a read backpressures ffmpeg
//! through the TCP window instead of dropping data.
use bytes::{Buf, Bytes, BytesMut};
use std::{collections::HashMap, io::Write, path::PathBuf, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{Mutex, Notify},
};

const BLOCK: u64 = 64 * 1024;
const REWIND_SECONDS: f64 = 180.0;
const MAX_HEAD: usize = 64 * 1024;
fn allocation(bytes: u64) -> u64 {
    bytes.div_ceil(BLOCK) * BLOCK
}
#[derive(Debug)]
struct Segment {
    start: f64,
    end: f64,
    served: bool,
}
#[derive(Debug)]
struct Job {
    dir: PathBuf,
    origin: f64,
    retained_start: f64,
    files: HashMap<String, u64>,
    segments: HashMap<String, Segment>,
}
#[derive(Debug)]
struct Inner {
    budget: u64,
    used: u64,
    jobs: HashMap<String, Job>,
}
#[derive(Clone, Debug)]
pub struct RemuxSink {
    root: Arc<PathBuf>,
    inner: Arc<Mutex<Inner>>,
    space: Arc<Notify>,
    endpoint: Arc<Mutex<Option<String>>>,
}
impl RemuxSink {
    pub fn new(root: PathBuf, budget: u64) -> Self {
        Self {
            root: Arc::new(root),
            inner: Arc::new(Mutex::new(Inner {
                budget,
                used: 0,
                jobs: HashMap::new(),
            })),
            space: Arc::new(Notify::new()),
            endpoint: Arc::new(Mutex::new(None)),
        }
    }
    pub async fn listen(&self) -> Result<String, String> {
        let mut endpoint = self.endpoint.lock().await;
        if let Some(url) = endpoint.as_ref() {
            return Ok(url.clone());
        }
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| e.to_string())?;
        let url = format!(
            "http://{}/put",
            listener.local_addr().map_err(|e| e.to_string())?
        );
        let sink = self.clone();
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((conn, _)) => {
                        let sink = sink.clone();
                        tokio::spawn(async move {
                            let _ = sink.serve_conn(conn).await;
                        });
                    }
                    Err(_) => break,
                }
            }
        });
        *endpoint = Some(url.clone());
        Ok(url)
    }
    pub async fn put_url(&self, job: &str, file: &str) -> Option<String> {
        Some(format!(
            "{}/{job}/{file}",
            self.endpoint.lock().await.as_ref()?
        ))
    }
    /// One connection carries one PUT: ffmpeg runs `-http_persistent 0` and
    /// closes right after writing, so there is nothing to reuse.
    async fn serve_conn(&self, conn: TcpStream) -> Result<(), String> {
        let _ = conn.set_nodelay(true);
        let (mut read_half, mut write_half) = conn.into_split();
        let mut buf = BytesMut::with_capacity(64 * 1024);
        let head = match read_head(&mut read_half, &mut buf)
            .await
            .map_err(|e| e.to_string())?
        {
            Some(head) => head,
            None => return Ok(()),
        };
        let mut parts = head.split_whitespace();
        let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        if method != "PUT" || !target.starts_with("/put/") {
            respond(&mut write_half, "404 Not Found").await.ok();
            return Ok(());
        }
        let mut names = target.trim_start_matches("/put/").split('/');
        let (id, file) = (names.next().unwrap_or(""), names.next().unwrap_or(""));
        if names.next().is_some() || safe_name(id).is_err() || safe_name(file).is_err() {
            respond(&mut write_half, "400 Bad Request").await.ok();
            return Ok(());
        }
        let headers = Head::parse(&head);
        if headers.expect_continue {
            write_half
                .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
                .await
                .map_err(|e| e.to_string())?;
        }
        // The body reader task owns the socket. When quota stalls the writer,
        // this small channel fills, the reader stops draining TCP, and the
        // closing window pauses ffmpeg mid-write instead of dropping data.
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<Bytes, String>>(4);
        let reader = tokio::spawn(read_body(read_half, buf, headers, tx));
        let body = futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx));
        // ffmpeg opens a fresh connection per file and playlist updates can
        // overlap on their own sockets, so every upload needs a private temp
        // path; publish order is enforced at rename time, not arrival time.
        let temp = format!(".{file}.{}.upload", uuid::Uuid::new_v4().simple());
        {
            let g = self.inner.lock().await;
            if g.jobs.get(id).is_none() {
                drop(g);
                drop(body);
                respond(&mut write_half, "410 Gone").await.ok();
                let _ = reader.await;
                return Ok(());
            }
        }
        match self.write_chunks(id, file, &temp, body).await {
            Ok(()) => {
                respond(&mut write_half, "200 OK").await.ok();
            }
            Err(error) => {
                let mut g = self.inner.lock().await;
                if g.jobs.contains_key(id) {
                    let _ = Self::delete_file(&mut g, id, &temp).await;
                }
                self.space.notify_waiters();
                tracing::debug!(%error, "remux upload rejected");
                respond(&mut write_half, "507 Insufficient Storage")
                    .await
                    .ok();
            }
        };
        let _ = reader.await;
        Ok(())
    }
    pub async fn set_budget(&self, budget: u64) -> Result<(), String> {
        let mut g = self.inner.lock().await;
        if budget < g.used {
            return Err("Pause playback and clear temporary video files before lowering the storage limit this far.".into());
        }
        g.budget = budget;
        self.space.notify_waiters();
        Ok(())
    }
    pub async fn begin_job(&self, id: &str, origin: f64) -> Result<PathBuf, String> {
        safe_name(id)?;
        let mut g = self.inner.lock().await;
        if g.jobs.contains_key(id) {
            return Err("conversion already exists".into());
        }
        let dir = self.root.join(id);
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| e.to_string())?;
        g.jobs.insert(
            id.into(),
            Job {
                dir: dir.clone(),
                origin,
                retained_start: origin,
                files: HashMap::new(),
                segments: HashMap::new(),
            },
        );
        Ok(dir)
    }
    pub async fn remove_job(&self, id: &str) -> Result<(), String> {
        let mut g = self.inner.lock().await;
        if let Some(job) = g.jobs.get(id) {
            match tokio::fs::remove_dir_all(&job.dir).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
            let job = g.jobs.remove(id).unwrap();
            g.used -= job.files.values().map(|n| allocation(*n)).sum::<u64>();
        }
        self.space.notify_waiters();
        Ok(())
    }
    pub async fn clear(&self) -> Result<(), String> {
        let ids: Vec<_> = self.inner.lock().await.jobs.keys().cloned().collect();
        for id in ids {
            self.remove_job(&id).await?;
        }
        Ok(())
    }
    pub async fn read(&self, id: &str, file: &str) -> Result<Vec<u8>, String> {
        safe_name(file)?;
        let g = self.inner.lock().await;
        let job = g.jobs.get(id).ok_or("conversion expired")?;
        tokio::fs::read(job.dir.join(file))
            .await
            .map_err(|e| e.to_string())
    }
    pub async fn put(&self, id: &str, file: &str, bytes: &[u8]) -> Result<(), String> {
        safe_name(id)?;
        safe_name(file)?;
        let temp = format!(".{file}.upload");
        {
            let mut g = self.inner.lock().await;
            let job = g.jobs.get(id).ok_or("conversion expired")?;
            if job.files.contains_key(&temp) {
                Self::delete_file(&mut g, id, &temp).await?;
            }
        }
        let chunks =
            futures_util::stream::iter(vec![Ok::<_, String>(Bytes::copy_from_slice(bytes))]);
        let result = self.write_chunks(id, file, &temp, chunks).await;
        if result.is_err() {
            let mut g = self.inner.lock().await;
            if g.jobs.contains_key(id) {
                let _ = Self::delete_file(&mut g, id, &temp).await;
            }
            self.space.notify_waiters();
        }
        result
    }
    async fn delete_file(g: &mut Inner, id: &str, file: &str) -> Result<(), String> {
        let job = g.jobs.get_mut(id).ok_or("conversion expired")?;
        match tokio::fs::remove_file(job.dir.join(file)).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        if let Some(bytes) = job.files.remove(file) {
            g.used -= allocation(bytes);
        }
        if let Some(segment) = job.segments.remove(file) {
            job.retained_start = job.retained_start.max(segment.end);
        }
        Ok(())
    }
    async fn evict_served(g: &mut Inner, id: &str, cutoff: f64) -> Result<bool, String> {
        let job = g.jobs.get(id).ok_or("conversion expired")?;
        let oldest = job
            .segments
            .iter()
            .filter(|(_, s)| s.served && s.end <= cutoff)
            .min_by(|(_, a), (_, b)| a.start.total_cmp(&b.start))
            .map(|(name, _)| name.clone());
        if let Some(name) = oldest {
            Self::delete_file(g, id, &name).await?;
            return Ok(true);
        }
        Ok(false)
    }
    async fn write_chunks<S>(
        &self,
        id: &str,
        file: &str,
        temp: &str,
        mut body: S,
    ) -> Result<(), String>
    where
        S: futures_util::Stream<Item = Result<Bytes, String>> + Unpin,
    {
        let mut size = 0u64;
        while let Some(chunk) = futures_util::StreamExt::next(&mut body).await {
            let chunk = chunk?;
            if chunk.is_empty() {
                continue;
            }
            let next_size = size
                .checked_add(chunk.len() as u64)
                .ok_or("output too large")?;
            loop {
                let notified = self.space.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let mut g = self.inner.lock().await;
                let dir = g.jobs.get(id).ok_or("conversion expired")?.dir.clone();
                // Always leave room to publish the playlist describing the
                // newest segment; otherwise a full cache deadlocks its reader.
                let metadata_reserve = (g.budget / 8).min(4 * 1024 * 1024);
                let limit = if is_segment(file) {
                    g.budget - metadata_reserve
                } else {
                    g.budget
                };
                if allocation(next_size) > limit {
                    return Err("One video segment exceeds the storage allowance.".into());
                }
                let growth = allocation(next_size) - allocation(size);
                while g.used.saturating_add(growth) > limit
                    && Self::evict_served(&mut g, id, f64::INFINITY).await?
                {}
                if g.used.saturating_add(growth) > limit {
                    drop(g);
                    notified.await;
                    continue;
                }
                // Hold the same lock through the write. Clear/eviction cannot
                // release space while an unlinked file is still being written.
                let mut output = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(dir.join(temp))
                    .map_err(|e| e.to_string())?;
                g.used += growth;
                g.jobs
                    .get_mut(id)
                    .unwrap()
                    .files
                    .insert(temp.into(), next_size);
                output.write_all(&chunk).map_err(|e| e.to_string())?;
                drop(output);
                size = next_size;
                break;
            }
        }
        let mut g = self.inner.lock().await;
        let job = g.jobs.get_mut(id).ok_or("conversion expired")?;
        if size == 0 {
            return Err("empty remux output".into());
        }
        let dir = job.dir.clone();
        let old = job.files.get(file).copied().unwrap_or(0);
        // EVENT playlists only grow, and overlapping PUTs finish in arbitrary
        // order: a smaller body is a stale snapshot — keep the newer file.
        if file == "media.m3u8" && size < old {
            let _ = std::fs::remove_file(dir.join(temp));
            job.files.remove(temp);
            g.used -= allocation(size);
            return Ok(());
        }
        // Windows rename cannot replace a file. Remove the prior playlist
        // under the same read lock; public readers retain their last good copy.
        if old > 0 {
            std::fs::remove_file(dir.join(file)).map_err(|e| e.to_string())?;
        }
        std::fs::rename(dir.join(temp), dir.join(file)).map_err(|e| e.to_string())?;
        g.used -= allocation(old);
        let job = g.jobs.get_mut(id).unwrap();
        job.files.remove(temp);
        job.files.insert(file.into(), size);
        if file == "media.m3u8" {
            let text = std::fs::read_to_string(dir.join(file)).map_err(|e| e.to_string())?;
            Self::parse_playlist(job, &text);
        }
        self.space.notify_waiters();
        Ok(())
    }
    fn parse_playlist(job: &mut Job, text: &str) {
        let mut cursor = job.origin;
        let mut duration = None;
        for line in text.lines() {
            if let Some(value) = line.strip_prefix("#EXTINF:") {
                duration = value
                    .split(',')
                    .next()
                    .and_then(|s| s.parse::<f64>().ok())
                    .filter(|v| v.is_finite() && *v > 0.0);
            } else if !line.starts_with('#') && !line.is_empty() {
                if let Some(seconds) = duration.take() {
                    // ffmpeg may use a full HTTP destination in its manifest.
                    let name = line.rsplit('/').next().unwrap_or(line);
                    let end = cursor + seconds;
                    if job.files.contains_key(name) {
                        job.segments.entry(name.into()).or_insert(Segment {
                            start: cursor,
                            end,
                            served: false,
                        });
                    }
                    cursor = end;
                }
            }
        }
    }
    pub async fn note_playlist(&self, id: &str, text: &str) -> Result<(), String> {
        let mut g = self.inner.lock().await;
        Self::parse_playlist(g.jobs.get_mut(id).ok_or("conversion expired")?, text);
        Ok(())
    }
    pub async fn set_playhead(&self, id: &str, absolute: f64) -> Result<(), String> {
        if !absolute.is_finite() {
            return Err("invalid playback position".into());
        }
        let mut g = self.inner.lock().await;
        while Self::evict_served(&mut g, id, absolute - REWIND_SECONDS).await? {}
        self.space.notify_waiters();
        Ok(())
    }
    pub async fn report_segment_served(&self, id: &str, file: &str) -> Result<(), String> {
        let mut g = self.inner.lock().await;
        let job = g.jobs.get_mut(id).ok_or("conversion expired")?;
        if let Some(s) = job.segments.get_mut(file) {
            s.served = true;
            let watermark = s.end;
            while Self::evict_served(&mut g, id, watermark - REWIND_SECONDS).await? {}
        }
        self.space.notify_waiters();
        Ok(())
    }
    pub async fn retained_start(&self, id: &str) -> Option<f64> {
        self.inner
            .lock()
            .await
            .jobs
            .get(id)
            .map(|j| j.retained_start)
    }
}

/// Minimal HTTP request reader. ffmpeg's closes are reliable FINs (its
/// receive buffer is empty because it never waits for responses), so a body
/// already on the wire is always fully drainable even after the peer's write
/// side is gone.
struct Head {
    chunked: bool,
    content_length: Option<u64>,
    expect_continue: bool,
}
impl Head {
    fn parse(head: &str) -> Self {
        let mut chunked = false;
        let mut content_length = None;
        let mut expect_continue = false;
        for line in head.lines().skip(1) {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            let value = value.trim();
            if name.eq_ignore_ascii_case("transfer-encoding") {
                chunked = value
                    .split(',')
                    .any(|t| t.trim().eq_ignore_ascii_case("chunked"));
            } else if name.eq_ignore_ascii_case("content-length") {
                content_length = value.parse::<u64>().ok();
            } else if name.eq_ignore_ascii_case("expect") {
                expect_continue = value.eq_ignore_ascii_case("100-continue");
            }
        }
        Self {
            chunked,
            content_length,
            expect_continue,
        }
    }
}
async fn read_head(
    read: &mut tokio::net::tcp::OwnedReadHalf,
    buf: &mut BytesMut,
) -> std::io::Result<Option<String>> {
    loop {
        if let Some(pos) = find_subslice(buf, b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..pos]).into_owned();
            buf.advance(pos + 4);
            return Ok(Some(head));
        }
        if buf.len() > MAX_HEAD {
            return Ok(None);
        }
        if read.read_buf(buf).await? == 0 {
            return Ok(None);
        }
    }
}
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}
async fn respond(write: &mut tokio::net::tcp::OwnedWriteHalf, status: &str) -> std::io::Result<()> {
    write
        .write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n").as_bytes())
        .await
}
/// Decodes one request body off the socket, yielding content bytes. Runs in
/// its own task so quota stalls in the writer translate into TCP backpressure
/// (the reader simply stops pulling) rather than blocking a shared executor.
async fn read_body(
    mut read: tokio::net::tcp::OwnedReadHalf,
    mut buf: BytesMut,
    headers: Head,
    tx: tokio::sync::mpsc::Sender<Result<Bytes, String>>,
) -> Result<(), String> {
    let result = read_body_inner(&mut read, &mut buf, &headers, &tx).await;
    if let Err(error) = &result {
        let _ = tx.send(Err(error.clone())).await;
    }
    result
}
async fn read_body_inner(
    read: &mut tokio::net::tcp::OwnedReadHalf,
    buf: &mut BytesMut,
    headers: &Head,
    tx: &tokio::sync::mpsc::Sender<Result<Bytes, String>>,
) -> Result<(), String> {
    if headers.chunked {
        loop {
            let size_line = read_line(read, buf).await?;
            let size_text = size_line.split(';').next().unwrap_or("").trim();
            let size =
                usize::from_str_radix(size_text, 16).map_err(|_| "bad chunk size".to_string())?;
            if size == 0 {
                // Trailer section ends at a blank line.
                while !read_line(read, buf).await?.is_empty() {}
                return Ok(());
            }
            let data = read_exact(read, buf, size).await?;
            if tx.send(Ok(data)).await.is_err() {
                return Ok(());
            }
            // CRLF after each chunk.
            if &read_exact(read, buf, 2).await?[..] != b"\r\n" {
                return Err("bad chunk terminator".into());
            }
        }
    }
    if let Some(mut left) = headers.content_length {
        while left > 0 {
            if buf.is_empty() {
                if read.read_buf(buf).await.map_err(|e| e.to_string())? == 0 {
                    return Err("truncated body".into());
                }
            }
            let take = (buf.len() as u64).min(left) as usize;
            let data = buf.split_to(take).freeze();
            left -= take as u64;
            if tx.send(Ok(data)).await.is_err() {
                return Ok(());
            }
        }
        return Ok(());
    }
    // No declared length: the body runs to EOF. ffmpeg always sends one of the
    // framed forms, but treating EOF as the end is the safer fallback.
    loop {
        if !buf.is_empty() {
            if tx.send(Ok(buf.split().freeze())).await.is_err() {
                return Ok(());
            }
        }
        if read.read_buf(buf).await.map_err(|e| e.to_string())? == 0 {
            return Ok(());
        }
    }
}
async fn read_line(
    read: &mut tokio::net::tcp::OwnedReadHalf,
    buf: &mut BytesMut,
) -> Result<String, String> {
    loop {
        if let Some(pos) = find_subslice(buf, b"\r\n") {
            let line = String::from_utf8_lossy(&buf[..pos]).into_owned();
            buf.advance(pos + 2);
            return Ok(line);
        }
        if buf.len() > MAX_HEAD {
            return Err("oversized chunk header".into());
        }
        if read.read_buf(buf).await.map_err(|e| e.to_string())? == 0 {
            return Err("connection closed mid-body".into());
        }
    }
}
async fn read_exact(
    read: &mut tokio::net::tcp::OwnedReadHalf,
    buf: &mut BytesMut,
    n: usize,
) -> Result<Bytes, String> {
    while buf.len() < n {
        if read.read_buf(buf).await.map_err(|e| e.to_string())? == 0 {
            return Err("connection closed mid-body".into());
        }
    }
    Ok(buf.split_to(n).freeze())
}
fn is_segment(name: &str) -> bool {
    name.ends_with(".m4s") || name.ends_with(".ts")
}
fn safe_name(s: &str) -> Result<(), String> {
    if s.is_empty() || s.starts_with('.') || s.contains('/') || s.contains('\\') {
        return Err("invalid output name".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (RemuxSink, PathBuf) {
        let root = std::env::temp_dir().join(format!("cubo-sink-{}", uuid::Uuid::new_v4()));
        (RemuxSink::new(root.clone(), 8 * BLOCK), root)
    }
    #[tokio::test]
    async fn pressure_reclaims_served_footage_and_keeps_future_segments() {
        let (sink, root) = fixture();
        sink.begin_job("job", 10.0).await.unwrap();
        sink.put("job", "init.mp4", &[1; 8]).await.unwrap();
        sink.put("job", "s0.m4s", &vec![2; 2 * BLOCK as usize])
            .await
            .unwrap();
        sink.put("job", "media.m3u8", b"#EXTM3U\n#EXTINF:6,\ns0.m4s\n")
            .await
            .unwrap();
        sink.report_segment_served("job", "s0.m4s").await.unwrap();
        sink.put("job", "s1.m4s", &vec![3; 2 * BLOCK as usize])
            .await
            .unwrap();
        sink.put("job", "s2.m4s", &vec![4; 2 * BLOCK as usize])
            .await
            .unwrap();
        assert!(sink.read("job", "s0.m4s").await.is_err());
        assert_eq!(sink.retained_start("job").await, Some(16.0));
        assert!(sink.inner.lock().await.used <= 8 * BLOCK);
        assert!(sink.read("job", "s1.m4s").await.is_ok());
        sink.remove_job("job").await.unwrap();
        assert_eq!(sink.inner.lock().await.used, 0);
        let _ = tokio::fs::remove_dir_all(root).await;
    }
    #[tokio::test]
    async fn clear_wakes_blocked_upload_and_stale_requests_cannot_recreate_files() {
        let (sink, root) = fixture();
        sink.begin_job("job", 0.0).await.unwrap();
        sink.put("job", "s0.m4s", &vec![1; 6 * BLOCK as usize])
            .await
            .unwrap();
        let writer = {
            let sink = sink.clone();
            tokio::spawn(async move {
                sink.put("job", "s1.m4s", &vec![2; 2 * BLOCK as usize])
                    .await
            })
        };
        tokio::task::yield_now().await;
        sink.remove_job("job").await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(2), writer)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(sink.put("job", "s2.m4s", &[1]).await.is_err());
        assert_eq!(sink.inner.lock().await.used, 0);
        assert!(!root.join("job").exists());
        let _ = tokio::fs::remove_dir_all(root).await;
    }
}
