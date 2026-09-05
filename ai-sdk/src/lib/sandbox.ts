// Runs a candidate patch to readiness.ts against the fixed fixture test file
// in an isolated child process (`bun test`). This is the deterministic judge
// for Compete: every candidate is graded the same way, in a temp directory
// nothing else touches, with a hard wall-clock timeout so a candidate that
// reintroduces the "retry forever" bug cannot hang the whole tournament.
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SandboxResult {
  passed: number;
  failed: number;
  total: number;
  ok: boolean;
  stdout: string;
  timedOut: boolean;
  durationMs: number;
}

const TEST_FILE_PATH = new URL("../fixtures/readiness.test.ts", import.meta.url);

export async function runSandbox(
  candidateSource: string,
  timeoutMs = 5000,
): Promise<SandboxResult> {
  const dir = await mkdtemp(join(tmpdir(), "readiness-sandbox-"));
  const start = Date.now();
  try {
    const testSource = await readFile(TEST_FILE_PATH, "utf8");
    await writeFile(join(dir, "readiness.ts"), candidateSource, "utf8");
    await writeFile(join(dir, "readiness.test.ts"), testSource, "utf8");

    const proc = Bun.spawn({
      cmd: ["bun", "test", "--timeout", "2000", "readiness.test.ts"],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const killer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
    }, timeoutMs);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(killer);

    const combined = `${stdout}\n${stderr}`;
    const durationMs = Date.now() - start;
    const timedOut = durationMs >= timeoutMs;

    // bun test prints "N pass" / "N fail" summary lines.
    const passMatch = combined.match(/(\d+)\s+pass/);
    const failMatch = combined.match(/(\d+)\s+fail/);
    const passed = passMatch ? Number(passMatch[1]) : 0;
    const failed = failMatch ? Number(failMatch[1]) : timedOut ? 5 : 0;
    const total = passed + failed;

    return {
      passed,
      failed,
      total,
      ok: exitCode === 0 && failed === 0 && total > 0,
      stdout: combined,
      timedOut,
      durationMs,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
