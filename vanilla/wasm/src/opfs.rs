//! `Storage` backed by the Origin Private File System.
//!
//! OPFS gives fast *synchronous* reads and writes through
//! `FileSystemSyncAccessHandle`, but only inside a Worker, and creating or
//! opening those handles is *asynchronous*. The VFS engine is synchronous, so
//! this backend keeps a cache of open handles and answers `EAGAIN` (with the
//! missing keys in `SysError::path`) when asked for a blob that isn't open
//! yet. The JS side then calls [`open_keys`] and retries the operation.
//!
//! Layout: key `data/<ino>` is file `<ino>` in the `data` directory, and
//! `meta/index.N` is file `index.N` in the `meta` directory.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use tiny_vfs::{Errno, Result, Storage, SysError};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    DomException, FileSystemDirectoryHandle, FileSystemFileHandle, FileSystemGetFileOptions,
    FileSystemReadWriteOptions, FileSystemRemoveOptions, FileSystemSyncAccessHandle,
};

/// Open handles above this count are evicted least-recently-used first.
const MAX_OPEN: usize = 512;

struct OpenFile {
    handle: FileSystemSyncAccessHandle,
    dirty: bool,
    last_used: u64,
}

pub(crate) struct Inner {
    data_dir: FileSystemDirectoryHandle,
    meta_dir: FileSystemDirectoryHandle,
    open: HashMap<String, OpenFile>,
    /// Keys known to exist on disk (listed at boot, or created since).
    existing: HashSet<String>,
    /// Deleted blobs whose files still need an async `removeEntry`.
    pending_remove: Vec<String>,
    tick: u64,
}

#[derive(Clone)]
pub struct OpfsStorage {
    inner: Rc<RefCell<Inner>>,
}

fn split_key(key: &str) -> (&str, &str) {
    key.split_once('/').unwrap_or(("data", key))
}

fn need(keys: impl IntoIterator<Item = String>) -> SysError {
    let joined = keys.into_iter().collect::<Vec<_>>().join("\n");
    SysError::new(Errno::EAGAIN).with_path(&joined)
}

fn from_js(e: JsValue) -> SysError {
    if let Some(ex) = e.dyn_ref::<DomException>() {
        let code = match ex.name().as_str() {
            "QuotaExceededError" => Errno::ENOSPC,
            "NotFoundError" => Errno::ENOENT,
            _ => Errno::EIO,
        };
        return SysError::msg(code, format!("{}: {}", ex.name(), ex.message()));
    }
    SysError::msg(Errno::EIO, format!("{e:?}"))
}

impl Inner {
    fn dir(&self, name: &str) -> std::result::Result<&FileSystemDirectoryHandle, JsValue> {
        match name {
            "data" => Ok(&self.data_dir),
            "meta" => Ok(&self.meta_dir),
            other => Err(JsValue::from_str(&format!("unknown storage namespace {other:?}"))),
        }
    }

    fn touch(&mut self, key: &str) {
        self.tick += 1;
        let tick = self.tick;
        if let Some(o) = self.open.get_mut(key) {
            o.last_used = tick;
        }
    }

    fn open_mut(&mut self, key: &str) -> Result<&mut OpenFile> {
        if !self.open.contains_key(key) {
            return Err(need([key.to_string()]));
        }
        self.touch(key);
        Ok(self.open.get_mut(key).expect("checked above"))
    }
}

impl OpfsStorage {
    pub fn new(
        data_dir: FileSystemDirectoryHandle,
        meta_dir: FileSystemDirectoryHandle,
        existing: impl IntoIterator<Item = String>,
    ) -> Self {
        OpfsStorage {
            inner: Rc::new(RefCell::new(Inner {
                data_dir,
                meta_dir,
                open: HashMap::new(),
                existing: existing.into_iter().collect(),
                pending_remove: Vec::new(),
                tick: 0,
            })),
        }
    }

    /// Flush and close every handle. Required before another instance (or a
    /// directory removal) can touch the same files.
    pub fn close_all(&self) {
        let mut i = self.inner.borrow_mut();
        for (_, o) in i.open.drain() {
            let _ = o.handle.flush();
            o.handle.close();
        }
    }

    pub(crate) fn shared(&self) -> Rc<RefCell<Inner>> {
        self.inner.clone()
    }
}

impl Storage for OpfsStorage {
    fn len(&self, key: &str) -> Result<Option<u64>> {
        let i = self.inner.borrow();
        if let Some(o) = i.open.get(key) {
            return o.handle.get_size().map(|s| Some(s as u64)).map_err(from_js);
        }
        if i.existing.contains(key) {
            Err(need([key.to_string()]))
        } else {
            Ok(None)
        }
    }

    fn read_at(&self, key: &str, offset: u64, buf: &mut [u8]) -> Result<usize> {
        let mut i = self.inner.borrow_mut();
        if !i.open.contains_key(key) {
            return if i.existing.contains(key) { Err(need([key.to_string()])) } else { Ok(0) };
        }
        i.touch(key);
        let opts = FileSystemReadWriteOptions::new();
        opts.set_at(offset as f64);
        let o = &i.open[key];
        let n = o.handle.read_with_u8_array_and_options(buf, &opts).map_err(from_js)?;
        Ok(n as usize)
    }

    fn write_at(&mut self, key: &str, offset: u64, data: &[u8]) -> Result<()> {
        let mut i = self.inner.borrow_mut();
        let o = i.open_mut(key)?;
        let size = o.handle.get_size().map_err(from_js)? as u64;
        if offset > size {
            o.handle.truncate_with_f64(offset as f64).map_err(from_js)?; // zero-fills the gap
        }
        let opts = FileSystemReadWriteOptions::new();
        let mut done = 0usize;
        while done < data.len() {
            opts.set_at((offset + done as u64) as f64);
            let n = o
                .handle
                .write_with_u8_array_and_options(&data[done..], &opts)
                .map_err(from_js)? as usize;
            if n == 0 {
                return Err(SysError::msg(Errno::EIO, "short write"));
            }
            done += n;
        }
        o.dirty = true;
        Ok(())
    }

    fn truncate(&mut self, key: &str, size: u64) -> Result<()> {
        let mut i = self.inner.borrow_mut();
        let o = i.open_mut(key)?;
        o.handle.truncate_with_f64(size as f64).map_err(from_js)?;
        o.dirty = true;
        Ok(())
    }

    fn delete(&mut self, key: &str) -> Result<()> {
        let mut i = self.inner.borrow_mut();
        if let Some(o) = i.open.remove(key) {
            o.handle.close();
        }
        if i.existing.remove(key) {
            i.pending_remove.push(key.to_string());
        }
        Ok(())
    }

    fn prepare(&mut self, keys: &[String]) -> Result<()> {
        let i = self.inner.borrow();
        let missing: Vec<String> =
            keys.iter().filter(|k| !i.open.contains_key(*k)).cloned().collect();
        if missing.is_empty() {
            Ok(())
        } else {
            Err(need(missing))
        }
    }

    fn list_keys(&self) -> Result<Vec<String>> {
        let mut keys: Vec<String> = self.inner.borrow().existing.iter().cloned().collect();
        keys.sort();
        Ok(keys)
    }

    fn flush(&mut self) -> Result<()> {
        let mut i = self.inner.borrow_mut();
        for o in i.open.values_mut().filter(|o| o.dirty) {
            o.handle.flush().map_err(from_js)?;
            o.dirty = false;
        }
        Ok(())
    }

    fn used(&self) -> u64 {
        // Only open blobs are measurable synchronously; the facade reports
        // real usage from `navigator.storage.estimate()`.
        let i = self.inner.borrow();
        i.open.values().filter_map(|o| o.handle.get_size().ok()).map(|s| s as u64).sum()
    }
}

/// Create (if needed) and open sync access handles for `keys`. Call this when
/// an operation returned `EAGAIN`, then retry the operation.
pub(crate) async fn open_keys(
    inner: &Rc<RefCell<Inner>>,
    keys: Vec<String>,
) -> std::result::Result<(), JsValue> {
    for key in &keys {
        if inner.borrow().open.contains_key(key) {
            continue;
        }
        let (dir_name, file_name) = split_key(key);
        let dir = inner.borrow().dir(dir_name)?.clone();
        let opts = FileSystemGetFileOptions::new();
        opts.set_create(true);
        let file: FileSystemFileHandle =
            JsFuture::from(dir.get_file_handle_with_options(file_name, &opts)).await?.unchecked_into();
        let handle: FileSystemSyncAccessHandle =
            JsFuture::from(file.create_sync_access_handle()).await?.unchecked_into();

        let mut i = inner.borrow_mut();
        i.tick += 1;
        let last_used = i.tick;
        i.existing.insert(key.clone());
        i.open.insert(key.clone(), OpenFile { handle, dirty: false, last_used });
    }
    evict(inner, &keys);
    Ok(())
}

/// Close least-recently-used handles above [`MAX_OPEN`], sparing `pinned` keys
/// and the index slots.
fn evict(inner: &Rc<RefCell<Inner>>, pinned: &[String]) {
    let mut i = inner.borrow_mut();
    while i.open.len() > MAX_OPEN {
        let victim = i
            .open
            .iter()
            .filter(|(k, _)| !k.starts_with("meta/") && !pinned.contains(k))
            .min_by_key(|(_, o)| o.last_used)
            .map(|(k, _)| k.clone());
        let Some(key) = victim else { break };
        let o = i.open.remove(&key).expect("victim is open");
        let _ = o.handle.flush();
        o.handle.close();
    }
}

/// Remove files for deleted blobs. Deletion is queued synchronously by the
/// engine because `removeEntry` is async.
pub(crate) async fn collect_garbage(inner: &Rc<RefCell<Inner>>) -> std::result::Result<u32, JsValue> {
    let keys = std::mem::take(&mut inner.borrow_mut().pending_remove);
    let mut removed = 0;
    for key in keys {
        let (dir_name, file_name) = split_key(&key);
        let dir = inner.borrow().dir(dir_name)?.clone();
        match JsFuture::from(dir.remove_entry_with_options(file_name, &FileSystemRemoveOptions::new()))
            .await
        {
            Ok(_) => removed += 1,
            Err(e) if e.dyn_ref::<DomException>().is_some_and(|d| d.name() == "NotFoundError") => {}
            Err(e) => return Err(e),
        }
    }
    Ok(removed)
}
