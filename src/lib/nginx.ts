// nginx detection, config generation/parsing, include-directive management, and
// process control.
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { run } from "./exec.ts";
import { writeFileAtomicSync } from "./fsatomic.ts";

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
  const includeDir = findIncludeDir(configPath);
  return { mainConfigPath: configPath, includeDir, isRunning, version };
}

async function isNginxRunning(): Promise<boolean> {
  const args = process.platform === "darwin" ? ["nginx"] : ["-x", "nginx"];
  const res = await run(["pgrep", ...args]);
  return res.ok;
}

async function getNginxInfo(): Promise<{ version: string; configPath: string }> {
  // `nginx -V` prints version + build flags to stderr. Use the trusted absolute
  // path rather than relying on $PATH.
  const bin = await resolveNginxBin();
  const res = await run([bin, "-V"]);
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

// Known nginx install locations, by platform. We deliberately do NOT consult
// $PATH / `which`: `init` runs under sudo, and an attacker-controlled PATH could
// otherwise make us execute or grant sudoers access to a planted binary.
const NGINX_CANDIDATES: Record<string, string[]> = {
  darwin: [
    "/opt/homebrew/bin/nginx",
    "/opt/homebrew/sbin/nginx",
    "/usr/local/bin/nginx",
    "/usr/local/sbin/nginx",
    "/usr/sbin/nginx",
  ],
  default: [
    "/usr/sbin/nginx",
    "/usr/bin/nginx",
    "/usr/local/sbin/nginx",
    "/usr/local/bin/nginx",
    "/usr/local/nginx/sbin/nginx",
  ],
};

/**
 * Resolves the absolute path to the nginx binary from a trusted allowlist of
 * standard install locations. Throws if none exist, rather than falling back to
 * a bare `nginx` that depends on $PATH.
 */
export async function resolveNginxBin(): Promise<string> {
  const candidates = NGINX_CANDIDATES[process.platform] ?? NGINX_CANDIDATES.default!;
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(`nginx binary not found in standard locations: ${candidates.join(", ")}`);
  }
  return found;
}

/**
 * Checks that a binary is safe to reference from a root sudoers rule. It's not
 * enough for the leaf file to be root-owned and unwritable: a root-owned 0755
 * binary inside a user-writable directory can be unlinked/renamed and replaced,
 * and a symlink along the path can be repointed. So every path component must be
 * root-owned and not group/world-writable, symlinks are followed and their
 * targets validated too, and the leaf must be a regular file.
 *
 * Returns a human-readable reason when unsafe, or null when fine. (On Homebrew
 * macOS the prefix is user-owned, so callers warn / require an opt-in rather
 * than silently trusting it.)
 */
export function untrustedBinaryReason(path: string): string | null {
  return checkTrustedPath(path, "file", 0);
}

/** Trust check for a regular file (e.g. nginx.conf or an included config file). */
export function untrustedFileReason(path: string): string | null {
  return checkTrustedPath(path, "file", 0);
}

/**
 * Same component-by-component trust check as untrustedBinaryReason, but for a
 * directory we're about to include into root nginx. A pre-existing
 * /etc/hostler or /etc/hostler/<user> that is symlinked, user-owned, or
 * group/world-writable would let an unprivileged process feed configs to root
 * nginx — so verify it before adding the include.
 */
export function untrustedConfigDirReason(path: string): string | null {
  return checkTrustedPath(path, "dir", 0);
}

// "file"    — leaf is a regular file (e.g. a binary or a config file).
// "dir"     — leaf is a directory we won't load new files from.
// "globdir" — leaf is a directory whose contents an `include glob` loads. The
//             sticky-bit exception does NOT apply to such a leaf: sticky stops
//             you replacing others' files, but a user can still CREATE a new
//             matching .conf in a world-writable sticky dir (e.g. /tmp) and have
//             a passwordless reload load it.
type Leaf = "file" | "dir" | "globdir";

function checkTrustedPath(path: string, leaf: Leaf, depth: number): string | null {
  if (depth > 16) return "too many symlink levels";
  if (!isAbsolute(path)) return `not an absolute path: ${path}`;

  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (let i = 0; i < parts.length; i++) {
    current += `/${parts[i]}`;
    const isFinal = i === parts.length - 1;
    let st;
    try {
      st = lstatSync(current);
    } catch {
      return `not found: ${current}`;
    }
    if (st.uid !== 0) return `${current} is not owned by root`;

    if (st.isSymbolicLink()) {
      // Symlink perm bits are meaningless on Linux (always 0777); safety comes
      // from the (already-validated) parent dir not being writable by non-root,
      // plus the symlink being root-owned. Validate the target path too.
      const target = readlinkSync(current);
      const resolved = isAbsolute(target) ? target : resolve(dirname(current), target);
      const rest = parts.slice(i + 1).join("/");
      return checkTrustedPath(rest ? `${resolved}/${rest}` : resolved, leaf, depth + 1);
    }

    if (st.mode & 0o022) {
      // A sticky directory (e.g. /tmp, 1777) is group/world-writable but others
      // can't delete or rename entries they don't own — safe as a PARENT (a
      // root-owned child can't be swapped). But it is NOT safe as a glob include
      // dir, where a user can create a brand-new matching file.
      const stickyDir = st.isDirectory() && (st.mode & 0o1000) !== 0;
      const stickyOk = stickyDir && !(leaf === "globdir" && isFinal);
      if (!stickyOk) return `${current} is writable by group or others`;
    }
  }

  const finalSt = lstatSync(path);
  if (leaf === "file" && !finalSt.isFile()) return `${path} is not a regular file`;
  if ((leaf === "dir" || leaf === "globdir") && !finalSt.isDirectory()) {
    return `${path} is not a directory`;
  }
  return null;
}

/**
 * Collects the absolute filesystem targets referenced by `include` directives,
 * recursively — for a glob like `servers/*.conf` the containing directory, for a
 * literal path the path itself. Used to trust-check the entire tree a
 * passwordless `nginx -s reload` would load.
 *
 * Recursion follows included FILES (so an `include` buried inside an included
 * file is still validated), bounded by `maxDepth` and a visited-set for cycle
 * protection. Glob includes also enumerate their currently-matching files to
 * follow nested includes; the directory itself is returned as a target so it's
 * trust-checked regardless.
 */
export async function collectIncludeTargets(mainConfigPath: string, maxDepth = 32): Promise<string[]> {
  const targets = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<{ file: string; depth: number }> = [{ file: mainConfigPath, depth: 0 }];

  while (queue.length > 0) {
    const { file, depth } = queue.shift()!;
    if (depth > maxDepth) {
      // Fail closed: an include chain deeper than the limit means we can't fully
      // verify the tree, so emit a target that untrustedReloadTargetReason rejects
      // rather than silently stopping.
      targets.add(DEPTH_MARKER + file);
      continue;
    }
    const real = realpathSafe(file);
    if (visited.has(real)) continue;
    visited.add(real);

    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const baseDir = dirname(file);

    for (let inc of scanIncludeArgs(content)) {
      if (!isAbsolute(inc)) inc = resolve(baseDir, inc);

      if (GLOB_CHARS.test(inc)) {
        for (const t of expandGlobInclude(inc)) {
          targets.add(t);
          if (!GLOB_CHARS.test(t)) maybeQueueFile(t, depth, queue);
        }
      } else {
        targets.add(inc);
        maybeQueueFile(inc, depth, queue);
      }
    }
  }
  return [...targets];
}

// Queues a file for include-parsing if it resolves (through symlinks) to a
// regular file. statSync follows symlinks — unlike lstatSync, which reports a
// symlink as non-file and would skip nested includes in a symlinked config
// (common in sites-enabled setups), the exact case nginx does follow.
function maybeQueueFile(
  path: string,
  depth: number,
  queue: Array<{ file: string; depth: number }>,
): void {
  try {
    if (statSync(path).isFile()) queue.push({ file: path, depth: depth + 1 });
  } catch {
    // missing / broken symlink — nothing to parse
  }
}

/**
 * Extracts the argument of every `include` directive in an nginx config.
 *
 * nginx directives are semicolon-delimited and can appear anywhere (including
 * inline, e.g. `http { include conf/*.conf; }`), so a line-anchored regex would
 * miss them. This is a small tokenizer that respects `#` comments and quoted
 * strings, splits on whitespace, and treats `;`/`{`/`}` as boundaries — then
 * picks the second token of any statement whose first token is `include`.
 */
export function scanIncludeArgs(content: string): string[] {
  const includes: string[] = [];
  let tokens: string[] = [];
  let cur = "";
  let quote: string | null = null;

  const pushTok = () => {
    if (cur) {
      tokens.push(cur);
      cur = "";
    }
  };
  const endStatement = () => {
    pushTok();
    if (tokens.length >= 2 && tokens[0] === "include") includes.push(tokens[1]!);
    tokens = [];
  };

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "#") {
      pushTok();
      while (i < content.length && content[i] !== "\n") i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ";") {
      endStatement();
      continue;
    }
    if (ch === "{" || ch === "}") {
      // Block boundary: discard the preceding directive name/args (a block
      // directive is never `include`).
      cur = "";
      tokens = [];
      continue;
    }
    if (/\s/.test(ch)) {
      pushTok();
      continue;
    }
    cur += ch;
  }
  return includes;
}

const GLOB_CHARS = /[*?[\]]/;

/**
 * Expands a glob include into the set of paths to trust-check:
 *  - every currently-matching file (so a writable file in an otherwise
 *    root-owned dir is caught — a glob dir being trusted isn't enough), and
 *  - a directory that bounds future matches.
 *
 * When the wildcard is only in the basename (e.g. `conf.d/<star>.conf`), the
 * containing directory bounds future files, so it's returned. When a wildcard
 * appears in an earlier component (e.g. `<star>/<star>.conf`), no single
 * existing dir bounds where a matching file could later appear, so the raw
 * pattern is returned unchanged — untrustedReloadTargetReason rejects any
 * wildcard path, failing the check closed.
 */
function expandGlobInclude(inc: string): string[] {
  const out = new Set<string>();
  const parts = inc.split("/");
  const globIdx = parts.findIndex((p) => GLOB_CHARS.test(p));
  const fixedPrefix = parts.slice(0, globIdx).join("/") || "/";
  const subPattern = parts.slice(globIdx).join("/");
  const wildcardOnlyInBasename = globIdx === parts.length - 1;

  // Enumerate current matches with a real glob engine (handles multi-level).
  try {
    for (const f of new Bun.Glob(subPattern).scanSync({
      cwd: fixedPrefix,
      absolute: true,
      onlyFiles: true,
    })) {
      out.add(f);
    }
  } catch {
    // unreadable/missing prefix — nothing currently matches
  }

  if (wildcardOnlyInBasename) {
    out.add(fixedPrefix); // bounds future files in this dir
  } else {
    out.add(inc); // unbounded — keep the wildcard so it fails closed
  }
  return [...out];
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// Sentinel prefix collectIncludeTargets emits when an include chain exceeds the
// recursion limit, so the depth cap fails closed instead of silently truncating.
const DEPTH_MARKER = "\0depth-exceeded:";

/**
 * Trust reason for a path that a reload would load, accounting for non-existence.
 * If the target is missing, the nearest existing ancestor must be trusted —
 * otherwise an unprivileged user could create the missing path (e.g. an absent
 * `/Users/alice/nginx` glob dir) and load arbitrary config via passwordless
 * reload. Directories that bound include globs are checked with "globdir", which
 * rejects sticky world-writable dirs (a user can still create a new matching
 * file there). Returns null when safe.
 */
export function untrustedReloadTargetReason(target: string): string | null {
  if (target.startsWith(DEPTH_MARKER)) {
    return `include depth limit exceeded at ${target.slice(DEPTH_MARKER.length)}; cannot verify the full reload tree`;
  }

  // A wildcard reaching here means an include glob with a wildcard before its
  // basename (e.g. `/etc/nginx/*/*.conf`): no single directory bounds where a
  // matching file could appear, so we can't prove the tree is root-owned. Fail
  // closed and let the user restructure the include or pass --allow-untrusted.
  if (GLOB_CHARS.test(target)) {
    return `${target} has a wildcard path component that can't be verified`;
  }

  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(target);
  } catch {
    const ancestor = nearestExistingAncestor(target);
    if (!ancestor) return null;
    // The missing path could be created in its nearest existing ancestor, so
    // that ancestor must itself be a non-(sticky-)writable dir → "globdir".
    const reason = checkTrustedPath(ancestor, "globdir", 0);
    return reason ? `${target} is missing and could be created — ${reason}` : null;
  }
  return st.isDirectory() ? checkTrustedPath(target, "globdir", 0) : untrustedFileReason(target);
}

function nearestExistingAncestor(path: string): string | null {
  let cur = dirname(path);
  for (;;) {
    try {
      lstatSync(cur);
      return cur;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
}

/**
 * Scans every other user's /etc/hostler/<user>/ dir for `domain`, so a
 * multi-user machine surfaces a cross-user collision before nginx silently
 * ignores the duplicate. Returns the conflicting dir, or null.
 */
export async function findDomainInOtherUserDirs(
  domain: string,
  selfConfigDir: string,
): Promise<string | null> {
  const base = dirname(selfConfigDir); // /etc/hostler
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    return null;
  }
  for (const name of names) {
    const dir = join(base, name);
    if (dir === selfConfigDir) continue;
    let isDir = false;
    try {
      isDir = lstatSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const entries = await parseUserConfigs(dir);
    if (entries.some((e) => e.domain === domain)) return dir;
  }
  return null;
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

/**
 * Resolves nginx's include directory WITHOUT creating it — detection must be
 * free of filesystem side effects so read-only commands like `status` can't
 * mutate the system or fail on permissions. Returns the platform-appropriate
 * default path when none exists yet; `init` is responsible for creating it.
 */
function findIncludeDir(configPath: string): string {
  const configDir = dirname(configPath);
  const candidates = [
    join(configDir, "servers"), // macOS Homebrew
    join(configDir, "sites-enabled"), // Debian/Ubuntu
    join(configDir, "conf.d"), // CentOS/RHEL
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return process.platform === "darwin" ? join(configDir, "servers") : join(configDir, "conf.d");
}

/** Creates the include directory if it doesn't exist. Called only by `init`. */
export async function ensureIncludeDir(includeDir: string): Promise<void> {
  await mkdir(includeDir, { recursive: true });
}

// --- Process control -------------------------------------------------------

/** Runs `nginx -t`; throws with combined output on failure. */
export async function testConfig(): Promise<void> {
  const bin = await resolveNginxBin();
  const res = await run([bin, "-t"]);
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
  const bin = await resolveNginxBin();
  const res = await run([bin, "-s", "reload"]);
  if (!res.ok) throw new Error(`nginx reload failed:\n${res.combined}`);
}

export async function start(): Promise<void> {
  if (process.platform === "darwin") {
    const brew = await run(["brew", "services", "start", "nginx"]);
    if (brew.ok) return;
  }
  const bin = await resolveNginxBin();
  const res = await run([bin]);
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
  const target = domainConfigPath(configDir, domain);
  writeFileAtomicSync(target, generateServerBlock(domain, port));
}

/** Removes a single domain's config from the user config dir (no-op if absent). */
export async function removeUserDomainConfig(configDir: string, domain: string): Promise<void> {
  const target = domainConfigPath(configDir, domain);
  await rm(target, { force: true });
}

/**
 * Builds the config path for a domain and asserts it stays inside `configDir`.
 * The domain is validated upstream, but this is defense in depth against any
 * path-traversal sneaking through (e.g. a crafted server_name).
 */
function domainConfigPath(configDir: string, domain: string): string {
  const target = resolve(configDir, `${domain}.conf`);
  const base = resolve(configDir);
  if (target !== join(base, `${domain}.conf`) || !target.startsWith(base + sep)) {
    throw new Error(`refusing to operate on path outside config dir: ${target}`);
  }
  return target;
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

  const inserted = insertIntoHttpBlock(content, `    # Hostler user configs\n    ${includeLine}\n`);
  if (inserted === null) {
    throw new Error("could not find http block in nginx.conf");
  }
  await writeFile(configPath, inserted);
  return true;
}

/**
 * Inserts `snippet` just before the closing brace of the top-level `http { }`
 * block, located by brace counting rather than a regex. This is robust to
 * trailing top-level blocks (`stream {}`, `events {}`) and comments after the
 * http block, which the old `...}$ ` regex mishandled. Returns null if no http
 * block is found. Braces inside `#` comments and quoted strings are ignored.
 */
export function insertIntoHttpBlock(content: string, snippet: string): string | null {
  const httpMatch = content.match(/(^|\n)\s*http\s*\{/);
  if (httpMatch?.index === undefined) return null;

  // Index of the opening brace of the http block.
  const openIdx = content.indexOf("{", httpMatch.index);
  if (openIdx === -1) return null;

  let depth = 0;
  let inComment = false;
  let quote: string | null = null;

  for (let i = openIdx; i < content.length; i++) {
    const ch = content[i]!;

    if (inComment) {
      if (ch === "\n") inComment = false;
      continue;
    }
    if (quote) {
      if (ch === quote && content[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "#") {
      inComment = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // `i` is the http block's closing brace — insert just before it.
        const indentedSnippet = snippet.endsWith("\n") ? snippet : `${snippet}\n`;
        return content.slice(0, i) + indentedSnippet + content.slice(i);
      }
    }
  }
  return null; // unbalanced — no matching close brace
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

/**
 * Removes ANY include line referencing `dirPath`'s glob, regardless of the
 * surrounding comment or whitespace (a previous/older/hand-edited install may
 * not match the exact generated form). Reports whether a matching reference
 * still remains afterward so the caller doesn't claim success when an unusual
 * include form was left behind.
 */
export async function removeIncludeByPath(
  configPath: string,
  dirPath: string,
): Promise<{ removed: boolean; stillPresent: boolean }> {
  const content = await readFile(configPath, "utf8").catch(() => "");
  if (!content) return { removed: false, stillPresent: false };

  const includeRe = new RegExp(`^\\s*include\\s+${escapeRegExp(dirPath)}/\\*\\.conf\\s*;\\s*$`);
  const hostlerCommentRe = /^\s*# Hostler user configs\s*$/;

  const kept: string[] = [];
  let removed = false;
  for (const line of content.split("\n")) {
    if (includeRe.test(line)) {
      removed = true;
      // Drop a hostler comment we may have written directly above the include.
      if (kept.length > 0 && hostlerCommentRe.test(kept[kept.length - 1]!)) kept.pop();
      continue;
    }
    kept.push(line);
  }

  const after = removed ? kept.join("\n") : content;
  if (removed) await writeFile(configPath, after);
  // Detect any other reference to the dir (e.g. bundled into a different include form).
  const stillPresent = after.includes(`${dirPath}/*.conf`);
  return { removed, stillPresent };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
