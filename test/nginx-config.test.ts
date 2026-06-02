import { describe, expect, test } from "bun:test";
import { collectIncludeTargets, insertIntoHttpBlock } from "../src/lib/nginx.ts";
import { buildSudoers, sudoersPathFor } from "../src/commands/init.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
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
