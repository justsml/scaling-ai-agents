import { expect, test } from "bun:test";
import type { Experimental_TextBatchItemResult as BatchItem } from "ai";
import { runProviderBatch } from "../src/lib/provider-batch";

const batch = {
  version: 1,
  type: "text",
  id: "accepted-123",
  provider: "gateway",
  modelId: "openai/gpt-5.6-luna",
} as const;
const failedItem: BatchItem = { id: "one", status: "failed", error: { message: "item rejected" } };
const operations = () => ({
  start: async (_signal: AbortSignal) => ({ ...batch, status: "pending" as const }),
  status: async (_batch: typeof batch, _signal: AbortSignal) => ({ status: "completed" as const }),
  results: async function* (_batch: typeof batch, _signal: AbortSignal) {
    yield failedItem;
  },
});

test("module-loading errors preserve their diagnosis without submitting", async () => {
  const result = await runProviderBatch({
    load: async () => {
      throw new Error("gateway initialization failed");
    },
  });
  expect(result).toMatchObject({
    outcome: "load-error",
    error: "Error: gateway initialization failed",
  });
});

test("lost submission acknowledgment stays unknown with no automatic retry", async () => {
  let calls = 0;
  const result = await runProviderBatch({
    load: async () => ({
      ...operations(),
      start: async () => {
        calls++;
        throw new Error("connection lost");
      },
    }),
  });
  expect(calls).toBe(1);
  expect(result).toMatchObject({
    outcome: "provider-error",
    phase: "submission",
    batch: undefined,
    error: "Error: connection lost",
  });
  expect(result.nextAction).toContain("Submission outcome is unknown");
});

test("synchronous provider errors return without an unhandled abort rejection", async () => {
  const result = await runProviderBatch({
    load: async () => ({
      ...operations(),
      start: () => {
        throw new Error("synchronous provider failure");
      },
    }),
  });
  expect(result).toMatchObject({
    outcome: "provider-error",
    phase: "submission",
    error: "Error: synchronous provider failure",
  });
  await Bun.sleep(0);
});

test("late submission acknowledgment is emitted even after local timeout", async () => {
  const saved: unknown[] = [];
  let acknowledge!: (value: typeof batch & { status: "pending" }) => void;
  const result = await runProviderBatch({
    maxWaitMs: 10,
    onAccepted: (value) => saved.push(value),
    load: async () => ({
      ...operations(),
      start: () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    }),
  });
  expect(result).toMatchObject({ outcome: "local-timeout", phase: "submission" });
  acknowledge({ ...batch, status: "pending" });
  await Bun.sleep(0);
  expect(saved).toEqual([batch]);
});

test("status failures retain and emit the acknowledged reference", async () => {
  const saved: unknown[] = [];
  const result = await runProviderBatch({
    pollMs: 0,
    onAccepted: (value) => saved.push(value),
    load: async () => ({
      ...operations(),
      status: async () => {
        throw new Error("unauthorized");
      },
    }),
  });
  expect(saved).toEqual([batch]);
  expect(result).toMatchObject({
    outcome: "provider-error",
    phase: "status",
    batch,
    error: "Error: unauthorized",
  });
  expect(result.nextAction).toContain("do not submit a replacement");
});

test("resume fetches results without submitting and retains item failures", async () => {
  let starts = 0;
  const result = await runProviderBatch({
    batch,
    load: async () => ({
      ...operations(),
      start: async () => {
        starts++;
        throw new Error("must not submit");
      },
    }),
  });
  expect(starts).toBe(0);
  expect(result).toMatchObject({ outcome: "completed", batch, results: [failedItem] });
});

test("failed remote batch reports its provider error and never fetches results", async () => {
  const result = await runProviderBatch({
    batch,
    load: async () => ({
      ...operations(),
      status: async () => ({ status: "failed", error: { message: "batch rejected" } }),
      results: () => {
        throw new Error("must not fetch");
      },
    }),
  });
  expect(result).toMatchObject({
    outcome: "failed",
    status: { error: { message: "batch rejected" } },
    batch,
    results: [],
  });
});

test("result-stream failure preserves partial output and resumable reference", async () => {
  const result = await runProviderBatch({
    batch,
    load: async () => ({
      ...operations(),
      results: async function* () {
        yield failedItem;
        throw new Error("stream lost");
      },
    }),
  });
  expect(result).toMatchObject({
    outcome: "provider-error",
    phase: "results",
    batch,
    results: [failedItem],
    error: "Error: stream lost",
  });
});

for (const phase of ["submission", "status", "results"] as const) {
  test(`local deadline bounds stalled ${phase} and aborts the request`, async () => {
    let signal: AbortSignal | undefined;
    const stalled = (value: AbortSignal) => {
      signal = value;
      return new Promise<never>(() => {});
    };
    const result = await runProviderBatch({
      batch: phase === "submission" ? undefined : batch,
      maxWaitMs: 20,
      load: async () => ({
        ...operations(),
        ...(phase === "submission" ? { start: stalled } : {}),
        ...(phase === "status" ? { status: (_batch, value) => stalled(value) } : {}),
        ...(phase === "results"
          ? {
              results: async function* (_batch, value) {
                await stalled(value);
              },
            }
          : {}),
      }),
    });
    expect(result).toMatchObject({ outcome: "local-timeout", phase });
    expect(signal?.aborted).toBe(true);
    if (phase !== "submission") expect(result.batch).toEqual(batch);
  });
}

test("deadline interrupts the polling sleep before another request", async () => {
  let polls = 0;
  const result = await runProviderBatch({
    batch,
    maxWaitMs: 20,
    pollMs: 10_000,
    load: async () => ({
      ...operations(),
      status: async () => {
        polls++;
        return { status: "pending" };
      },
    }),
  });
  expect(polls).toBe(1);
  expect(result).toMatchObject({ outcome: "local-timeout", batch });
});

test("importing the teaching snippet launches no work", async () => {
  const child = Bun.spawn(["bun", "-e", 'await import("./src/snippets/04-batching.ts");'], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OPENAI_API_KEY: "", AI_GATEWAY_API_KEY: "" },
  });
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toBe("");
  expect(await new Response(child.stderr).text()).toBe("");
});
