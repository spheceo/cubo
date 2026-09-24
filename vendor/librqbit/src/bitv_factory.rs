use crate::{api::TorrentIdOrHash, bitv::BitV, type_aliases::BF};

#[async_trait::async_trait]
pub trait BitVFactory: Send + Sync {
    async fn load(&self, id: TorrentIdOrHash) -> anyhow::Result<Option<Box<dyn BitV>>>;
    async fn clear(&self, id: TorrentIdOrHash) -> anyhow::Result<()>;
    async fn store_initial_check(
        &self,
        id: TorrentIdOrHash,
        b: BF,
    ) -> anyhow::Result<Box<dyn BitV>>;
}

pub struct NonPersistentBitVFactory {}

#[async_trait::async_trait]
impl BitVFactory for NonPersistentBitVFactory {
    async fn load(&self, _: TorrentIdOrHash) -> anyhow::Result<Option<Box<dyn BitV>>> {
        Ok(None)
    }

    async fn clear(&self, _id: TorrentIdOrHash) -> anyhow::Result<()> {
        Ok(())
    }

    async fn store_initial_check(
        &self,
        _id: TorrentIdOrHash,
        b: BF,
    ) -> anyhow::Result<Box<dyn BitV>> {
        Ok(Box::new(b))
    }
}

/// Cubo: keeps each torrent's have-pieces bitfield in `<folder>/<info hash>.bitv`
/// without the rest of session persistence, so a torrent re-added after a
/// restart skips the full initial hash check of files already on disk. The
/// caller removes a torrent's file when it deletes that torrent's data.
pub struct FolderBitVFactory {
    folder: std::path::PathBuf,
    spawner: crate::spawn_utils::BlockingSpawner,
}

impl FolderBitVFactory {
    pub fn new(folder: std::path::PathBuf, spawner: crate::spawn_utils::BlockingSpawner) -> Self {
        Self { folder, spawner }
    }

    fn filename(&self, id: TorrentIdOrHash) -> Option<std::path::PathBuf> {
        match id {
            TorrentIdOrHash::Hash(hash) => {
                Some(self.folder.join(format!("{}.bitv", hash.as_string())))
            }
            // Ids are per-process; only hashes name a file across restarts.
            TorrentIdOrHash::Id(_) => None,
        }
    }
}

#[async_trait::async_trait]
impl BitVFactory for FolderBitVFactory {
    async fn load(&self, id: TorrentIdOrHash) -> anyhow::Result<Option<Box<dyn BitV>>> {
        let Some(filename) = self.filename(id) else {
            return Ok(None);
        };
        match crate::bitv::DiskBackedBitV::new(filename, self.spawner.clone()).await {
            Ok(bitv) => Ok(Some(bitv.into_dyn())),
            // Missing or unreadable: do the full check instead.
            Err(_) => Ok(None),
        }
    }

    async fn clear(&self, id: TorrentIdOrHash) -> anyhow::Result<()> {
        if let Some(filename) = self.filename(id) {
            let _ = tokio::fs::remove_file(filename).await;
        }
        Ok(())
    }

    async fn store_initial_check(
        &self,
        id: TorrentIdOrHash,
        b: BF,
    ) -> anyhow::Result<Box<dyn BitV>> {
        let Some(filename) = self.filename(id) else {
            return Ok(Box::new(b));
        };
        if tokio::fs::create_dir_all(&self.folder).await.is_err() {
            return Ok(Box::new(b));
        }
        // A released Core and a dev Core can share this folder. Their initial
        // checks must not write the same temporary file at once.
        let tmp = filename.with_extension(format!("bitv.{}.tmp", std::process::id()));
        if tokio::fs::write(&tmp, b.as_raw_slice()).await.is_err()
            || tokio::fs::rename(&tmp, &filename).await.is_err()
        {
            return Ok(Box::new(b));
        }
        match crate::bitv::DiskBackedBitV::new(filename, self.spawner.clone()).await {
            Ok(bitv) => Ok(bitv.into_dyn()),
            Err(_) => Ok(Box::new(b)),
        }
    }
}
