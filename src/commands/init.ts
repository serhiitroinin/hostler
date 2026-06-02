// `sudo hostler init` — one-time privileged setup that enables passwordless
// daily use: create the root-owned config dir under /etc, add the nginx
// include, and install a minimal per-user sudoers rule.
import { existsSync } from "node:fs";
import { writeFile, mkdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
  getUserConfigDir,
  resolveUserHome,
  writeInitMarker,
} from "../lib/config.ts";
import { isValidDomain, normalizeDomain } from "../lib/domain.ts";
import { isCompiled, run, selfPath } from "../lib/exec.ts";
import * as nginx from "../lib/nginx.ts";
import { printError, printInfo, printOk, printWarn, rule } from "../lib/ui.ts";

const LEGACY_SUDOERS_PATH = "/etc/sudoers.d/hostler";
// Opt-in to proceed when the environment (binaries OR the nginx config tree that
// `reload` loads) is user-writable, e.g. Homebrew's user-owned prefix. The older
// `--allow-untrusted-binaries` name is kept as an alias. It does NOT bypass a
// stale legacy include or an unsafe config dir — those always fail closed.
const ALLOW_UNTRUSTED_FLAGS = ["--allow-untrusted", "--allow-untrusted-binaries"];

/**
 * Per-user sudoers filename keyed on the numeric UID. A UID is unique, always
 * filename-safe, and dot-free (sudo ignores sudoers.d files containing a dot).
 * Sanitizing the username instead would collide — `first.last` and `first_last`
 * both map to the same name.
 */
export function sudoersPathFor(uid: number): string {
  if (!Number.isInteger(uid) || uid < 0) throw new Error(`invalid uid: ${uid}`);
  return `/etc/sudoers.d/hostler-${uid}`;
}

export async function init(args: string[] = []): Promise<void> {
  const allowUntrusted = args.some((a) => ALLOW_UNTRUSTED_FLAGS.includes(a));

  if (!(process.getuid && process.getuid() === 0)) {
    printError("This command requires root privileges. Please run with sudo.");
    process.exit(1);
  }

  // The sudoers rule must reference a stable binary path. In source mode
  // (`bun run`), process.execPath is the Bun binary, which would produce a
  // broken and overly broad rule — require the compiled binary instead.
  if (!isCompiled()) {
    printError("init must be run from the compiled hostler binary.");
    console.log("\nBuild it first, then run init on the binary:");
    console.log("  bun run build");
    console.log("  sudo ./hostler init");
    process.exit(1);
  }

  const username = process.env.SUDO_USER;
  const uid = Number.parseInt(process.env.SUDO_UID ?? "", 10);
  if (!username || !Number.isInteger(uid)) {
    printError("Could not determine user. Run via sudo (sudo hostler init), not as root directly.");
    process.exit(1);
  }

  console.log();
  console.log("hostler init");
  console.log(rule());

  // Step 0: resolve nginx's path and validate trust BEFORE executing it.
  // detect() runs `nginx -V`, so the trust check has to come first — otherwise a
  // user-controlled nginx would run as root before the fail-closed guard fires.
  printInfo("Verifying binaries...");
  let nginxBin: string;
  try {
    nginxBin = await nginx.resolveNginxBin(); // path lookup only, no execution
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  await assertTrustedBinaries(nginxBin, allowUntrusted);

  // Step 1: detect nginx (now safe to execute it).
  printInfo("Detecting nginx...");
  let cfg: nginx.NginxConfig;
  try {
    cfg = await nginx.detect();
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  console.log(`  nginx version: ${cfg.version}`);
  console.log(`  nginx config: ${cfg.mainConfigPath}`);

  // Make sure nginx's include dir exists (detect() no longer creates it).
  try {
    await nginx.ensureIncludeDir(cfg.includeDir);
  } catch (err) {
    printWarn(`  Could not ensure include dir ${cfg.includeDir}: ${err instanceof Error ? err.message : err}`);
  }

  // Step 2: create the config directory under /etc — root-owned with no
  // user-writable parent, so an unprivileged process cannot swap it out and
  // feed arbitrary configs to root nginx. Writes go through the _nginx-* helpers.
  console.log();
  printInfo("Creating configuration directory...");
  const configDir = getUserConfigDir(username);
  try {
    await mkdir(configDir, { recursive: true, mode: 0o755 });
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // mkdir won't repair a pre-existing unsafe dir (symlinked, user-owned, or
  // group/world-writable). Verify it before we ever include it into root nginx.
  // Always fail closed here: unlike a Homebrew binary, there is no legitimate
  // reason for /etc/hostler to be user-writable.
  const dirReason = nginx.untrustedConfigDirReason(configDir);
  if (dirReason) {
    printError(`config directory is unsafe: ${dirReason}`);
    console.log("Remove or fix it (it must be a root-owned directory under /etc/hostler), then retry.");
    process.exit(1);
  }
  printOk(`  Created: ${configDir} (root-owned)`);

  // Step 2b: migrate from a previous-version dir (~/.hostler/nginx) and, crucially,
  // remove its include so the upgrade doesn't keep including an unsafe path. This
  // runs even when the old dir is gone (a stale include can outlive it) and fails
  // closed if the include can't be fully removed.
  await migrateOldInstall(username, configDir, cfg.mainConfigPath);

  // Step 2c: the sudoers rule will grant passwordless `nginx -s reload`, which
  // loads nginx.conf and everything it already includes. Verify that tree is
  // root-owned before we commit to anything. Our own config dir was validated
  // above; here we check nginx.conf and its existing include targets.
  console.log();
  printInfo("Verifying nginx config tree...");
  await assertTrustedReloadTree(cfg.mainConfigPath, allowUntrusted);
  printOk("  nginx config tree is trusted");

  // Step 3: add the include directive to nginx.conf.
  console.log();
  printInfo("Adding include directive to nginx.conf...");
  let includeAdded = false;
  try {
    includeAdded = await nginx.addIncludeDirective(cfg.mainConfigPath, configDir);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (includeAdded) printOk(`  Added: include ${configDir}/*.conf;`);
  else printWarn("  Include directive already exists");

  // Step 4: validate nginx config, rolling back the include on failure.
  console.log();
  printInfo("Testing nginx configuration...");
  try {
    await nginx.testConfig();
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    printWarn("  Rolling back changes...");
    await nginx.removeIncludeDirective(cfg.mainConfigPath, configDir);
    process.exit(1);
  }
  printOk("  nginx config is valid");

  // Step 5: install the per-user sudoers rule.
  console.log();
  printInfo("Setting up passwordless sudo...");
  const sudoersPath = sudoersPathFor(uid);
  try {
    await createSudoersFile(username, sudoersPath);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    printWarn("  Rolling back changes...");
    await nginx.removeIncludeDirective(cfg.mainConfigPath, configDir);
    process.exit(1);
  }
  printOk(`  Created: ${sudoersPath}`);

  // Step 6: mark initialization complete (root-owned, like the rest of the dir).
  try {
    await writeInitMarker(configDir);
  } catch (err) {
    printWarn(`Warning: Could not write init marker: ${err instanceof Error ? err.message : err}`);
  }

  console.log();
  printOk("Successfully initialized hostler!");
  console.log("\nYou can now use these commands without sudo:");
  console.log("  hostler add myapp.loc 3000");
  console.log("  hostler remove myapp.loc");
  console.log("  hostler list\n");
}

/**
 * Aborts init when the hostler or nginx binary isn't safe to reference from a
 * NOPASSWD sudoers rule (not root-owned, or writable by group/others) — that
 * would be equivalent to handing the writer passwordless root. Pass
 * --allow-untrusted-binaries to override (e.g. Homebrew, whose prefix is
 * user-owned and the user accepts the risk).
 */
async function assertTrustedBinaries(nginxPath: string, allowUntrusted: boolean): Promise<void> {
  const problems: string[] = [];
  for (const [label, path] of [
    ["hostler", selfPath()],
    ["nginx", nginxPath],
  ] as const) {
    const reason = nginx.untrustedBinaryReason(path);
    if (reason) problems.push(`${label} binary ${path} is ${reason}`);
  }
  if (problems.length === 0) return;

  if (!allowUntrusted) {
    printError("refusing to grant passwordless root to a non-root-owned binary:");
    for (const p of problems) console.log(`  - ${p}`);
    console.log("\nAnyone who can modify that binary could run it as root via the sudoers rule.");
    console.log("Fix it by installing hostler/nginx to a root-owned path, e.g.:");
    console.log("  sudo install -o root -m 0755 ./hostler /usr/local/bin/hostler");
    console.log("\nOr, to proceed anyway and accept the risk, re-run with --allow-untrusted.");
    process.exit(1);
  }

  printWarn("  Proceeding with untrusted binaries (--allow-untrusted):");
  for (const p of problems) printWarn(`    - ${p}`);
}

/**
 * Validates the nginx config tree that a passwordless `nginx -s reload` would
 * load: nginx.conf itself and the directories/files its include directives
 * reference. If any is user-writable, granting passwordless reload would let the
 * user load arbitrary config as root. Gated by --allow-untrusted (same
 * environmental risk as untrusted binaries, e.g. Homebrew's user-owned prefix).
 */
async function assertTrustedReloadTree(mainConfigPath: string, allowUntrusted: boolean): Promise<void> {
  const problems: string[] = [];

  const mainReason = nginx.untrustedFileReason(mainConfigPath);
  if (mainReason) problems.push(`nginx config ${mainConfigPath}: ${mainReason}`);

  // collectIncludeTargets recurses through included files; untrustedReloadTarget
  // Reason validates each, including missing-but-creatable glob dirs.
  for (const target of await nginx.collectIncludeTargets(mainConfigPath)) {
    const reason = nginx.untrustedReloadTargetReason(target);
    if (reason) problems.push(`include ${target}: ${reason}`);
  }

  if (problems.length === 0) return;

  if (!allowUntrusted) {
    printError("refusing to grant passwordless 'nginx -s reload' over a user-writable config tree:");
    for (const p of problems) console.log(`  - ${p}`);
    console.log("\nAnyone who can write those paths could load arbitrary config as root.");
    console.log("Use root-owned nginx config/include dirs, or re-run with --allow-untrusted.");
    process.exit(1);
  }

  printWarn("  Proceeding with an untrusted nginx config tree (--allow-untrusted):");
  for (const p of problems) printWarn(`    - ${p}`);
}

/**
 * Migrates a previous-version ~/.hostler/nginx install and, crucially, removes
 * its include from nginx.conf. The include removal runs even when the old dir is
 * already gone — a stale `include ~/.hostler/nginx/*.conf;` line can outlive the
 * directory, and a user could later recreate the home-owned dir and trigger a
 * passwordless reload. Fails closed if the include can't be fully removed.
 */
async function migrateOldInstall(username: string, configDir: string, mainConfigPath: string): Promise<void> {
  const home = await resolveUserHome(username);
  if (!home) {
    // Can't locate the legacy dir to clean its include. Fail closed if nginx.conf
    // still references a ~/.hostler/nginx path — proceeding could leave a stale
    // user-writable include armed. Otherwise there's nothing to clean.
    const content = await Bun.file(mainConfigPath).text().catch(() => "");
    if (/\.hostler\/nginx\//.test(content)) {
      printError("could not resolve your home directory to clean up a legacy include.");
      console.log(`nginx.conf still references a ~/.hostler/nginx path. Remove that include line`);
      console.log(`manually from ${mainConfigPath}, then re-run init.`);
      process.exit(1);
    }
    return;
  }

  const oldDir = join(home, ".hostler", "nginx");
  const oldDirExists = existsSync(oldDir);

  // Migrate domains (regenerated from template) only if the old dir is present.
  if (oldDirExists) {
    let migrated = 0;
    for (const entry of await nginx.parseUserConfigs(oldDir)) {
      const domain = normalizeDomain(entry.domain);
      if (entry.port !== null && isValidDomain(domain)) {
        await nginx.writeUserDomainConfig(configDir, domain, entry.port);
        migrated++;
      }
    }
    if (migrated > 0) printOk(`  Migrated ${migrated} domain(s) from ${oldDir}`);
  }

  // ALWAYS neutralize any legacy include for the old path, present dir or not.
  // This ALWAYS fails closed if it can't be fully removed — a leftover
  // user-writable include is an escalation path, not an environmental quirk, so
  // --allow-untrusted does not bypass it.
  const { removed, stillPresent } = await nginx.removeIncludeByPath(mainConfigPath, oldDir);
  if (stillPresent) {
    printError(`a legacy include referencing ${oldDir} remains in ${mainConfigPath}.`);
    console.log("nginx would keep including a user-writable directory. Remove that include line");
    console.log("manually, then re-run init.");
    process.exit(1);
  }
  if (removed) printOk(`  Removed legacy include for ${oldDir}`);

  // Delete only the old nginx config dir (not the whole ~/.hostler, which may
  // hold unrelated data), then drop ~/.hostler if it's now empty.
  if (oldDirExists) {
    await rm(oldDir, { recursive: true, force: true });
    await rmdir(join(home, ".hostler")).catch(() => {});
    printOk(`  Removed ${oldDir}`);
  }
}

async function createSudoersFile(username: string, sudoersPath: string): Promise<void> {
  const hostlerPath = selfPath();
  const nginxPath = await nginx.resolveNginxBin();
  const content = buildSudoers(username, hostlerPath, nginxPath);

  // sudoers files must be mode 0440.
  await writeFile(sudoersPath, content, { mode: 0o440 });

  // Validate syntax; remove the file if visudo rejects it.
  const check = await run(["visudo", "-c", "-f", sudoersPath]);
  if (!check.ok) {
    await rm(sudoersPath, { force: true });
    throw new Error(`invalid sudoers syntax: ${check.combined}`);
  }

  // Retire older sudoers files (the original shared file, and the earlier
  // username-keyed form) so they can't leave a dangling rule pointing at a
  // previous binary path.
  const legacyUsernameForm = `/etc/sudoers.d/hostler-${username.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  for (const legacy of [LEGACY_SUDOERS_PATH, legacyUsernameForm]) {
    if (legacy !== sudoersPath && existsSync(legacy)) {
      await rm(legacy, { force: true });
      printWarn(`  Removed stale sudoers file ${legacy}`);
    }
  }
}

/**
 * Builds the sudoers file granting the user passwordless access to exactly the
 * privileged operations hostler needs: hosts edits, nginx config writes (via
 * the validated helpers), and nginx test/reload. Pure function for testability.
 */
export function buildSudoers(username: string, hostlerPath: string, nginxPath: string): string {
  return `# Sudoers rules for hostler CLI
# Generated by: sudo hostler init
# User: ${username}

# Allow hostler internal hosts commands
${username} ALL=(root) NOPASSWD: ${hostlerPath} _hosts-add *
${username} ALL=(root) NOPASSWD: ${hostlerPath} _hosts-remove *

# Allow hostler internal nginx config writes (config dir is root-owned)
${username} ALL=(root) NOPASSWD: ${hostlerPath} _nginx-add *
${username} ALL=(root) NOPASSWD: ${hostlerPath} _nginx-remove *

# Allow nginx test and reload
${username} ALL=(root) NOPASSWD: ${nginxPath} -t
${username} ALL=(root) NOPASSWD: ${nginxPath} -s reload
`;
}
