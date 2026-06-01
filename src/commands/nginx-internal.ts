// Hidden, sudo-invoked commands that write the per-domain nginx configs as root.
//
// The config dir is root-owned (see init), so unprivileged processes cannot
// drop arbitrary .conf files for root-owned nginx to load. All writes funnel
// through here, where the domain and port are re-validated before a config
// built entirely from hostler's own template is written. This is the nginx
// analogue of _hosts-add / _hosts-remove.
import { getInvokingUserConfigDir } from "../lib/config.ts";
import { isValidDomain, normalizeDomain, parsePort } from "../lib/domain.ts";
import { removeUserDomainConfig, writeUserDomainConfig } from "../lib/nginx.ts";
import { printError } from "../lib/ui.ts";

function requireRoot(): void {
  if (process.getuid && process.getuid() !== 0) {
    printError("This command requires root privileges");
    process.exit(1);
  }
}

export async function nginxAdd(args: string[]): Promise<void> {
  requireRoot();

  const domain = normalizeDomain(args[0] ?? "");
  if (!isValidDomain(domain)) {
    printError("Invalid domain format");
    process.exit(1);
  }
  const port = parsePort(args[1] ?? "");
  if (port === null) {
    printError("Invalid port number");
    process.exit(1);
  }

  const configDir = getInvokingUserConfigDir();
  try {
    await writeUserDomainConfig(configDir, domain, port);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export async function nginxRemove(args: string[]): Promise<void> {
  requireRoot();

  const domain = normalizeDomain(args[0] ?? "");
  if (!isValidDomain(domain)) {
    printError("Invalid domain format");
    process.exit(1);
  }

  const configDir = getInvokingUserConfigDir();
  try {
    await removeUserDomainConfig(configDir, domain);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
