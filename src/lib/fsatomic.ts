// Atomic file writes and a crude cross-process advisory lock. Used for
// /etc/hosts and nginx config mutations so concurrent add/remove invocations
// can't clobber each other or leave a half-written file behind.
import { closeSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
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

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

/**
 * Runs `fn` while holding an exclusive lock created via O_EXCL.
 *
 * Fails CLOSED: if the lock can't be acquired within `timeoutMs`, it throws
 * rather than running the critical section unlocked (the previous behavior left
 * /etc/hosts open to clobbering under contention). A lock file whose mtime is
 * older than `staleMs` is treated as abandoned and reclaimed, so a crashed
 * process can't wedge the tool forever.
 */
export async function withLock<T>(
  name: string,
  fn: () => Promise<T> | T,
  { timeoutMs = 5000, staleMs = 30000 }: LockOptions = {},
): Promise<T> {
  const lockPath = join(tmpdir(), `hostler-${name}.lock`);
  const deadline = Date.now() + timeoutMs;
  let fd: number;

  for (;;) {
    try {
      fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL — fails if it exists
      writeSync(fd, `${process.pid}\n`);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      // Reclaim an abandoned lock left by a crashed process.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // lock vanished between open and stat — retry immediately
        continue;
      }

      if (Date.now() > deadline) {
        throw new Error(`could not acquire ${name} lock within ${timeoutMs}ms (held by another process)`);
      }
      await Bun.sleep(50);
    }
  }

  try {
    return await fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone — fine
    }
  }
}
