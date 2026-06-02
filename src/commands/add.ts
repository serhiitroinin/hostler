// `hostler add <domain> <port>` — create or update a domain → port mapping.
//
// Re-adding an existing domain with a new port performs an atomic UPDATE rather
// than erroring. nginx config writes go through the privileged `_nginx-add`
// helper (the config dir is root-owned), and every failure path — hosts update,
// `nginx -t`, and reload — rolls the change back to the prior state.
import { isInitialized, getCurrentUserConfigDir } from "../lib/config.ts";
import { isValidDomain, normalizeDomain, parsePort } from "../lib/domain.ts";
import { run, selfInvocation } from "../lib/exec.ts";
import * as hosts from "../lib/hosts.ts";
import * as nginx from "../lib/nginx.ts";
import { confirm, green, printError, printInfo, printOk, printWarn } from "../lib/ui.ts";

export async function add(args: string[]): Promise<void> {
  if (!args[0] || !args[1]) {
    printError("Usage: hostler add <domain> <port>");
    process.exit(1);
  }

  const domain = normalizeDomain(args[0]);
  const port = parsePort(args[1]);

  if (port === null) {
    printError(`Invalid port number: ${args[1]}`);
    printWarn("  Port must be an integer between 1 and 65535");
    process.exit(1);
  }
  if (!isValidDomain(domain)) {
    printError(`Invalid domain format: ${args[0]}`);
    printWarn("  Domains must look like 'myapp.loc' (letters, numbers, hyphens, at least one dot)");
    process.exit(1);
  }

  if (!isInitialized()) {
    printError("hostler not initialized.");
    console.log("\nRun 'sudo hostler init' to set up hostler for passwordless operation.");
    process.exit(1);
  }

  const configDir = getCurrentUserConfigDir();
  const sudoSelf = (...a: string[]) => run(["sudo", ...selfInvocation(), ...a]);

  console.log();
  printInfo("Detecting nginx configuration...");

  let cfg: nginx.NginxConfig;
  try {
    cfg = await nginx.detect();
  } catch (err) {
    printError(message(err));
    process.exit(1);
  }

  console.log(`  nginx version: ${cfg.version}`);
  console.log(`  config dir: ${configDir}`);

  if (!cfg.isRunning) {
    printWarn("Warning: nginx is not running");
    if (await confirm("  Start nginx? [y/N]: ")) {
      try {
        await nginx.start();
        printOk("  nginx started");
        cfg.isRunning = true;
      } catch (err) {
        printError(message(err));
        process.exit(1);
      }
    }
  } else {
    printOk("  nginx is running");
  }

  console.log();
  printInfo("Checking for conflicts...");

  const entries = await nginx.parseUserConfigs(configDir);
  const existing = nginx.findEntry(entries, domain);

  if (existing && existing.port === port) {
    printOk(`  ${domain} is already mapped to localhost:${port} — nothing to do`);
    console.log();
    return;
  }

  const isUpdate = existing !== undefined;

  const portTwin = entries.find((e) => e.domain !== domain && e.port === port);
  if (portTwin) {
    printWarn(`Warning: port ${port} is also used by '${portTwin.domain}'`);
  }

  // Another user's hostler configs live under a sibling /etc/hostler/<user>/ dir;
  // nginx would only warn ("conflicting server name") and silently ignore the
  // duplicate, so catch it here as a hard error.
  if (!isUpdate) {
    const otherUserDir = await nginx
      .findDomainInOtherUserDirs(domain, configDir)
      .catch(() => null);
    if (otherUserDir) {
      printError(`Domain '${domain}' is already configured by another user in: ${otherUserDir}`);
      process.exit(1);
    }
  }

  try {
    const { domainConflict, portConflict } = await nginx.findConflicts(cfg.includeDir, domain, port);
    if (domainConflict) {
      printError(`Domain '${domain}' is already configured in: ${domainConflict}`);
      process.exit(1);
    }
    if (portConflict) {
      printWarn(`Warning: port ${port} may conflict with config in: ${portConflict}`);
    }
  } catch (err) {
    printWarn(`Warning: Could not check for conflicts: ${message(err)}`);
  }

  if (!isUpdate) {
    const inHosts = await hosts.hasDomain(hosts.getHostsPath(), domain).catch(() => false);
    if (inHosts) {
      printWarn(`Warning: Domain '${domain}' already exists in /etc/hosts (will be updated)`);
    }
  }

  printOk("  No conflicts found");

  console.log();
  printInfo("Updating configuration...");

  // Restores the prior state. On update, rewrite the previous port (when known);
  // otherwise tear down the new config and hosts entry.
  const rollback = async () => {
    if (isUpdate && existing!.port !== null) {
      await sudoSelf("_nginx-add", domain, String(existing!.port));
    } else {
      await sudoSelf("_nginx-remove", domain);
      if (!isUpdate) await sudoSelf("_hosts-remove", domain);
    }
  };

  // 1. Write the nginx config as root via the privileged helper.
  const writeRes = await sudoSelf("_nginx-add", domain, String(port));
  if (!writeRes.ok) {
    printError("Failed to write nginx config");
    if (writeRes.combined.trim()) console.log(writeRes.combined.trim());
    process.exit(1);
  }
  if (isUpdate) printOk(`  Updated ${configDir}/${domain}.conf (port ${existing!.port ?? "?"} → ${port})`);
  else printOk(`  Created ${configDir}/${domain}.conf`);

  // 2. Add the hosts entry (idempotent; already present on update).
  const hostsRes = await sudoSelf("_hosts-add", domain);
  if (!hostsRes.ok) {
    printError("Failed to update hosts file");
    if (hostsRes.combined.trim()) console.log(hostsRes.combined.trim());
    await rollback();
    process.exit(1);
  }
  if (!isUpdate) printOk("  Updated /etc/hosts (via sudo)");

  // 3. Validate. `nginx -t` exits 0 even when it merely *warns* about a
  // conflicting server name (a duplicate from any source — another user, a stale
  // config). Treat such a warning for our domain as a hard failure, since nginx
  // would otherwise silently ignore one of the duplicates.
  const nginxBin = await nginx.resolveNginxBin();
  const test = await run(["sudo", nginxBin, "-t"]);
  const conflictsOurDomain = new RegExp(
    `conflicting server name "${escapeRegExp(domain)}"`,
  ).test(test.combined);
  if (!test.ok || conflictsOurDomain) {
    printError(conflictsOurDomain ? `Domain '${domain}' conflicts with an existing server block` : "nginx config test failed");
    console.log(test.combined.trim());
    printWarn("  Rolling back changes...");
    await rollback();
    process.exit(1);
  }
  printOk("  nginx config is valid");

  // 4. Reload — and roll back the running config if the reload fails.
  if (cfg.isRunning) {
    const reload = await run(["sudo", nginxBin, "-s", "reload"]);
    if (!reload.ok) {
      printError("Failed to reload nginx");
      console.log(reload.combined.trim());
      printWarn("  Rolling back changes...");
      await rollback();
      await run(["sudo", nginxBin, "-s", "reload"]); // best-effort revert of running state
      process.exit(1);
    }
    printOk("  nginx reloaded");
  }

  console.log();
  const verb = isUpdate ? "Updated" : "Successfully added";
  printOk(`${verb} ${domain} -> localhost:${port}`);
  console.log(`\n  Access your app at: ${green(`http://${domain}`)}\n`);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
