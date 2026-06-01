import { describe, expect, test } from "bun:test";
import { insertIntoHttpBlock } from "../src/lib/nginx.ts";
import { buildSudoers } from "../src/commands/init.ts";

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
