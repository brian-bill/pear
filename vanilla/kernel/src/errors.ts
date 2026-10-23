const MESSAGES: Record<string, string> = {
  ENOENT: 'no such file or directory',
  EINVAL: 'invalid argument',
  EBADF: 'bad file handle',
  EAGAIN: 'resource temporarily unavailable',
  ENOSYS: 'function not implemented',
  ESRCH: 'no such process',
  EPERM: 'operation not permitted',
  ENOTDIR: 'not a directory',
  EISDIR: 'is a directory',
  EPIPE: 'port is dead',
  EACCES: 'permission denied',
  EEXIST: 'already exists',
  ETIMEDOUT: 'timed out',
  EMFILE: 'too many open files',
  ENOTTY: 'not a terminal',
  E2BIG: 'value too large',
  EBUSY: 'resource busy',
  EROFS: 'read-only file system',
  ENOTEMPTY: 'directory not empty',
  ECANCELED: 'canceled',
  EXDEV: 'cross-device link',
  EIO: 'input/output error',
  ENOSPC: 'no space left',
}

/** errno-style error raised by the kernel (the file system engine raises the same shape). */
export class SysError extends Error {
  constructor(
    readonly code: string,
    message?: string,
    readonly path?: string,
  ) {
    super(message ?? MESSAGES[code] ?? code)
    this.name = 'SysError'
  }
}

export interface WireError {
  name: string
  message: string
  code?: string
  path?: string
}

export function toWireError(e: unknown): WireError {
  const err = e as { name?: string; message?: string; code?: string; path?: string }
  return { name: err?.name ?? 'Error', message: err?.message ?? String(e), code: err?.code, path: err?.path }
}
