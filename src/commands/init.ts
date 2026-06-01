// `sudo hostler init` — one-time privileged setup that enables passwordless
// daily use: create the (root-owned) config dir, add the nginx include, and
// install a minimal sudoers rule.
import { chownSync, readdirSync } from "node:fs";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getRealUser, getUserConfigDir, writeInitMarker } from "../lib/config.ts";
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

  const realUser = getRealUser();
  if (!realUser) {
    printError("Could not determine user. Make sure to run with sudo, not as root directly.");
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

  // Step 2: create the config directory. It is ROOT-owned so unprivileged
  // processes cannot drop arbitrary .conf files for root nginx to load; writes
  // go through the privileged _nginx-add / _nginx-remove helpers. The parent
  // ~/.hostler is owned by the user so they can read it.
  console.log();
  printInfo("Creating configuration directory...");
  const userConfigDir = getUserConfigDir(realUser.home);
  try {
    await createConfigDir(userConfigDir, realUser.uid, realUser.gid);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  printOk(`  Created: ${userConfigDir} (root-owned)`);

  // Step 3: add the include directive to nginx.conf.
  console.log();
  printInfo("Adding include directive to nginx.conf...");
  let includeAdded = false;
  try {
    includeAdded = await nginx.addIncludeDirective(cfg.mainConfigPath, userConfigDir);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (includeAdded) printOk(`  Added: include ${userConfigDir}/*.conf;`);
  else printWarn("  Include directive already exists");

  // Step 4: validate nginx config, rolling back the include on failure.
  console.log();
  printInfo("Testing nginx configuration...");
  try {
    await nginx.testConfig();
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    printWarn("  Rolling back changes...");
    await nginx.removeIncludeDirective(cfg.mainConfigPath, userConfigDir);
    process.exit(1);
  }
  printOk("  nginx config is valid");

  // Step 5: install the sudoers rule.
  console.log();
  printInfo("Setting up passwordless sudo...");
  try {
    await createSudoersFile(realUser.name);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    printWarn("  Rolling back changes...");
    await nginx.removeIncludeDirective(cfg.mainConfigPath, userConfigDir);
    process.exit(1);
  }
  printOk(`  Created: ${SUDOERS_PATH}`);

  // Step 6: mark initialization complete (root-owned, like the rest of the dir).
  try {
    await writeInitMarker(userConfigDir);
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
 * Creates the config dir owned by root, with the parent ~/.hostler owned by the
 * user. Any pre-existing contents (from an older user-owned install) are also
 * chowned to root so they can't be tampered with after the fact.
 */
async function createConfigDir(configDir: string, uid: number, gid: number): Promise<void> {
  const parent = dirname(configDir);
  await mkdir(configDir, { recursive: true });

  if (uid >= 0 && gid >= 0) chownSync(parent, uid, gid); // ~/.hostler → user
  chownSync(configDir, 0, 0); // ~/.hostler/nginx → root

  for (const name of readdirSync(configDir)) {
    chownSync(join(configDir, name), 0, 0);
  }
}

async function createSudoersFile(username: string): Promise<void> {
  const content = buildSudoers(username, selfPath(), await nginx.resolveNginxBin());

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
