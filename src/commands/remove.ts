// `hostler remove <domain>` — delete a domain's nginx config and hosts entry.
//
// The domain argument is validated and normalized before use, removal goes
// through the privileged `_nginx-remove` helper (root-owned config dir), and a
// failed hosts update / validation / reload rolls the removal back.
import { isInitialized, getCurrentUserConfigDir } from "../lib/config.ts";
import { isValidDomain, normalizeDomain } from "../lib/domain.ts";
import { run, selfInvocation } from "../lib/exec.ts";
import * as nginx from "../lib/nginx.ts";
import { printError, printInfo, printOk, printWarn } from "../lib/ui.ts";

export async function remove(args: string[]): Promise<void> {
  if (!args[0]) {
    printError("Usage: hostler remove <domain>");
    process.exit(1);
  }

  const domain = normalizeDomain(args[0]);
  if (!isValidDomain(domain)) {
    printError(`Invalid domain format: ${args[0]}`);
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

  // Re-creates what we removed. The port may be unknown for a malformed config;
  // in that case we can only restore the hosts entry.
  const rollback = async () => {
    if (found.port !== null) await sudoSelf("_nginx-add", domain, String(found.port));
    await sudoSelf("_hosts-add", domain);
  };

  const removeRes = await sudoSelf("_nginx-remove", domain);
  if (!removeRes.ok) {
    printError("Failed to remove nginx config");
    if (removeRes.combined.trim()) console.log(removeRes.combined.trim());
    process.exit(1);
  }
  printOk(`  Removed ${configDir}/${domain}.conf`);

  const hostsRes = await sudoSelf("_hosts-remove", domain);
  if (!hostsRes.ok) {
    printError("Failed to update hosts file");
    if (hostsRes.combined.trim()) console.log(hostsRes.combined.trim());
    printWarn("  Rolling back changes...");
    // The hosts entry wasn't removed (the call failed), so only the nginx config
    // needs restoring — and only if we know the port it had. A malformed config
    // with no parseable port can't be faithfully regenerated.
    if (found.port !== null) {
      await sudoSelf("_nginx-add", domain, String(found.port));
    } else {
      printWarn(`  Could not restore '${domain}': original config had no valid port`);
    }
    process.exit(1);
  }
  printOk("  Updated /etc/hosts (via sudo)");

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

  if (cfg.isRunning) {
    const reload = await run(["sudo", nginxBin, "-s", "reload"]);
    if (!reload.ok) {
      printError("Failed to reload nginx");
      console.log(reload.combined.trim());
      printWarn("  Rolling back changes...");
      await rollback();
      await run(["sudo", nginxBin, "-s", "reload"]); // best-effort revert
      process.exit(1);
    }
    printOk("  nginx reloaded");
  }

  console.log();
  printOk(`Successfully removed ${domain}`);
  console.log();
}
