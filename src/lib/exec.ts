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

/**
 * True when running as a Bun-compiled standalone binary (as opposed to
 * `bun run src/index.ts`). Compiled binaries expose their entry point through
 * Bun's embedded filesystem, so Bun.main lives under /$bunfs (or B:\~BUN on
 * Windows); in source mode Bun.main is the real script path.
 */
export function isCompiled(): boolean {
  return Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:\\~BUN");
}

/**
 * Absolute path to the running hostler executable, with symlinks resolved.
 * Only meaningful when isCompiled() is true — in source mode process.execPath
 * is the Bun binary, not hostler.
 */
export function selfPath(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

/**
 * The argv prefix needed to re-invoke hostler (e.g. for `sudo hostler _hosts-add`).
 * Compiled: just the binary. Source/dev: `bun <entry-script>` so self-exec still
 * works while developing. The sudoers rule, however, must reference a stable
 * binary path — see init, which requires the compiled binary.
 */
export function selfInvocation(): string[] {
  if (isCompiled()) return [selfPath()];
  const script = process.argv[1] ?? Bun.main;
  return [process.execPath, script];
}
