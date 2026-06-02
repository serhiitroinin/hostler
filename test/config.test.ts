import { describe, expect, test } from "bun:test";
import { getUserConfigDir, SYSTEM_CONFIG_BASE } from "../src/lib/config.ts";
import { untrustedBinaryReason } from "../src/lib/nginx.ts";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("getUserConfigDir", () => {
  test("lives under the root-owned /etc base, not the user home", () => {
    expect(SYSTEM_CONFIG_BASE).toBe("/etc/hostler");
    expect(getUserConfigDir("alice")).toBe("/etc/hostler/alice");
  });

  test("rejects usernames that could escape the base directory", () => {
    expect(() => getUserConfigDir("../etc")).toThrow();
    expect(() => getUserConfigDir("a/b")).toThrow();
    expect(() => getUserConfigDir("")).toThrow();
  });
});

describe("untrustedBinaryReason", () => {
  test("flags a binary in a user-owned directory (replaceable → unsafe)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hostler-bin-"));
    const bin = join(dir, "nginx");
    writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    // Test runs unprivileged, so a path component is owned by the test user.
    expect(untrustedBinaryReason(bin)).toMatch(/not owned by root/);
  });

  test("reports a missing path", () => {
    expect(untrustedBinaryReason("/nonexistent/hostler-x/nginx")).toMatch(/not found/);
  });

  test("rejects a relative path", () => {
    expect(untrustedBinaryReason("relative/nginx")).toMatch(/not an absolute path/);
  });

  test("accepts a fully root-owned system path", () => {
    // /usr and below are root-owned and not group/world-writable on a sane box.
    // Use a binary that exists in CI/dev; skip cleanly if absent.
    for (const p of ["/bin/sh", "/usr/bin/true"]) {
      if (existsSync(p)) {
        expect(untrustedBinaryReason(p)).toBeNull();
        return;
      }
    }
  });
});
