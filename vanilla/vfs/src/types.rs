use std::collections::BTreeMap;
use std::ops::BitOr;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileType {
    File,
    Dir,
    Symlink,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Entry {
    pub name: String,
    pub ino: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Inode {
    pub kind: FileType,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub size: u64,
    pub nlink: u32,
    pub atime: u64,
    pub mtime: u64,
    pub ctime: u64,
    pub birthtime: u64,
    /// Directory entries keyed by case-folded name (when the volume is
    /// case-insensitive), preserving the original spelling in `Entry::name`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub children: BTreeMap<String, Entry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub xattrs: BTreeMap<String, String>,
}

/// File metadata. Times are milliseconds since the Unix epoch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub ino: u64,
    pub kind: FileType,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub size: u64,
    pub nlink: u32,
    pub atime: u64,
    pub mtime: u64,
    pub ctime: u64,
    pub birthtime: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub ino: u64,
    pub kind: FileType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Statfs {
    /// Total capacity in bytes, if the backend reports one.
    pub total: Option<u64>,
    /// Bytes used by file contents.
    pub used: u64,
    /// Bytes free, if the capacity is known.
    pub free: Option<u64>,
}

/// What mounting had to repair after an unclean shutdown. All zero/false after a clean one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    /// Journal records applied on top of the last full index.
    pub replayed_records: u32,
    /// Bytes at the end of the journal that were torn or corrupt and dropped.
    pub discarded_journal_bytes: u64,
    /// Data blobs with no file to belong to (left by a crash), removed.
    pub orphan_blobs_removed: u32,
    /// Files that were deleted but still open when the last session ended, freed.
    pub unlinked_files_freed: u32,
    /// The index was written by an older format and will be rewritten on the next flush.
    pub upgraded_index: bool,
}

/// How the metadata journal is doing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalStats {
    /// Sequence number of the newest durable change.
    pub seq: u64,
    /// Bytes in the journal now (records since the last full index).
    pub journal_bytes: u64,
    /// Size of the last full index.
    pub index_bytes: u64,
    /// Journal records appended since mount.
    pub records: u64,
    /// Full index rewrites since mount.
    pub checkpoints: u64,
}

/// Open flags. The access mode occupies the low two bits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenFlags(pub u32);

impl OpenFlags {
    pub const RDONLY: OpenFlags = OpenFlags(0);
    pub const WRONLY: OpenFlags = OpenFlags(1);
    pub const RDWR: OpenFlags = OpenFlags(2);
    pub const CREAT: OpenFlags = OpenFlags(0x40);
    pub const EXCL: OpenFlags = OpenFlags(0x80);
    pub const TRUNC: OpenFlags = OpenFlags(0x200);
    pub const APPEND: OpenFlags = OpenFlags(0x400);
    pub const DIRECTORY: OpenFlags = OpenFlags(0x10000);

    pub fn has(self, flag: OpenFlags) -> bool {
        self.0 & flag.0 == flag.0 && flag.0 != 0
    }

    pub fn readable(self) -> bool {
        matches!(self.0 & 3, 0 | 2)
    }

    pub fn writable(self) -> bool {
        matches!(self.0 & 3, 1 | 2)
    }
}

impl BitOr for OpenFlags {
    type Output = OpenFlags;
    fn bitor(self, rhs: OpenFlags) -> OpenFlags {
        OpenFlags(self.0 | rhs.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Whence {
    Set,
    Cur,
    End,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FsEventKind {
    Created,
    Modified,
    Deleted,
    Renamed,
}

/// A change notification, drained with `Vfs::take_events`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEvent {
    pub kind: FsEventKind,
    pub path: String,
    /// Previous path, for `Renamed`.
    pub old_path: Option<String>,
}
