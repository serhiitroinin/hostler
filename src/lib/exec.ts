// Thin wrapper around Bun.spawn that captures stdout/stderr and never throws,
// so callers can branch on exit code the way the Go version used CombinedOutput.
import { realpathSync } from "node:fs";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
  ok: boolean;
}

export async function run(cmd: string[]): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "inherit" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout,
    stderr,
    combined: stdout + stderr,
    ok: exitCode === 0,
  };
}

/** Resolves the absolute path of a binary via `which`, or null if not found. */
export async function which(bin: string): Promise<string | null> {
  const res = await run(["/usr/bin/which", bin]);
  if (!res.ok) return null;
  const path = res.stdout.trim().split("\n")[0];
  return path || null;
}

/** Absolute path to the running hostler executable, with symlinks resolved. */
export function selfPath(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}
