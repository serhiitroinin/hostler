// `hostler remove <domain>` — delete a domain's nginx config and hosts entry.
import { isInitialized, getCurrentUserConfigDir } from "../lib/config.ts";
import { run, selfPath } from "../lib/exec.ts";
import * as nginx from "../lib/nginx.ts";
import { printError, printInfo, printOk, printWarn } from "../lib/ui.ts";

export async function remove(args: string[]): Promise<void> {
  const domain = args[0];
  if (!domain) {
    printError("Usage: hostler remove <domain>");
    process.exit(1);
  }

  if (!isInitialized()) {
    printError("hostler not initialized.");
    console.log("\nRun 'sudo hostler init' to set up hostler for passwordless operation.");
    process.exit(1);
  }

  const configDir = getCurrentUserConfigDir();

  console.log();
  printInfo("Detecting nginx configuration...");

  let cfg: nginx.NginxConfig;
  try {
    cfg = await nginx.detect();
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const entries = await nginx.parseUserConfigs(configDir);
  const found = nginx.findEntry(entries, domain);
  if (!found) {
    printWarn(`Domain '${domain}' is not managed by hostler`);
    process.exit(1);
  }

  console.log(`  Found: ${domain} -> localhost:${found.port ?? "?"}`);

  console.log();
  printInfo("Removing configuration...");

  await nginx.removeUserDomainConfig(configDir, domain);
  printOk(`  Removed ${configDir}/${domain}.conf`);

  const hostsRes = await run(["sudo", selfPath(), "_hosts-remove", domain]);
  if (!hostsRes.ok) {
    printError("Failed to update hosts file");
    if (hostsRes.combined.trim()) console.log(hostsRes.combined.trim());
    process.exit(1);
  }
  printOk("  Updated /etc/hosts (via sudo)");

  const nginxBin = await nginx.resolveNginxBin();
  const test = await run(["sudo", nginxBin, "-t"]);
  if (!test.ok) {
    printError("nginx config test failed");
    console.log(test.combined.trim());
    process.exit(1);
  }
  printOk("  nginx config is valid");

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
  printOk(`Successfully removed ${domain}`);
  console.log();
}
