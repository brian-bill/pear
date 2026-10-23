use std::cell::Cell;
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

fn names(v: &Vfs<MemStorage>, path: &str) -> Vec<String> {
    v.readdir(path).unwrap().into_iter().map(|e| e.name).collect()
}

const RW_CREATE: OpenFlags = OpenFlags(2 | 0x40);

// ------------------------------------------------------------------ mounting

#[test]
fn first_mount_creates_default_hierarchy() {
    let v = fresh();
    let root = names(&v, "/");
    for dir in ["System", "Applications", "Users", "Volumes", "tmp", "dev"] {
        assert!(root.iter().any(|n| n == dir), "missing /{dir}");
    }
    assert!(v.exists("/var/log"));
    assert_eq!(v.stat("/tmp").unwrap().mode, 0o1777);
}

#[test]
fn metadata_and_contents_survive_remount() {
    let mut v = fresh();
    v.mkdir("/Users/me/Documents", 0o755, true).unwrap();
    v.write_file("/Users/me/Documents/a.txt", b"hello").unwrap();
    v.symlink("/Users/me/Documents/a.txt", "/Users/me/link").unwrap();
    v.setxattr("/Users/me/Documents/a.txt", "tag", "red").unwrap();
    v.flush().unwrap();

    let mut v = Vfs::mount(v.into_storage()).unwrap();
    assert_eq!(v.read_file("/Users/me/link").unwrap(), b"hello");
    assert_eq!(v.getxattr("/Users/me/Documents/a.txt", "tag").unwrap().as_deref(), Some("red"));
}

#[test]
fn unflushed_changes_are_not_persisted() {
    let mut v = fresh();
    v.write_file("/tmp/x", b"1").unwrap();
    let v = Vfs::mount(v.into_storage()).unwrap();
    assert!(!v.exists("/tmp/x"));
}

#[test]
fn damage_to_both_index_slots_is_an_io_error() {
    let mut s = MemStorage::new();
    s.put("meta/index.0", b"not an index").unwrap();
    s.put("meta/index.1", b"also not an index").unwrap();
    assert_eq!(code(Vfs::mount(s)), Errno::EIO);
}

#[test]
fn an_aborted_first_boot_is_reformatted_not_reported_as_corruption() {
    // Empty slots: a backend created the blobs, then the first format retried.
    let mut s = MemStorage::new();
    s.truncate("meta/index.1", 0).unwrap();
    assert!(Vfs::mount(s).unwrap().exists("/tmp"));

    // A lone partial slot: the first write was cut short.
    let mut s = MemStorage::new();
    s.put("meta/index.1", b"TVFS-partial").unwrap();
    assert!(Vfs::mount(s).unwrap().exists("/tmp"));
}

#[test]
fn a_torn_newest_index_falls_back_to_the_previous_one() {
    let mut v = fresh();
    v.write_file("/tmp/a", b"1").unwrap();
    v.checkpoint().unwrap();
    v.write_file("/tmp/b", b"2").unwrap();
    v.checkpoint().unwrap();

    // Sequence numbers: format=1 (slot 1), first checkpoint=2 (slot 0), second=3 (slot 1).
    // Simulate a crash that tore the newest slot mid-write.
    let mut st = v.into_storage();
    let len = st.len("meta/index.1").unwrap().unwrap();
    st.truncate("meta/index.1", len / 2).unwrap();

    let v = Vfs::mount(st).unwrap();
    assert!(v.exists("/tmp/a"));
    assert!(!v.exists("/tmp/b"));
}

#[test]
fn a_bit_flip_in_the_newest_index_is_detected() {
    let mut v = fresh();
    v.flush().unwrap();
    v.write_file("/tmp/a", b"1").unwrap();
    v.checkpoint().unwrap();
    let mut st = v.into_storage();
    let mut byte = [0u8; 1];
    st.read_at("meta/index.0", 40, &mut byte).unwrap();
    st.write_at("meta/index.0", 40, &[byte[0] ^ 0xff]).unwrap();
    let v = Vfs::mount(st).unwrap();
    assert!(!v.exists("/tmp/a"));
}

#[test]
fn flushing_alternates_slots_and_keeps_both_loadable() {
    let mut v = fresh();
    for i in 0..4 {
        v.write_file(&format!("/tmp/f{i}"), b"x").unwrap();
        v.checkpoint().unwrap();
    }
    let st = v.into_storage();
    assert!(st.len("meta/index.0").unwrap().is_some());
    assert!(st.len("meta/index.1").unwrap().is_some());
    let v = Vfs::mount(st).unwrap();
    assert!(v.exists("/tmp/f3"));
}

#[test]
fn case_sensitivity_is_fixed_at_format_time() {
    let mut v = Vfs::format(MemStorage::new(), Options { case_sensitive: true, umask: 0o022 }).unwrap();
    v.flush().unwrap();
    let mut v = Vfs::mount(v.into_storage()).unwrap();
    v.write_file("/tmp/a", b"1").unwrap();
    v.write_file("/tmp/A", b"2").unwrap();
    assert_eq!(names(&v, "/tmp"), ["A", "a"]);
}

// --------------------------------------------------------------- files / IO

#[test]
fn write_then_read_back() {
    let mut v = fresh();
    v.write_file("/tmp/f", b"hello world").unwrap();
    assert_eq!(v.read_file("/tmp/f").unwrap(), b"hello world");
    assert_eq!(v.stat("/tmp/f").unwrap().size, 11);
}

#[test]
fn handle_position_advances_and_seeks() {
    let mut v = fresh();
    let fd = v.open("/tmp/f", RW_CREATE, 0o644).unwrap();
    v.write(fd, b"abcdef", None).unwrap();
    assert_eq!(v.lseek(fd, 2, Whence::Set).unwrap(), 2);
    let mut buf = [0u8; 3];
    assert_eq!(v.read(fd, &mut buf, None).unwrap(), 3);
    assert_eq!(&buf, b"cde");
    assert_eq!(v.lseek(fd, -1, Whence::End).unwrap(), 5);
    assert_eq!(v.lseek(fd, -10, Whence::Cur).unwrap_err().code, Errno::EINVAL);
    v.close(fd).unwrap();
}

#[test]
fn positional_io_does_not_move_the_handle() {
    let mut v = fresh();
    let fd = v.open("/tmp/f", RW_CREATE, 0o644).unwrap();
    v.write(fd, b"0123456789", Some(0)).unwrap();
    let mut buf = [0u8; 2];
    v.read(fd, &mut buf, Some(4)).unwrap();
    assert_eq!(&buf, b"45");
    assert_eq!(v.lseek(fd, 0, Whence::Cur).unwrap(), 0);
}

#[test]
fn writing_past_the_end_zero_fills() {
    let mut v = fresh();
    let fd = v.open("/tmp/f", RW_CREATE, 0o644).unwrap();
    v.write(fd, b"x", Some(4)).unwrap();
    v.close(fd).unwrap();
    assert_eq!(v.read_file("/tmp/f").unwrap(), [0, 0, 0, 0, b'x']);
}

#[test]
fn append_always_writes_at_the_end() {
    let mut v = fresh();
    v.write_file("/tmp/log", b"a").unwrap();
    let fd = v.open("/tmp/log", OpenFlags::WRONLY | OpenFlags::APPEND, 0).unwrap();
    v.lseek(fd, 0, Whence::Set).unwrap();
    v.write(fd, b"b", None).unwrap();
    v.close(fd).unwrap();
    assert_eq!(v.read_file("/tmp/log").unwrap(), b"ab");
}

#[test]
fn trunc_flag_empties_the_file() {
    let mut v = fresh();
    v.write_file("/tmp/f", b"long content").unwrap();
    v.write_file("/tmp/f", b"x").unwrap();
    assert_eq!(v.read_file("/tmp/f").unwrap(), b"x");
}

#[test]
fn truncate_shrinks_and_grows() {
    let mut v = fresh();
    v.write_file("/tmp/f", b"abcdef").unwrap();
    v.truncate("/tmp/f", 3).unwrap();
    assert_eq!(v.read_file("/tmp/f").unwrap(), b"abc");
    v.truncate("/tmp/f", 5).unwrap();
    assert_eq!(v.read_file("/tmp/f").unwrap(), [b'a', b'b', b'c', 0, 0]);
}

#[test]
fn access_mode_is_enforced() {
    let mut v = fresh();
    v.write_file("/tmp/f", b"x").unwrap();
    let ro = v.open("/tmp/f", OpenFlags::RDONLY, 0).unwrap();
    assert_eq!(code(v.write(ro, b"y", None)), Errno::EBADF);
    let wo = v.open("/tmp/f", OpenFlags::WRONLY, 0).unwrap();
    assert_eq!(code(v.read(wo, &mut [0u8; 1], None)), Errno::EBADF);
}

#[test]
fn open_errors() {
    let mut v = fresh();
    assert_eq!(code(v.open("/tmp/none", OpenFlags::RDONLY, 0)), Errno::ENOENT);
    assert_eq!(code(v.open("/none/x", RW_CREATE, 0o644)), Errno::ENOENT);
    v.write_file("/tmp/f", b"").unwrap();
    assert_eq!(code(v.open("/tmp/f", RW_CREATE | OpenFlags::EXCL, 0o644)), Errno::EEXIST);
    assert_eq!(code(v.open("/tmp", OpenFlags::WRONLY, 0)), Errno::EISDIR);
    assert_eq!(code(v.open("/tmp/f", OpenFlags::RDONLY | OpenFlags::DIRECTORY, 0)), Errno::ENOTDIR);
    assert_eq!(code(v.open("/tmp/f/x", OpenFlags::RDONLY, 0)), Errno::ENOTDIR);
    assert_eq!(code(v.open("relative", OpenFlags::RDONLY, 0)), Errno::EINVAL);
    assert_eq!(code(v.close(999)), Errno::EBADF);
}

#[test]
fn reading_a_directory_handle_fails() {
    let mut v = fresh();
    let fd = v.open("/tmp", OpenFlags::RDONLY | OpenFlags::DIRECTORY, 0).unwrap();
    assert_eq!(code(v.read(fd, &mut [0u8; 1], None)), Errno::EISDIR);
}

#[test]
fn creation_mode_honours_umask() {
    let mut v = fresh();
    let fd = v.open("/tmp/f", RW_CREATE, 0o666).unwrap();
    v.close(fd).unwrap();
    assert_eq!(v.stat("/tmp/f").unwrap().mode, 0o644);
}

#[test]
fn unlinked_open_file_stays_readable_until_closed() {
    let mut v = fresh();
    let fd = v.open("/tmp/f", RW_CREATE, 0o644).unwrap();
    v.write(fd, b"still here", None).unwrap();
    v.unlink("/tmp/f").unwrap();
    assert!(!v.exists("/tmp/f"));
    let mut buf = [0u8; 10];
    assert_eq!(v.read(fd, &mut buf, Some(0)).unwrap(), 10);
    assert_eq!(&buf, b"still here");
    assert!(v.storage().keys().iter().any(|k| k.starts_with("data/")));
    v.close(fd).unwrap();
    v.flush().unwrap(); // blobs go once the index that forgets them is durable
    assert!(!v.storage().keys().iter().any(|k| k.starts_with("data/")));
}

#[test]
fn orphans_left_by_a_crash_are_swept_on_mount() {
    let mut v = fresh();
    let fd = v.open("/tmp/f", RW_CREATE, 0o644).unwrap();
    v.write(fd, b"x", None).unwrap();
    v.unlink("/tmp/f").unwrap();
    v.flush().unwrap(); // index now holds an nlink=0 inode; the "crash" skips close
    let v = Vfs::mount(v.into_storage()).unwrap();
    assert!(!v.storage().keys().iter().any(|k| k.starts_with("data/")));
}

// ------------------------------------------------------------- directories

#[test]
fn mkdir_basic_and_errors() {
    let mut v = fresh();
    v.mkdir("/tmp/a", 0o755, false).unwrap();
    assert_eq!(code(v.mkdir("/tmp/a", 0o755, false)), Errno::EEXIST);
    assert_eq!(code(v.mkdir("/tmp/x/y", 0o755, false)), Errno::ENOENT);
    v.write_file("/tmp/file", b"").unwrap();
    assert_eq!(code(v.mkdir("/tmp/file/y", 0o755, false)), Errno::ENOTDIR);
    assert_eq!(code(v.mkdir("/tmp/bad\0name", 0o755, false)), Errno::EINVAL);
}

#[test]
fn mkdir_recursive_is_idempotent() {
    let mut v = fresh();
    v.mkdir("/tmp/a/b/c", 0o755, true).unwrap();
    v.mkdir("/tmp/a/b/c", 0o755, true).unwrap();
    assert!(v.exists("/tmp/a/b/c"));
    v.write_file("/tmp/a/f", b"").unwrap();
    assert_eq!(code(v.mkdir("/tmp/a/f/g", 0o755, true)), Errno::ENOTDIR);
}

#[test]
fn readdir_lists_entries_with_kinds() {
    let mut v = fresh();
    v.mkdir("/tmp/d", 0o755, false).unwrap();
    v.write_file("/tmp/f", b"").unwrap();
    v.symlink("/tmp/f", "/tmp/l").unwrap();
    let kinds: Vec<_> = v.readdir("/tmp").unwrap().into_iter().map(|e| (e.name, e.kind)).collect();
    assert_eq!(
        kinds,
        [
            ("d".into(), FileType::Dir),
            ("f".into(), FileType::File),
            ("l".into(), FileType::Symlink)
        ]
    );
    assert_eq!(code(v.readdir("/tmp/f")), Errno::ENOTDIR);
}

#[test]
fn rmdir_rules() {
    let mut v = fresh();
    v.mkdir("/tmp/d", 0o755, false).unwrap();
    v.write_file("/tmp/d/f", b"").unwrap();
    assert_eq!(code(v.rmdir("/tmp/d")), Errno::ENOTEMPTY);
    v.unlink("/tmp/d/f").unwrap();
    v.rmdir("/tmp/d").unwrap();
    assert_eq!(code(v.rmdir("/")), Errno::EBUSY);
    v.write_file("/tmp/f", b"").unwrap();
    assert_eq!(code(v.rmdir("/tmp/f")), Errno::ENOTDIR);
    assert_eq!(code(v.unlink("/tmp")), Errno::EISDIR);
}

#[test]
fn remove_all_deletes_trees_and_their_data() {
    let mut v = fresh();
    v.mkdir("/tmp/t/sub", 0o755, true).unwrap();
    v.write_file("/tmp/t/a", b"1").unwrap();
    v.write_file("/tmp/t/sub/b", b"2").unwrap();
    v.remove_all("/tmp/t").unwrap();
    assert!(!v.exists("/tmp/t"));
    v.flush().unwrap();
    assert!(!v.storage().keys().iter().any(|k| k.starts_with("data/")));
    assert_eq!(code(v.remove_all("/")), Errno::EBUSY);
}

// -------------------------------------------------------- paths and symlinks

#[test]
fn dot_and_dotdot_resolve_lexically_within_the_tree() {
    let mut v = fresh();
    v.mkdir("/tmp/a/b", 0o755, true).unwrap();
    assert_eq!(v.realpath("/tmp/a/./b/../b").unwrap(), "/tmp/a/b");
    assert_eq!(v.realpath("/../../tmp").unwrap(), "/tmp");
    assert_eq!(v.realpath("//tmp///a/").unwrap(), "/tmp/a");
    assert_eq!(v.realpath("/").unwrap(), "/");
}

#[test]
fn symlinks_resolve_absolute_and_relative() {
    let mut v = fresh();
    v.mkdir("/tmp/real/inner", 0o755, true).unwrap();
    v.write_file("/tmp/real/inner/f", b"data").unwrap();
    v.symlink("/tmp/real", "/tmp/abs").unwrap();
    v.symlink("real/inner", "/tmp/rel").unwrap();
    assert_eq!(v.read_file("/tmp/abs/inner/f").unwrap(), b"data");
    assert_eq!(v.read_file("/tmp/rel/f").unwrap(), b"data");
    assert_eq!(v.realpath("/tmp/rel/f").unwrap(), "/tmp/real/inner/f");
    assert_eq!(v.readlink("/tmp/rel").unwrap(), "real/inner");
    assert_eq!(code(v.readlink("/tmp/real")), Errno::EINVAL);
}

#[test]
fn dotdot_after_a_symlink_follows_the_physical_parent() {
    let mut v = fresh();
    v.mkdir("/tmp/a/b", 0o755, true).unwrap();
    v.mkdir("/tmp/c", 0o755, true).unwrap();
    v.symlink("/tmp/a/b", "/tmp/c/link").unwrap();
    assert_eq!(v.realpath("/tmp/c/link/..").unwrap(), "/tmp/a");
}

#[test]
fn stat_follows_links_but_lstat_does_not() {
    let mut v = fresh();
    v.write_file("/tmp/f", b"12345").unwrap();
    v.symlink("/tmp/f", "/tmp/l").unwrap();
    assert_eq!(v.stat("/tmp/l").unwrap().kind, FileType::File);
    assert_eq!(v.stat("/tmp/l").unwrap().size, 5);
    assert_eq!(v.lstat("/tmp/l").unwrap().kind, FileType::Symlink);
}

#[test]
fn symlink_loops_and_dangling_links() {
    let mut v = fresh();
    v.symlink("/tmp/b", "/tmp/a").unwrap();
    v.symlink("/tmp/a", "/tmp/b").unwrap();
    assert_eq!(code(v.stat("/tmp/a")), Errno::ELOOP);
    v.symlink("/tmp/missing", "/tmp/dangling").unwrap();
    assert_eq!(code(v.stat("/tmp/dangling")), Errno::ENOENT);
    assert!(v.lstat("/tmp/dangling").is_ok());
    assert_eq!(code(v.open("/tmp/dangling", RW_CREATE, 0o644)), Errno::ENOENT);
}

#[test]
fn unlinking_a_symlink_leaves_the_target() {
    let mut v = fresh();
    v.write_file("/tmp/f", b"x").unwrap();
    v.symlink("/tmp/f", "/tmp/l").unwrap();
    v.unlink("/tmp/l").unwrap();
    assert!(v.exists("/tmp/f"));
}

#[test]
fn name_and_path_limits() {
    let mut v = fresh();
    let long = "x".repeat(256);
    assert_eq!(code(v.write_file(&format!("/tmp/{long}"), b"")), Errno::ENAMETOOLONG);
    v.write_file(&format!("/tmp/{}", "x".repeat(255)), b"").unwrap();
    assert_eq!(code(v.stat(&format!("/{}", "a/".repeat(2100)))), Errno::ENAMETOOLONG);
    assert_eq!(code(v.mkdir("/tmp/..", 0o755, false)), Errno::EINVAL);
}

// -------------------------------------------------------------- case folding

#[test]
fn lookups_ignore_case_but_preserve_spelling() {
    let mut v = fresh();
    v.write_file("/tmp/Hello.TXT", b"hi").unwrap();
    assert_eq!(v.read_file("/tmp/hello.txt").unwrap(), b"hi");
    assert_eq!(v.realpath("/TMP/HELLO.txt").unwrap(), "/tmp/Hello.TXT");
    assert_eq!(code(v.mkdir("/tmp/hello.txt", 0o755, false)), Errno::EEXIST);
}

#[test]
fn case_only_rename_is_allowed() {
    let mut v = fresh();
    v.write_file("/tmp/note", b"x").unwrap();
    v.rename("/tmp/note", "/tmp/Note").unwrap();
    assert_eq!(names(&v, "/tmp"), ["Note"]);
    assert_eq!(v.read_file("/tmp/note").unwrap(), b"x");
}

// ------------------------------------------------------------------- rename

#[test]
fn rename_moves_files_and_directories() {
    let mut v = fresh();
    v.mkdir("/tmp/d", 0o755, false).unwrap();
    v.write_file("/tmp/d/f", b"1").unwrap();
    v.rename("/tmp/d", "/tmp/e").unwrap();
    assert_eq!(v.read_file("/tmp/e/f").unwrap(), b"1");
    assert!(!v.exists("/tmp/d"));
    v.rename("/tmp/e/f", "/tmp/g").unwrap();
    assert_eq!(v.read_file("/tmp/g").unwrap(), b"1");
}

#[test]
fn rename_replaces_an_existing_file_and_frees_it() {
    let mut v = fresh();
    v.write_file("/tmp/a", b"new").unwrap();
    v.write_file("/tmp/b", b"old").unwrap();
    v.rename("/tmp/a", "/tmp/b").unwrap();
    assert_eq!(v.read_file("/tmp/b").unwrap(), b"new");
    v.flush().unwrap();
    assert_eq!(v.storage().keys().iter().filter(|k| k.starts_with("data/")).count(), 1);
}

#[test]
fn rename_type_conflicts() {
    let mut v = fresh();
    v.mkdir("/tmp/d", 0o755, false).unwrap();
    v.mkdir("/tmp/full", 0o755, false).unwrap();
    v.write_file("/tmp/full/x", b"").unwrap();
    v.mkdir("/tmp/empty", 0o755, false).unwrap();
    v.write_file("/tmp/f", b"").unwrap();
    assert_eq!(code(v.rename("/tmp/d", "/tmp/f")), Errno::ENOTDIR);
    assert_eq!(code(v.rename("/tmp/f", "/tmp/d")), Errno::EISDIR);
    assert_eq!(code(v.rename("/tmp/d", "/tmp/full")), Errno::ENOTEMPTY);
    v.rename("/tmp/d", "/tmp/empty").unwrap();
}

#[test]
fn rename_directory_into_itself_is_rejected() {
    let mut v = fresh();
    v.mkdir("/tmp/a/b", 0o755, true).unwrap();
    assert_eq!(code(v.rename("/tmp/a", "/tmp/a/b/a")), Errno::EINVAL);
    assert_eq!(code(v.rename("/tmp/a", "/tmp/a/x")), Errno::EINVAL);
    assert_eq!(code(v.rename("/", "/tmp/r")), Errno::EBUSY);
    v.rename("/tmp/a", "/tmp/a").unwrap();
}

#[test]
fn open_handles_follow_a_renamed_file() {
    let mut v = fresh();
    let fd = v.open("/tmp/a", RW_CREATE, 0o644).unwrap();
    v.rename("/tmp/a", "/tmp/b").unwrap();
    v.take_events();
    v.write(fd, b"x", None).unwrap();
    assert_eq!(v.take_events()[0].path, "/tmp/b");
}

// --------------------------------------------------------------------- copy

#[test]
fn copy_file_duplicates_contents_and_metadata() {
    let mut v = fresh();
    let big: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    v.write_file("/tmp/src", &big).unwrap();
    v.setxattr("/tmp/src", "k", "v").unwrap();
    v.chmod("/tmp/src", 0o600).unwrap();
    v.copy("/tmp/src", "/tmp/dst", false).unwrap();
    assert_eq!(v.read_file("/tmp/dst").unwrap(), big);
    assert_eq!(v.getxattr("/tmp/dst", "k").unwrap().as_deref(), Some("v"));
    assert_eq!(v.stat("/tmp/dst").unwrap().mode, 0o600);
    v.write_file("/tmp/src", b"changed").unwrap();
    assert_eq!(v.read_file("/tmp/dst").unwrap(), big);
}

#[test]
fn copy_directory_requires_recursive_and_copies_the_tree() {
    let mut v = fresh();
    v.mkdir("/tmp/t/sub", 0o755, true).unwrap();
    v.write_file("/tmp/t/sub/f", b"deep").unwrap();
    v.symlink("sub/f", "/tmp/t/l").unwrap();
    assert_eq!(code(v.copy("/tmp/t", "/tmp/u", false)), Errno::EISDIR);
    v.copy("/tmp/t", "/tmp/u", true).unwrap();
    assert_eq!(v.read_file("/tmp/u/l").unwrap(), b"deep");
    assert_eq!(v.readlink("/tmp/u/l").unwrap(), "sub/f");
}

#[test]
fn copy_errors() {
    let mut v = fresh();
    v.mkdir("/tmp/a", 0o755, false).unwrap();
    v.write_file("/tmp/f", b"").unwrap();
    assert_eq!(code(v.copy("/tmp/f", "/tmp/a", false)), Errno::EEXIST);
    assert_eq!(code(v.copy("/tmp/a", "/tmp/a/inside", true)), Errno::EINVAL);
    assert_eq!(code(v.copy("/tmp/none", "/tmp/x", false)), Errno::ENOENT);
}

// -------------------------------------------------------------------- trash

#[test]
fn trash_and_restore_round_trip() {
    let mut v = fresh();
    v.mkdir("/Users/me/Documents", 0o755, true).unwrap();
    v.write_file("/Users/me/Documents/a.txt", b"keep").unwrap();
    let trashed = v.trash("/Users/me/Documents/a.txt", "/Users/me/.Trash").unwrap();
    assert_eq!(trashed, "/Users/me/.Trash/a.txt");
    assert!(!v.exists("/Users/me/Documents/a.txt"));
    let back = v.restore(&trashed).unwrap();
    assert_eq!(back, "/Users/me/Documents/a.txt");
    assert_eq!(v.read_file(&back).unwrap(), b"keep");
    assert!(v.listxattr(&back).unwrap().is_empty());
}

#[test]
fn trash_renames_on_name_clash() {
    let mut v = fresh();
    for dir in ["/tmp/x", "/tmp/y", "/tmp/z"] {
        v.mkdir(dir, 0o755, false).unwrap();
        v.write_file(&format!("{dir}/a.txt"), b"").unwrap();
    }
    let t = "/Users/.Trash";
    assert_eq!(v.trash("/tmp/x/a.txt", t).unwrap(), "/Users/.Trash/a.txt");
    assert_eq!(v.trash("/tmp/y/a.txt", t).unwrap(), "/Users/.Trash/a 2.txt");
    assert_eq!(v.trash("/tmp/z/a.txt", t).unwrap(), "/Users/.Trash/a 3.txt");
}

#[test]
fn restore_recreates_missing_parents_and_refuses_to_overwrite() {
    let mut v = fresh();
    v.mkdir("/tmp/gone", 0o755, false).unwrap();
    v.write_file("/tmp/gone/f", b"1").unwrap();
    let t = v.trash("/tmp/gone/f", "/Users/.Trash").unwrap();
    v.rmdir("/tmp/gone").unwrap();
    assert_eq!(v.restore(&t).unwrap(), "/tmp/gone/f");

    let t = v.trash("/tmp/gone/f", "/Users/.Trash").unwrap();
    v.write_file("/tmp/gone/f", b"2").unwrap();
    assert_eq!(code(v.restore(&t)), Errno::EEXIST);
    assert_eq!(code(v.restore("/tmp")), Errno::EINVAL);
}

#[test]
fn trash_guards_and_empty_trash() {
    let mut v = fresh();
    v.mkdir("/tmp/d", 0o755, false).unwrap();
    v.write_file("/tmp/d/f", b"x").unwrap();
    let t = v.trash("/tmp/d", "/Users/.Trash").unwrap();
    assert_eq!(code(v.trash(&t, "/Users/.Trash")), Errno::EINVAL);
    assert_eq!(code(v.trash("/", "/Users/.Trash")), Errno::EBUSY);
    v.empty_trash("/Users/.Trash").unwrap();
    assert!(v.readdir("/Users/.Trash").unwrap().is_empty());
    v.flush().unwrap();
    assert!(!v.storage().keys().iter().any(|k| k.starts_with("data/")));
}

// ---------------------------------------------------------------- atomic write

#[test]
fn atomic_write_replaces_contents_and_leaves_no_temp_files() {
    let mut v = fresh();
    v.write_file("/tmp/doc", b"v1").unwrap();
    v.write_file_atomic("/tmp/doc", b"v2").unwrap();
    assert_eq!(v.read_file("/tmp/doc").unwrap(), b"v2");
    v.write_file_atomic("/tmp/new", b"fresh").unwrap();
    assert_eq!(names(&v, "/tmp"), ["doc", "new"]);
}

#[test]
fn atomic_write_failure_keeps_the_original() {
    let mut v = fresh();
    v.write_file("/tmp/doc", b"original").unwrap();
    let used = v.storage().used();
    v.storage_mut().set_capacity(Some(used + 4));
    let r = v.write_file_atomic("/tmp/doc", b"a much longer replacement");
    assert_eq!(code(r), Errno::ENOSPC);
    assert_eq!(v.read_file("/tmp/doc").unwrap(), b"original");
    assert_eq!(names(&v, "/tmp"), ["doc"]);
}

// ----------------------------------------------------------------- misc

#[test]
fn enospc_surfaces_from_storage() {
    let mut v = Vfs::format(MemStorage::with_capacity(200_000), Options::default()).unwrap();
    v.write_file("/tmp/ok", &[0u8; 1000]).unwrap();
    let r = v.write_file("/tmp/big", &vec![0u8; 500_000]);
    assert_eq!(code(r), Errno::ENOSPC);
}

#[test]
fn statfs_reports_usage() {
    let mut v = Vfs::format(MemStorage::with_capacity(1_000_000), Options::default()).unwrap();
    v.write_file("/tmp/f", &[1u8; 4096]).unwrap();
    let s = v.statfs();
    assert_eq!(s.used, 4096);
    assert_eq!(s.total, Some(1_000_000));
    assert!(s.free.unwrap() < 1_000_000);
    assert_eq!(fresh().statfs().total, None);
}

#[test]
fn timestamps_use_the_injected_clock() {
    let mut v = fresh();
    let t = Rc::new(Cell::new(1000u64));
    let t2 = t.clone();
    v.set_clock(Box::new(move || t2.get()));
    v.write_file("/tmp/f", b"a").unwrap();
    assert_eq!(v.stat("/tmp/f").unwrap().birthtime, 1000);
    t.set(2000);
    v.write_file("/tmp/f", b"b").unwrap();
    let s = v.stat("/tmp/f").unwrap();
    assert_eq!((s.birthtime, s.mtime), (1000, 2000));
    assert_eq!(v.stat("/tmp").unwrap().mtime, 1000);
    v.utimes("/tmp/f", 5, 6).unwrap();
    let s = v.stat("/tmp/f").unwrap();
    assert_eq!((s.atime, s.mtime), (5, 6));
}

#[test]
fn chmod_masks_to_permission_bits() {
    let mut v = fresh();
    v.write_file("/tmp/f", b"").unwrap();
    v.chmod("/tmp/f", 0o170755).unwrap();
    assert_eq!(v.stat("/tmp/f").unwrap().mode, 0o755);
}

#[test]
fn xattr_lifecycle() {
    let mut v = fresh();
    v.write_file("/tmp/f", b"").unwrap();
    assert_eq!(v.getxattr("/tmp/f", "a").unwrap(), None);
    v.setxattr("/tmp/f", "b", "2").unwrap();
    v.setxattr("/tmp/f", "a", "1").unwrap();
    assert_eq!(v.listxattr("/tmp/f").unwrap(), ["a", "b"]);
    v.removexattr("/tmp/f", "a").unwrap();
    assert_eq!(v.listxattr("/tmp/f").unwrap(), ["b"]);
}

// --------------------------------------------------------------------- events

#[test]
fn events_describe_namespace_changes() {
    let mut v = fresh();
    v.take_events();
    v.write_file("/tmp/f", b"x").unwrap();
    v.rename("/tmp/f", "/tmp/g").unwrap();
    v.unlink("/tmp/g").unwrap();
    let ev: Vec<_> = v.take_events().into_iter().map(|e| (e.kind, e.path, e.old_path)).collect();
    assert_eq!(
        ev,
        [
            (FsEventKind::Created, "/tmp/f".into(), None),
            (FsEventKind::Modified, "/tmp/f".into(), None),
            (FsEventKind::Renamed, "/tmp/g".into(), Some("/tmp/f".into())),
            (FsEventKind::Deleted, "/tmp/g".into(), None),
        ]
    );
    assert!(v.take_events().is_empty());
}

#[test]
fn repeated_writes_on_one_handle_emit_a_single_modified_event() {
    let mut v = fresh();
    let fd = v.open("/tmp/f", RW_CREATE, 0o644).unwrap();
    v.take_events();
    for _ in 0..5 {
        v.write(fd, b"x", None).unwrap();
    }
    assert_eq!(v.take_events().len(), 1);
}

// ---------------------------------------------------------------------------
// Backends that need async setup (OPFS) answer `EAGAIN` until the caller opens
// a blob, then the whole operation is retried. Every operation must be safe to
// retry: it may not leave partial state, and a retry must converge.

mod lazy {
    use std::cell::RefCell;
    use std::collections::HashSet;
    use std::rc::Rc;

    use tiny_vfs::*;

    /// `MemStorage` that refuses access to a blob until it has been "opened".
    #[derive(Clone, Default)]
    pub struct LazyStorage {
        inner: Rc<RefCell<MemStorage>>,
        opened: Rc<RefCell<HashSet<String>>>,
        pub retries: Rc<RefCell<u32>>,
    }

    impl LazyStorage {
        fn gate(&self, key: &str) -> Result<()> {
            if self.opened.borrow().contains(key) {
                Ok(())
            } else {
                Err(SysError::new(Errno::EAGAIN).with_path(key))
            }
        }
        pub fn open(&self, keys: &str) {
            for k in keys.split('\n') {
                self.opened.borrow_mut().insert(k.to_string());
            }
            *self.retries.borrow_mut() += 1;
        }
        pub fn snapshot(&self) -> MemStorage {
            self.inner.borrow().clone()
        }
    }

    impl Storage for LazyStorage {
        fn len(&self, key: &str) -> Result<Option<u64>> {
            if self.inner.borrow().len(key)?.is_some() {
                self.gate(key)?;
            }
            self.inner.borrow().len(key)
        }
        fn read_at(&self, key: &str, offset: u64, buf: &mut [u8]) -> Result<usize> {
            if self.inner.borrow().len(key)?.is_some() {
                self.gate(key)?;
            }
            self.inner.borrow().read_at(key, offset, buf)
        }
        fn write_at(&mut self, key: &str, offset: u64, data: &[u8]) -> Result<()> {
            self.gate(key)?;
            self.inner.borrow_mut().write_at(key, offset, data)
        }
        fn truncate(&mut self, key: &str, size: u64) -> Result<()> {
            self.gate(key)?;
            self.inner.borrow_mut().truncate(key, size)
        }
        fn delete(&mut self, key: &str) -> Result<()> {
            self.opened.borrow_mut().remove(key);
            self.inner.borrow_mut().delete(key)
        }
        fn prepare(&mut self, keys: &[String]) -> Result<()> {
            let missing: Vec<String> =
                keys.iter().filter(|k| !self.opened.borrow().contains(*k)).cloned().collect();
            if missing.is_empty() {
                Ok(())
            } else {
                Err(SysError::new(Errno::EAGAIN).with_path(&missing.join("\n")))
            }
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
}

use lazy::LazyStorage;

/// Run `op`, opening whatever the backend asks for and retrying, as the
/// TypeScript wrapper does.
fn retry<T>(
    st: &LazyStorage,
    vfs: &mut Vfs<LazyStorage>,
    mut op: impl FnMut(&mut Vfs<LazyStorage>) -> Result<T>,
) -> Result<T> {
    for _ in 0..64 {
        match op(vfs) {
            Err(e) if e.code == Errno::EAGAIN => st.open(e.path.as_deref().unwrap()),
            other => return other,
        }
    }
    panic!("operation never converged");
}

fn lazy_vfs() -> (LazyStorage, Vfs<LazyStorage>) {
    let st = LazyStorage::default();
    let mut vfs = None;
    for _ in 0..64 {
        match Vfs::mount(st.clone()) {
            Ok(v) => {
                vfs = Some(v);
                break;
            }
            Err(e) if e.code == Errno::EAGAIN => st.open(e.path.as_deref().unwrap()),
            Err(e) => panic!("mount failed: {e}"),
        }
    }
    (st.clone(), vfs.expect("mount converged"))
}

#[test]
fn lazy_backend_first_boot_converges_and_persists() {
    let (st, mut v) = lazy_vfs();
    retry(&st, &mut v, |v| v.flush()).unwrap();
    drop(v);
    let v = Vfs::mount(st.snapshot()).unwrap();
    assert!(v.exists("/tmp"));
}

#[test]
fn lazy_backend_write_file_is_retry_safe() {
    let (st, mut v) = lazy_vfs();
    retry(&st, &mut v, |v| v.write_file("/tmp/f", b"hello")).unwrap();
    assert_eq!(retry(&st, &mut v, |v| v.read_file("/tmp/f")).unwrap(), b"hello");
    let listing: Vec<String> = v.readdir("/tmp").unwrap().into_iter().map(|e| e.name).collect();
    assert_eq!(listing, ["f"]);
}

#[test]
fn lazy_backend_atomic_write_converges_without_leftovers() {
    let (st, mut v) = lazy_vfs();
    retry(&st, &mut v, |v| v.write_file("/tmp/doc", b"v1")).unwrap();
    retry(&st, &mut v, |v| v.write_file_atomic("/tmp/doc", b"v2")).unwrap();
    assert_eq!(retry(&st, &mut v, |v| v.read_file("/tmp/doc")).unwrap(), b"v2");
    let listing: Vec<String> =
        v.readdir("/tmp").unwrap().into_iter().map(|e| e.name).collect();
    assert_eq!(listing, ["doc"], "retries must not strand temp files");
}

#[test]
fn lazy_backend_copy_tree_opens_everything_up_front() {
    let (st, mut v) = lazy_vfs();
    retry(&st, &mut v, |v| v.mkdir("/tmp/src/sub", 0o755, true)).unwrap();
    for i in 0..20 {
        let data = format!("file {i}");
        retry(&st, &mut v, |v| v.write_file(&format!("/tmp/src/sub/f{i}"), data.as_bytes())).unwrap();
    }
    let before = *st.retries.borrow();
    // Exactly one retry round for the whole tree, and no partial copy on the way.
    let mut attempts = 0;
    let r = retry(&st, &mut v, |v| {
        attempts += 1;
        if attempts == 1 {
            // The first attempt must fail cleanly before changing anything.
            let r = v.copy("/tmp/src", "/tmp/dst", true);
            assert_eq!(r.as_ref().unwrap_err().code, Errno::EAGAIN);
            assert!(!v.exists("/tmp/dst"), "a failed attempt must not leave a partial copy");
            return r;
        }
        v.copy("/tmp/src", "/tmp/dst", true)
    });
    r.unwrap();
    assert_eq!(*st.retries.borrow() - before, 1);
    for i in 0..20 {
        let got = retry(&st, &mut v, |v| v.read_file(&format!("/tmp/dst/sub/f{i}"))).unwrap();
        assert_eq!(got, format!("file {i}").as_bytes());
    }
}

#[test]
fn lazy_backend_handle_io_and_truncate() {
    let (st, mut v) = lazy_vfs();
    let fd = retry(&st, &mut v, |v| v.open("/tmp/h", RW_CREATE, 0o644)).unwrap();
    retry(&st, &mut v, |v| v.write(fd, b"abcdef", None)).unwrap();
    retry(&st, &mut v, |v| v.ftruncate(fd, 3)).unwrap();
    let mut buf = [0u8; 8];
    let n = retry(&st, &mut v, |v| v.read(fd, &mut buf, Some(0))).unwrap();
    assert_eq!(&buf[..n], b"abc");
    v.close(fd).unwrap();
    retry(&st, &mut v, |v| v.truncate("/tmp/h", 5)).unwrap();
    assert_eq!(retry(&st, &mut v, |v| v.read_file("/tmp/h")).unwrap(), [b'a', b'b', b'c', 0, 0]);
}

#[test]
fn lazy_backend_events_are_not_duplicated_by_retries() {
    let (st, mut v) = lazy_vfs();
    v.take_events();
    retry(&st, &mut v, |v| v.write_file("/tmp/e", b"x")).unwrap();
    let kinds: Vec<_> = v.take_events().into_iter().map(|e| e.kind).collect();
    assert_eq!(kinds, [FsEventKind::Created, FsEventKind::Modified]);
}

#[test]
fn reading_a_directory_as_a_file_is_eisdir() {
    let mut v = fresh();
    assert_eq!(code(v.read_file("/tmp")), Errno::EISDIR);
}

#[test]
fn owners_follow_the_creator_and_chown_changes_them() {
    let mut fs = Vfs::mount(MemStorage::new()).unwrap();
    // root by default
    fs.mkdir("/a", 0o755, false).unwrap();
    assert_eq!((fs.stat("/a").unwrap().uid, fs.stat("/a").unwrap().gid), (0, 0));

    fs.set_creds(501, 20);
    fs.mkdir("/a/b/c", 0o755, true).unwrap();
    fs.write_file("/a/f", b"x").unwrap();
    fs.symlink("/a/f", "/a/l").unwrap();
    for p in ["/a/b", "/a/b/c", "/a/f"] {
        let st = fs.stat(p).unwrap();
        assert_eq!((st.uid, st.gid), (501, 20), "{p}");
    }
    assert_eq!(fs.lstat("/a/l").unwrap().uid, 501);
    assert_eq!(fs.stat("/a").unwrap().uid, 0); // already existed

    // creating does not change who owns what is already there
    fs.set_creds(0, 0);
    fs.write_file("/a/f", b"y").unwrap();
    assert_eq!(fs.stat("/a/f").unwrap().uid, 501);

    fs.chown("/a/f", Some(7), None).unwrap();
    let st = fs.stat("/a/f").unwrap();
    assert_eq!((st.uid, st.gid), (7, 20));
    fs.chown("/a/f", None, Some(9)).unwrap();
    assert_eq!((fs.stat("/a/f").unwrap().uid, fs.stat("/a/f").unwrap().gid), (7, 9));
    assert_eq!(fs.chown("/nope", Some(1), None).unwrap_err().code, Errno::ENOENT);
}

#[test]
fn owners_survive_a_remount() {
    let mut fs = Vfs::mount(MemStorage::new()).unwrap();
    fs.set_creds(501, 20);
    fs.write_file("/mine", b"x").unwrap();
    fs.chown("/mine", Some(502), None).unwrap();
    fs.flush().unwrap();
    let fs = Vfs::mount(fs.into_storage()).unwrap();
    let st = fs.stat("/mine").unwrap();
    assert_eq!((st.uid, st.gid), (502, 20));
}
