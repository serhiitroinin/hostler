// `hostler status` — report nginx + hostler configuration health.
import { existsSync } from "node:fs";
import { isInitialized, getCurrentUserConfigDir } from "../lib/config.ts";
import * as nginx from "../lib/nginx.ts";
import { green, red, rule, yellow } from "../lib/ui.ts";

export async function status(): Promise<void> {
  console.log();
  console.log("hostler status");
  console.log(rule());

  let cfg: nginx.NginxConfig;
  try {
    cfg = await nginx.detect();
  } catch (err) {
    console.log(red("nginx:          not found"));
    console.log(`error:          ${err instanceof Error ? err.message : err}`);
    console.log();
    process.exit(1);
  }

  console.log(cfg.isRunning ? green("nginx:          running") : red("nginx:          stopped"));
  console.log(`nginx version:  ${cfg.version}`);
  console.log(`nginx config:   ${cfg.mainConfigPath}`);
  console.log(`include dir:    ${cfg.includeDir}`);
  console.log();

  if (isInitialized()) {
    console.log(green("hostler mode:   initialized"));
    const configDir = getCurrentUserConfigDir();
    console.log(`user config:    ${configDir}`);

    console.log(
      existsSync("/etc/sudoers.d/hostler")
        ? green("sudoers:        configured")
        : yellow("sudoers:        not found"),
    );

    console.log(
      (await nginx.hasIncludeDirective(cfg.mainConfigPath, configDir))
        ? green("nginx include:  configured")
        : yellow("nginx include:  not found"),
    );

    try {
      const entries = await nginx.parseUserConfigs(configDir);
      console.log(`domains:        ${entries.length}`);
    } catch {
      console.log("domains:        error reading configs");
    }
  } else {
    console.log(yellow("hostler mode:   not initialized"));
    console.log("\nRun 'sudo hostler init' to set up hostler for passwordless operation.");
  }

  console.log();
  const test = await nginx.testConfigSudo();
  console.log(test.ok ? green("config valid:   yes") : red("config valid:   no"));

  // Conflicting server names mean a domain is defined more than once (e.g. a
  // stale config in the system include dir shadowing a per-domain file). nginx
  // silently ignores the duplicate, so a port change can appear to do nothing —
  // surface it here.
  const conflicts = [...test.output.matchAll(/conflicting server name "([^"]+)"/g)].map((m) => m[1]);
  if (conflicts.length > 0) {
    console.log();
    console.log(yellow(`conflicts:      ${[...new Set(conflicts)].join(", ")}`));
    console.log(yellow("                a domain is defined in more than one config — nginx ignores the"));
    console.log(yellow("                duplicate. Check for stale files in the system nginx include dir."));
  }
  console.log();
}
