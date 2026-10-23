use std::fmt;

/// errno-style codes, matching `contracts/conventions.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Errno {
    ENOENT,
    EEXIST,
    EACCES,
    EPERM,
    EINVAL,
    EBUSY,
    ENOSPC,
    ENOTDIR,
    EISDIR,
    ENOTEMPTY,
    ELOOP,
    ENAMETOOLONG,
    EBADF,
    EIO,
    /// The storage backend needs async work first; see `Storage::prepare`.
    /// `SysError::path` lists the blob keys to open, separated by newlines.
    EAGAIN,
}

impl Errno {
    pub fn as_str(self) -> &'static str {
        match self {
            Errno::ENOENT => "ENOENT",
            Errno::EEXIST => "EEXIST",
            Errno::EACCES => "EACCES",
            Errno::EPERM => "EPERM",
            Errno::EINVAL => "EINVAL",
            Errno::EBUSY => "EBUSY",
            Errno::ENOSPC => "ENOSPC",
            Errno::ENOTDIR => "ENOTDIR",
            Errno::EISDIR => "EISDIR",
            Errno::ENOTEMPTY => "ENOTEMPTY",
            Errno::ELOOP => "ELOOP",
            Errno::ENAMETOOLONG => "ENAMETOOLONG",
            Errno::EBADF => "EBADF",
            Errno::EIO => "EIO",
            Errno::EAGAIN => "EAGAIN",
        }
    }

    fn describe(self) -> &'static str {
        match self {
            Errno::ENOENT => "no such file or directory",
            Errno::EEXIST => "file exists",
            Errno::EACCES => "permission denied",
            Errno::EPERM => "operation not permitted",
            Errno::EINVAL => "invalid argument",
            Errno::EBUSY => "resource busy",
            Errno::ENOSPC => "no space left on device",
            Errno::ENOTDIR => "not a directory",
            Errno::EISDIR => "is a directory",
            Errno::ENOTEMPTY => "directory not empty",
            Errno::ELOOP => "too many levels of symbolic links",
            Errno::ENAMETOOLONG => "name too long",
            Errno::EBADF => "bad file handle",
            Errno::EIO => "input/output error",
            Errno::EAGAIN => "resource temporarily unavailable",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SysError {
    pub code: Errno,
    pub message: String,
    pub path: Option<String>,
}

impl SysError {
    pub fn new(code: Errno) -> Self {
        SysError { code, message: code.describe().to_string(), path: None }
    }

    pub fn msg(code: Errno, message: impl Into<String>) -> Self {
        SysError { code, message: message.into(), path: None }
    }

    pub fn with_path(mut self, path: &str) -> Self {
        if self.path.is_none() {
            self.path = Some(path.to_string());
        }
        self
    }
}

impl fmt::Display for SysError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.path {
            Some(p) => write!(f, "{}: {} ({})", self.code.as_str(), self.message, p),
            None => write!(f, "{}: {}", self.code.as_str(), self.message),
        }
    }
}

impl std::error::Error for SysError {}

pub type Result<T> = std::result::Result<T, SysError>;
