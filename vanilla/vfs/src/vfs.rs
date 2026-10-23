use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::error::{Errno, Result, SysError};
use crate::path::{components, join, parent_and_name, split, validate_name};
use crate::storage::Storage;
use crate::types::*;

const ROOT: u64 = 1;
/// Persistence is a full index plus a journal of changes since.
///
/// The index alternates between two slots so a torn write only ever damages the older copy. Each slot is
/// `MAGIC | seq | length | fnv1a | payload`. The journal (`meta/wal`) is a sequence of frames with the same
/// layout (magic `TWAL`), one per flush, each carrying only the inodes that changed. `seq` counts durable
/// changes: a slot with seq N holds everything up to N, and journal records N+1, N+2, ... follow it.
/// Mount applies the contiguous run of intact records after the newest intact slot and drops the rest.
const INDEX_SLOTS: [&str; 2] = ["meta/index.0", "meta/index.1"];
const INDEX_MAGIC: &[u8; 4] = b"TVFS";
const WAL_KEY: &str = "meta/wal";
const WAL_MAGIC: &[u8; 4] = b"TWAL";
const INDEX_HEADER: usize = 4 + 8 + 8 + 8;
/// Version 2 added the journal. Version 1 indexes are read and upgraded.
const INDEX_VERSION: u32 = 2;
/// The journal is folded into a new full index once it outgrows this or the last index, whichever is larger.
const WAL_CHECKPOINT_MIN: u64 = 256 * 1024;
const MAX_SYMLINKS: u32 = 40;
const COPY_CHUNK: usize = 64 * 1024;
const ORIGIN_XATTR: &str = "tiny.trash.origin";

/// Directories created on first boot (see `contracts/filesystem.md`).
const DEFAULT_DIRS: &[(&str, u32)] = &[
    ("/System", 0o755),
    ("/Applications", 0o755),
    ("/Users", 0o755),
    ("/Volumes", 0o755),
    ("/tmp", 0o1777),
    ("/dev", 0o755),
    ("/etc", 0o755),
    ("/var", 0o755),
    ("/var/log", 0o755),
];

#[derive(Debug, Clone, Copy)]
pub struct Options {
    /// Case-sensitive names. The default is case-insensitive, as on macOS.
    pub case_sensitive: bool,
    pub umask: u32,
}

impl Default for Options {
    fn default() -> Self {
        Options { case_sensitive: false, umask: 0o022 }
    }
}

#[derive(Serialize, Deserialize)]
struct Index {
    version: u32,
    case_sensitive: bool,
    next_id: u64,
    inodes: BTreeMap<u64, Inode>,
}

/// `Index` for writing: borrows the table instead of cloning it.
#[derive(Serialize)]
struct IndexRef<'a> {
    version: u32,
    case_sensitive: bool,
    next_id: u64,
    inodes: &'a BTreeMap<u64, Inode>,
}

/// One journal record: the inodes that changed (whole, directories included) and the ones that are gone.
#[derive(Serialize)]
struct WalRecordRef<'a> {
    next_id: u64,
    upserts: Vec<(u64, &'a Inode)>,
    removed: Vec<u64>,
}

#[derive(Deserialize)]
struct WalRecord {
    next_id: u64,
    upserts: Vec<(u64, Inode)>,
    removed: Vec<u64>,
}

struct OpenFile {
    ino: u64,
    flags: OpenFlags,
    pos: u64,
    path: String,
    notified: bool,
}

struct Walk {
    id: u64,
    parent: u64,
    name: String,
    /// Canonical absolute path: symlinks resolved, `.`/`..` removed, stored spelling.
    canon: String,
}

pub struct Vfs<S: Storage> {
    storage: S,
    inodes: BTreeMap<u64, Inode>,
    next_id: u64,
    case_sensitive: bool,
    umask: u32,
    /// Owner given to files and directories created from now on (set by the kernel per call).
    creds: (u32, u32),
    handles: HashMap<u32, OpenFile>,
    next_fd: u32,
    events: Vec<FsEvent>,
    /// Something changed since the last flush.
    dirty: bool,
    /// Inodes touched since the last flush; the next journal record carries exactly these.
    dirty_inodes: BTreeSet<u64>,
    /// Sequence number of the newest durable change; the next flush writes `+ 1`.
    seq: u64,
    /// Which index slot holds the newest full index. A checkpoint writes the other one, so the newest intact
    /// index is never overwritten while the journal that follows it is still needed.
    newest_slot: usize,
    /// Bytes in the journal that belong to it (the append position), and the size of the last full index.
    wal_len: u64,
    index_len: u64,
    /// The next flush must write a full index (first format, an upgrade, or a failed journal append).
    checkpoint_due: bool,
    /// Blobs of removed files. They are deleted only once the index that no longer mentions them is durable,
    /// or a crash would leave a file whose data is gone.
    pending_deletes: Vec<String>,
    /// Files whose blob is known not to extend past `size`. A crash can leave extra bytes after the end;
    /// they must never become visible when the file grows again.
    verified: HashSet<u64>,
    recovery: Recovery,
    stats: JournalStats,
    clock: Box<dyn Fn() -> u64>,
}

fn fnv1a(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in data {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn encode_frame(magic: &[u8; 4], seq: u64, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(INDEX_HEADER + payload.len());
    out.extend_from_slice(magic);
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    out.extend_from_slice(&fnv1a(payload).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/// Parses the frame at the start of `bytes`: `(seq, payload, total frame length)` if it is complete and intact.
fn decode_frame<'a>(magic: &[u8; 4], bytes: &'a [u8]) -> Option<(u64, &'a [u8], usize)> {
    if bytes.len() < INDEX_HEADER || &bytes[..4] != magic {
        return None;
    }
    let word = |i: usize| u64::from_le_bytes(bytes[i..i + 8].try_into().expect("8 bytes"));
    let (seq, len, hash) = (word(4), word(12) as usize, word(20));
    let end = INDEX_HEADER.checked_add(len)?;
    let payload = bytes.get(INDEX_HEADER..end)?;
    (fnv1a(payload) == hash).then_some((seq, payload, end))
}

/// Returns `(seq, payload)` if the slot is complete and intact.
fn decode_index(bytes: &[u8]) -> Option<(u64, &[u8])> {
    decode_frame(INDEX_MAGIC, bytes).map(|(seq, payload, _)| (seq, payload))
}

fn default_clock() -> Box<dyn Fn() -> u64> {
    #[cfg(target_arch = "wasm32")]
    {
        // `SystemTime` is unavailable on wasm32-unknown-unknown; the host
        // installs a real clock with `set_clock`.
        Box::new(|| 0)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        Box::new(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        })
    }
}

fn data_key(ino: u64) -> String {
    format!("data/{ino}")
}

impl<S: Storage> Vfs<S> {
    /// Formats a new file system with default options if none exists.
    ///
    /// Empty index slots count as never written: a backend may create the blob
    /// (and then ask the caller to retry) before the first format completes.
    pub fn mount(mut storage: S) -> Result<Self> {
        // Everything mount reads must be open before it reads anything (lazy backends answer `EAGAIN`).
        storage.prepare(&[INDEX_SLOTS[0].to_string(), INDEX_SLOTS[1].to_string(), WAL_KEY.to_string()])?;
        // Newest intact slot wins; a torn newer slot falls back to the older one.
        let mut best: Option<(u64, Vec<u8>, usize)> = None;
        let mut written = 0;
        for (slot, key) in INDEX_SLOTS.into_iter().enumerate() {
            let Some(bytes) = storage.get(key)? else { continue };
            if bytes.is_empty() {
                continue;
            }
            written += 1;
            if let Some((seq, payload)) = decode_index(&bytes) {
                if best.as_ref().is_none_or(|(g, _, _)| seq > *g) {
                    best = Some((seq, payload.to_vec(), slot));
                }
            }
        }
        match best {
            Some((seq, payload, slot)) => Self::load(storage, seq, slot, &payload),
            // Nothing, or a single damaged slot: only the very first format
            // ever ran, so there is no user data to lose.
            None if written <= 1 => Self::format(storage, Options::default()),
            None => Err(SysError::msg(Errno::EIO, "corrupt index: no intact slot")),
        }
    }

    pub fn format(storage: S, opts: Options) -> Result<Self> {
        let mut vfs = Self::blank(storage, opts.case_sensitive, opts.umask);
        vfs.dirty = true;
        vfs.checkpoint_due = true;
        let now = vfs.now();
        vfs.inodes.insert(ROOT, new_inode(FileType::Dir, 0o755, now, None));
        vfs.dirty_inodes.insert(ROOT);
        for (path, mode) in DEFAULT_DIRS {
            let (parent, name) = parent_and_name(path).expect("default dir has a name");
            let w = vfs.resolve(&split(&parent)?, true)?;
            vfs.create_node(w.id, &name, FileType::Dir, *mode, None)?;
        }
        vfs.flush()?;
        Ok(vfs)
    }

    fn blank(storage: S, case_sensitive: bool, umask: u32) -> Self {
        Vfs {
            storage,
            inodes: BTreeMap::new(),
            next_id: ROOT + 1,
            case_sensitive,
            umask,
            creds: (0, 0),
            handles: HashMap::new(),
            next_fd: 3,
            events: Vec::new(),
            dirty: false,
            dirty_inodes: BTreeSet::new(),
            seq: 0,
            newest_slot: 0, // so the first index goes to slot 1
            wal_len: 0,
            index_len: 0,
            checkpoint_due: false,
            pending_deletes: Vec::new(),
            verified: HashSet::new(),
            recovery: Recovery::default(),
            stats: JournalStats::default(),
            clock: default_clock(),
        }
    }

    fn load(storage: S, seq: u64, newest_slot: usize, payload: &[u8]) -> Result<Self> {
        let index: Index = serde_json::from_slice(payload)
            .map_err(|e| SysError::msg(Errno::EIO, format!("corrupt index: {e}")))?;
        if index.version == 0 || index.version > INDEX_VERSION {
            return Err(SysError::msg(
                Errno::EIO,
                format!("unsupported index version {}", index.version),
            ));
        }
        let upgrade = index.version < INDEX_VERSION;
        let mut vfs = Self::blank(storage, index.case_sensitive, Options::default().umask);
        vfs.inodes = index.inodes;
        vfs.next_id = index.next_id;
        vfs.seq = seq;
        vfs.newest_slot = newest_slot;
        vfs.index_len = payload.len() as u64;
        // A version 1 index has no journal; write a version 2 one before appending anything an old reader would ignore.
        vfs.checkpoint_due = upgrade;
        vfs.recovery.upgraded_index = upgrade;
        vfs.replay_journal()?;
        if !vfs.inodes.contains_key(&ROOT) {
            return Err(SysError::msg(Errno::EIO, "corrupt index: no root directory"));
        }
        vfs.dirty = vfs.checkpoint_due;

        // Unlinked-but-open files from a previous session are unreachable.
        let orphans: Vec<u64> =
            vfs.inodes.iter().filter(|(_, n)| n.nlink == 0).map(|(id, _)| *id).collect();
        vfs.recovery.unlinked_files_freed = orphans.len() as u32;
        for id in orphans {
            vfs.free(id);
        }
        vfs.sweep_orphan_blobs()?;
        Ok(vfs)
    }

    /// Apply the journal records that follow the loaded index, and trim whatever is torn or stale.
    fn replay_journal(&mut self) -> Result<()> {
        let wal = self.storage.get(WAL_KEY)?.unwrap_or_default();
        let base = self.seq;
        let mut off = 0usize;
        let mut applied = 0u32;
        while let Some((seq, payload, len)) = decode_frame(WAL_MAGIC, &wal[off..]) {
            if seq <= base {
                off += len; // folded into the index already (a crash between writing it and resetting the journal)
                continue;
            }
            if seq != self.seq + 1 {
                break; // a gap: nothing after it can be trusted
            }
            let Ok(rec) = serde_json::from_slice::<WalRecord>(payload) else { break };
            for id in rec.removed {
                self.inodes.remove(&id);
            }
            for (id, inode) in rec.upserts {
                self.inodes.insert(id, inode);
            }
            self.next_id = rec.next_id;
            self.seq = seq;
            applied += 1;
            off += len;
        }
        self.recovery.replayed_records = applied;
        if applied == 0 {
            off = 0; // only stale records, or none
        }
        if wal.len() > off {
            self.recovery.discarded_journal_bytes = (wal.len() - off) as u64;
            // Drop the tail so new records are appended to intact ones, never behind garbage.
            self.storage.truncate(WAL_KEY, off as u64)?;
        }
        self.wal_len = off as u64;
        Ok(())
    }

    /// Delete data blobs that belong to no file. A crash between writing a file's data and journalling the
    /// file leaves these behind.
    fn sweep_orphan_blobs(&mut self) -> Result<()> {
        for key in self.storage.list_keys()? {
            let Some(id) = key.strip_prefix("data/").and_then(|n| n.parse::<u64>().ok()) else { continue };
            if self.inodes.get(&id).is_none_or(|n| n.kind != FileType::File) {
                self.storage.delete(&key)?;
                self.recovery.orphan_blobs_removed += 1;
            }
        }
        Ok(())
    }

    /// Make every change so far durable. Cheap when nothing changed. Normally appends one journal record with
    /// just the inodes that changed; a full index is written when the journal has grown past the index.
    pub fn flush(&mut self) -> Result<()> {
        if !self.dirty {
            return Ok(());
        }
        self.write_journal(false)
    }

    /// Like `flush`, but folds the journal into a fresh full index, so the next mount has nothing to replay.
    pub fn checkpoint(&mut self) -> Result<()> {
        if !self.dirty && self.wal_len == 0 && !self.checkpoint_due {
            return Ok(());
        }
        self.write_journal(true)
    }

    fn write_journal(&mut self, force_checkpoint: bool) -> Result<()> {
        let seq = self.seq + 1;
        let record = {
            let upserts: Vec<(u64, &Inode)> =
                self.dirty_inodes.iter().filter_map(|id| self.inodes.get(id).map(|n| (*id, n))).collect();
            let removed: Vec<u64> =
                self.dirty_inodes.iter().filter(|id| !self.inodes.contains_key(id)).copied().collect();
            let payload = serde_json::to_vec(&WalRecordRef { next_id: self.next_id, upserts, removed })
                .map_err(|e| SysError::msg(Errno::EIO, format!("serialize journal: {e}")))?;
            encode_frame(WAL_MAGIC, seq, &payload)
        };
        let checkpoint = force_checkpoint
            || self.checkpoint_due
            || self.wal_len + record.len() as u64 > WAL_CHECKPOINT_MIN.max(self.index_len);

        let target = 1 - self.newest_slot;
        let slot = INDEX_SLOTS[target];
        let keys: Vec<String> = if checkpoint { vec![slot.to_string(), WAL_KEY.to_string()] } else { vec![WAL_KEY.to_string()] };
        self.storage.prepare(&keys)?;
        // Data blobs must be durable before metadata that refers to them.
        self.storage.flush()?;

        if checkpoint {
            let payload = serde_json::to_vec(&IndexRef {
                version: INDEX_VERSION,
                case_sensitive: self.case_sensitive,
                next_id: self.next_id,
                inodes: &self.inodes,
            })
            .map_err(|e| SysError::msg(Errno::EIO, format!("serialize index: {e}")))?;
            self.storage.put(slot, &encode_frame(INDEX_MAGIC, seq, &payload))?;
            self.storage.flush()?;
            // The new index is durable and covers everything: from here on it is the truth.
            self.seq = seq;
            self.newest_slot = target;
            self.index_len = payload.len() as u64;
            self.checkpoint_due = false;
            self.stats.checkpoints += 1;
            // Resetting the journal is housekeeping: leftover records are skipped on mount because their seq is old.
            if self.storage.truncate(WAL_KEY, 0).is_ok() {
                self.wal_len = 0;
            }
        } else {
            let appended = self.storage.write_at(WAL_KEY, self.wal_len, &record).and_then(|_| self.storage.flush());
            if let Err(e) = appended {
                // A partial record may sit at the end. Cut it off if possible, and make the next flush write a
                // full index (which resets the journal) so nothing is ever appended behind garbage.
                let _ = self.storage.truncate(WAL_KEY, self.wal_len);
                self.checkpoint_due = true;
                return Err(e);
            }
            self.wal_len += record.len() as u64;
            self.seq = seq;
            self.stats.records += 1;
        }
        self.dirty = false;
        self.dirty_inodes.clear();
        // The index no longer mentions these files: now their data can go.
        for key in std::mem::take(&mut self.pending_deletes) {
            let _ = self.storage.delete(&key); // best effort; a leftover blob is swept on the next mount
        }
        Ok(())
    }

    pub fn recovery(&self) -> Recovery {
        self.recovery
    }

    pub fn journal_stats(&self) -> JournalStats {
        JournalStats { seq: self.seq, journal_bytes: self.wal_len, index_bytes: self.index_len, ..self.stats }
    }

    pub fn set_clock(&mut self, clock: Box<dyn Fn() -> u64>) {
        self.clock = clock;
    }

    pub fn storage(&self) -> &S {
        &self.storage
    }

    pub fn storage_mut(&mut self) -> &mut S {
        &mut self.storage
    }

    pub fn into_storage(self) -> S {
        self.storage
    }

    pub fn take_events(&mut self) -> Vec<FsEvent> {
        std::mem::take(&mut self.events)
    }

    fn now(&self) -> u64 {
        (self.clock)()
    }

    fn fold(&self, name: &str) -> String {
        if self.case_sensitive {
            name.to_string()
        } else {
            name.to_lowercase()
        }
    }

    fn node(&self, id: u64) -> &Inode {
        self.inodes.get(&id).expect("inode table is consistent")
    }

    fn node_mut(&mut self, id: u64) -> &mut Inode {
        // Every change to an inode goes through here, so the journal record can list exactly what changed.
        self.dirty_inodes.insert(id);
        self.dirty = true;
        self.inodes.get_mut(&id).expect("inode table is consistent")
    }

    fn handle(&self, fd: u32) -> Result<&OpenFile> {
        self.handles.get(&fd).ok_or_else(|| SysError::new(Errno::EBADF))
    }

    fn masked(&self, mode: u32) -> u32 {
        mode & 0o7777 & !self.umask
    }

    fn stamp_modified(&mut self, id: u64) -> &mut Inode {
        let now = self.now();
        let n = self.node_mut(id);
        n.mtime = now;
        n.ctime = now;
        n
    }

    fn child_names(&self, id: u64) -> Vec<String> {
        self.node(id).children.values().map(|e| e.name.clone()).collect()
    }

    fn lookup(&self, dir: u64, name: &str) -> Option<u64> {
        self.node(dir).children.get(&self.fold(name)).map(|e| e.ino)
    }

    fn emit(&mut self, kind: FsEventKind, path: String, old_path: Option<String>) {
        // Repeated modifications of one file collapse into a single event.
        // This also hides the duplicate a retried (`EAGAIN`) write would emit.
        if kind == FsEventKind::Modified {
            if let Some(last) = self.events.last() {
                if last.kind == kind && last.path == path {
                    return;
                }
            }
        }
        self.events.push(FsEvent { kind, path, old_path });
    }

    /// Walk `comps` from the root. Intermediate symlinks are always followed;
    /// the last one only if `follow_last`.
    fn resolve(&self, comps: &[String], follow_last: bool) -> Result<Walk> {
        let mut queue: VecDeque<String> = comps.iter().cloned().collect();
        let mut stack = vec![ROOT];
        let mut names: Vec<String> = Vec::new();
        let mut links = 0;

        while let Some(c) = queue.pop_front() {
            if c == "." {
                continue;
            }
            if c == ".." {
                if stack.len() > 1 {
                    stack.pop();
                    names.pop();
                }
                continue;
            }
            let cur = *stack.last().expect("stack never empty");
            let dir = self.node(cur);
            if dir.kind != FileType::Dir {
                return Err(SysError::new(Errno::ENOTDIR));
            }
            let entry = dir
                .children
                .get(&self.fold(&c))
                .ok_or_else(|| SysError::new(Errno::ENOENT))?;
            let child = self.node(entry.ino);
            let is_last = queue.is_empty();
            if child.kind == FileType::Symlink && (!is_last || follow_last) {
                links += 1;
                if links > MAX_SYMLINKS {
                    return Err(SysError::new(Errno::ELOOP));
                }
                let target = child.target.clone().unwrap_or_default();
                if target.starts_with('/') {
                    stack.truncate(1);
                    names.clear();
                }
                for t in split(&target)?.into_iter().rev() {
                    queue.push_front(t);
                }
                continue;
            }
            stack.push(entry.ino);
            names.push(entry.name.clone());
        }

        let id = *stack.last().expect("stack never empty");
        let parent = if stack.len() >= 2 { stack[stack.len() - 2] } else { ROOT };
        let canon = if names.is_empty() { "/".to_string() } else { format!("/{}", names.join("/")) };
        Ok(Walk { id, parent, name: names.last().cloned().unwrap_or_default(), canon })
    }

    fn walk(&self, path: &str, follow_last: bool) -> Result<Walk> {
        let comps = components(path)?;
        self.resolve(&comps, follow_last).map_err(|e| e.with_path(path))
    }

    /// Resolve everything but the last component, which must be a valid new name.
    /// Returns (parent id, name, parent canonical path).
    fn walk_parent(&self, path: &str) -> Result<(u64, String, String)> {
        let mut comps = components(path)?;
        let Some(name) = comps.pop() else {
            return Err(SysError::msg(Errno::EINVAL, "path has no parent").with_path(path));
        };
        validate_name(&name).map_err(|e| e.with_path(path))?;
        let w = self.resolve(&comps, true).map_err(|e| e.with_path(path))?;
        if self.node(w.id).kind != FileType::Dir {
            return Err(SysError::new(Errno::ENOTDIR).with_path(path));
        }
        Ok((w.id, name, w.canon))
    }

    fn insert_entry(&mut self, parent: u64, name: &str, id: u64) {
        let key = self.fold(name);
        self.stamp_modified(parent).children.insert(key, Entry { name: name.to_string(), ino: id });
    }

    fn remove_entry(&mut self, parent: u64, name: &str) -> Option<u64> {
        let key = self.fold(name);
        let removed = self.node_mut(parent).children.remove(&key).map(|e| e.ino);
        if removed.is_some() {
            self.stamp_modified(parent);
        }
        removed
    }

    fn create_node(
        &mut self,
        parent: u64,
        name: &str,
        kind: FileType,
        mode: u32,
        target: Option<String>,
    ) -> Result<u64> {
        validate_name(name)?;
        if self.lookup(parent, name).is_some() {
            return Err(SysError::new(Errno::EEXIST));
        }
        let id = self.next_id;
        self.next_id += 1;
        let now = self.now();
        let mut node = new_inode(kind, mode, now, target);
        node.uid = self.creds.0;
        node.gid = self.creds.1;
        self.inodes.insert(id, node);
        self.dirty_inodes.insert(id);
        self.verified.insert(id); // brand new: no blob yet, nothing stale to hide
        self.insert_entry(parent, name, id);
        Ok(id)
    }

    fn create_at(&mut self, path: &str, kind: FileType, mode: u32, target: Option<String>) -> Result<u64> {
        let (parent, name, pcanon) = self.walk_parent(path)?;
        let id = self.create_node(parent, &name, kind, mode, target).map_err(|e| e.with_path(path))?;
        self.emit(FsEventKind::Created, join(&pcanon, &name), None);
        Ok(id)
    }

    fn has_open_handles(&self, ino: u64) -> bool {
        self.handles.values().any(|h| h.ino == ino)
    }

    /// Called after an inode lost its last directory entry.
    fn orphan(&mut self, id: u64) {
        self.node_mut(id).nlink = 0;
        self.maybe_free(id);
    }

    fn maybe_free(&mut self, id: u64) {
        if self.inodes.get(&id).is_some_and(|n| n.nlink == 0) && !self.has_open_handles(id) {
            self.free(id);
        }
    }

    fn free(&mut self, id: u64) {
        if let Some(n) = self.inodes.remove(&id) {
            if n.kind == FileType::File {
                // Not yet: until the index that forgets this file is durable, a crash would bring the file back.
                self.pending_deletes.push(data_key(id));
            }
            self.verified.remove(&id);
            self.dirty_inodes.insert(id);
            self.dirty = true;
        }
    }

    /// Run a storage operation; if the device is full but removed files are only waiting for a flush to give
    /// their space back, flush and try once more.
    fn with_space<T>(&mut self, mut op: impl FnMut(&mut S) -> Result<T>) -> Result<T> {
        match op(&mut self.storage) {
            Err(e) if e.code == Errno::ENOSPC && !self.pending_deletes.is_empty() => {
                self.flush()?;
                op(&mut self.storage)
            }
            other => other,
        }
    }

    /// Before a file grows or is cut, make sure its blob does not extend past its recorded size. Writes that
    /// reached the blob before a crash but never reached the index would otherwise reappear as stale data in
    /// the gap when the file is extended. Idempotent, and changes nothing the index records.
    fn verify_blob(&mut self, id: u64) -> Result<()> {
        if self.verified.contains(&id) {
            return Ok(());
        }
        let size = self.node(id).size;
        let key = data_key(id);
        if let Some(len) = self.storage.len(&key)? {
            if len > size {
                self.storage.truncate(&key, size)?;
            }
        }
        self.verified.insert(id);
        Ok(())
    }

    fn set_size(&mut self, id: u64, size: u64) -> Result<()> {
        self.verify_blob(id)?;
        let key = data_key(id);
        self.with_space(|st| st.truncate(&key, size))?;
        self.stamp_modified(id).size = size;
        Ok(())
    }

    fn stat_of(&self, id: u64) -> Stat {
        let n = self.node(id);
        Stat {
            ino: id,
            kind: n.kind,
            mode: n.mode,
            uid: n.uid,
            gid: n.gid,
            size: n.size,
            nlink: n.nlink,
            atime: n.atime,
            mtime: n.mtime,
            ctime: n.ctime,
            birthtime: n.birthtime,
        }
    }

    fn is_within(&self, path: &str, ancestor: &str) -> bool {
        let p = self.fold(path);
        let a = self.fold(ancestor);
        p == a || p.starts_with(&format!("{}/", a.trim_end_matches('/')))
    }

    pub fn open(&mut self, path: &str, flags: OpenFlags, mode: u32) -> Result<u32> {
        let comps = components(path)?;
        let existing = match self.resolve(&comps, true) {
            Ok(w) => Some(w),
            Err(e) if e.code == Errno::ENOENT && flags.has(OpenFlags::CREAT) => None,
            Err(e) => return Err(e.with_path(path)),
        };

        let (ino, canon) = match existing {
            Some(w) => {
                if flags.has(OpenFlags::CREAT) && flags.has(OpenFlags::EXCL) {
                    return Err(SysError::new(Errno::EEXIST).with_path(path));
                }
                let kind = self.node(w.id).kind;
                if kind == FileType::Dir && (flags.writable() || flags.has(OpenFlags::TRUNC)) {
                    return Err(SysError::new(Errno::EISDIR).with_path(path));
                }
                if flags.has(OpenFlags::DIRECTORY) && kind != FileType::Dir {
                    return Err(SysError::new(Errno::ENOTDIR).with_path(path));
                }
                if flags.has(OpenFlags::TRUNC) && flags.writable() {
                    self.set_size(w.id, 0)?;
                    self.emit(FsEventKind::Modified, w.canon.clone(), None);
                }
                (w.id, w.canon)
            }
            None => {
                let (parent, name, pcanon) = self.walk_parent(path)?;
                if self.lookup(parent, &name).is_some() {
                    // The name exists but did not resolve: a dangling symlink.
                    return Err(SysError::new(Errno::ENOENT).with_path(path));
                }
                let mode = self.masked(mode);
                let id = self
                    .create_node(parent, &name, FileType::File, mode, None)
                    .map_err(|e| e.with_path(path))?;
                let canon = join(&pcanon, &name);
                self.emit(FsEventKind::Created, canon.clone(), None);
                (id, canon)
            }
        };

        let fd = self.next_fd;
        self.next_fd += 1;
        self.handles.insert(fd, OpenFile { ino, flags, pos: 0, path: canon, notified: false });
        Ok(fd)
    }

    pub fn close(&mut self, fd: u32) -> Result<()> {
        let h = self.handles.remove(&fd).ok_or_else(|| SysError::new(Errno::EBADF))?;
        self.maybe_free(h.ino);
        Ok(())
    }

    /// Read into `buf`. With `offset == None`, reads at and advances the
    /// handle position. Returns bytes read (0 at end of file).
    pub fn read(&mut self, fd: u32, buf: &mut [u8], offset: Option<u64>) -> Result<usize> {
        let h = self.handle(fd)?;
        if !h.flags.readable() {
            return Err(SysError::new(Errno::EBADF));
        }
        let (ino, off) = (h.ino, offset.unwrap_or(h.pos));
        let node = self.node(ino);
        if node.kind == FileType::Dir {
            return Err(SysError::new(Errno::EISDIR));
        }
        if off >= node.size {
            return Ok(0);
        }
        let n = (buf.len() as u64).min(node.size - off) as usize;
        let got = self.storage.read_at(&data_key(ino), off, &mut buf[..n])?;
        buf[got..n].fill(0); // sparse tail
        if offset.is_none() {
            self.handles.get_mut(&fd).expect("checked above").pos = off + n as u64;
        }
        Ok(n)
    }

    /// Write `data`. With `offset == None`, writes at and advances the handle
    /// position (or at end of file for `APPEND` handles).
    pub fn write(&mut self, fd: u32, data: &[u8], offset: Option<u64>) -> Result<usize> {
        let h = self.handle(fd)?;
        if !h.flags.writable() {
            return Err(SysError::new(Errno::EBADF));
        }
        let ino = h.ino;
        let off = if h.flags.has(OpenFlags::APPEND) {
            self.node(ino).size
        } else {
            offset.unwrap_or(h.pos)
        };
        self.verify_blob(ino)?;
        let key = data_key(ino);
        self.with_space(|st| st.write_at(&key, off, data))?;

        let end = off + data.len() as u64;
        let n = self.stamp_modified(ino);
        n.size = n.size.max(end);

        let h = self.handles.get_mut(&fd).expect("checked above");
        if offset.is_none() {
            h.pos = end;
        }
        if !h.notified {
            h.notified = true;
            let path = h.path.clone();
            self.emit(FsEventKind::Modified, path, None);
        }
        Ok(data.len())
    }

    pub fn lseek(&mut self, fd: u32, offset: i64, whence: Whence) -> Result<u64> {
        let h = self.handle(fd)?;
        let base = match whence {
            Whence::Set => 0,
            Whence::Cur => h.pos as i64,
            Whence::End => self.node(h.ino).size as i64,
        };
        let pos = base
            .checked_add(offset)
            .filter(|p| *p >= 0)
            .ok_or_else(|| SysError::new(Errno::EINVAL))?;
        self.handles.get_mut(&fd).expect("checked above").pos = pos as u64;
        Ok(pos as u64)
    }

    pub fn fstat(&self, fd: u32) -> Result<Stat> {
        let h = self.handle(fd)?;
        Ok(self.stat_of(h.ino))
    }

    pub fn ftruncate(&mut self, fd: u32, size: u64) -> Result<()> {
        let h = self.handle(fd)?;
        if !h.flags.writable() {
            return Err(SysError::new(Errno::EBADF));
        }
        let (ino, path) = (h.ino, h.path.clone());
        self.set_size(ino, size)?;
        self.emit(FsEventKind::Modified, path, None);
        Ok(())
    }

    pub fn stat(&self, path: &str) -> Result<Stat> {
        Ok(self.stat_of(self.walk(path, true)?.id))
    }

    pub fn lstat(&self, path: &str) -> Result<Stat> {
        Ok(self.stat_of(self.walk(path, false)?.id))
    }

    pub fn exists(&self, path: &str) -> bool {
        self.walk(path, true).is_ok()
    }

    pub fn realpath(&self, path: &str) -> Result<String> {
        Ok(self.walk(path, true)?.canon)
    }

    pub fn readdir(&self, path: &str) -> Result<Vec<DirEntry>> {
        let w = self.walk(path, true)?;
        let dir = self.node(w.id);
        if dir.kind != FileType::Dir {
            return Err(SysError::new(Errno::ENOTDIR).with_path(path));
        }
        Ok(dir
            .children
            .values()
            .map(|e| DirEntry { name: e.name.clone(), ino: e.ino, kind: self.node(e.ino).kind })
            .collect())
    }

    pub fn chmod(&mut self, path: &str, mode: u32) -> Result<()> {
        let w = self.walk(path, true)?;
        let now = self.now();
        let n = self.node_mut(w.id);
        n.mode = mode & 0o7777;
        n.ctime = now;
        Ok(())
    }

    /// Owner and group of files created by the calls that follow.
    pub fn set_creds(&mut self, uid: u32, gid: u32) {
        self.creds = (uid, gid);
    }

    /// Change owner and group. `None` leaves that field alone. Follows symlinks.
    pub fn chown(&mut self, path: &str, uid: Option<u32>, gid: Option<u32>) -> Result<()> {
        let w = self.walk(path, true)?;
        let now = self.now();
        let n = self.node_mut(w.id);
        if let Some(u) = uid {
            n.uid = u;
        }
        if let Some(g) = gid {
            n.gid = g;
        }
        n.ctime = now;
        Ok(())
    }

    pub fn utimes(&mut self, path: &str, atime: u64, mtime: u64) -> Result<()> {
        let w = self.walk(path, true)?;
        let now = self.now();
        let n = self.node_mut(w.id);
        n.atime = atime;
        n.mtime = mtime;
        n.ctime = now;
        Ok(())
    }

    pub fn statfs(&self) -> Statfs {
        let used: u64 =
            self.inodes.values().filter(|n| n.kind == FileType::File).map(|n| n.size).sum();
        let total = self.storage.quota();
        let free = total.map(|t| t.saturating_sub(self.storage.used()));
        Statfs { total, used, free }
    }

    pub fn setxattr(&mut self, path: &str, name: &str, value: &str) -> Result<()> {
        let w = self.walk(path, false)?;
        self.node_mut(w.id).xattrs.insert(name.to_string(), value.to_string());
        Ok(())
    }

    pub fn getxattr(&self, path: &str, name: &str) -> Result<Option<String>> {
        let w = self.walk(path, false)?;
        Ok(self.node(w.id).xattrs.get(name).cloned())
    }

    pub fn listxattr(&self, path: &str) -> Result<Vec<String>> {
        let w = self.walk(path, false)?;
        Ok(self.node(w.id).xattrs.keys().cloned().collect())
    }

    pub fn removexattr(&mut self, path: &str, name: &str) -> Result<()> {
        let w = self.walk(path, false)?;
        self.node_mut(w.id).xattrs.remove(name);
        Ok(())
    }

    pub fn mkdir(&mut self, path: &str, mode: u32, recursive: bool) -> Result<()> {
        let mode = self.masked(mode);
        if !recursive {
            return self.create_at(path, FileType::Dir, mode, None).map(|_| ());
        }
        let comps = components(path)?;
        for i in 0..comps.len() {
            match self.resolve(&comps[..=i], true) {
                Ok(w) => {
                    if self.node(w.id).kind != FileType::Dir {
                        return Err(SysError::new(Errno::ENOTDIR).with_path(path));
                    }
                }
                Err(e) if e.code == Errno::ENOENT => {
                    let prefix = format!("/{}", comps[..=i].join("/"));
                    let (parent, name, pcanon) = self.walk_parent(&prefix)?;
                    self.create_node(parent, &name, FileType::Dir, mode, None)
                        .map_err(|e| e.with_path(path))?;
                    self.emit(FsEventKind::Created, join(&pcanon, &name), None);
                }
                Err(e) => return Err(e.with_path(path)),
            }
        }
        Ok(())
    }

    pub fn rmdir(&mut self, path: &str) -> Result<()> {
        let w = self.walk(path, false)?;
        let node = self.node(w.id);
        if node.kind != FileType::Dir {
            return Err(SysError::new(Errno::ENOTDIR).with_path(path));
        }
        if w.canon == "/" {
            return Err(SysError::new(Errno::EBUSY).with_path(path));
        }
        if !node.children.is_empty() {
            return Err(SysError::new(Errno::ENOTEMPTY).with_path(path));
        }
        self.remove_entry(w.parent, &w.name);
        self.orphan(w.id);
        self.emit(FsEventKind::Deleted, w.canon, None);
        Ok(())
    }

    pub fn unlink(&mut self, path: &str) -> Result<()> {
        let w = self.walk(path, false)?;
        if self.node(w.id).kind == FileType::Dir {
            return Err(SysError::new(Errno::EISDIR).with_path(path));
        }
        self.remove_entry(w.parent, &w.name);
        self.orphan(w.id);
        self.emit(FsEventKind::Deleted, w.canon, None);
        Ok(())
    }

    pub fn remove_all(&mut self, path: &str) -> Result<()> {
        let w = self.walk(path, false)?;
        if w.canon == "/" {
            return Err(SysError::new(Errno::EBUSY).with_path(path));
        }
        self.remove_tree(&w.canon)
    }

    fn remove_tree(&mut self, canon: &str) -> Result<()> {
        let w = self.walk(canon, false)?;
        if self.node(w.id).kind == FileType::Dir {
            for name in self.child_names(w.id) {
                self.remove_tree(&join(canon, &name))?;
            }
            self.rmdir(canon)
        } else {
            self.unlink(canon)
        }
    }

    pub fn symlink(&mut self, target: &str, path: &str) -> Result<()> {
        if target.is_empty() || target.contains('\0') {
            return Err(SysError::msg(Errno::EINVAL, "invalid symlink target"));
        }
        self.create_at(path, FileType::Symlink, 0o777, Some(target.to_string())).map(|_| ())
    }

    pub fn readlink(&self, path: &str) -> Result<String> {
        let w = self.walk(path, false)?;
        self.node(w.id)
            .target
            .clone()
            .ok_or_else(|| SysError::new(Errno::EINVAL).with_path(path))
    }

    pub fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        let src = self.walk(from, false)?;
        if src.canon == "/" {
            return Err(SysError::new(Errno::EBUSY).with_path(from));
        }
        let (dparent, dname, dpcanon) = self.walk_parent(to)?;
        let src_kind = self.node(src.id).kind;
        let new_canon = join(&dpcanon, &dname);

        // Renaming onto itself (or changing only the case) is fine; moving a
        // directory beneath itself is not.
        if src_kind == FileType::Dir
            && self.fold(&new_canon) != self.fold(&src.canon)
            && self.is_within(&new_canon, &src.canon)
        {
            return Err(SysError::msg(Errno::EINVAL, "cannot move a directory into itself")
                .with_path(to));
        }

        if let Some(did) = self.lookup(dparent, &dname) {
            if did == src.id {
                // Same entry: a no-op, or a case-only rename on a
                // case-insensitive volume.
                if src.name == dname {
                    return Ok(());
                }
                self.remove_entry(src.parent, &src.name);
                self.insert_entry(dparent, &dname, src.id);
                self.emit(FsEventKind::Renamed, new_canon, Some(src.canon));
                return Ok(());
            }
            let dkind = self.node(did).kind;
            match (src_kind == FileType::Dir, dkind == FileType::Dir) {
                (true, false) => return Err(SysError::new(Errno::ENOTDIR).with_path(to)),
                (false, true) => return Err(SysError::new(Errno::EISDIR).with_path(to)),
                (true, true) if !self.node(did).children.is_empty() => {
                    return Err(SysError::new(Errno::ENOTEMPTY).with_path(to));
                }
                _ => {}
            }
            self.remove_entry(dparent, &dname);
            self.orphan(did);
        }

        self.remove_entry(src.parent, &src.name);
        self.insert_entry(dparent, &dname, src.id);
        let now = self.now();
        self.node_mut(src.id).ctime = now;
        for h in self.handles.values_mut().filter(|h| h.ino == src.id) {
            h.path = new_canon.clone();
        }
        self.emit(FsEventKind::Renamed, new_canon, Some(src.canon));
        Ok(())
    }

    /// Copy a file, symlink, or (with `recursive`) directory. The destination
    /// must not exist.
    pub fn copy(&mut self, from: &str, to: &str, recursive: bool) -> Result<()> {
        let src = self.walk(from, false)?;
        let (dparent, dname, dpcanon) = self.walk_parent(to)?;
        let kind = self.node(src.id).kind;
        if kind == FileType::Dir {
            if !recursive {
                return Err(SysError::new(Errno::EISDIR).with_path(from));
            }
            if self.is_within(&join(&dpcanon, &dname), &src.canon) {
                return Err(SysError::msg(Errno::EINVAL, "cannot copy a directory into itself")
                    .with_path(to));
            }
        }
        // Backends with async setup need every blob this copy will touch opened
        // up front; discovering that halfway through would leave a partial copy.
        let mut keys = Vec::new();
        let mut next = self.next_id;
        self.plan_copy_keys(src.id, &mut next, &mut keys);
        self.storage.prepare(&keys)?;
        if self.lookup(dparent, &dname).is_some() {
            // Checked here so the rollback below can only ever remove what this copy created.
            return Err(SysError::new(Errno::EEXIST).with_path(to));
        }
        if let Err(e) = self.copy_node(src.id, dparent, &dname) {
            // Do not leave half a copy behind (typically the device filled up).
            let _ = self.remove_tree(&join(&dpcanon, &dname));
            return Err(e.with_path(to));
        }
        self.emit(FsEventKind::Created, join(&dpcanon, &dname), None);
        Ok(())
    }

    /// Blob keys `copy_node` will read and write, assuming it allocates inode
    /// ids from `next` in the same pre-order it visits them.
    fn plan_copy_keys(&self, id: u64, next: &mut u64, keys: &mut Vec<String>) {
        let n = self.node(id);
        let new_id = *next;
        *next += 1;
        match n.kind {
            FileType::File if n.size > 0 => {
                keys.push(data_key(id));
                keys.push(data_key(new_id));
            }
            FileType::Dir => {
                for e in n.children.values() {
                    self.plan_copy_keys(e.ino, next, keys);
                }
            }
            _ => {}
        }
    }

    fn copy_node(&mut self, src: u64, dparent: u64, dname: &str) -> Result<u64> {
        let (kind, mode, target, xattrs, size) = {
            let n = self.node(src);
            (n.kind, n.mode, n.target.clone(), n.xattrs.clone(), n.size)
        };
        let id = self.create_node(dparent, dname, kind, mode, target)?;
        self.node_mut(id).xattrs = xattrs;
        match kind {
            FileType::File => {
                let (skey, dkey) = (data_key(src), data_key(id));
                let mut buf = vec![0u8; COPY_CHUNK];
                let mut off = 0u64;
                while off < size {
                    let n = self.storage.read_at(&skey, off, &mut buf)?;
                    if n == 0 {
                        break;
                    }
                    self.with_space(|st| st.write_at(&dkey, off, &buf[..n]))?;
                    off += n as u64;
                }
                self.node_mut(id).size = size;
            }
            FileType::Dir => {
                let children: Vec<(String, u64)> = self
                    .node(src)
                    .children
                    .values()
                    .map(|e| (e.name.clone(), e.ino))
                    .collect();
                for (name, child) in children {
                    self.copy_node(child, id, &name)?;
                }
            }
            FileType::Symlink => {}
        }
        Ok(id)
    }

    // ------------------------------------------------------------ whole-file I/O

    pub fn read_file(&mut self, path: &str) -> Result<Vec<u8>> {
        let fd = self.open(path, OpenFlags::RDONLY, 0)?;
        let result = (|| {
            let stat = self.fstat(fd)?;
            if stat.kind == FileType::Dir {
                return Err(SysError::new(Errno::EISDIR).with_path(path));
            }
            let size = stat.size as usize;
            let mut buf = vec![0u8; size];
            let mut got = 0;
            while got < size {
                let n = self.read(fd, &mut buf[got..], None)?;
                if n == 0 {
                    break;
                }
                got += n;
            }
            buf.truncate(got);
            Ok(buf)
        })();
        self.close(fd)?;
        result
    }

    pub fn write_file(&mut self, path: &str, data: &[u8]) -> Result<()> {
        let fd = self.open(path, OpenFlags::WRONLY | OpenFlags::CREAT | OpenFlags::TRUNC, 0o666)?;
        let result = self.write(fd, data, None).map(|_| ());
        self.close(fd)?;
        result
    }

    /// Write to a temp file in the same directory, then rename over `path`, so
    /// readers never see a partial file.
    pub fn write_file_atomic(&mut self, path: &str, data: &[u8]) -> Result<()> {
        let (parent, name, pcanon) = self.walk_parent(path)?;
        // The temp file's blob is named after the next inode id. Ask the
        // backend for it before creating anything: if it must be opened first
        // (`EAGAIN`), the retry then picks the same name instead of a new one.
        self.storage.prepare(&[data_key(self.next_id)])?;
        let mut n = 0;
        let tmp = loop {
            let candidate = join(&pcanon, &format!(".{name}.tmp{n}"));
            if self.lookup(parent, &format!(".{name}.tmp{n}")).is_none() {
                break candidate;
            }
            n += 1;
        };
        let result = self.write_file(&tmp, data).and_then(|_| self.rename(&tmp, path));
        if result.is_err() {
            let _ = self.unlink(&tmp);
        }
        result
    }

    pub fn truncate(&mut self, path: &str, size: u64) -> Result<()> {
        let w = self.walk(path, true)?;
        match self.node(w.id).kind {
            FileType::Dir => return Err(SysError::new(Errno::EISDIR).with_path(path)),
            FileType::Symlink => return Err(SysError::new(Errno::EINVAL).with_path(path)),
            FileType::File => {}
        }
        self.set_size(w.id, size)?;
        self.emit(FsEventKind::Modified, w.canon, None);
        Ok(())
    }

    /// Move `path` into `trash_dir`, recording where it came from. Returns the
    /// new path. Name clashes get a numeric suffix.
    pub fn trash(&mut self, path: &str, trash_dir: &str) -> Result<String> {
        let src = self.walk(path, false)?;
        if src.canon == "/" {
            return Err(SysError::new(Errno::EBUSY).with_path(path));
        }
        self.mkdir(trash_dir, 0o700, true)?;
        let tcanon = self.walk(trash_dir, true)?.canon;
        if self.is_within(&src.canon, &tcanon) {
            return Err(SysError::msg(Errno::EINVAL, "already in the trash").with_path(path));
        }
        let tid = self.walk(&tcanon, true)?.id;
        let mut candidate = src.name.clone();
        let mut n = 1;
        while self.lookup(tid, &candidate).is_some() {
            n += 1;
            candidate = match src.name.rsplit_once('.') {
                Some((stem, ext)) if !stem.is_empty() => format!("{stem} {n}.{ext}"),
                _ => format!("{} {n}", src.name),
            };
        }
        let dest = join(&tcanon, &candidate);
        self.rename(&src.canon, &dest)?;
        self.setxattr(&dest, ORIGIN_XATTR, &src.canon)?;
        Ok(dest)
    }

    /// Move a trashed item back to where it came from.
    pub fn restore(&mut self, path: &str) -> Result<String> {
        let origin = self
            .getxattr(path, ORIGIN_XATTR)?
            .ok_or_else(|| SysError::msg(Errno::EINVAL, "not a trashed item").with_path(path))?;
        if self.exists(&origin) {
            return Err(SysError::new(Errno::EEXIST).with_path(&origin));
        }
        let (parent, _) = parent_and_name(&origin)
            .ok_or_else(|| SysError::msg(Errno::EINVAL, "bad origin"))?;
        self.mkdir(&parent, 0o755, true)?;
        self.rename(path, &origin)?;
        self.removexattr(&origin, ORIGIN_XATTR)?;
        Ok(origin)
    }

    pub fn empty_trash(&mut self, trash_dir: &str) -> Result<()> {
        let w = self.walk(trash_dir, true)?;
        for name in self.child_names(w.id) {
            self.remove_tree(&join(&w.canon, &name))?;
        }
        Ok(())
    }
}

fn new_inode(kind: FileType, mode: u32, now: u64, target: Option<String>) -> Inode {
    let size = target.as_ref().map_or(0, |t| t.len() as u64);
    Inode {
        kind,
        mode: mode & 0o7777,
        uid: 0,
        gid: 0,
        size,
        nlink: 1,
        atime: now,
        mtime: now,
        ctime: now,
        birthtime: now,
        children: BTreeMap::new(),
        target,
        xattrs: BTreeMap::new(),
    }
}
