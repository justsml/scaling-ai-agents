import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runSandbox } from "../src/lib/sandbox";

const BUGGY_PATH = new URL("../src/fixtures/readiness.ts", import.meta.url);
const FIXED_PATH = new URL("../src/compiled/readiness.ts", import.meta.url);

describe("runSandbox", () => {
  test("the buggy fixture yields 2 pass / 3 fail", async () => {
    const source = await readFile(BUGGY_PATH, "utf8");
    const result = await runSandbox(source, 8000);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(3);
    expect(result.ok).toBe(false);
  }, 15000);

  test("the compiled (fixed) readiness.ts passes all five tests", async () => {
    const fixed = await readFile(FIXED_PATH, "utf8");
    const result = await runSandbox(fixed, 8000);
    expect(result.passed).toBe(5);
    expect(result.failed).toBe(0);
    expect(result.ok).toBe(true);
  }, 15000);
});
