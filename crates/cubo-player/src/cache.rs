//! The player's byte cache: the remote file, fetched ahead of the playhead
//! as fast as the link allows and kept in a sparse local file.
//!
//! This is the part the browser could not do. Chrome caps a media buffer at
//! roughly 150 MB and hls.js budgets it in seconds, so on a slow link the
//! browser never got more than a segment ahead. Here everything the link
//! delivers is kept, so quiet scenes bank time for busy ones.
//!
//! One downloader streams ranged requests from the first missing chunk at
//! or after the readers' focus. A read of a chunk that is not here yet
//! moves the focus there (a seek, or the decoder opening the file's index
//! at its end) and the downloader follows within a chunk.

use std::fs::File;
use std::io::Read;
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};

pub const CHUNK: u64 = 1 << 20;
/// The most one ranged request asks for; a new request re-checks the focus.
const REQUEST_CHUNKS: u64 = 64;

pub struct Cache {
    url: String,
    agent: ureq::Agent,
    path: PathBuf,
    file: File,
    pub size: u64,
    state: Mutex<State>,
    changed: Condvar,
    pub downloaded: AtomicU64,
    /// Bumped whenever a reader moves the focus to a chunk the downloader
    /// was not about to fetch; a running request checks it every read.
    redirects: AtomicU64,
    /// Where the decoders last read: the byte position of the playhead,
    /// give or take the decoders' own small queues.
    pub read_offset: AtomicU64,
}

struct State {
    have: Vec<bool>,
    /// Chunk the readers are at; the downloader fetches forward from it.
    focus: u64,
    closed: bool,
}

impl Cache {
    /// Asks the source for its size and creates the sparse cache file.
    pub fn open(url: &str, agent: ureq::Agent, dir: &Path) -> Result<Arc<Self>> {
        let response = agent
            .get(url)
            .set("Range", "bytes=0-0")
            .call()
            .map_err(|error| anyhow!("could not open the stream: {error}"))?;
        let size = response
            .header("Content-Range")
            .and_then(|range| range.rsplit('/').next())
            .and_then(|total| total.parse::<u64>().ok())
            .or_else(|| response.header("Content-Length").and_then(|len| len.parse().ok()))
            .ok_or_else(|| anyhow!("the stream does not report its size"))?;
        std::fs::create_dir_all(dir)?;
        remove_abandoned(dir);
        let path = dir.join(format!("{}.part", std::process::id()));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&path)
            .with_context(|| format!("could not create {}", path.display()))?;
        file.set_len(size)?;
        let chunks = size.div_ceil(CHUNK) as usize;
        Ok(Arc::new(Self {
            url: url.to_string(),
            agent,
            path,
            file,
            size,
            state: Mutex::new(State { have: vec![false; chunks], focus: 0, closed: false }),
            changed: Condvar::new(),
            downloaded: AtomicU64::new(0),
            redirects: AtomicU64::new(0),
            read_offset: AtomicU64::new(0),
        }))
    }

    pub fn start(self: &Arc<Self>) {
        let this = Arc::clone(self);
        std::thread::Builder::new()
            .name("cache-download".into())
            .spawn(move || this.download_loop())
            .expect("spawn downloader");
    }

    pub fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.changed.notify_all();
        let _ = std::fs::remove_file(&self.path);
    }

    fn chunks(&self) -> u64 {
        self.size.div_ceil(CHUNK)
    }

    /// Reads at `offset`, waiting for the bytes to arrive. Returns 0 at
    /// the end of the file or once the cache is closed.
    pub fn read_at(&self, offset: u64, buf: &mut [u8]) -> usize {
        if offset >= self.size || buf.is_empty() {
            return 0;
        }
        let chunk = offset / CHUNK;
        let mut state = self.state.lock().unwrap();
        if !state.have[chunk as usize] {
            // A read the downloader is not heading for moves it here.
            let next = first_missing(&state.have, state.focus);
            if next != Some(chunk) {
                state.focus = chunk;
                self.redirects.fetch_add(1, Ordering::AcqRel);
                self.changed.notify_all();
            }
        }
        while !state.have[chunk as usize] {
            if state.closed {
                return 0;
            }
            state = self.changed.wait_timeout(state, Duration::from_millis(500)).unwrap().0;
        }
        // The focus follows the readers. The video and audio decoders read
        // a few chunks apart, but with everything between them here the
        // downloader's next chunk is the same for both.
        state.focus = chunk;
        drop(state);
        self.read_offset.store(offset, Ordering::Relaxed);
        let end_of_chunk = ((chunk + 1) * CHUNK).min(self.size);
        let len = (buf.len() as u64).min(end_of_chunk - offset) as usize;
        self.file.read_at(&mut buf[..len], offset).unwrap_or_default()
    }

    /// Bytes on disk without a gap from `offset` on.
    pub fn contiguous_from(&self, offset: u64) -> u64 {
        let state = self.state.lock().unwrap();
        let first = (offset / CHUNK) as usize;
        let count = state.have.iter().skip(first).take_while(|have| **have).count() as u64;
        if count == 0 {
            return 0;
        }
        ((first as u64 + count) * CHUNK).min(self.size).saturating_sub(offset)
    }

    /// Which parts of the file are here, in `buckets` equal slices (0–255).
    pub fn coverage(&self, buckets: usize) -> Vec<u8> {
        let state = self.state.lock().unwrap();
        let total = state.have.len().max(1);
        (0..buckets)
            .map(|bucket| {
                let from = bucket * total / buckets;
                let to = ((bucket + 1) * total / buckets).max(from + 1).min(total);
                let have = state.have[from..to].iter().filter(|have| **have).count();
                (have * 255 / (to - from)) as u8
            })
            .collect()
    }

    fn download_loop(&self) {
        let mut buffer = vec![0u8; CHUNK as usize];
        loop {
            let start = {
                let mut state = self.state.lock().unwrap();
                loop {
                    if state.closed {
                        return;
                    }
                    let next = first_missing(&state.have, state.focus).or_else(|| first_missing(&state.have, 0));
                    match next {
                        Some(next) => break next,
                        None => state = self.changed.wait(state).unwrap(),
                    }
                }
            };
            let end = {
                let state = self.state.lock().unwrap();
                let limit = (start + REQUEST_CHUNKS).min(self.chunks());
                (start..limit).find(|chunk| state.have[*chunk as usize]).unwrap_or(limit)
            };
            let from = start * CHUNK;
            let to = (end * CHUNK).min(self.size) - 1;
            let response = self.agent.get(&self.url).set("Range", &format!("bytes={from}-{to}")).call();
            let mut reader = match response {
                Ok(response) => response.into_reader(),
                Err(error) => {
                    eprintln!("cubo-player: download failed at {from}: {error}");
                    std::thread::sleep(Duration::from_secs(1));
                    continue;
                }
            };
            let redirects = self.redirects.load(Ordering::Acquire);
            let mut chunk = start;
            'request: while chunk < end {
                let len = (((chunk + 1) * CHUNK).min(self.size) - chunk * CHUNK) as usize;
                // Read the chunk in small pieces so a seek elsewhere costs
                // at most one piece of the link, not a whole chunk.
                let mut filled = 0;
                while filled < len {
                    let piece = (len - filled).min(64 * 1024);
                    if reader.read_exact(&mut buffer[filled..filled + piece]).is_err() {
                        std::thread::sleep(Duration::from_millis(250));
                        break 'request;
                    }
                    filled += piece;
                    self.downloaded.fetch_add(piece as u64, Ordering::Relaxed);
                    if self.redirects.load(Ordering::Acquire) != redirects && self.should_redirect(chunk) {
                        break 'request;
                    }
                }
                if self.file.write_at(&buffer[..len], chunk * CHUNK).is_err() {
                    break;
                }
                let redirect = {
                    let mut state = self.state.lock().unwrap();
                    state.have[chunk as usize] = true;
                    if state.closed {
                        return;
                    }
                    // Keep streaming while this request is still the next
                    // thing the readers need; otherwise start over there.
                    first_missing(&state.have, state.focus) != Some(chunk + 1)
                };
                self.changed.notify_all();
                chunk += 1;
                if redirect && chunk < end {
                    break;
                }
            }
        }
    }

    /// The readers now need something other than `chunk`, which is being
    /// fetched.
    fn should_redirect(&self, chunk: u64) -> bool {
        let state = self.state.lock().unwrap();
        state.closed || first_missing(&state.have, state.focus) != Some(chunk)
    }
}

/// Deletes caches left by players that are no longer running (a crash
/// skips the removal on exit). Files are named `<pid>.part`.
fn remove_abandoned(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(pid) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".part"))
            .and_then(|pid| pid.parse::<i32>().ok())
        else {
            continue;
        };
        // kill(pid, 0) fails with ESRCH once that process is gone.
        let alive = unsafe { libc::kill(pid, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        if !alive {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn first_missing(have: &[bool], from: u64) -> Option<u64> {
    have.iter().skip(from as usize).position(|have| !*have).map(|index| from + index as u64)
}
