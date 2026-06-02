import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  findDomainInOtherUserDirs,
  findEntry,
  generateServerBlock,
  parseConfigFile,
  parseUserConfigs,
} from "../src/lib/nginx.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hostler-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseConfigFile", () => {
  test("extracts domain and port from a generated block", async () => {
    const path = join(dir, "app.loc.conf");
    await writeFile(path, generateServerBlock("app.loc", 3000));
    const entry = await parseConfigFile(path);
    expect(entry).toEqual({ domain: "app.loc", port: 3000, file: path });
  });

  test("falls back to filename and reports null port when proxy_pass is malformed", async () => {
    // The old line-by-line parser dropped this entry entirely; we surface it.
    const path = join(dir, "broken.loc.conf");
    await writeFile(path, "server {\n  server_name broken.loc;\n  proxy_pass http://example;\n}\n");
    const entry = await parseConfigFile(path);
    expect(entry).not.toBeNull();
    expect(entry!.domain).toBe("broken.loc");
    expect(entry!.port).toBeNull();
  });

  test("ignores files that are not domain configs", async () => {
    const path = join(dir, "random.conf");
    await writeFile(path, "# just a comment\n");
    expect(await parseConfigFile(path)).toBeNull();
  });
});

describe("parseUserConfigs", () => {
  test("reads every config and never silently drops a domain", async () => {
    await writeFile(join(dir, "a.loc.conf"), generateServerBlock("a.loc", 3000));
    await writeFile(join(dir, "b.loc.conf"), generateServerBlock("b.loc", 4000));
    await writeFile(join(dir, ".initialized"), "initialized\n"); // marker, must be skipped

    const entries = await parseUserConfigs(dir);
    expect(entries).toHaveLength(2);
    expect(findEntry(entries, "a.loc")?.port).toBe(3000);
    expect(findEntry(entries, "b.loc")?.port).toBe(4000);
  });

  test("returns empty for a missing directory", async () => {
    expect(await parseUserConfigs(join(dir, "nope"))).toEqual([]);
  });
});

describe("findDomainInOtherUserDirs", () => {
  test("finds a domain configured under a sibling user's dir", async () => {
    // dir acts as /etc/hostler; self and other are sibling <user> dirs.
    const self = join(dir, "alice");
    const other = join(dir, "bob");
    await mkdir(self);
    await mkdir(other);
    await writeFile(join(other, "app.loc.conf"), generateServerBlock("app.loc", 3000));

    expect(await findDomainInOtherUserDirs("app.loc", self)).toBe(other);
    expect(await findDomainInOtherUserDirs("other.loc", self)).toBeNull();
  });

  test("ignores the caller's own dir", async () => {
    const self = join(dir, "alice");
    await mkdir(self);
    await writeFile(join(self, "mine.loc.conf"), generateServerBlock("mine.loc", 3000));
    expect(await findDomainInOtherUserDirs("mine.loc", self)).toBeNull();
  });
});
