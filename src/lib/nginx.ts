// nginx detection, config generation/parsing, include-directive management, and
// process control.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { run, which } from "./exec.ts";

export interface NginxConfig {
  mainConfigPath: string;
  includeDir: string;
  isRunning: boolean;
  version: string;
}

export interface DomainEntry {
  domain: string;
  /** null when the config file exists but no valid proxy_pass port was found. */
  port: number | null;
  file: string;
}

// --- Detection -------------------------------------------------------------

/** Finds nginx installation and configuration paths. */
export async function detect(): Promise<NginxConfig> {
  const isRunning = await isNginxRunning();
  const { version, configPath } = await getNginxInfo();
  if (!configPath) throw new Error("could not determine nginx config path");
  const includeDir = await findIncludeDir(configPath);
  return { mainConfigPath: configPath, includeDir, isRunning, version };
}

async function isNginxRunning(): Promise<boolean> {
  const args = process.platform === "darwin" ? ["nginx"] : ["-x", "nginx"];
  const res = await run(["pgrep", ...args]);
  return res.ok;
}

async function getNginxInfo(): Promise<{ version: string; configPath: string }> {
  // `nginx -V` prints version + build flags to stderr.
  const res = await run(["nginx", "-V"]);
  const output = res.combined;

  let version = "";
  const versionMatch = output.match(/nginx version: nginx\/(\S+)/);
  if (versionMatch) version = versionMatch[1]!;

  let configPath = "";
  const confMatch = output.match(/--conf-path=(\S+)/);
  if (confMatch) {
    configPath = confMatch[1]!;
  } else {
    configPath = findConfigFile();
  }

  return { version, configPath };
}

/**
 * Resolves the absolute path to the nginx binary. Used for both the sudoers
 * rule and the privileged `sudo nginx ...` calls so they match exactly.
 */
export async function resolveNginxBin(): Promise<string> {
  const found = await which("nginx");
  if (found) return found;
  const fallbacks =
    process.platform === "darwin"
      ? ["/opt/homebrew/bin/nginx", "/usr/local/bin/nginx"]
      : ["/usr/sbin/nginx", "/usr/bin/nginx"];
  return fallbacks.find((p) => existsSync(p)) ?? "nginx";
}

function findConfigFile(): string {
  const candidates = [
    "/opt/homebrew/etc/nginx/nginx.conf", // Apple Silicon
    "/usr/local/etc/nginx/nginx.conf", // Intel Mac
    "/etc/nginx/nginx.conf", // Linux
    "/usr/local/nginx/conf/nginx.conf", // custom install
  ];
  return candidates.find((p) => existsSync(p)) ?? "";
}

async function findIncludeDir(configPath: string): Promise<string> {
  const configDir = dirname(configPath);
  const candidates = [
    join(configDir, "servers"), // macOS Homebrew
    join(configDir, "sites-enabled"), // Debian/Ubuntu
    join(configDir, "conf.d"), // CentOS/RHEL
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }

  // Nothing exists yet — create the platform-appropriate default.
  const fallback = process.platform === "darwin" ? join(configDir, "servers") : join(configDir, "conf.d");
  await mkdir(fallback, { recursive: true });
  return fallback;
}

// --- Process control -------------------------------------------------------

/** Runs `nginx -t`; throws with combined output on failure. */
export async function testConfig(): Promise<void> {
  const res = await run(["nginx", "-t"]);
  if (!res.ok) throw new Error(`nginx config test failed:\n${res.combined}`);
}

/**
 * Validates config via `sudo nginx -t`. Unprivileged `nginx -t` fails on
 * Homebrew because it can't open the root-owned error log / pid file, so
 * `status` uses this (the sudoers rule allows it passwordless) for an accurate
 * result. Returns the combined output alongside the verdict so callers can
 * surface warnings such as conflicting server names.
 */
export async function testConfigSudo(): Promise<{ ok: boolean; output: string }> {
  const bin = await resolveNginxBin();
  const res = await run(["sudo", "-n", bin, "-t"]);
  return { ok: res.ok, output: res.combined };
}

export async function reload(): Promise<void> {
  const res = await run(["nginx", "-s", "reload"]);
  if (!res.ok) throw new Error(`nginx reload failed:\n${res.combined}`);
}

export async function start(): Promise<void> {
  if (process.platform === "darwin") {
    const brew = await run(["brew", "services", "start", "nginx"]);
    if (brew.ok) return;
  }
  const res = await run(["nginx"]);
  if (!res.ok) throw new Error(`failed to start nginx:\n${res.combined}`);
}

// --- Config generation -----------------------------------------------------

/** Returns the nginx server block hostler writes for a domain → port mapping. */
export function generateServerBlock(domain: string, port: number): string {
  return `# Managed by hostler - ${domain}
server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
`;
}

/** Writes (or overwrites) a single domain's config in the user config dir. */
export async function writeUserDomainConfig(
  configDir: string,
  domain: string,
  port: number,
): Promise<void> {
  await writeFile(join(configDir, `${domain}.conf`), generateServerBlock(domain, port));
}

/** Removes a single domain's config from the user config dir (no-op if absent). */
export async function removeUserDomainConfig(configDir: string, domain: string): Promise<void> {
  await rm(join(configDir, `${domain}.conf`), { force: true });
}

// --- Config parsing --------------------------------------------------------

const SERVER_NAME_RE = /server_name\s+([^;]+);/;
const PROXY_PASS_RE = /proxy_pass\s+https?:\/\/127\.0\.0\.1:(\d+)\s*;/;

/**
 * Parses a single hostler config file into one entry.
 *
 * Unlike the old line-by-line state machine, this reads the whole file and
 * pulls server_name and proxy_pass independently. The domain falls back to the
 * file name, so a file with a malformed proxy_pass surfaces as `port: null`
 * instead of being silently dropped from `list` and conflict checks.
 */
export async function parseConfigFile(path: string): Promise<DomainEntry | null> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return null;
  }

  const nameMatch = content.match(SERVER_NAME_RE);
  const portMatch = content.match(PROXY_PASS_RE);

  // A file with neither marker isn't a hostler domain config — skip it.
  if (!nameMatch && !portMatch) return null;

  const domain = nameMatch ? nameMatch[1]!.trim() : basename(path).replace(/\.conf$/, "");
  const port = portMatch ? Number.parseInt(portMatch[1]!, 10) : null;
  return { domain, port, file: path };
}

/** Reads every domain config from the user config dir. */
export async function parseUserConfigs(configDir: string): Promise<DomainEntry[]> {
  let names: string[];
  try {
    names = await readdir(configDir);
  } catch {
    return [];
  }

  const entries: DomainEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".conf")) continue;
    const entry = await parseConfigFile(join(configDir, name));
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => a.domain.localeCompare(b.domain));
  return entries;
}

/** Finds an entry by domain name. */
export function findEntry(entries: DomainEntry[], domain: string): DomainEntry | undefined {
  return entries.find((e) => e.domain === domain);
}

/**
 * Scans the system include dir for a domain or port already configured outside
 * hostler. Returns the conflicting file paths (empty string = no conflict).
 */
export async function findConflicts(
  includeDir: string,
  domain: string,
  port: number,
): Promise<{ domainConflict: string; portConflict: string }> {
  let domainConflict = "";
  let portConflict = "";

  let names: string[];
  try {
    names = await readdir(includeDir);
  } catch {
    return { domainConflict, portConflict };
  }

  const domainRe = new RegExp(`server_name\\s+${escapeRegExp(domain)}\\s*;`);
  const portRe = new RegExp(`proxy_pass\\s+https?://127\\.0\\.0\\.1:${port}\\s*;`);

  for (const name of names) {
    if (!name.endsWith(".conf")) continue;
    const path = join(includeDir, name);
    const content = await readFile(path, "utf8").catch(() => "");
    if (domainRe.test(content)) domainConflict = path;
    if (portRe.test(content)) portConflict = path;
  }

  return { domainConflict, portConflict };
}

// --- Include directive management ------------------------------------------

/** True if nginx.conf already includes the user config dir. */
export async function hasIncludeDirective(configPath: string, userConfigDir: string): Promise<boolean> {
  const content = await readFile(configPath, "utf8").catch(() => "");
  return content.includes(`include ${userConfigDir}/*.conf;`);
}

/**
 * Adds an `include <userConfigDir>/*.conf;` directive inside the http block.
 * Returns true if added, false if it was already present.
 */
export async function addIncludeDirective(configPath: string, userConfigDir: string): Promise<boolean> {
  const content = await readFile(configPath, "utf8");
  const includeLine = `include ${userConfigDir}/*.conf;`;
  if (content.includes(includeLine)) return false;

  // Insert before the closing brace of the http block.
  const httpBlockRe = /(http\s*\{[\s\S]*?)(\n\s*\})(\s*)$/;
  if (!httpBlockRe.test(content)) {
    throw new Error("could not find http block in nginx.conf");
  }

  const newContent = content.replace(
    httpBlockRe,
    `$1\n    # Hostler user configs\n    ${includeLine}$2$3`,
  );
  await writeFile(configPath, newContent);
  return true;
}

/** Removes the include directive (and its comment) added by addIncludeDirective. */
export async function removeIncludeDirective(configPath: string, userConfigDir: string): Promise<void> {
  const content = await readFile(configPath, "utf8").catch(() => "");
  if (!content) return;
  const re = new RegExp(
    `\\n\\s*# Hostler user configs\\n\\s*include ${escapeRegExp(userConfigDir)}/\\*\\.conf;`,
  );
  await writeFile(configPath, content.replace(re, ""));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
