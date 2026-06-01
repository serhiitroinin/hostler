#!/usr/bin/env bun
// hostler — manage local development domains with nginx.
// Entry point: parses argv and dispatches to a command module.
import pkg from "../package.json" with { type: "json" };
import { add } from "./commands/add.ts";
import { remove } from "./commands/remove.ts";
import { list } from "./commands/list.ts";
import { status } from "./commands/status.ts";
import { init } from "./commands/init.ts";
import { hostsAdd, hostsRemove } from "./commands/hosts-internal.ts";
import { nginxAdd, nginxRemove } from "./commands/nginx-internal.ts";
import { bold, cyan, dim, printError } from "./lib/ui.ts";

const VERSION = pkg.version;

function printHelp(): void {
  console.log(`${bold("hostler")} ${dim(`v${VERSION}`)} — manage local development domains with nginx

${bold("USAGE")}
  hostler <command> [arguments]

${bold("COMMANDS")}
  ${cyan("init")}             One-time setup for passwordless operation (run with sudo)
  ${cyan("add")} <domain> <port>   Add or update a domain → port mapping
  ${cyan("remove")} <domain>   Remove a domain (aliases: rm, delete)
  ${cyan("list")}             List all managed domains (alias: ls)
  ${cyan("status")}           Show nginx and hostler status

${bold("EXAMPLES")}
  sudo hostler init
  hostler add myapp.loc 3000
  hostler list
  hostler remove myapp.loc

${bold("FLAGS")}
  -h, --help       Show this help
  -v, --version    Show version
`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case undefined:
    case "-h":
    case "--help":
    case "help":
      printHelp();
      return;

    case "-v":
    case "--version":
    case "version":
      console.log(VERSION);
      return;

    case "init":
      await init();
      return;
    case "add":
      await add(args);
      return;
    case "remove":
    case "rm":
    case "delete":
      await remove(args);
      return;
    case "list":
    case "ls":
      await list();
      return;
    case "status":
      await status();
      return;

    // Hidden internal commands invoked via sudo (see commands/hosts-internal.ts).
    case "_hosts-add":
      await hostsAdd(args);
      return;
    case "_hosts-remove":
      await hostsRemove(args);
      return;
    case "_nginx-add":
      await nginxAdd(args);
      return;
    case "_nginx-remove":
      await nginxRemove(args);
      return;

    default:
      printError(`Unknown command: ${command}`);
      console.log("\nRun 'hostler --help' for usage.");
      process.exit(1);
  }
}

main().catch((err) => {
  printError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
