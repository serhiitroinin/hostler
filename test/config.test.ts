import { describe, expect, test } from "bun:test";
import { getUserConfigDir, SYSTEM_CONFIG_BASE } from "../src/lib/config.ts";
import { untrustedBinaryReason } from "../src/lib/nginx.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
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
  test("flags a non-root-owned binary (sudoers reference would be unsafe)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hostler-bin-"));
    const bin = join(dir, "nginx");
    writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    // Test runs unprivileged, so the file is owned by the test user, not root.
    expect(untrustedBinaryReason(bin)).toBe("not owned by root");
  });

  test("reports a missing binary", () => {
    expect(untrustedBinaryReason("/nonexistent/nginx")).toBe("not found");
  });
});
