use crate::error::Result;

/// Byte-addressed blob store the VFS engine persists to.
///
/// Keys are flat strings (`data/<ino>`, `meta/index`). The OPFS backend maps
/// each key to a file and uses synchronous access handles; `MemStorage` is the
/// in-memory implementation used by tests.
pub trait Storage {
    /// Length of the blob, or `None` if it does not exist.
    fn len(&self, key: &str) -> Result<Option<u64>>;

    /// Read up to `buf.len()` bytes at `offset`. A missing blob reads as empty.
    /// Returns the number of bytes read.
    fn read_at(&self, key: &str, offset: u64, buf: &mut [u8]) -> Result<usize>;

    /// Write `data` at `offset`, creating the blob and zero-filling any gap.
    fn write_at(&mut self, key: &str, offset: u64, data: &[u8]) -> Result<()>;

    /// Set the blob length, creating it if missing. Growth zero-fills.
    fn truncate(&mut self, key: &str, size: u64) -> Result<()>;

    /// Delete the blob. Deleting a missing blob is not an error.
    fn delete(&mut self, key: &str) -> Result<()>;

    /// Ensure `keys` can be accessed synchronously. Backends that need async
    /// setup (OPFS opens files asynchronously) return `EAGAIN` with the keys
    /// to open in `SysError::path`, newline-separated; the caller opens them
    /// and retries. Must not change any state. In-memory backends need nothing.
    fn prepare(&mut self, _keys: &[String]) -> Result<()> {
        Ok(())
    }

    /// Every blob key that exists (as of the last `prepare`/listing for lazy backends).
    /// Used at mount to find blobs that belong to no file.
    fn list_keys(&self) -> Result<Vec<String>>;

    /// Make all prior writes durable.
    fn flush(&mut self) -> Result<()>;

    /// Total bytes in use across all blobs.
    fn used(&self) -> u64;

    /// Total capacity if the backend knows it.
    fn quota(&self) -> Option<u64> {
        None
    }

    /// Replace the whole blob with `data`.
    /// Not atomic: callers needing atomicity use two alternating blobs.
    fn put(&mut self, key: &str, data: &[u8]) -> Result<()> {
        self.truncate(key, 0)?;
        self.write_at(key, 0, data)
    }

    /// Read the whole blob, if it exists.
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        match self.len(key)? {
            None => Ok(None),
            Some(n) => {
                let mut buf = vec![0u8; n as usize];
                let got = self.read_at(key, 0, &mut buf)?;
                buf.truncate(got);
                Ok(Some(buf))
            }
        }
    }
}
