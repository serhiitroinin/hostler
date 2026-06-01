// Hidden commands invoked via sudo from `add`/`remove`. They run as root and do
// the minimum privileged work: editing /etc/hosts. Strict domain validation
// guards against argument injection through the sudoers rule.
import { addEntry, getHostsPath, removeEntry } from "../lib/hosts.ts";
import { isValidDomain, normalizeDomain } from "../lib/domain.ts";
import { printError } from "../lib/ui.ts";

function guard(raw: string | undefined): string {
  // Normalize here too: these helpers are reachable directly through the
  // sudoers wildcard, so an uppercase domain shouldn't slip past the lowercase
  // canonicalization that `add`/`remove` apply.
  const domain = normalizeDomain(raw ?? "");
  if (!isValidDomain(domain)) {
    printError("Invalid domain format");
    process.exit(1);
  }
  if (process.getuid && process.getuid() !== 0) {
    printError("This command requires root privileges");
    process.exit(1);
  }
  return domain;
}

export async function hostsAdd(args: string[]): Promise<void> {
  const domain = guard(args[0]);
  try {
    await addEntry(getHostsPath(), domain);
  } catch (err) {
    printError(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}

export async function hostsRemove(args: string[]): Promise<void> {
  const domain = guard(args[0]);
  try {
    await removeEntry(getHostsPath(), domain);
  } catch (err) {
    printError(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
