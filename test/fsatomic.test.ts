import { afterEach, expect, test } from "bun:test";
import { existsSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock } from "../src/lib/fsatomic.ts";

// Lock files live at tmpdir()/hostler-<name>.lock. Use unique names per test.
const lockPath = (name: string) => join(tmpdir(), `hostler-${name}.lock`);
const cleanup: string[] = [];

afterEach(() => {
  for (const p of cleanup.splice(0)) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
});

test("fails closed: throws instead of running unlocked when held", async () => {
  const name = "test-held";
  const path = lockPath(name);
  cleanup.push(path);
  writeFileSync(path, "99999\n"); // simulate a live lock held by another process

  let ran = false;
  await expect(
    withLock(name, () => {
      ran = true;
    }, { timeoutMs: 150, staleMs: 60_000 }),
  ).rejects.toThrow(/could not acquire/);
  expect(ran).toBe(false);
});

test("reclaims a stale lock and runs the critical section", async () => {
  const name = "test-stale";
  const path = lockPath(name);
  cleanup.push(path);
  writeFileSync(path, "1\n");
  // Backdate the lock well past staleMs.
  const old = new Date(Date.now() - 120_000);
  utimesSync(path, old, old);

  let ran = false;
  await withLock(name, () => {
    ran = true;
  }, { timeoutMs: 150, staleMs: 30_000 });
  expect(ran).toBe(true);
});

test("serializes concurrent holders of the same lock", async () => {
  const name = "test-serial";
  cleanup.push(lockPath(name));
  const events: string[] = [];
  const section = (id: string) =>
    withLock(name, async () => {
      events.push(`start-${id}`);
      await Bun.sleep(40);
      events.push(`end-${id}`);
    });

  await Promise.all([section("a"), section("b")]);
  // Whichever ran first must fully finish before the other starts.
  expect(events).toHaveLength(4);
  expect(events[1]).toBe(events[0]!.replace("start", "end"));
});
