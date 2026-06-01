// `hostler add <domain> <port>` — create or update a domain → port mapping.
//
// Re-adding an existing domain with a new port performs an atomic UPDATE rather
// than erroring: the config is rewritten, validated, and reloaded, with a
// rollback to the previous config if `nginx -t` fails. This removes the old
// remove-then-re-add dance that could leave a domain "mounted" on a stale port.
import { readFile } from "node:fs/promises";
import { isInitialized, getCurrentUserConfigDir } from "../lib/config.ts";
import { isValidDomain } from "../lib/domain.ts";
import { run, selfPath } from "../lib/exec.ts";
import * as hosts from "../lib/hosts.ts";
import * as nginx from "../lib/nginx.ts";
import { confirm, green, printError, printInfo, printOk, printWarn } from "../lib/ui.ts";

export async function add(args: string[]): Promise<void> {
  const domain = args[0];
  const portStr = args[1];

  if (!domain || !portStr) {
    printError("Usage: hostler add <domain> <port>");
    process.exit(1);
  }

  const port = Number.parseInt(portStr, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    printError(`Invalid port number: ${portStr}`);
    process.exit(1);
  }

  if (!isValidDomain(domain)) {
    printError(`Invalid domain format: ${domain}`);
    printWarn("  Domains must look like 'myapp.loc' (letters, numbers, hyphens, at least one dot)");
    process.exit(1);
  }

  if (!isInitialized()) {
    printError("hostler not initialized.");
    console.log("\nRun 'sudo hostler init' to set up hostler for passwordless operation.");
    process.exit(1);
  }

  const configDir = getCurrentUserConfigDir();
  const configPath = `${configDir}/${domain}.conf`;

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

  // Idempotent no-op: same domain, same port.
  if (existing && existing.port === port) {
    printOk(`  ${domain} is already mapped to localhost:${port} — nothing to do`);
    console.log();
    return;
  }

  const isUpdate = existing !== undefined;

  // A different hostler domain already targets this port. Unusual but valid in
  // nginx, so warn instead of refusing (the old version hard-failed here).
  const portTwin = entries.find((e) => e.domain !== domain && e.port === port);
  if (portTwin) {
    printWarn(`Warning: port ${port} is also used by '${portTwin.domain}'`);
  }

  // Conflicts in the SYSTEM nginx include dir (configs not managed by hostler).
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

  // Capture the previous config so we can restore it if validation fails.
  const previousContent = isUpdate ? await readFile(configPath, "utf8").catch(() => null) : null;

  await nginx.writeUserDomainConfig(configDir, domain, port);
  if (isUpdate) {
    printOk(`  Updated ${configPath} (port ${existing!.port ?? "?"} → ${port})`);
  } else {
    printOk(`  Created ${configPath}`);
  }

  // Helper that restores the working tree to its pre-`add` state.
  const rollback = async () => {
    if (isUpdate && previousContent !== null) {
      await Bun.write(configPath, previousContent);
    } else {
      await nginx.removeUserDomainConfig(configDir, domain);
      await run(["sudo", selfPath(), "_hosts-remove", domain]);
    }
  };

  // Add the hosts entry via sudo (idempotent; already present on update).
  const hostsRes = await run(["sudo", selfPath(), "_hosts-add", domain]);
  if (!hostsRes.ok) {
    printError("Failed to update hosts file");
    if (hostsRes.combined.trim()) console.log(hostsRes.combined.trim());
    if (isUpdate && previousContent !== null) await Bun.write(configPath, previousContent);
    else await nginx.removeUserDomainConfig(configDir, domain);
    process.exit(1);
  }
  if (!isUpdate) printOk("  Updated /etc/hosts (via sudo)");

  // Validate via sudo nginx -t.
  const nginxBin = await nginx.resolveNginxBin();
  const test = await run(["sudo", nginxBin, "-t"]);
  if (!test.ok) {
    printError("nginx config test failed");
    console.log(test.combined.trim());
    printWarn("  Rolling back changes...");
    await rollback();
    process.exit(1);
  }
  printOk("  nginx config is valid");

  // Reload if nginx is running.
  if (cfg.isRunning) {
    const reload = await run(["sudo", nginxBin, "-s", "reload"]);
    if (!reload.ok) {
      printError("Failed to reload nginx");
      console.log(reload.combined.trim());
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
