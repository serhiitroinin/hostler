// `sudo hostler init` — one-time privileged setup that enables passwordless
// daily use: create the root-owned config dir under /etc, add the nginx
// include, and install a minimal sudoers rule.
import { existsSync } from "node:fs";
import { writeFile, mkdir, rm } from "node:fs/promises";
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

const SUDOERS_PATH = "/etc/sudoers.d/hostler";

export async function init(): Promise<void> {
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
  if (!username) {
    printError("Could not determine user. Run via sudo (sudo hostler init), not as root directly.");
    process.exit(1);
  }

  console.log();
  console.log("hostler init");
  console.log(rule());

  // Step 1: detect nginx.
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
  printOk(`  Created: ${configDir} (root-owned)`);

  // Step 2b: migrate domains from a previous-version dir (~/.hostler/nginx).
  // Only the validated domain + port are carried over and regenerated from
  // hostler's own template — pre-existing file contents are never copied.
  await migrateOldConfigs(username, configDir);

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

  // Step 5: install the sudoers rule.
  console.log();
  printInfo("Setting up passwordless sudo...");
  try {
    await createSudoersFile(username);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    printWarn("  Rolling back changes...");
    await nginx.removeIncludeDirective(cfg.mainConfigPath, configDir);
    process.exit(1);
  }
  printOk(`  Created: ${SUDOERS_PATH}`);

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

/** Regenerates domain configs from a previous-version ~/.hostler/nginx dir. */
async function migrateOldConfigs(username: string, configDir: string): Promise<void> {
  const home = await resolveUserHome(username);
  if (!home) return;
  const oldDir = join(home, ".hostler", "nginx");
  if (!existsSync(oldDir)) return;

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

async function createSudoersFile(username: string): Promise<void> {
  const hostlerPath = selfPath();
  const nginxPath = await nginx.resolveNginxBin();

  // Referencing a non-root-owned binary from a NOPASSWD rule means whoever can
  // write that binary can run it as root. On Homebrew macOS the prefix is
  // user-owned, so warn rather than hard-fail (it would block normal installs).
  for (const [label, path] of [
    ["hostler", hostlerPath],
    ["nginx", nginxPath],
  ] as const) {
    const reason = nginx.untrustedBinaryReason(path);
    if (reason) {
      printWarn(`  Warning: ${label} binary ${path} is ${reason}.`);
      printWarn("           Anyone who can modify it could run it as root via this rule.");
      printWarn("           Install hostler/nginx to a root-owned path for best security.");
    }
  }

  const content = buildSudoers(username, hostlerPath, nginxPath);

  // sudoers files must be mode 0440.
  await writeFile(SUDOERS_PATH, content, { mode: 0o440 });

  // Validate syntax; remove the file if visudo rejects it.
  const check = await run(["visudo", "-c", "-f", SUDOERS_PATH]);
  if (!check.ok) {
    await rm(SUDOERS_PATH, { force: true });
    throw new Error(`invalid sudoers syntax: ${check.combined}`);
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
