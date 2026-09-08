/**
 * sandbox.ts — the deterministic judge.
 *
 * A candidate patch is a whole replacement for
 * `readiness.ts`. To judge it we:
 *   1. make a scratch directory,
 *   2. write the candidate as `readiness.ts`,
 *   3. copy the *unmodified* fixture test next to it,
 *   4. run `bun test --timeout 2000` in a child process,
 *   5. parse the pass/fail counts out of bun's summary.
 *
 * The child process matters. The buggy fixture retries
 * `EACCES` forever; run in-process it would hang the
 * snippet. In a child with a per-test timeout it just
 * fails three tests, which is exactly the signal we
 * want. `test/sandbox.test.ts` pins that: the buggy
 * fixture scores 2 pass / 3 fail.
 *
 * This runs untrusted-ish model output, so: no network
 * flag is granted, the scratch dir is under the OS temp
 * dir, and the whole child is killed on the run's
 * AbortSignal.
 */

import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = fileURLToPath(
  new URL("../fixtures/", import.meta.url),
);

export const TOTAL_FIXTURE_TESTS = 5;

export interface SandboxResult {
  passed: number;
  failed: number;
  total: number;
  /** True only when every fixture test passed. */
  green: boolean;
  durationMs: number;
  /** Names of failing tests, best effort from bun's output. */
  failures: string[];
  /** Raw output, trimmed. Useful when parsing fails. */
  output: string;
  /** Set when the sandbox itself broke (timeout, spawn failure), not the candidate. */
  error?: string;
}

export async function readBuggyModule(): Promise<string> {
  return readFile(
    join(FIXTURE_DIR, "readiness.ts"),
    "utf8",
  );
}

export async function readFixtureTest(): Promise<string> {
  return readFile(
    join(FIXTURE_DIR, "readiness.test.ts"),
    "utf8",
  );
}

export async function readRubric(): Promise<string> {
  return readFile(
    join(FIXTURE_DIR, "rubric.md"),
    "utf8",
  );
}

/**
 * Run one candidate against the fixture tests.
 *
 * @param candidateSource full replacement source for
 * `readiness.ts` @param signal the run's deadline;
 * kills the child when it fires
 */
export async function runCandidate(
  candidateSource: string,
  signal?: AbortSignal,
): Promise<SandboxResult> {
  const started = Date.now();
  let dir: string | undefined;
  try {
    dir = await mkdtemp(
      join(tmpdir(), "readiness-candidate-"),
    );
    await writeFile(
      join(dir, "readiness.ts"),
      candidateSource,
      "utf8",
    );
    // The test file is copied verbatim. A candidate
    // that "passes" by editing the test cannot: it
    // never gets the chance, because we overwrite the
    // test every time.
    await writeFile(
      join(dir, "readiness.test.ts"),
      await readFixtureTest(),
      "utf8",
    );

    const proc = Bun.spawn(
      [
        "bun",
        "test",
        "--timeout",
        "2000",
        "readiness.test.ts",
      ],
      {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
      },
    );

    const onAbort = () => proc.kill();
    signal?.addEventListener("abort", onAbort, {
      once: true,
    });

    // Hard ceiling independent of the run deadline: 5
    // tests x 2s plus startup.
    const guard = setTimeout(() => proc.kill(), 20_000);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    clearTimeout(guard);
    signal?.removeEventListener("abort", onAbort);

    const output = `${stdout}\n${stderr}`.trim();
    const parsed = parseBunTestOutput(output);
    return {
      ...parsed,
      durationMs: Date.now() - started,
      output: output.slice(-4000),
    };
  } catch (error) {
    return {
      passed: 0,
      failed: TOTAL_FIXTURE_TESTS,
      total: TOTAL_FIXTURE_TESTS,
      green: false,
      durationMs: Date.now() - started,
      failures: [],
      output: "",
      error:
        error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    if (dir)
      await rm(dir, {
        recursive: true,
        force: true,
      }).catch(() => {});
  }
}

/**
 * Bun prints a summary like:
 *    2 pass
 *    0 skip
 *    3 fail
 * and marks each failing test with `(fail)`. Both are
 * parsed; the summary wins.
 */
export function parseBunTestOutput(
  output: string,
): Omit<SandboxResult, "durationMs" | "output"> {
  const plain = output.replace(/\[[0-9;]*m/g, "");
  const passMatch = plain.match(
    /^\s*(\d+)\s+pass\s*$/m,
  );
  const failMatch = plain.match(
    /^\s*(\d+)\s+fail\s*$/m,
  );

  const failures = [
    ...plain.matchAll(
      /^\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/gm,
    ),
  ].map((m) => m[1]!.trim());

  // A candidate that does not even compile produces no
  // summary at all.
  if (!passMatch && !failMatch) {
    return {
      passed: 0,
      failed: TOTAL_FIXTURE_TESTS,
      total: TOTAL_FIXTURE_TESTS,
      green: false,
      failures: [
        "no test summary — candidate probably failed to parse or import",
      ],
    };
  }

  const passed = passMatch ? Number(passMatch[1]) : 0;
  const failed = failMatch ? Number(failMatch[1]) : 0;
  const total = passed + failed;
  return {
    passed,
    failed,
    total: total || TOTAL_FIXTURE_TESTS,
    green:
      failed === 0 && passed === TOTAL_FIXTURE_TESTS,
    failures,
  };
}

/**
 * A candidate is disqualified before it ever reaches
 * the rubric judge if it broke a rule the rubric calls
 * a disqualifier. Cheap string checks, deliberately:
 * the point is that the deterministic gate runs first
 * and for free.
 */
export function disqualify(
  candidateSource: string,
): string | null {
  const importMatch = candidateSource.match(
    /(?:from|^\s*import)\s+['"]([^'"]+)['"]/m,
  );
  if (
    importMatch &&
    !/^(\.\/|\.\.\/|node:)/.test(importMatch[1]!)
  ) {
    return `adds a dependency (${importMatch[1]})`;
  }
  // Importing the test file is a disqualifier.
  // *Mentioning* it in a comment is not — several good
  // candidates cite it while explaining themselves.
  if (
    /(?:from|import)\s+['"][^'"]*readiness\.test/.test(
      candidateSource,
    )
  ) {
    return "imports the test file";
  }

  // "Uses real timers INSTEAD OF the injected
  // sleep/now" is the rubric's wording, and the word
  // that matters is "instead". A candidate that writes
  //     const sleep = options.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)))
  // still honours the injected clock in every test; it
  // is only providing a default. So the check is: does
  // a real timer appear *without* the injected one
  // being used at all?
  const usesInjectedSleep =
    /options\.sleep|\bsleep\s*\(/.test(candidateSource);
  if (
    /\bsetTimeout\s*\(|\bsetInterval\s*\(/.test(
      candidateSource,
    ) &&
    !usesInjectedSleep
  ) {
    return "waits with setTimeout instead of the injected sleep()";
  }
  const usesInjectedNow =
    /options\.now|\bnow\s*\(\s*\)/.test(
      candidateSource,
    );
  if (
    /Date\.now\s*\(/.test(candidateSource) &&
    !usesInjectedNow
  ) {
    return "reads the clock with Date.now instead of the injected now()";
  }
  return null;
}
