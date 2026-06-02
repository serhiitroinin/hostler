// Manages /etc/hosts entries inside a delimited block so hostler never touches
// lines it doesn't own.
import { readFile } from "node:fs/promises";
import { withLock, writeFileAtomicSync } from "./fsatomic.ts";

const BEGIN_MARKER = "# BEGIN hostler managed block";
const END_MARKER = "# END hostler managed block";

/** Path to the system hosts file for the current platform. */
export function getHostsPath(): string {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32\\drivers\\etc\\hosts";
  }
  return "/etc/hosts";
}

/** True if `domain` appears on any active (non-comment) line in the hosts file. */
export async function hasDomain(hostsPath: string, domain: string): Promise<boolean> {
  const content = await readFile(hostsPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    // Match the domain as a whole field, not a substring of another host.
    if (trimmed.split(/\s+/).includes(domain)) return true;
  }
  return false;
}

/**
 * True if `domain` appears on an active line OUTSIDE hostler's managed block.
 * Such an entry would shadow (or compete with) the one hostler manages — and
 * hostler must not silently claim to have "updated" a line it doesn't own.
 */
export async function hasUnmanagedDomain(hostsPath: string, domain: string): Promise<boolean> {
  const content = await readFile(hostsPath, "utf8").catch(() => "");
  const target = domain.toLowerCase(); // hostnames are case-insensitive
  let inBlock = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === BEGIN_MARKER) {
      inBlock = true;
      continue;
    }
    if (trimmed === END_MARKER) {
      inBlock = false;
      continue;
    }
    if (inBlock || trimmed.startsWith("#") || trimmed === "") continue;
    const hostFields = trimmed.split(/\s+/).slice(1).map((f) => f.toLowerCase());
    if (hostFields.includes(target)) return true;
  }
  return false;
}

/** Returns the domains currently inside hostler's managed block. */
export async function getManagedDomains(hostsPath: string): Promise<string[]> {
  const content = await readFile(hostsPath, "utf8").catch(() => "");
  const entries: string[] = [];
  let inBlock = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === BEGIN_MARKER) {
      inBlock = true;
      continue;
    }
    if (trimmed === END_MARKER) {
      inBlock = false;
      continue;
    }
    if (inBlock) {
      const fields = trimmed.split(/\s+/);
      if (fields.length >= 2 && fields[0] === "127.0.0.1") {
        entries.push(fields[1]!);
      }
    }
  }
  return entries;
}

/** Adds a domain to the managed block (no-op if already present). */
export async function addEntry(hostsPath: string, domain: string): Promise<void> {
  // Lock the whole read-modify-write so concurrent invocations can't clobber.
  await withLock("hosts", async () => {
    const entries = await getManagedDomains(hostsPath);
    if (entries.includes(domain)) return;
    entries.push(domain);
    await writeManagedBlock(hostsPath, entries);
  });
}

/** Removes a domain from the managed block. */
export async function removeEntry(hostsPath: string, domain: string): Promise<void> {
  await withLock("hosts", async () => {
    const entries = (await getManagedDomains(hostsPath)).filter((d) => d !== domain);
    await writeManagedBlock(hostsPath, entries);
  });
}

// Rewrites the hosts file, stripping any existing managed block and appending a
// fresh one built from `entries`.
async function writeManagedBlock(hostsPath: string, entries: string[]): Promise<void> {
  const content = await readFile(hostsPath, "utf8");

  const kept: string[] = [];
  let inBlock = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === BEGIN_MARKER) {
      inBlock = true;
      continue;
    }
    if (trimmed === END_MARKER) {
      inBlock = false;
      continue;
    }
    if (!inBlock) kept.push(line);
  }

  let result = kept.join("\n").replace(/\n+$/, "");
  if (entries.length > 0) {
    const block = [BEGIN_MARKER, ...entries.map((d) => `127.0.0.1\t${d}`), END_MARKER].join("\n");
    result = `${result}\n${block}\n`;
  } else {
    result = `${result}\n`;
  }

  writeFileAtomicSync(hostsPath, result);
}
