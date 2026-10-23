//! Crash safety: the metadata journal, recovery on mount, deferred blob deletion, orphan cleanup, and ENOSPC.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use tiny_vfs::*;

fn fresh() -> Vfs<MemStorage> {
    Vfs::mount(MemStorage::new()).unwrap()
}

fn code<T>(r: Result<T>) -> Errno {
    match r {
        Ok(_) => panic!("expected an error, got Ok"),
        Err(e) => e.code,
    }
}

const RW_CREATE: OpenFlags = OpenFlags(2 | 0x40);
const APPEND_CREATE: OpenFlags = OpenFlags(1 | 0x40 | 0x400);

fn len_of(st: &MemStorage, key: &str) -> u64 {
    st.len(key).unwrap().unwrap_or(0)
}

// ------------------------------------------------------------------- journal

#[test]
fn a_flush_appends_to_the_journal_instead_of_rewriting_the_index() {
    // A volume with some bulk in it, so the index is large and a single change is small by comparison.
    let mut v = fresh();
    for d in 0..200 {
        v.mkdir(&format!("/Users/u{d}/Documents"), 0o755, true).unwrap();
        v.write_file(&format!("/Users/u{d}/Documents/notes.txt"), b"notes").unwrap();
    }
    v.checkpoint().unwrap();
    let before = v.journal_stats();
    let slot = if v.storage().len("meta/index.0").unwrap().is_some_and(|n| n > 0) { "meta/index.0" } else { "meta/index.1" };
    let index_len = len_of(v.storage(), slot);
    assert!(index_len > 50_000, "index is only {index_len} bytes");

    for i in 0..50 {
        v.write_file(&format!("/Users/u7/Documents/f{i}"), b"hello").unwrap();
        v.flush().unwrap();
    }
    let st = v.journal_stats();
    assert_eq!(st.records, 50);
    assert_eq!(st.checkpoints, before.checkpoints, "the index must not be rewritten");
    assert_eq!(len_of(v.storage(), slot), index_len);
    // Each flush wrote a few hundred bytes to the journal, not the whole index.
    assert!(st.journal_bytes / 50 < index_len / 20, "records are not small: {} vs index {}", st.journal_bytes / 50, index_len);

    let mut v = Vfs::mount(v.into_storage()).unwrap();
    assert_eq!(v.recovery().replayed_records, 50);
    for i in 0..50 {
        assert_eq!(v.read_file(&format!("/Users/u7/Documents/f{i}")).unwrap(), b"hello");
    }
    assert_eq!(v.read_file("/Users/u199/Documents/notes.txt").unwrap(), b"notes");
}

#[test]
fn the_journal_is_folded_into_a_new_index_when_it_grows_past_it() {
    let mut v = fresh();
    // Big directory entries make each record large: a few hundred flushes cross the threshold.
    for i in 0..400 {
        v.write_file(&format!("/tmp/a-fairly-long-file-name-number-{i}"), b"x").unwrap();
        v.flush().unwrap();
    }
    let st = v.journal_stats();
    assert!(st.checkpoints >= 1, "no checkpoint after {} journal bytes", st.journal_bytes);
    assert!(st.journal_bytes < 300 * 1024, "journal not bounded: {}", st.journal_bytes);

    let v = Vfs::mount(v.into_storage()).unwrap();
    assert_eq!(v.readdir("/tmp").unwrap().len(), 400);
}

#[test]
fn checkpoint_leaves_nothing_to_replay() {
    let mut v = fresh();
    v.write_file("/tmp/a", b"1").unwrap();
    v.flush().unwrap();
    v.write_file("/tmp/b", b"2").unwrap();
    v.checkpoint().unwrap();
    assert_eq!(v.journal_stats().journal_bytes, 0);
    let v = Vfs::mount(v.into_storage()).unwrap();
    assert_eq!(v.recovery(), Recovery::default());
    assert!(v.exists("/tmp/a") && v.exists("/tmp/b"));
}

#[test]
fn unlink_rename_and_directory_changes_replay_correctly() {
    let mut v = fresh();
    v.mkdir("/tmp/d", 0o755, false).unwrap();
    v.write_file("/tmp/d/keep", b"k").unwrap();
    v.write_file("/tmp/d/drop", b"d").unwrap();
    v.flush().unwrap();
    v.unlink("/tmp/d/drop").unwrap();
    v.rename("/tmp/d/keep", "/tmp/d/kept").unwrap();
    v.symlink("/tmp/d/kept", "/tmp/link").unwrap();
    v.setxattr("/tmp/d/kept", "tag", "blue").unwrap();
    v.chmod("/tmp/d", 0o700).unwrap();
    v.remove_all("/Users").unwrap();
    v.flush().unwrap();

    let mut v = Vfs::mount(v.into_storage()).unwrap();
    assert!(!v.exists("/tmp/d/drop"));
    assert!(!v.exists("/tmp/d/keep"));
    assert_eq!(v.read_file("/tmp/link").unwrap(), b"k");
    assert_eq!(v.getxattr("/tmp/d/kept", "tag").unwrap().as_deref(), Some("blue"));
    assert_eq!(v.stat("/tmp/d").unwrap().mode, 0o700);
    assert!(!v.exists("/Users"));
    // Ids keep counting up after replay: a new file does not reuse a removed one's blob.
    v.write_file("/tmp/new", b"n").unwrap();
    v.flush().unwrap();
    let mut v = Vfs::mount(v.into_storage()).unwrap();
    assert_eq!(v.read_file("/tmp/new").unwrap(), b"n");
    assert_eq!(v.read_file("/tmp/d/kept").unwrap(), b"k");
}

#[test]
fn a_torn_journal_tail_is_dropped_and_new_records_follow_the_intact_ones() {
    let mut v = fresh();
    v.write_file("/tmp/a", b"1").unwrap();
    v.flush().unwrap();
    let good = v.journal_stats().journal_bytes;
    v.write_file("/tmp/b", b"2").unwrap();
    v.flush().unwrap();

    let mut st = v.into_storage();
    let full = len_of(&st, "meta/wal");
    assert!(full > good);
    st.truncate("meta/wal", full - 5).unwrap(); // the second record is cut short

    let mut v = Vfs::mount(st).unwrap();
    assert!(v.exists("/tmp/a"));
    assert!(!v.exists("/tmp/b"));
    assert_eq!(v.recovery().replayed_records, 1);
    assert_eq!(v.recovery().discarded_journal_bytes, full - 5 - good);
    assert_eq!(len_of(v.storage(), "meta/wal"), good, "the torn tail must be trimmed");

    // Appending afterwards must not hide behind garbage.
    v.write_file("/tmp/c", b"3").unwrap();
    v.flush().unwrap();
    let v = Vfs::mount(v.into_storage()).unwrap();
    assert!(v.exists("/tmp/a") && v.exists("/tmp/c") && !v.exists("/tmp/b"));
    assert_eq!(v.recovery().discarded_journal_bytes, 0);
}

#[test]
fn a_corrupt_record_in_the_middle_discards_everything_after_it() {
    let mut v = fresh();
    let mut ends = vec![];
    for name in ["a", "b", "c"] {
        v.write_file(&format!("/tmp/{name}"), b"x").unwrap();
        v.flush().unwrap();
        ends.push(v.journal_stats().journal_bytes);
    }
    let mut st = v.into_storage();
    // Flip a payload byte of the second record.
    let at = ends[0] + 40;
    let mut b = [0u8; 1];
    st.read_at("meta/wal", at, &mut b).unwrap();
    st.write_at("meta/wal", at, &[b[0] ^ 0x55]).unwrap();

    let v = Vfs::mount(st).unwrap();
    assert!(v.exists("/tmp/a"));
    assert!(!v.exists("/tmp/b") && !v.exists("/tmp/c")); // c came after the damage: not trusted
    assert_eq!(v.recovery().replayed_records, 1);
    assert_eq!(v.recovery().discarded_journal_bytes, ends[2] - ends[0]);
}

#[test]
fn stale_journal_records_after_a_checkpoint_are_ignored_and_reset() {
    let mut v = fresh();
    v.write_file("/tmp/a", b"1").unwrap();
    v.flush().unwrap();
    v.write_file("/tmp/b", b"2").unwrap();
    v.flush().unwrap();
    let stale = v.storage().get("meta/wal").unwrap().unwrap();
    v.write_file("/tmp/c", b"3").unwrap();
    v.checkpoint().unwrap(); // the journal is reset...
    let mut st = v.into_storage();
    st.put("meta/wal", &stale).unwrap(); // ...but the crash happened before that reset reached the disk

    let mut v = Vfs::mount(st).unwrap();
    assert!(v.exists("/tmp/a") && v.exists("/tmp/b") && v.exists("/tmp/c"));
    assert_eq!(v.recovery().replayed_records, 0);
    assert_eq!(len_of(v.storage(), "meta/wal"), 0);
    // A new record then replays on top of the index, not behind the stale ones.
    v.write_file("/tmp/d", b"4").unwrap();
    v.flush().unwrap();
    let v = Vfs::mount(v.into_storage()).unwrap();
    assert!(v.exists("/tmp/d"));
    assert_eq!(v.recovery().replayed_records, 1);
}

#[test]
fn a_torn_checkpoint_falls_back_to_the_previous_index_plus_journal() {
    let mut v = fresh();
    v.write_file("/tmp/a", b"1").unwrap();
    v.flush().unwrap();
    v.write_file("/tmp/b", b"2").unwrap();
    v.flush().unwrap();
    let journal = v.storage().get("meta/wal").unwrap().unwrap();
    v.write_file("/tmp/c", b"3").unwrap();
    v.checkpoint().unwrap();
    // Crash while writing the new index: its slot is torn and the journal still holds records 2 and 3.
    let mut st = v.into_storage();
    st.put("meta/wal", &journal).unwrap();
    let len = len_of(&st, "meta/index.0");
    st.truncate("meta/index.0", len / 2).unwrap();

    let v = Vfs::mount(st).unwrap();
    assert!(v.exists("/tmp/a") && v.exists("/tmp/b"));
    assert!(!v.exists("/tmp/c"));
    assert_eq!(v.recovery().replayed_records, 2);
}

fn version_1_index(v: Vfs<MemStorage>) -> MemStorage {
    // Rewrite the newest slot the way the previous release stored it: version 1, no journal.
    fn fnv1a(data: &[u8]) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        for b in data {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h
    }
    let mut st = v.into_storage();
    let mut best = ("meta/index.0", 0u64);
    for key in ["meta/index.0", "meta/index.1"] {
        if let Some(bytes) = st.get(key).unwrap().filter(|b| b.len() > 28) {
            let seq = u64::from_le_bytes(bytes[4..12].try_into().unwrap());
            if seq >= best.1 {
                best = (key, seq);
            }
        }
    }
    let bytes = st.get(best.0).unwrap().unwrap();
    let payload = String::from_utf8(bytes[28..].to_vec()).unwrap().replacen("\"version\":2", "\"version\":1", 1);
    let mut out = b"TVFS".to_vec();
    out.extend_from_slice(&best.1.to_le_bytes());
    out.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    out.extend_from_slice(&fnv1a(payload.as_bytes()).to_le_bytes());
    out.extend_from_slice(payload.as_bytes());
    st.put(best.0, &out).unwrap();
    st.delete("meta/wal").unwrap();
    st
}

#[test]
fn a_version_1_index_is_read_and_rewritten_as_version_2() {
    let mut v = fresh();
    v.write_file("/tmp/old", b"from the old format").unwrap();
    v.checkpoint().unwrap();
    let st = version_1_index(v);

    let mut v = Vfs::mount(st).unwrap();
    assert!(v.recovery().upgraded_index);
    assert_eq!(v.read_file("/tmp/old").unwrap(), b"from the old format");
    // The first flush after upgrading writes a full version 2 index, not a journal record only new code understands.
    v.write_file("/tmp/new", b"n").unwrap();
    v.flush().unwrap();
    assert_eq!(v.journal_stats().checkpoints, 1);
    assert_eq!(v.journal_stats().journal_bytes, 0);
    let v = Vfs::mount(v.into_storage()).unwrap();
    assert!(!v.recovery().upgraded_index);
    assert!(v.exists("/tmp/new") && v.exists("/tmp/old"));
}

// ----------------------------------------------- deletion waits for the index

#[test]
fn a_file_removed_but_not_yet_flushed_keeps_its_data_after_a_crash() {
    let mut v = fresh();
    v.write_file("/tmp/precious", b"do not lose me").unwrap();
    v.flush().unwrap();
    v.unlink("/tmp/precious").unwrap();
    // Crash now: the removal never reached the journal, so the file is still there, and so must its data be.
    let mut crashed = Vfs::mount(v.storage().clone()).unwrap();
    assert_eq!(crashed.read_file("/tmp/precious").unwrap(), b"do not lose me");

    // Once flushed, the blob is released.
    v.flush().unwrap();
    assert!(!v.storage().keys().iter().any(|k| k.starts_with("data/")));
}

#[test]
fn overwriting_by_rename_keeps_the_old_data_until_the_flush() {
    let mut v = fresh();
    v.write_file("/tmp/a", b"new").unwrap();
    v.write_file("/tmp/b", b"old").unwrap();
    v.flush().unwrap();
    v.rename("/tmp/a", "/tmp/b").unwrap();
    let mut crashed = Vfs::mount(v.storage().clone()).unwrap();
    assert_eq!(crashed.read_file("/tmp/b").unwrap(), b"old");
    assert_eq!(crashed.read_file("/tmp/a").unwrap(), b"new");
}

// ------------------------------------------------------------ orphan blobs

#[test]
fn blobs_without_a_file_are_removed_on_mount() {
    let mut v = fresh();
    v.write_file("/tmp/real", b"data").unwrap();
    v.flush().unwrap();
    let mut st = v.into_storage();
    // A crash after a file's data was written but before the journal named the file leaves blobs like these.
    st.put("data/900", b"orphan").unwrap();
    st.put("data/901", b"another").unwrap();
    st.put("data/not-a-number", b"foreign").unwrap(); // not ours: left alone
    st.put("meta/something", b"other").unwrap();

    let mut v = Vfs::mount(st).unwrap();
    assert_eq!(v.recovery().orphan_blobs_removed, 2);
    let keys = v.storage().keys();
    assert!(!keys.contains(&"data/900".to_string()) && !keys.contains(&"data/901".to_string()));
    assert!(keys.contains(&"data/not-a-number".to_string()));
    assert!(keys.contains(&"meta/something".to_string()));
    assert_eq!(v.read_file("/tmp/real").unwrap(), b"data");
}

#[test]
fn a_blob_whose_inode_is_a_directory_or_missing_is_an_orphan_too() {
    let v = fresh();
    let dir_ino = v.stat("/tmp").unwrap().ino;
    let mut st = v.into_storage();
    st.put(&format!("data/{dir_ino}"), b"x").unwrap();
    let v = Vfs::mount(st).unwrap();
    assert_eq!(v.recovery().orphan_blobs_removed, 1);
}

#[test]
fn files_created_after_a_crash_never_reuse_an_orphans_name() {
    // The orphan blob data/N exists because next_id advanced in memory only. After the crash next_id is N
    // again, so the new file gets blob N: the sweep must have removed the orphan or the new file inherits its bytes.
    let mut v = fresh();
    v.flush().unwrap();
    v.write_file("/tmp/lost", b"stale contents that must not leak").unwrap(); // never flushed
    let st = v.storage().clone();
    let mut v = Vfs::mount(st).unwrap();
    assert!(!v.exists("/tmp/lost"));
    v.write_file("/tmp/fresh", b"").unwrap();
    assert_eq!(v.read_file("/tmp/fresh").unwrap(), b"");
    let fd = v.open("/tmp/fresh", OpenFlags(2), 0).unwrap();
    v.write(fd, b"z", Some(10)).unwrap();
    let mut buf = [1u8; 11];
    assert_eq!(v.read(fd, &mut buf, Some(0)).unwrap(), 11);
    assert_eq!(&buf[..10], &[0u8; 10]);
}

// ---------------------------------------- data that reached disk before the index

#[test]
fn bytes_written_past_the_recorded_end_never_reappear_when_the_file_grows() {
    let mut v = fresh();
    v.write_file("/tmp/f", &[b'a'; 100]).unwrap();
    v.flush().unwrap();
    // Extend the file (data reaches the blob), then crash before the journal records the new size.
    let fd = v.open("/tmp/f", OpenFlags(1 | 0x400), 0).unwrap();
    v.write(fd, &[b'S'; 100], None).unwrap();
    let st = v.storage().clone();
    assert_eq!(len_of(&st, &format!("data/{}", v.stat("/tmp/f").unwrap().ino)), 200);

    let mut v = Vfs::mount(st).unwrap();
    assert_eq!(v.stat("/tmp/f").unwrap().size, 100);
    // Grow the file again with a gap: the gap must read as zeros, not as the lost 'S' bytes.
    let fd = v.open("/tmp/f", OpenFlags(2), 0).unwrap();
    v.write(fd, b"!", Some(150)).unwrap();
    let mut buf = vec![9u8; 151];
    assert_eq!(v.read(fd, &mut buf, Some(0)).unwrap(), 151);
    assert_eq!(&buf[..100], &[b'a'; 100][..]);
    assert_eq!(&buf[100..150], &[0u8; 50][..]);
    assert_eq!(buf[150], b'!');

    // Same through truncate-to-grow.
    let mut v = Vfs::mount({
        let mut w = fresh();
        w.write_file("/tmp/g", &[b'a'; 10]).unwrap();
        w.flush().unwrap();
        let fd = w.open("/tmp/g", OpenFlags(1 | 0x400), 0).unwrap();
        w.write(fd, &[b'S'; 40], None).unwrap();
        w.storage().clone()
    })
    .unwrap();
    v.truncate("/tmp/g", 30).unwrap();
    let got = v.read_file("/tmp/g").unwrap();
    assert_eq!(&got[..10], &[b'a'; 10][..]);
    assert_eq!(&got[10..], &[0u8; 20][..]);
}

#[test]
fn a_blob_shorter_than_the_recorded_size_reads_as_zeros() {
    let mut v = fresh();
    v.write_file("/tmp/f", &[b'x'; 100]).unwrap();
    v.flush().unwrap();
    // The file was cut to 10 bytes (blob truncated) but the crash came before the size reached the journal.
    let ino = v.stat("/tmp/f").unwrap().ino;
    v.storage_mut().truncate(&format!("data/{ino}"), 10).unwrap();
    let mut v = Vfs::mount(v.storage().clone()).unwrap();
    let got = v.read_file("/tmp/f").unwrap();
    assert_eq!(got.len(), 100);
    assert_eq!(&got[..10], &[b'x'; 10][..]);
    assert!(got[10..].iter().all(|b| *b == 0));
}

// ------------------------------------------------------------------ ENOSPC

#[test]
fn a_copy_that_runs_out_of_space_leaves_no_partial_copy() {
    let mut v = Vfs::format(MemStorage::new(), Options::default()).unwrap();
    v.mkdir("/tmp/src/sub", 0o755, true).unwrap();
    v.write_file("/tmp/src/a", &[1u8; 50_000]).unwrap();
    v.write_file("/tmp/src/sub/b", &[2u8; 50_000]).unwrap();
    v.flush().unwrap();
    let used = v.storage().used();
    v.storage_mut().set_capacity(Some(used + 60_000)); // room for the first file's copy, not the second

    assert_eq!(code(v.copy("/tmp/src", "/tmp/dst", true)), Errno::ENOSPC);
    assert!(!v.exists("/tmp/dst"));
    // The original is untouched, and once there is room the copy works.
    assert_eq!(v.read_file("/tmp/src/sub/b").unwrap(), vec![2u8; 50_000]);
    v.flush().unwrap(); // the failed copy's blobs are released
    v.storage_mut().set_capacity(Some(used + 150_000));
    v.copy("/tmp/src", "/tmp/dst", true).unwrap();
    assert_eq!(v.read_file("/tmp/dst/sub/b").unwrap(), vec![2u8; 50_000]);
}

#[test]
fn copying_onto_an_existing_name_does_not_remove_it() {
    let mut v = fresh();
    v.mkdir("/tmp/a", 0o755, false).unwrap();
    v.write_file("/tmp/a/keep", b"k").unwrap();
    v.write_file("/tmp/f", b"f").unwrap();
    assert_eq!(code(v.copy("/tmp/f", "/tmp/a", false)), Errno::EEXIST);
    assert_eq!(v.read_file("/tmp/a/keep").unwrap(), b"k");
}

#[test]
fn space_from_removed_files_is_reused_without_waiting_for_a_flush() {
    let mut v = Vfs::format(MemStorage::with_capacity(400_000), Options::default()).unwrap();
    v.write_file("/tmp/big", &vec![7u8; 250_000]).unwrap();
    v.flush().unwrap();
    v.unlink("/tmp/big").unwrap(); // its 250 KB is only released once the removal is durable
    v.write_file("/tmp/other", &vec![8u8; 250_000]).unwrap(); // would not fit without flushing first
    assert_eq!(v.read_file("/tmp/other").unwrap(), vec![8u8; 250_000]);
    assert!(!v.exists("/tmp/big"));
}

#[test]
fn a_flush_that_runs_out_of_space_can_be_retried_and_nothing_is_lost() {
    let mut v = Vfs::format(MemStorage::new(), Options::default()).unwrap();
    v.write_file("/tmp/a", b"first").unwrap();
    v.flush().unwrap();
    v.write_file("/tmp/b", b"second").unwrap();
    let used = v.storage().used();
    v.storage_mut().set_capacity(Some(used + 3)); // not even room for the journal record
    assert_eq!(code(v.flush()), Errno::ENOSPC);

    // Nothing was half-written; with room again the same flush succeeds and everything is there.
    v.storage_mut().set_capacity(None);
    v.flush().unwrap();
    let mut v = Vfs::mount(v.into_storage()).unwrap();
    assert_eq!(v.read_file("/tmp/a").unwrap(), b"first");
    assert_eq!(v.read_file("/tmp/b").unwrap(), b"second");
}

#[test]
fn a_failed_journal_append_forces_a_full_index_next_so_nothing_follows_garbage() {
    use std::cell::Cell;
    /// Storage whose next write to the journal fails after writing half of it.
    #[derive(Clone)]
    struct HalfWrite {
        inner: Rc<RefCell<MemStorage>>,
        fail_next_wal_write: Rc<Cell<bool>>,
    }
    impl Storage for HalfWrite {
        fn len(&self, key: &str) -> Result<Option<u64>> {
            self.inner.borrow().len(key)
        }
        fn read_at(&self, key: &str, offset: u64, buf: &mut [u8]) -> Result<usize> {
            self.inner.borrow().read_at(key, offset, buf)
        }
        fn write_at(&mut self, key: &str, offset: u64, data: &[u8]) -> Result<()> {
            if key == "meta/wal" && self.fail_next_wal_write.replace(false) {
                self.inner.borrow_mut().write_at(key, offset, &data[..data.len() / 2])?;
                return Err(SysError::new(Errno::EIO));
            }
            self.inner.borrow_mut().write_at(key, offset, data)
        }
        fn truncate(&mut self, key: &str, size: u64) -> Result<()> {
            self.inner.borrow_mut().truncate(key, size)
        }
        fn delete(&mut self, key: &str) -> Result<()> {
            self.inner.borrow_mut().delete(key)
        }
        fn list_keys(&self) -> Result<Vec<String>> {
            self.inner.borrow().list_keys()
        }
        fn flush(&mut self) -> Result<()> {
            Ok(())
        }
        fn used(&self) -> u64 {
            self.inner.borrow().used()
        }
    }
    let flag = Rc::new(Cell::new(false));
    let st = HalfWrite { inner: Rc::new(RefCell::new(MemStorage::new())), fail_next_wal_write: flag.clone() };
    let mut v = Vfs::mount(st.clone()).unwrap();
    v.write_file("/tmp/a", b"1").unwrap();
    v.flush().unwrap();

    v.write_file("/tmp/b", b"2").unwrap();
    flag.set(true);
    assert_eq!(code(v.flush()), Errno::EIO);
    v.write_file("/tmp/c", b"3").unwrap();
    v.flush().unwrap(); // retried as a full index, which also resets the journal
    assert_eq!(v.journal_stats().journal_bytes, 0);

    let v = Vfs::mount(st).unwrap();
    assert!(v.exists("/tmp/a") && v.exists("/tmp/b") && v.exists("/tmp/c"));
}

// ----------------------------------------------------- random crash testing

/// `MemStorage` that records every mutation and flush barrier, so the on-disk state at any crash point can be rebuilt.
#[derive(Clone, Debug)]
enum Op {
    Write { key: String, off: u64, data: Vec<u8> },
    Truncate { key: String, size: u64 },
    Delete { key: String },
    Flush,
}

#[derive(Clone, Default)]
struct Recorder {
    live: Rc<RefCell<MemStorage>>,
    history: Rc<RefCell<Vec<Op>>>,
}

impl Storage for Recorder {
    fn len(&self, key: &str) -> Result<Option<u64>> {
        self.live.borrow().len(key)
    }
    fn read_at(&self, key: &str, offset: u64, buf: &mut [u8]) -> Result<usize> {
        self.live.borrow().read_at(key, offset, buf)
    }
    fn write_at(&mut self, key: &str, offset: u64, data: &[u8]) -> Result<()> {
        self.history.borrow_mut().push(Op::Write { key: key.into(), off: offset, data: data.to_vec() });
        self.live.borrow_mut().write_at(key, offset, data)
    }
    fn truncate(&mut self, key: &str, size: u64) -> Result<()> {
        self.history.borrow_mut().push(Op::Truncate { key: key.into(), size });
        self.live.borrow_mut().truncate(key, size)
    }
    fn delete(&mut self, key: &str) -> Result<()> {
        self.history.borrow_mut().push(Op::Delete { key: key.into() });
        self.live.borrow_mut().delete(key)
    }
    fn list_keys(&self) -> Result<Vec<String>> {
        self.live.borrow().list_keys()
    }
    fn flush(&mut self) -> Result<()> {
        self.history.borrow_mut().push(Op::Flush);
        Ok(())
    }
    fn used(&self) -> u64 {
        self.live.borrow().used()
    }
}

fn apply(st: &mut MemStorage, op: &Op) {
    match op {
        Op::Write { key, off, data } => st.write_at(key, *off, data).unwrap(),
        Op::Truncate { key, size } => st.truncate(key, *size).unwrap(),
        Op::Delete { key } => st.delete(key).unwrap(),
        Op::Flush => {}
    }
}

/// Every disk state a crash could leave: at each point in the history, only what was flushed; everything written
/// so far; and everything plus a torn prefix of the next write.
fn crash_images(history: &[Op]) -> Vec<(usize, MemStorage)> {
    let mut images = vec![];
    let (mut durable, mut live) = (MemStorage::new(), MemStorage::new());
    for k in 0..=history.len() {
        images.push((k, durable.clone()));
        images.push((k, live.clone()));
        if let Some(Op::Write { key, off, data }) = history.get(k) {
            for cut in [1, data.len() / 2, data.len().saturating_sub(1)] {
                if cut > 0 && cut < data.len() {
                    let mut torn = live.clone();
                    torn.write_at(key, *off, &data[..cut]).unwrap();
                    images.push((k, torn));
                }
            }
        }
        if let Some(op) = history.get(k) {
            apply(&mut live, op);
            if matches!(op, Op::Flush) {
                durable = live.clone();
            }
        }
    }
    images
}

type Tree = BTreeMap<String, String>;

/// Structure of the file system: path -> kind, size (files), and mode.
fn tree<S: Storage>(v: &Vfs<S>) -> Tree {
    fn walk<S: Storage>(v: &Vfs<S>, dir: &str, out: &mut Tree) {
        for e in v.readdir(dir).unwrap() {
            let path = if dir == "/" { format!("/{}", e.name) } else { format!("{dir}/{}", e.name) };
            let st = v.lstat(&path).unwrap();
            let size = if st.kind == FileType::File { st.size } else { 0 };
            out.insert(path.clone(), format!("{:?} {} {:o}", st.kind, size, st.mode));
            if st.kind == FileType::Dir {
                walk(v, &path, out);
            }
        }
    }
    let mut out = Tree::new();
    walk(v, "/", &mut out);
    out
}

fn contents<S: Storage>(v: &mut Vfs<S>, tree: &Tree) -> BTreeMap<String, Vec<u8>> {
    tree.iter()
        .filter(|(_, d)| d.starts_with("File"))
        .map(|(p, _)| (p.clone(), v.read_file(p).unwrap()))
        .collect()
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const PATHS: [&str; 7] = ["/tmp/a", "/tmp/b", "/tmp/c", "/tmp/d/x", "/tmp/d/y", "/tmp/d/sub/z", "/Users/u/f"];

/// One random history: operations with flushes in between, recording the file system state at every flush.
fn random_history(seed: u64, steps: usize) -> (Vec<Op>, Vec<(usize, Tree)>) {
    let rec = Recorder::default();
    let mut v = Vfs::format(rec.clone(), Options::default()).unwrap();
    let mut snaps = vec![(rec.history.borrow().len(), tree(&v))];
    let mut rng = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1);
    for _ in 0..steps {
        let p = PATHS[rng.below(PATHS.len() as u64) as usize];
        let q = PATHS[rng.below(PATHS.len() as u64) as usize];
        let len = rng.below(3000) as usize;
        let byte = rng.below(250) as u8 + 1;
        let _ = match rng.below(10) {
            0 | 1 => v.mkdir("/tmp/d/sub", 0o755, true).and_then(|_| v.write_file(p, &vec![byte; len])),
            2 => v.open(p, APPEND_CREATE, 0o644).and_then(|fd| {
                let r = v.write(fd, &vec![byte; len], None).map(|_| ());
                v.close(fd).and(r)
            }),
            3 => v.unlink(p),
            4 => v.rename(p, q),
            5 => v.truncate(p, rng.below(4000)),
            6 => v.copy(p, q, false),
            7 => v.remove_all("/tmp/d"),
            8 => v.write_file_atomic(p, &vec![byte; len]),
            _ => v.mkdir("/Users/u", 0o755, true),
        };
        if rng.below(10) < 4 {
            let r = if rng.below(6) == 0 { v.checkpoint() } else { v.flush() };
            r.unwrap();
            snaps.push((rec.history.borrow().len(), tree(&v)));
        }
    }
    v.flush().unwrap();
    snaps.push((rec.history.borrow().len(), tree(&v)));
    let history = rec.history.borrow().clone();
    (history, snaps)
}

/// A crash at any point must mount to a state the file system really passed through: the last flush that
/// finished, or the one that was in progress.
#[test]
fn a_crash_at_any_point_mounts_to_a_state_the_file_system_was_in() {
    let mut checked = 0;
    for seed in 1..=8u64 {
        let (history, snaps) = random_history(seed, 40);
        for (k, image) in crash_images(&history) {
            // Index of the newest flush that had finished when the crash hit.
            let last = snaps.iter().rposition(|(done_at, _)| *done_at <= k);
            let allowed: Vec<&Tree> = match last {
                Some(i) => snaps[i..(i + 2).min(snaps.len())].iter().map(|(_, t)| t).collect(),
                None => vec![&snaps[0].1],
            };

            let mut v = Vfs::mount(image).unwrap_or_else(|e| panic!("seed {seed} crash at {k}: mount failed: {e}"));
            let got = tree(&v);
            let matching: Vec<usize> = snaps.iter().enumerate().filter(|(_, (_, t))| *t == got).map(|(i, _)| i).collect();
            assert!(
                allowed.iter().any(|t| **t == got),
                "seed {seed} crash at op {k}: mounted state matches no flush point (last finished flush #{last:?}, it equals snapshots {matching:?}, flush completions at {:?})\nrecovery {:?}",
                snaps.iter().map(|(d, _)| *d).collect::<Vec<_>>(),
                v.recovery()
            );

            // No blob without a file.
            let inos: Vec<u64> = got
                .iter()
                .filter(|(_, d)| d.starts_with("File"))
                .map(|(p, _)| v.lstat(p).unwrap().ino)
                .collect();
            for key in v.storage().keys().iter().filter(|k| k.starts_with("data/")) {
                let n: u64 = key[5..].parse().unwrap();
                assert!(inos.contains(&n), "seed {seed} crash at {k}: orphan blob {key} survived mount");
            }

            // The recovered file system is fully usable: files can grow with a gap and read back zeros there,
            // and a flush plus remount keeps everything.
            for (path, _) in got.iter().filter(|(_, d)| d.starts_with("File")) {
                let size = v.lstat(path).unwrap().size;
                let fd = v.open(path, OpenFlags(2), 0).unwrap();
                v.write(fd, b"!", Some(size + 40)).unwrap();
                let mut gap = vec![9u8; 40];
                assert_eq!(v.read(fd, &mut gap, Some(size)).unwrap(), 40);
                assert!(gap.iter().all(|b| *b == 0), "seed {seed} crash at {k}: stale bytes in the gap of {path}");
                v.close(fd).unwrap();
            }
            let before = tree(&v);
            v.flush().unwrap();
            let again = Vfs::mount(v.into_storage()).unwrap();
            assert_eq!(tree(&again), before, "seed {seed} crash at {k}: changes after recovery were lost");
            checked += 1;
        }
    }
    assert!(checked > 1000, "only {checked} crash points were exercised");
}

/// With nothing in flight, a recovered volume matches the last flush exactly, contents included.
#[test]
fn after_a_clean_flush_a_crash_loses_nothing() {
    for seed in 20..=27u64 {
        let rec_history = {
            let (h, snaps) = random_history(seed, 40);
            (h, snaps)
        };
        let (history, snaps) = rec_history;
        // The state after the very last flush: replay the whole history, all of it durable.
        let mut full = MemStorage::new();
        for op in &history {
            apply(&mut full, op);
        }
        let mut v = Vfs::mount(full).unwrap();
        assert_eq!(tree(&v), snaps.last().unwrap().1, "seed {seed}");
        let t = tree(&v);
        let c = contents(&mut v, &t);
        for (path, data) in &c {
            assert_eq!(data.len() as u64, v.lstat(path).unwrap().size, "seed {seed}: {path} length");
        }
    }
}
