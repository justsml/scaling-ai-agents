import { expect, test } from "bun:test";
import { certifyCompiledPatch } from "../src/snippets/05-compile.ts";
import { COMPILED_PATCH } from "../src/compiled/readiness-fix.ts";

test("compiled serving gate rejects a broken artifact", async () => {
  await expect(
    certifyCompiledPatch("export const runWhenReady = async () => ({status: 'ran', attempts: 0});"),
  ).rejects.toThrow("fixture contract");
});
test("compiled serving gate accepts the reference and rejects cancellation", async () => {
  expect((await certifyCompiledPatch(COMPILED_PATCH)).green).toBe(true);
  await expect(certifyCompiledPatch(COMPILED_PATCH, AbortSignal.abort())).rejects.toThrow(
    "cancelled",
  );
});

test("cached lookup still invokes certification, while changed source misses", async () => {
  const { buildCompileGraph } = await import("../src/snippets/05-compile.ts");
  const { TARGET_SOURCE } = await import("../src/compiled/readiness-fix.ts");
  let checks = 0;
  const graph = buildCompileGraph(async () => {
    checks++;
    if (checks > 1) throw Error("revoked");
    return { green: true } as Awaited<ReturnType<typeof certifyCompiledPatch>>;
  });
  const input = { request: "Fix runWhenReady", source: TARGET_SOURCE };
  expect((await graph.invoke(input)).path).toBe("compiled-reference");
  await expect(graph.invoke(input)).rejects.toThrow("revoked");
  expect(checks).toBe(2);
  expect((await graph.invoke({ ...input, source: TARGET_SOURCE + " " })).patch).toBe("");
});
