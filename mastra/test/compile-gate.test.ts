import { expect, test } from "bun:test";
import { certifyCompiledPatch, serveCompiled } from "../src/lib/compiled.js";
import { readinessChallenge } from "../src/lib/readiness-challenge.js";
import { compiledWorkflow } from "../src/snippets/03-compile.js";
test("a failed or cancelled certification refuses the patch", async () => {
  const buggy = await readinessChallenge.load("buggy");
  await expect(certifyCompiledPatch(buggy.source)).rejects.toThrow("refused");
  await expect(certifyCompiledPatch(buggy.source, AbortSignal.abort())).rejects.toThrow("refused");
});
test("native tool step certifies a hit and declines even whitespace source drift", async () => {
  const buggy = await readinessChallenge.load("buggy");
  const result = await (await compiledWorkflow.createRun()).start({
    inputData: { source: buggy.source },
  });
  expect(result.status).toBe("success");
  if (result.status === "success") expect(result.result.matched).toBe(true);
  expect((await serveCompiled(buggy.source + " ")).matched).toBe(false);
});
