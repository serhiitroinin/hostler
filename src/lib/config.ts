// User configuration management: paths under ~/.hostler/ and init detection.
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export const HOSTLER_DIR = ".hostler";
export const NGINX_SUBDIR = "nginx";
export const INIT_MARKER_FILE = ".initialized";

/** Returns the user's hostler nginx config directory for a given home dir. */
export function getUserConfigDir(home: string): string {
  return join(home, HOSTLER_DIR, NGINX_SUBDIR);
}

/** Returns the hostler nginx config directory for the current user. */
export function getCurrentUserConfigDir(): string {
  return getUserConfigDir(homedir());
}

/** Returns the top-level ~/.hostler directory for a given home dir. */
export function getHostlerDir(home: string): string {
  return join(home, HOSTLER_DIR);
}

/** Path to a domain's nginx config file inside the current user's config dir. */
export function getDomainConfigPath(domain: string): string {
  return join(getCurrentUserConfigDir(), `${domain}.conf`);
}

/** True if hostler has been initialized for the current user. */
export function isInitialized(): boolean {
  const dir = getCurrentUserConfigDir();
  if (!dir) return false;
  return existsSync(join(dir, INIT_MARKER_FILE));
}

/** Writes the init marker file into the given config directory. */
export async function writeInitMarker(configDir: string): Promise<void> {
  await writeFile(join(configDir, INIT_MARKER_FILE), "initialized\n");
}

/**
 * Resolves the real (non-root) user who invoked `sudo`, mirroring the Go
 * version's getRealUser. Returns null when not running under sudo.
 */
export function getRealUser(): { name: string; home: string; uid: number; gid: number } | null {
  const sudoUser = process.env.SUDO_USER;
  if (!sudoUser) return null;

  const sudoUid = process.env.SUDO_UID;
  const sudoGid = process.env.SUDO_GID;
  // SUDO_USER is set; derive home. macOS uses /Users, Linux /home.
  // Prefer the OS user record when available, fall back to a conventional path.
  let home = "";
  try {
    const info = userInfo();
    if (info.username === sudoUser && info.homedir) home = info.homedir;
  } catch {
    // ignore — fall through to conventional path
  }
  if (!home) {
    home = process.platform === "darwin" ? `/Users/${sudoUser}` : `/home/${sudoUser}`;
  }

  return {
    name: sudoUser,
    home,
    uid: sudoUid ? Number.parseInt(sudoUid, 10) : -1,
    gid: sudoGid ? Number.parseInt(sudoGid, 10) : -1,
  };
}
