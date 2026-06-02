import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeIncludeByPath } from "../src/lib/nginx.ts";

let dir: string;
let conf: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hostler-inc-"));
  conf = join(dir, "nginx.conf");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("removes an include in the exact generated form (with comment)", async () => {
  writeFileSync(
    conf,
    "http {\n    # Hostler user configs\n    include /home/u/.hostler/nginx/*.conf;\n}\n",
  );
  const { removed, stillPresent } = await removeIncludeByPath(conf, "/home/u/.hostler/nginx");
  expect(removed).toBe(true);
  expect(stillPresent).toBe(false);
  const out = readFileSync(conf, "utf8");
  expect(out).not.toContain("Hostler user configs");
  expect(out).not.toContain(".hostler/nginx");
});

test("removes a hand-edited include with different whitespace and no comment", async () => {
  // The old narrow remover (exact comment+include form) would have missed this.
  writeFileSync(conf, "http {\n\tinclude    /home/u/.hostler/nginx/*.conf ;\n}\n");
  const { removed, stillPresent } = await removeIncludeByPath(conf, "/home/u/.hostler/nginx");
  expect(removed).toBe(true);
  expect(stillPresent).toBe(false);
});

test("reports stillPresent when the path survives in an unusual form", async () => {
  // Two paths in one include directive — we don't rewrite this, but must not
  // claim the reference is gone.
  writeFileSync(conf, "http {\n    include /home/u/.hostler/nginx/*.conf /other/*.conf;\n}\n");
  const { removed, stillPresent } = await removeIncludeByPath(conf, "/home/u/.hostler/nginx");
  expect(removed).toBe(false);
  expect(stillPresent).toBe(true);
});
