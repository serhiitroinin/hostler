import { describe, expect, test } from "bun:test";
import { isValidDomain, normalizeDomain, parsePort } from "../src/lib/domain.ts";

describe("parsePort", () => {
  test("accepts in-range integers", () => {
    expect(parsePort("3000")).toBe(3000);
    expect(parsePort("1")).toBe(1);
    expect(parsePort("65535")).toBe(65535);
  });

  test("rejects junk that parseInt would silently accept", () => {
    expect(parsePort("3000abc")).toBeNull();
    expect(parsePort("3000.5")).toBeNull();
    expect(parsePort(" 3000")).toBeNull();
    expect(parsePort("0x10")).toBeNull();
    expect(parsePort("")).toBeNull();
  });

  test("rejects out-of-range ports", () => {
    expect(parsePort("0")).toBeNull();
    expect(parsePort("65536")).toBeNull();
    expect(parsePort("70000")).toBeNull();
  });
});

describe("normalizeDomain", () => {
  test("trims and lowercases", () => {
    expect(normalizeDomain("  App.LOC  ")).toBe("app.loc");
    expect(normalizeDomain("MyApp.Dev.LOC")).toBe("myapp.dev.loc");
  });

  test("normalized variants collapse to the same key", () => {
    expect(normalizeDomain("App.loc")).toBe(normalizeDomain("app.loc"));
  });
});

describe("isValidDomain", () => {
  test("accepts valid and rejects unsafe", () => {
    expect(isValidDomain("app.loc")).toBe(true);
    expect(isValidDomain("nodot")).toBe(false);
    expect(isValidDomain("../evil.loc")).toBe(false);
    expect(isValidDomain("a/b.loc")).toBe(false);
    expect(isValidDomain("evil.loc; rm -rf")).toBe(false);
  });
});
