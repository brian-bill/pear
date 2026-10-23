use crate::error::{Errno, Result, SysError};

pub const NAME_MAX: usize = 255;
pub const PATH_MAX: usize = 4096;

/// Split a path into components, dropping empty segments. `.` and `..` are kept
/// for the resolver to handle.
pub fn split(path: &str) -> Result<Vec<String>> {
    if path.len() > PATH_MAX {
        return Err(SysError::new(Errno::ENAMETOOLONG));
    }
    if path.contains('\0') {
        return Err(SysError::msg(Errno::EINVAL, "path contains NUL"));
    }
    let mut out = Vec::new();
    for c in path.split('/').filter(|c| !c.is_empty()) {
        if c.len() > NAME_MAX {
            return Err(SysError::new(Errno::ENAMETOOLONG));
        }
        out.push(c.to_string());
    }
    Ok(out)
}

/// Like [`split`], but requires an absolute path. The VFS has no working
/// directory; the syscall layer makes relative paths absolute.
pub fn components(path: &str) -> Result<Vec<String>> {
    if !path.starts_with('/') {
        return Err(SysError::msg(Errno::EINVAL, "path must be absolute").with_path(path));
    }
    split(path).map_err(|e| e.with_path(path))
}

/// Validate a single entry name for creation.
pub fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\0') {
        return Err(SysError::msg(Errno::EINVAL, format!("invalid name {name:?}")));
    }
    if name.len() > NAME_MAX {
        return Err(SysError::new(Errno::ENAMETOOLONG));
    }
    Ok(())
}

pub fn join(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// Split a canonical absolute path into (parent, name). The root has no name.
pub fn parent_and_name(path: &str) -> Option<(String, String)> {
    let trimmed = path.trim_end_matches('/');
    let idx = trimmed.rfind('/')?;
    let name = &trimmed[idx + 1..];
    if name.is_empty() {
        return None;
    }
    let parent = if idx == 0 { "/" } else { &trimmed[..idx] };
    Some((parent.to_string(), name.to_string()))
}
