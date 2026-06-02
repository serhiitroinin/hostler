// Configuration paths and init detection.
//
// The per-domain nginx configs live under /etc/hostler/<username>, NOT under
// the user's home. Anything inside ~ is unsafe to include into root nginx: the
// user owns ~ and can rename any path component (even a root-owned child) and
// recreate it user-writable. /etc is root-owned all the way down, so the
// included path can't be swapped out by an unprivileged process.
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve, sep } from "node:path";
import { run } from "./exec.ts";

export const SYSTEM_CONFIG_BASE = "/etc/hostler";
export const INIT_MARKER_FILE = ".initialized";

// Unix usernames are restricted; reject anything that could escape the base dir.
function sanitizeUsername(name: string): string {
  if (!/^[a-zA-Z0-9._][a-zA-Z0-9._-]*$/.test(name) || name.length > 32) {
    throw new Error(`unsafe username: ${name}`);
  }
  // "." and "..", though they match the charset, are path traversal: they'd
  // resolve getUserConfigDir to /etc/hostler or /etc itself.
  if (name === "." || name === "..") {
    throw new Error(`unsafe username: ${name}`);
  }
  // Assert the resulting path actually stays directly under the base dir.
  const full = resolve(SYSTEM_CONFIG_BASE, name);
  if (full !== join(SYSTEM_CONFIG_BASE, name) || !full.startsWith(SYSTEM_CONFIG_BASE + sep)) {
    throw new Error(`unsafe username: ${name}`);
  }
  return name;
}

/** Returns the (root-owned) config directory for a username. */
export function getUserConfigDir(username: string): string {
  return join(SYSTEM_CONFIG_BASE, sanitizeUsername(username));
}

/** The username of the process owner (root inside the privileged helpers). */
export function getCurrentUsername(): string {
  return userInfo().username;
}

/** The username that invoked the command, resolving through sudo. */
export function getInvokingUsername(): string {
  return process.env.SUDO_USER || getCurrentUsername();
}

/** Config dir for the current process owner (used by unprivileged commands). */
export function getCurrentUserConfigDir(): string {
  return getUserConfigDir(getCurrentUsername());
}

/**
 * Config dir of the user who invoked the process, even under sudo. The
 * privileged `_nginx-*` helpers run as root, so they resolve the target dir
 * from SUDO_USER rather than the current (root) user.
 */
export function getInvokingUserConfigDir(): string {
  return getUserConfigDir(getInvokingUsername());
}

/** True if hostler has been initialized for the current user. */
export function isInitialized(): boolean {
  return existsSync(join(getCurrentUserConfigDir(), INIT_MARKER_FILE));
}

/** Writes the init marker into the given config directory. */
export async function writeInitMarker(configDir: string): Promise<void> {
  await writeFile(join(configDir, INIT_MARKER_FILE), "initialized\n");
}

/**
 * Resolves a user's home directory robustly. Under sudo, os.userInfo() and
 * $HOME describe root, and guessing /home/<user> or /Users/<user> is wrong for
 * nonstandard homes — so query the OS account database directly. Returns null
 * if the user can't be resolved. Used only to locate a previous-version config
 * dir during migration.
 */
export async function resolveUserHome(username: string): Promise<string | null> {
  const name = sanitizeUsername(username);
  if (process.platform === "darwin") {
    const res = await run(["/usr/bin/dscl", ".", "-read", `/Users/${name}`, "NFSHomeDirectory"]);
    const match = res.stdout.match(/NFSHomeDirectory:\s*(.+)/);
    return match ? match[1]!.trim() : null;
  }
  const res = await run(["/usr/bin/getent", "passwd", name]);
  if (!res.ok) return null;
  const home = res.stdout.split("\n")[0]?.split(":")[5];
  return home || null;
}
