//! Vanilla kernel module. Runs inside a dedicated Worker.
//!
//! Methods are synchronous. Any of them can throw an error with
//! `code === "EAGAIN"` and `path` listing newline-separated storage keys: call
//! `openKeys(path.split("\n"))` and retry. The TypeScript wrapper in
//! `vanilla/kernel` does this automatically.

mod opfs;

use serde::Serialize;
use tiny_vfs::{OpenFlags, SysError, Vfs, Whence};
use wasm_bindgen::prelude::*;
use web_sys::FileSystemDirectoryHandle;

use opfs::OpfsStorage;

fn js_error(e: SysError) -> JsValue {
    let err = js_sys::Error::new(&e.to_string());
    err.set_name("SysError");
    let _ = js_sys::Reflect::set(&err, &"code".into(), &e.code.as_str().into());
    if let Some(p) = &e.path {
        let _ = js_sys::Reflect::set(&err, &"path".into(), &p.as_str().into());
    }
    err.into()
}

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsValue> {
    v.serialize(&serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true))
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub struct Vanilla {
    storage: OpfsStorage,
    vfs: Option<Vfs<OpfsStorage>>,
}

#[wasm_bindgen]
impl Vanilla {
    /// `existing_keys` lists blobs already on disk, e.g. `data/12`, `meta/index.0`.
    #[wasm_bindgen(constructor)]
    pub fn new(
        data_dir: FileSystemDirectoryHandle,
        meta_dir: FileSystemDirectoryHandle,
        existing_keys: Vec<String>,
    ) -> Vanilla {
        console_error_panic_hook::set_once();
        Vanilla { storage: OpfsStorage::new(data_dir, meta_dir, existing_keys), vfs: None }
    }

    /// Load the file system, formatting it on first boot. May throw `EAGAIN`.
    pub fn mount(&mut self) -> Result<(), JsValue> {
        let mut vfs = Vfs::mount(self.storage.clone()).map_err(js_error)?;
        vfs.set_clock(Box::new(|| js_sys::Date::now() as u64));
        self.vfs = Some(vfs);
        Ok(())
    }

    /// Fold the journal into a fresh index (so the next boot has nothing to replay), close all OPFS handles,
    /// and unmount. Run `gc` afterwards to delete files of removed blobs.
    pub fn shutdown(&mut self) -> Result<(), JsValue> {
        if let Some(vfs) = self.vfs.as_mut() {
            vfs.checkpoint().map_err(js_error)?;
        }
        self.storage.close_all();
        self.vfs = None;
        Ok(())
    }

    #[wasm_bindgen(js_name = openKeys)]
    pub async fn open_keys(&self, keys: Vec<String>) -> Result<(), JsValue> {
        opfs::open_keys(&self.storage.shared(), keys).await
    }

    /// Remove files of deleted blobs. Returns how many were removed.
    pub async fn gc(&self) -> Result<u32, JsValue> {
        opfs::collect_garbage(&self.storage.shared()).await
    }

    fn fs(&mut self) -> Result<&mut Vfs<OpfsStorage>, JsValue> {
        self.vfs.as_mut().ok_or_else(|| JsValue::from_str("not mounted"))
    }

    pub fn flush(&mut self) -> Result<(), JsValue> {
        self.fs()?.flush().map_err(js_error)
    }

    /// Write a full index now and reset the journal.
    pub fn checkpoint(&mut self) -> Result<(), JsValue> {
        self.fs()?.checkpoint().map_err(js_error)
    }

    /// What the last mount had to repair: `{replayedRecords, discardedJournalBytes, orphanBlobsRemoved, ...}`.
    pub fn recovery(&mut self) -> Result<JsValue, JsValue> {
        to_js(&self.fs()?.recovery())
    }

    #[wasm_bindgen(js_name = journalStats)]
    pub fn journal_stats(&mut self) -> Result<JsValue, JsValue> {
        to_js(&self.fs()?.journal_stats())
    }

    #[wasm_bindgen(js_name = takeEvents)]
    pub fn take_events(&mut self) -> Result<JsValue, JsValue> {
        to_js(&self.fs()?.take_events())
    }

    pub fn stat(&mut self, path: &str) -> Result<JsValue, JsValue> {
        to_js(&self.fs()?.stat(path).map_err(js_error)?)
    }

    pub fn lstat(&mut self, path: &str) -> Result<JsValue, JsValue> {
        to_js(&self.fs()?.lstat(path).map_err(js_error)?)
    }

    pub fn exists(&mut self, path: &str) -> Result<bool, JsValue> {
        Ok(self.fs()?.exists(path))
    }

    pub fn realpath(&mut self, path: &str) -> Result<String, JsValue> {
        self.fs()?.realpath(path).map_err(js_error)
    }

    pub fn readdir(&mut self, path: &str) -> Result<JsValue, JsValue> {
        to_js(&self.fs()?.readdir(path).map_err(js_error)?)
    }

    pub fn chmod(&mut self, path: &str, mode: u32) -> Result<(), JsValue> {
        self.fs()?.chmod(path, mode).map_err(js_error)
    }

    /// Owner of files created by the calls that follow.
    #[wasm_bindgen(js_name = setCreds)]
    pub fn set_creds(&mut self, uid: u32, gid: u32) -> Result<(), JsValue> {
        // Before mount there is nothing to own yet.
        if let Some(vfs) = self.vfs.as_mut() {
            vfs.set_creds(uid, gid);
        }
        Ok(())
    }

    /// `uid` / `gid` of -1 leave that field alone.
    pub fn chown(&mut self, path: &str, uid: f64, gid: f64) -> Result<(), JsValue> {
        let opt = |v: f64| if v < 0.0 { None } else { Some(v as u32) };
        self.fs()?.chown(path, opt(uid), opt(gid)).map_err(js_error)
    }

    pub fn utimes(&mut self, path: &str, atime: f64, mtime: f64) -> Result<(), JsValue> {
        self.fs()?.utimes(path, atime as u64, mtime as u64).map_err(js_error)
    }

    pub fn statfs(&mut self) -> Result<JsValue, JsValue> {
        to_js(&self.fs()?.statfs())
    }

    pub fn setxattr(&mut self, path: &str, name: &str, value: &str) -> Result<(), JsValue> {
        self.fs()?.setxattr(path, name, value).map_err(js_error)
    }

    pub fn getxattr(&mut self, path: &str, name: &str) -> Result<Option<String>, JsValue> {
        self.fs()?.getxattr(path, name).map_err(js_error)
    }

    pub fn listxattr(&mut self, path: &str) -> Result<Vec<String>, JsValue> {
        self.fs()?.listxattr(path).map_err(js_error)
    }

    pub fn removexattr(&mut self, path: &str, name: &str) -> Result<(), JsValue> {
        self.fs()?.removexattr(path, name).map_err(js_error)
    }

    pub fn mkdir(&mut self, path: &str, mode: u32, recursive: bool) -> Result<(), JsValue> {
        self.fs()?.mkdir(path, mode, recursive).map_err(js_error)
    }

    pub fn rmdir(&mut self, path: &str) -> Result<(), JsValue> {
        self.fs()?.rmdir(path).map_err(js_error)
    }

    pub fn unlink(&mut self, path: &str) -> Result<(), JsValue> {
        self.fs()?.unlink(path).map_err(js_error)
    }

    #[wasm_bindgen(js_name = removeAll)]
    pub fn remove_all(&mut self, path: &str) -> Result<(), JsValue> {
        self.fs()?.remove_all(path).map_err(js_error)
    }

    pub fn symlink(&mut self, target: &str, path: &str) -> Result<(), JsValue> {
        self.fs()?.symlink(target, path).map_err(js_error)
    }

    pub fn readlink(&mut self, path: &str) -> Result<String, JsValue> {
        self.fs()?.readlink(path).map_err(js_error)
    }

    pub fn rename(&mut self, from: &str, to: &str) -> Result<(), JsValue> {
        self.fs()?.rename(from, to).map_err(js_error)
    }

    pub fn copy(&mut self, from: &str, to: &str, recursive: bool) -> Result<(), JsValue> {
        self.fs()?.copy(from, to, recursive).map_err(js_error)
    }

    pub fn truncate(&mut self, path: &str, size: f64) -> Result<(), JsValue> {
        self.fs()?.truncate(path, size as u64).map_err(js_error)
    }

    pub fn open(&mut self, path: &str, flags: u32, mode: u32) -> Result<u32, JsValue> {
        self.fs()?.open(path, OpenFlags(flags), mode).map_err(js_error)
    }

    pub fn close(&mut self, fd: u32) -> Result<(), JsValue> {
        self.fs()?.close(fd).map_err(js_error)
    }

    /// Pass `offset` for a positional read that leaves the handle position alone.
    pub fn read(&mut self, fd: u32, len: u32, offset: Option<f64>) -> Result<Vec<u8>, JsValue> {
        let mut buf = vec![0u8; len as usize];
        let n = self.fs()?.read(fd, &mut buf, offset.map(|o| o as u64)).map_err(js_error)?;
        buf.truncate(n);
        Ok(buf)
    }

    pub fn write(&mut self, fd: u32, data: &[u8], offset: Option<f64>) -> Result<u32, JsValue> {
        let n = self.fs()?.write(fd, data, offset.map(|o| o as u64)).map_err(js_error)?;
        Ok(n as u32)
    }

    /// `whence`: 0 = start, 1 = current, 2 = end.
    pub fn lseek(&mut self, fd: u32, offset: f64, whence: u8) -> Result<f64, JsValue> {
        let whence = match whence {
            0 => Whence::Set,
            1 => Whence::Cur,
            2 => Whence::End,
            _ => return Err(js_error(SysError::new(tiny_vfs::Errno::EINVAL))),
        };
        self.fs()?.lseek(fd, offset as i64, whence).map(|p| p as f64).map_err(js_error)
    }

    pub fn fstat(&mut self, fd: u32) -> Result<JsValue, JsValue> {
        to_js(&self.fs()?.fstat(fd).map_err(js_error)?)
    }

    pub fn ftruncate(&mut self, fd: u32, size: f64) -> Result<(), JsValue> {
        self.fs()?.ftruncate(fd, size as u64).map_err(js_error)
    }

    #[wasm_bindgen(js_name = readFile)]
    pub fn read_file(&mut self, path: &str) -> Result<Vec<u8>, JsValue> {
        self.fs()?.read_file(path).map_err(js_error)
    }

    #[wasm_bindgen(js_name = writeFile)]
    pub fn write_file(&mut self, path: &str, data: &[u8]) -> Result<(), JsValue> {
        self.fs()?.write_file(path, data).map_err(js_error)
    }

    #[wasm_bindgen(js_name = writeFileAtomic)]
    pub fn write_file_atomic(&mut self, path: &str, data: &[u8]) -> Result<(), JsValue> {
        self.fs()?.write_file_atomic(path, data).map_err(js_error)
    }

    pub fn trash(&mut self, path: &str, trash_dir: &str) -> Result<String, JsValue> {
        self.fs()?.trash(path, trash_dir).map_err(js_error)
    }

    pub fn restore(&mut self, path: &str) -> Result<String, JsValue> {
        self.fs()?.restore(path).map_err(js_error)
    }

    #[wasm_bindgen(js_name = emptyTrash)]
    pub fn empty_trash(&mut self, trash_dir: &str) -> Result<(), JsValue> {
        self.fs()?.empty_trash(trash_dir).map_err(js_error)
    }
}
