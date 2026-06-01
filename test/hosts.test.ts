import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addEntry, getManagedDomains, hasDomain, removeEntry } from "../src/lib/hosts.ts";
import { isValidDomain } from "../src/lib/domain.ts";

let hostsPath: string;
const BASE = "127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n";

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "hostler-hosts-"));
  hostsPath = join(dir, "hosts");
  await writeFile(hostsPath, BASE);
});

afterEach(async () => {
  await rm(join(hostsPath, ".."), { recursive: true, force: true });
});

test("add/remove round-trips within the managed block", async () => {
  await addEntry(hostsPath, "app.loc");
  await addEntry(hostsPath, "api.loc");
  expect(await getManagedDomains(hostsPath)).toEqual(["app.loc", "api.loc"]);

  await removeEntry(hostsPath, "app.loc");
  expect(await getManagedDomains(hostsPath)).toEqual(["api.loc"]);

  // Original entries are never touched.
  const content = await readFile(hostsPath, "utf8");
  expect(content).toContain("127.0.0.1\tlocalhost");
  expect(content).toContain("broadcasthost");
});

test("adding the same domain twice is idempotent", async () => {
  await addEntry(hostsPath, "app.loc");
  await addEntry(hostsPath, "app.loc");
  expect(await getManagedDomains(hostsPath)).toEqual(["app.loc"]);
});

test("removing the last domain leaves no managed block", async () => {
  await addEntry(hostsPath, "app.loc");
  await removeEntry(hostsPath, "app.loc");
  const content = await readFile(hostsPath, "utf8");
  expect(content).not.toContain("BEGIN hostler");
});

test("hasDomain matches whole fields, not substrings", async () => {
  await addEntry(hostsPath, "app.loc");
  expect(await hasDomain(hostsPath, "app.loc")).toBe(true);
  expect(await hasDomain(hostsPath, "pp.loc")).toBe(false);
});

test("isValidDomain accepts valid and rejects unsafe domains", () => {
  expect(isValidDomain("app.loc")).toBe(true);
  expect(isValidDomain("my-app.dev.loc")).toBe(true);
  expect(isValidDomain("nodot")).toBe(false);
  expect(isValidDomain("bad domain.loc")).toBe(false);
  expect(isValidDomain("evil.loc; rm -rf")).toBe(false);
  expect(isValidDomain("-leading.loc")).toBe(false);
});
