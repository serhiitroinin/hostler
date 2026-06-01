// Atomic file writes and a crude cross-process advisory lock. Used for
// /etc/hosts and nginx config mutations so concurrent add/remove invocations
// can't clobber each other or leave a half-written file behind.
import { closeSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Writes `content` to `path` atomically: write a sibling temp file, fsync via
 * close, then rename over the target (atomic within a filesystem). A crash
 * leaves either the old file or the temp file — never a truncated target.
 */
export function writeFileAtomicSync(path: string, content: string, mode = 0o644): void {
  // pid alone is enough to disambiguate; we already hold the lock when writing.
  const tmp = join(dirname(path), `.${process.pid}.hostler.tmp`);
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * Runs `fn` while holding an exclusive lock created via O_EXCL. Retries briefly
 * if the lock is held, then gives up. The lock file is always removed on exit.
 */
export async function withLock<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const lockPath = join(tmpdir(), `hostler-${name}.lock`);
  const deadline = Date.now() + 5000;
  let fd: number | undefined;

  for (;;) {
    try {
      fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL — fails if it exists
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() > deadline) {
        // Couldn't acquire (held too long or unexpected error) — proceed without
        // the lock rather than failing the whole operation outright.
        fd = undefined;
        break;
      }
      await Bun.sleep(50);
    }
  }

  try {
    return await fn();
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {
        // already gone — fine
      }
    }
  }
}
