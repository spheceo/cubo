//! A bounded store of torrent pieces. Reservations happen before network
//! requests, so concurrent downloads cannot overshoot the disk budget.
use anyhow::{Context, Result};
use librqbit::{
    storage::{BoxStorageFactory, StorageFactory, StorageFactoryExt, TorrentStorage},
    ManagedTorrentShared, TorrentMetadata,
};
use librqbit_core::lengths::{Lengths, ValidPieceIndex};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

// Account conservatively for filesystem allocation, including small final pieces.
const BLOCK: u64 = 64 * 1024;
type Key = (String, u32);
struct Piece {
    path: PathBuf,
    reserved: u64,
    complete: bool,
    touched: u64,
}
struct Inner {
    root: PathBuf,
    limit: u64,
    used: u64,
    clock: u64,
    pieces: HashMap<Key, Piece>,
    evicted: HashMap<String, Vec<u32>>,
}
#[derive(Clone)]
pub struct RollingCache {
    inner: Arc<Mutex<Inner>>,
}
impl RollingCache {
    pub fn new(root: PathBuf, limit: u64) -> Result<Self> {
        std::fs::create_dir_all(&root)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(Inner {
                root,
                limit,
                used: 0,
                clock: 0,
                pieces: HashMap::new(),
                evicted: HashMap::new(),
            })),
        })
    }
    pub fn set_limit(&self, limit: u64) -> Result<()> {
        let mut g = self.inner.lock().unwrap();
        let inflight: u64 = g
            .pieces
            .values()
            .filter(|p| !p.complete)
            .map(|p| p.reserved)
            .sum();
        anyhow::ensure!(
            inflight <= limit,
            "Downloads are busy. Try lowering the storage limit again in a moment."
        );
        g.limit = limit;
        Self::make_room(&mut g, 0)?;
        Ok(())
    }
    pub fn reset(&self, root: PathBuf) -> Result<()> {
        let mut g = self.inner.lock().unwrap();
        std::fs::create_dir_all(&root)?;
        g.root = root;
        g.pieces.clear();
        g.evicted.clear();
        g.used = 0;
        Ok(())
    }
    fn make_room(g: &mut Inner, needed: u64) -> Result<bool> {
        while g.used.saturating_add(needed) > g.limit {
            let candidate = g
                .pieces
                .iter()
                .filter(|(_, p)| p.complete)
                .min_by_key(|(_, p)| p.touched)
                .map(|(k, _)| k.clone());
            let Some(key) = candidate else {
                return Ok(false);
            };
            Self::remove(g, &key)?;
        }
        Ok(true)
    }
    fn remove(g: &mut Inner, key: &Key) -> Result<()> {
        if let Some(p) = g.pieces.get(key) {
            match std::fs::remove_file(&p.path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        if let Some(p) = g.pieces.remove(key) {
            g.used -= p.reserved;
            if p.complete {
                g.evicted.entry(key.0.clone()).or_default().push(key.1);
            }
        }
        Ok(())
    }
    fn reserve(&self, key: Key, bytes: u64) -> Result<bool> {
        let mut g = self.inner.lock().unwrap();
        if g.pieces.contains_key(&key) {
            return Ok(true);
        }
        let reserved = bytes.div_ceil(BLOCK) * BLOCK;
        anyhow::ensure!(reserved <= g.limit, "This source uses torrent pieces larger than the available cache. Choose a larger storage limit.");
        if !Self::make_room(&mut g, reserved)? {
            return Ok(false);
        }
        let dir = g.root.join(".cubo-pieces").join(&key.0);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{}.piece", key.1));
        // No source-sized sparse file: storage is proportional to retained pieces.
        File::create(&path)?.set_len(bytes)?;
        g.clock += 1;
        let touched = g.clock;
        g.used += reserved;
        g.pieces.insert(
            key,
            Piece {
                path,
                reserved,
                complete: false,
                touched,
            },
        );
        Ok(true)
    }
    #[cfg(test)]
    fn available(&self, key: &Key) -> bool {
        self.inner
            .lock()
            .unwrap()
            .pieces
            .get(key)
            .is_some_and(|p| p.complete)
    }
    fn complete(&self, key: &Key) -> Result<()> {
        let mut g = self.inner.lock().unwrap();
        g.clock += 1;
        let now = g.clock;
        let p = g
            .pieces
            .get_mut(key)
            .context("completed piece has no reservation")?;
        p.complete = true;
        p.touched = now;
        Ok(())
    }
    fn io(
        &self,
        key: &Key,
        offset: u64,
        read: Option<&mut [u8]>,
        write: Option<&[u8]>,
    ) -> Result<()> {
        let mut g = self.inner.lock().unwrap();
        g.clock += 1;
        let now = g.clock;
        let p = g.pieces.get_mut(key).context("torrent piece was evicted")?;
        p.touched = now;
        let mut file = OpenOptions::new()
            .read(true)
            .write(write.is_some())
            .open(&p.path)?;
        file.seek(SeekFrom::Start(offset))?;
        if let Some(buf) = read {
            file.read_exact(buf)?;
        }
        if let Some(buf) = write {
            file.write_all(buf)?;
        }
        Ok(())
    }
    fn read_verified(&self, key: &Key, offset: u64, buf: &mut [u8]) -> Result<()> {
        let mut g = self.inner.lock().unwrap();
        g.clock += 1;
        let now = g.clock;
        let p = g
            .pieces
            .get_mut(key)
            .filter(|p| p.complete)
            .ok_or(librqbit::storage::PieceNotAvailable)?;
        p.touched = now;
        // Completion check and byte copy share the eviction lock. A new,
        // unverified reservation cannot masquerade as an older good piece.
        let mut file = File::open(&p.path)?;
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(buf)?;
        Ok(())
    }
    fn remove_torrent(&self, torrent: &str) -> Result<()> {
        let mut g = self.inner.lock().unwrap();
        let keys: Vec<_> = g
            .pieces
            .keys()
            .filter(|(id, _)| id == torrent)
            .cloned()
            .collect();
        for key in keys {
            Self::remove(&mut g, &key)?;
        }
        Ok(())
    }
}

impl StorageFactory for RollingCache {
    type Storage = PieceStorage;
    fn create(
        &self,
        shared: &ManagedTorrentShared,
        metadata: &TorrentMetadata,
    ) -> Result<PieceStorage> {
        Ok(PieceStorage {
            cache: self.clone(),
            torrent: shared.info_hash.as_string(),
            lengths: *metadata.lengths(),
            files: metadata
                .file_infos
                .iter()
                .map(|f| (f.offset_in_torrent, f.len))
                .collect(),
        })
    }
    fn clone_box(&self) -> BoxStorageFactory {
        self.clone().boxed()
    }
}
#[derive(Clone)]
pub struct PieceStorage {
    cache: RollingCache,
    torrent: String,
    lengths: Lengths,
    files: Vec<(u64, u64)>,
}
impl PieceStorage {
    fn key(&self, piece: ValidPieceIndex) -> Key {
        (self.torrent.clone(), piece.get())
    }
    fn visit(
        &self,
        file: usize,
        offset: u64,
        size: usize,
        mut op: impl FnMut(Key, u64, usize, usize) -> Result<()>,
    ) -> Result<()> {
        let &(start, length) = self.files.get(file).context("invalid torrent file")?;
        anyhow::ensure!(
            offset
                .checked_add(size as u64)
                .is_some_and(|end| end <= length),
            "torrent I/O exceeds file"
        );
        let mut done = 0;
        while done < size {
            let absolute = start + offset + done as u64;
            let piece = self
                .lengths
                .validate_piece_index(
                    (absolute / self.lengths.default_piece_length() as u64).try_into()?,
                )
                .context("invalid piece")?;
            let local = absolute - self.lengths.piece_offset(piece);
            let count =
                (size - done).min((self.lengths.piece_length(piece) as u64 - local) as usize);
            op(self.key(piece), local, done, count)?;
            done += count;
        }
        Ok(())
    }
}
impl TorrentStorage for PieceStorage {
    fn pread_exact_verified(&self, file: usize, offset: u64, buf: &mut [u8]) -> Result<()> {
        self.visit(file, offset, buf.len(), |key, local, done, count| {
            self.cache
                .read_verified(&key, local, &mut buf[done..done + count])
        })
    }
    fn streaming_only(&self) -> bool {
        true
    }
    fn init(&mut self, _: &ManagedTorrentShared, _: &TorrentMetadata) -> Result<()> {
        Ok(())
    }
    fn pread_exact(&self, file: usize, offset: u64, buf: &mut [u8]) -> Result<()> {
        self.visit(file, offset, buf.len(), |key, local, done, count| {
            self.cache
                .io(&key, local, Some(&mut buf[done..done + count]), None)
        })
    }
    fn pwrite_all(&self, file: usize, offset: u64, buf: &[u8]) -> Result<()> {
        self.visit(file, offset, buf.len(), |key, local, done, count| {
            self.cache
                .io(&key, local, None, Some(&buf[done..done + count]))
        })
    }
    fn ensure_file_length(&self, _: usize, _: u64) -> Result<()> {
        Ok(())
    }
    fn remove_file(&self, _: usize, _: &Path) -> Result<()> {
        self.cache.remove_torrent(&self.torrent)
    }
    fn remove_directory_if_empty(&self, _: &Path) -> Result<()> {
        Ok(())
    }
    fn take(&self) -> Result<Box<dyn TorrentStorage>> {
        Ok(Box::new(self.clone()))
    }
    fn on_piece_completed(&self, piece: ValidPieceIndex) -> Result<()> {
        self.cache.complete(&self.key(piece))
    }
    fn try_reserve_piece(&self, piece: ValidPieceIndex) -> Result<bool> {
        self.cache
            .reserve(self.key(piece), self.lengths.piece_length(piece) as u64)
    }
    fn take_evicted_pieces(&self) -> Vec<ValidPieceIndex> {
        self.cache
            .inner
            .lock()
            .unwrap()
            .evicted
            .remove(&self.torrent)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|id| self.lengths.validate_piece_index(id))
            .collect()
    }
    fn release_piece_reservation(&self, piece: ValidPieceIndex) {
        let mut g = self.cache.inner.lock().unwrap();
        let key = self.key(piece);
        if g.pieces.get(&key).is_some_and(|p| !p.complete) {
            if let Err(error) = RollingCache::remove(&mut g, &key) {
                tracing::warn!(%error, "could not release torrent piece reservation");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup(limit: u64) -> (RollingCache, PathBuf) {
        let path = std::env::temp_dir().join(format!("cubo-pieces-{}", uuid::Uuid::new_v4()));
        (RollingCache::new(path.clone(), limit).unwrap(), path)
    }
    #[test]
    fn reservations_never_exceed_limit_and_inflight_pieces_are_protected() {
        let (cache, dir) = setup(2 * BLOCK);
        assert!(cache.reserve(("test".into(), 0), BLOCK).unwrap());
        assert!(cache.reserve(("test".into(), 1), BLOCK).unwrap());
        assert!(!cache.reserve(("test".into(), 2), BLOCK).unwrap());
        cache.complete(&("test".into(), 0)).unwrap();
        assert!(cache.reserve(("test".into(), 2), BLOCK).unwrap());
        assert!(!cache.available(&("test".into(), 0)));
        assert_eq!(cache.inner.lock().unwrap().used, 2 * BLOCK);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn recently_read_pieces_survive_and_evicted_ones_can_return() {
        let (cache, dir) = setup(2 * BLOCK);
        for id in 0..2 {
            let key = ("test".into(), id);
            cache.reserve(key.clone(), BLOCK).unwrap();
            cache.io(&key, 0, None, Some(&[id as u8])).unwrap();
            cache.complete(&key).unwrap();
        }
        let mut byte = [0];
        cache
            .io(&("test".into(), 0), 0, Some(&mut byte), None)
            .unwrap();
        cache.reserve(("test".into(), 2), BLOCK).unwrap();
        assert!(cache.available(&("test".into(), 0)));
        assert!(!cache.available(&("test".into(), 1)));
        cache.complete(&("test".into(), 2)).unwrap();
        assert!(cache.reserve(("test".into(), 1), BLOCK).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn concurrent_reservations_share_one_limit() {
        let (cache, dir) = setup(8 * BLOCK);
        std::thread::scope(|scope| {
            for id in 0..32 {
                let cache = cache.clone();
                scope.spawn(move || {
                    cache.reserve(("parallel".into(), id), BLOCK).unwrap();
                });
            }
        });
        let g = cache.inner.lock().unwrap();
        assert_eq!(g.pieces.len(), 8);
        assert_eq!(g.used, 8 * BLOCK);
        drop(g);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_piece_crossing_files_is_stored_and_evicted_as_one_unit() {
        let (cache, dir) = setup(BLOCK);
        let lengths = Lengths::new(32, 16).unwrap();
        let storage = PieceStorage {
            cache: cache.clone(),
            torrent: "pack".into(),
            lengths,
            files: vec![(0, 10), (10, 22)],
        };
        let first = lengths.validate_piece_index(0).unwrap();
        assert!(storage.try_reserve_piece(first).unwrap());
        storage.pwrite_all(0, 0, &[1; 10]).unwrap();
        storage.pwrite_all(1, 0, &[2; 6]).unwrap();
        storage.on_piece_completed(first).unwrap();
        let mut actual = [0; 6];
        storage.pread_exact(1, 0, &mut actual).unwrap();
        assert_eq!(actual, [2; 6]);
        assert!(storage
            .try_reserve_piece(lengths.validate_piece_index(1).unwrap())
            .unwrap());
        assert_eq!(storage.take_evicted_pieces(), vec![first]);
        assert!(storage.pread_exact(0, 0, &mut actual).is_err());
        storage.release_piece_reservation(lengths.validate_piece_index(1).unwrap());
        assert_eq!(cache.inner.lock().unwrap().used, 0);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
