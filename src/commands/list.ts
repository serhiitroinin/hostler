// `hostler list` — show all managed domains with live port status.
import { connect } from "node:net";
import { isInitialized, getCurrentUserConfigDir } from "../lib/config.ts";
import * as nginx from "../lib/nginx.ts";
import { blue, green, printError, printWarn, red, table } from "../lib/ui.ts";

export async function list(): Promise<void> {
  console.log();

  if (!isInitialized()) {
    printWarn("hostler not initialized.");
    console.log("\nRun 'sudo hostler init' to set up hostler.\n");
    return;
  }

  const configDir = getCurrentUserConfigDir();

  let entries: nginx.DomainEntry[];
  try {
    entries = await nginx.parseUserConfigs(configDir);
  } catch (err) {
    printError(`Failed to parse configs: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  if (entries.length === 0) {
    printWarn("No domains configured yet.");
    console.log("\nAdd a domain with:\n  hostler add myapp.loc 3000\n");
    return;
  }

  // Probe all ports concurrently.
  const statuses = await Promise.all(
    entries.map((e) => (e.port === null ? Promise.resolve(false) : checkPort(e.port))),
  );

  const rows = entries.map((e, i) => [
    e.domain,
    e.port === null ? "?" : String(e.port),
    `http://${e.domain}`,
    statuses[i] ? "up" : "down",
  ]);

  const out = table(["Domain", "Port", "URL", "Status"], rows, (cell, col, row) => {
    if (col === 1) return cell; // port — leave plain
    if (col === 2) return blue(cell); // URL
    if (col === 3) return statuses[row] ? green("up") : red("down");
    return cell;
  });

  console.log(out);
  console.log(`\n  Total: ${entries.length} domain(s)`);
  console.log(`  Config: ${configDir}\n`);
}

/** Resolves true if something accepts a TCP connection on 127.0.0.1:port. */
function checkPort(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
