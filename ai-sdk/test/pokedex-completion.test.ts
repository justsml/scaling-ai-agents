import { afterEach, expect, test } from "bun:test";
import { PokedexGatewaySession, answerSchema, type InvestigationRequest } from "../src/lib/pokedex";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function investigation(options: Partial<InvestigationRequest> = {}) {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { ref } = (await request.json()) as { ref: string };
      if (ref === "pokemon/404")
        return Response.json(
          { requestId: `read-${++calls}`, ok: false, error: { code: "NOT_FOUND" } },
          { status: 404 },
        );
      if (ref === "region/1" || ref === "evolution-chain/1")
        return Response.json({
          requestId: `read-${++calls}`,
          data:
            ref === "region/1"
              ? { name: "kanto" }
              : { species: ["bulbasaur", "ivysaur", "venusaur"] },
        });
      return Response.json({
        requestId: `read-${++calls}`,
        data:
          ref === "pokemon/4"
            ? { name: "charmander", weight: 85 }
            : { name: "bulbasaur", weight: 69, names: ["bulbasaur", "ivysaur"] },
      });
    },
  });
  servers.push(server);
  const request: InvestigationRequest = {
    runId: "completion",
    scenarioId: "completion",
    prompt: "Find names",
    gatewayBaseUrl: String(server.url),
    deadlineMs: 1000,
    maxToolCalls: 4,
    model: "openai/gpt-5.6-luna",
    reasoningEffort: "none",
    ...options,
  };
  return new PokedexGatewaySession(request, "ai-sdk");
}
const answer = (value: unknown = "bulbasaur", requestIds = ["read-1"]) => ({
  summary: "Observed locally",
  claims: [{ path: "name", value, requestIds }],
});

test("completion rejects an unsupported citation after normalization and retains diagnosis", async () => {
  const session = investigation();
  await session.call("pokedex_get", { ref: "pokemon/1" });
  const rejected = answer("mewtwo", ["invented"]);
  const result = session.finish({ answer: rejected, finishReason: "stop" });
  expect(result.stopReason).toBe("invalid-evidence");
  expect(result.answer).toBeNull();
  expect(result.stopMetadata.rejectedAnswer).toEqual(rejected);
  expect(result.toolCalls).toHaveLength(1);
});

test.each([null, {}, { summary: "empty", claims: [] }, answer("bulbasaur", [])])(
  "completion rejects malformed or empty answers %j",
  (raw) => {
    const result = investigation().finish({ answer: raw });
    expect(result.stopReason).toBe("invalid-evidence");
    expect(result.answer).toBeNull();
  },
);

test("completion repairs only exact supported values and revalidates merged claims", async () => {
  const session = investigation();
  await session.call("pokedex_get", { ref: "pokemon/1" });
  const result = session.finish({
    answer: {
      summary: "names",
      claims: [
        { path: "name", value: ["Bulbasaur"], requestIds: ["invented"] },
        { path: "name", value: ["Ivysaur"], requestIds: ["read-1"] },
      ],
    },
    usage: { inputTokens: 12, outputTokens: 3 },
    finishReason: "stop",
  });
  expect(result.stopReason).toBe("stop");
  expect(result.answer?.claims).toEqual([
    { path: "names", value: ["bulbasaur", "ivysaur"], requestIds: ["read-1"] },
  ]);
  expect(answerSchema.safeParse(result.answer).success).toBe(true);
  expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
  expect(result.stopMetadata.toolCallAttempts).toBe(1);
});

test("citation repair does not match substrings or numeric text", async () => {
  for (const value of ["saur", 6]) {
    const session = investigation();
    await session.call("pokedex_get", { ref: "pokemon/1" });
    expect(session.finish({ answer: answer(value, ["invented"]) }).stopReason).toBe(
      "invalid-evidence",
    );
  }
});

test("completion retains both reads for a derived comparison", async () => {
  const session = investigation({
    prompt: "Which weighs more, Bulbasaur or Charmander, and by how much?",
  });
  await session.call("pokedex_get", { ref: "pokemon/1" });
  await session.call("pokedex_get", { ref: "pokemon/4" });
  const result = session.finish({
    answer: {
      summary: "comparison",
      claims: [
        { path: "heavier", value: "Charmander", requestIds: ["read-2"] },
        { path: "difference", value: 16, requestIds: ["read-1", "read-2"] },
      ],
    },
  });
  expect(result.stopReason).toBe("completed");
  expect(result.answer?.claims.every((claim) => claim.requestIds.length === 2)).toBe(true);
});

test("call limits take precedence while retaining valid partial evidence", async () => {
  const session = investigation({ maxToolCalls: 1 });
  await session.call("pokedex_get", { ref: "pokemon/1" });
  await session.call("pokedex_get", { ref: "pokemon/4" });
  const result = session.finish({ answer: answer(), error: new Error("aborted") });
  expect(result.stopReason).toBe("max-tool-calls");
  expect(result.answer?.claims[0]?.value).toBe("bulbasaur");
  expect(result.stopMetadata.toolCallAttempts).toBe(2);
});

test("deadline takes precedence over model error and invalid evidence", async () => {
  const session = investigation({ deadlineMs: 1 });
  await Bun.sleep(5);
  const result = session.finish({ answer: answer(), error: new Error("aborted") });
  expect(result.stopReason).toBe("deadline");
  expect(result.answer).toBeNull();
  expect(result.stopMetadata.error).toBe("aborted");
});

test("model errors retain usage and evidence; finalization closes the deadline timer", async () => {
  const session = investigation({ deadlineMs: 100 });
  await session.call("pokedex_get", { ref: "pokemon/1" });
  const result = session.finish({
    error: new Error("model failed"),
    usage: { inputTokens: 4, outputTokens: 0 },
  });
  expect(result.stopReason).toBe("error:model failed");
  expect(result.usage.inputTokens).toBe(4);
  expect(result.toolCalls).toHaveLength(1);
  await Bun.sleep(110);
  expect(session.signal.aborted).toBe(false);
});

test("completion retains canonical relationship claims and repaired evidence", async () => {
  const evolution = investigation({ prompt: "Find later evolution species" });
  await evolution.call("pokedex_get", { ref: "evolution-chain/1" });
  expect(
    evolution.finish({
      answer: {
        summary: "chain",
        claims: [{ path: "names", value: ["Ivysaur", "Venusaur"], requestIds: ["invented"] }],
      },
    }).answer?.claims[0],
  ).toEqual({ path: "laterSpecies", value: ["ivysaur", "venusaur"], requestIds: ["read-1"] });
  const region = investigation({ prompt: "Follow its main region relationship" });
  await region.call("pokedex_get", { ref: "region/1" });
  expect(region.finish({ answer: answer("Kanto") }).answer?.claims[0]?.path).toBe("region");
});

test("completion rejects citations to failed gateway calls", async () => {
  const session = investigation();
  await session.call("pokedex_get", { ref: "pokemon/404" });
  const result = session.finish({ answer: answer() });
  expect(result.stopReason).toBe("invalid-evidence");
  expect(result.answer).toBeNull();
  expect(result.toolCalls[0]?.ok).toBe(false);
});

test("CLI entrypoint validates stdin before starting any model call", async () => {
  const child = Bun.spawn(["bun", "run", "src/snippets/05-pokedex.ts"], {
    cwd: new URL("../", import.meta.url).pathname,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write("{}\n");
  child.stdin.end();
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exit).not.toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toContain("ZodError");
});

test("tool results expose remaining allowance without changing recorded gateway evidence", async () => {
  const session = investigation({ maxToolCalls: 2 });
  const first = await session.call("pokedex_get", { ref: "pokemon/1" });
  expect(first).toMatchObject({ remainingToolCalls: 1 });
  const last = await session.call("pokedex_get", { ref: "pokemon/4" });
  expect(last).toMatchObject({ remainingToolCalls: 0 });
  expect(session.evidence[1]?.result).not.toHaveProperty("remainingToolCalls");
  session.finish({ answer: answer() });
});
