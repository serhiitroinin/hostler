import { describe, expect, test } from "bun:test";
import {
  collectIncludeTargets,
  insertIntoHttpBlock,
  scanIncludeArgs,
  untrustedReloadTargetReason,
} from "../src/lib/nginx.ts";
import { buildSudoers, sudoersPathFor } from "../src/commands/init.ts";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("insertIntoHttpBlock", () => {
  test("inserts before the http block's closing brace, not the file end", () => {
    const conf = `events {}
http {
    server { listen 80; }
}
stream {
    server { listen 9000; }
}
`;
    const out = insertIntoHttpBlock(conf, "    include /x/*.conf;");
    expect(out).not.toBeNull();
    // The include must sit inside http {}, before the stream {} block.
    const includeIdx = out!.indexOf("include /x/*.conf;");
    const streamIdx = out!.indexOf("stream {");
    expect(includeIdx).toBeGreaterThan(-1);
    expect(includeIdx).toBeLessThan(streamIdx);
  });

  test("handles braces inside comments and strings without miscounting", () => {
    const conf = `http {
    # a stray } brace in a comment
    log_format main '} { weird';
    server { listen 80; }
}
`;
    const out = insertIntoHttpBlock(conf, "include /x/*.conf;");
    expect(out).not.toBeNull();
    // Inserted inside the block: there is content after the include before EOF.
    expect(out!.trimEnd().endsWith("}")).toBe(true);
    expect(out!).toContain("include /x/*.conf;");
  });

  test("returns null when there is no http block", () => {
    expect(insertIntoHttpBlock("events {}\n", "include /x/*.conf;")).toBeNull();
  });
});

describe("buildSudoers", () => {
  const sudoers = buildSudoers("alice", "/usr/local/bin/hostler", "/opt/homebrew/bin/nginx");

  test("grants exactly the privileged operations hostler needs", () => {
    expect(sudoers).toContain("alice ALL=(root) NOPASSWD: /usr/local/bin/hostler _hosts-add *");
    expect(sudoers).toContain("alice ALL=(root) NOPASSWD: /usr/local/bin/hostler _hosts-remove *");
    expect(sudoers).toContain("alice ALL=(root) NOPASSWD: /usr/local/bin/hostler _nginx-add *");
    expect(sudoers).toContain("alice ALL=(root) NOPASSWD: /usr/local/bin/hostler _nginx-remove *");
    expect(sudoers).toContain("alice ALL=(root) NOPASSWD: /opt/homebrew/bin/nginx -t");
    expect(sudoers).toContain("alice ALL=(root) NOPASSWD: /opt/homebrew/bin/nginx -s reload");
  });

  test("does not grant a blanket nginx or shell rule", () => {
    expect(sudoers).not.toMatch(/NOPASSWD:\s*\/opt\/homebrew\/bin\/nginx\s*$/m);
    expect(sudoers).not.toContain("ALL\n");
  });
});

describe("collectIncludeTargets", () => {
  test("resolves glob includes to their directory and literals to the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hostler-conf-"));
    const conf = join(dir, "nginx.conf");
    writeFileSync(
      conf,
      [
        "http {",
        "    include /etc/nginx/conf.d/*.conf;", // glob → dir
        "    include servers/*;", // relative glob → dir under conf dir
        "    include /etc/nginx/mime.types;", // literal file
        "}",
        "",
      ].join("\n"),
    );
    const targets = await collectIncludeTargets(conf);
    expect(targets).toContain("/etc/nginx/conf.d");
    expect(targets).toContain(join(dir, "servers"));
    expect(targets).toContain("/etc/nginx/mime.types");
  });

  test("adds each glob-matched file as a target (not just the directory)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hostler-conf-"));
    const confd = join(dir, "conf.d");
    mkdirSync(confd);
    writeFileSync(join(confd, "app.conf"), "# server block\n");
    writeFileSync(join(confd, "api.conf"), "# server block\n");
    const main = join(dir, "nginx.conf");
    writeFileSync(main, "include conf.d/*.conf;\n");

    const targets = await collectIncludeTargets(main);
    // The directory AND each matched file must be present so a writable file in
    // an otherwise root-owned dir gets trust-checked.
    expect(targets).toContain(confd);
    expect(targets).toContain(join(confd, "app.conf"));
    expect(targets).toContain(join(confd, "api.conf"));
  });

  test("fails closed when the include chain exceeds the depth limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hostler-conf-"));
    const main = join(dir, "nginx.conf");
    writeFileSync(main, "include a.conf;\n");
    writeFileSync(join(dir, "a.conf"), "include b.conf;\n");
    writeFileSync(join(dir, "b.conf"), "# leaf\n");

    const targets = await collectIncludeTargets(main, 1); // maxDepth = 1
    const reasons = targets.map((t) => untrustedReloadTargetReason(t));
    expect(reasons.some((r) => r?.includes("include depth limit exceeded"))).toBe(true);
  });

  test("keeps a pre-basename wildcard as a target so it fails closed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hostler-conf-"));
    const main = join(dir, "nginx.conf");
    writeFileSync(main, "include /etc/nginx/sites/*/*.conf;\n");
    const targets = await collectIncludeTargets(main);
    expect(targets.some((t) => t.includes("*"))).toBe(true);
  });

  test("finds an inline include (not anchored to line start)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hostler-conf-"));
    const main = join(dir, "nginx.conf");
    writeFileSync(main, "http { include /Users/alice/nginx/*.conf; }\n");
    const targets = await collectIncludeTargets(main);
    expect(targets).toContain("/Users/alice/nginx");
  });

  test("recurses into a symlinked included config file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hostler-conf-"));
    const main = join(dir, "nginx.conf");
    const real = join(dir, "real.conf");
    const link = join(dir, "link.conf");
    writeFileSync(real, "include /Users/alice/nginx/*.conf;\n");
    symlinkSync(real, link); // sites-enabled style symlink
    writeFileSync(main, `include ${link};\n`);

    const targets = await collectIncludeTargets(main);
    // Only discoverable by following the symlink and reading real.conf.
    expect(targets).toContain("/Users/alice/nginx");
  });

  test("recurses through included files and survives cycles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hostler-conf-"));
    const main = join(dir, "nginx.conf");
    writeFileSync(main, "include sub.conf;\ninclude self.conf;\n");
    // A nested include inside an included FILE must still be discovered.
    writeFileSync(join(dir, "sub.conf"), "include /Users/alice/nginx/*.conf;\n");
    // Self-referential include must not hang.
    writeFileSync(join(dir, "self.conf"), "include self.conf;\n");

    const targets = await collectIncludeTargets(main);
    expect(targets).toContain(join(dir, "sub.conf"));
    expect(targets).toContain("/Users/alice/nginx"); // found only via recursion into sub.conf
  });
});

describe("scanIncludeArgs", () => {
  test("finds inline includes and ignores comments and quotes", () => {
    const args = scanIncludeArgs(
      [
        "http { include /a/*.conf; }",
        "# include /commented/*.conf;",
        'include "/b/c.conf";',
        "server { listen 80; }", // not an include
      ].join("\n"),
    );
    expect(args).toEqual(["/a/*.conf", "/b/c.conf"]);
  });

  test("handles multiple directives on one line", () => {
    expect(scanIncludeArgs("include /x.conf; include /y.conf;")).toEqual(["/x.conf", "/y.conf"]);
  });
});

describe("sudoersPathFor", () => {
  test("is keyed on UID — unique, dot-free, no collisions", () => {
    expect(sudoersPathFor(501)).toBe("/etc/sudoers.d/hostler-501");
    expect(sudoersPathFor(0)).toBe("/etc/sudoers.d/hostler-0");
    // Distinct UIDs never collide (unlike sanitized usernames first.last/first_last).
    expect(sudoersPathFor(501)).not.toBe(sudoersPathFor(1001));
  });

  test("rejects invalid uids", () => {
    expect(() => sudoersPathFor(-1)).toThrow();
    expect(() => sudoersPathFor(1.5)).toThrow();
    expect(() => sudoersPathFor(Number.NaN)).toThrow();
  });
});
