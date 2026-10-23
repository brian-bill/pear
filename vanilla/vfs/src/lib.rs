//! Vanilla virtual file system engine.
//!
//! A Unix-style hierarchy over a flat [`Storage`] blob store. See
//! `contracts/filesystem.md` for the contract this implements.

mod error;
mod mem;
pub mod path;
mod storage;
mod types;
mod vfs;

pub use error::{Errno, Result, SysError};
pub use mem::MemStorage;
pub use storage::Storage;
pub use types::{
    DirEntry, FileType, FsEvent, FsEventKind, JournalStats, OpenFlags, Recovery, Stat, Statfs, Whence,
};
pub use vfs::{Options, Vfs};
