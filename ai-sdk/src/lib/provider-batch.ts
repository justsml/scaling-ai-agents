import {
  experimental_startTextBatch as startBatch,
  experimental_getBatchStatus as getStatus,
  experimental_getBatchResults as getResults,
  type Experimental_BatchReference as BatchReference,
  type Experimental_BatchStatus as BatchStatus,
  type Experimental_TextBatchItemResult as BatchItem,
} from "ai";
import { setTimeout as sleep } from "node:timers/promises";

interface BatchOperations {
  start(
    signal: AbortSignal,
  ): Promise<BatchReference & BatchStatus>;
  status(
    batch: BatchReference,
    signal: AbortSignal,
  ): Promise<BatchStatus>;
  results(
    batch: BatchReference,
    signal: AbortSignal,
  ): AsyncIterable<BatchItem>;
}

async function loadGateway(): Promise<BatchOperations> {
  const { gateway } = await import("@ai-sdk/gateway");
  const model = () => gateway("openai/gpt-5.6-luna");
  return {
    start: (abortSignal) =>
      startBatch({
        model: model(),
        abortSignal,
        requests: [
          { id: "one", prompt: "Say one." },
          { id: "two", prompt: "Say two." },
        ],
      }),
    status: (batch, abortSignal) =>
      getStatus({
        model: model(),
        batch,
        abortSignal,
        maxRetries: 0,
      }),
    results: (batch, abortSignal) =>
      getResults({
        model: model(),
        batch,
        abortSignal,
        maxRetries: 0,
      }),
  };
}

/** Ending the local wait never cancels the provider's durable batch. */
export async function runProviderBatch({
  batch: resumeBatch,
  maxWaitMs = 30_000,
  pollMs = 2_000,
  load = loadGateway,
  onAccepted = (batch: BatchReference) =>
    console.log(
      "batch reference (save to resume)",
      JSON.stringify(batch),
    ),
}: {
  batch?: BatchReference;
  maxWaitMs?: number;
  pollMs?: number;
  load?: () => Promise<BatchOperations>;
  onAccepted?: (batch: BatchReference) => void;
} = {}) {
  if (
    !Number.isFinite(maxWaitMs) ||
    maxWaitMs <= 0 ||
    !Number.isFinite(pollMs) ||
    pollMs < 0
  )
    throw new Error("invalid local batch wait limits");
  let operations: BatchOperations;
  try {
    operations = await load();
  } catch (error) {
    return {
      outcome: "load-error",
      error: String(error),
      reason:
        "Could not load @ai-sdk/gateway; check the reported import error.",
    };
  }

  let batch = resumeBatch;
  let status: BatchStatus | undefined;
  const results: BatchItem[] = [];
  const controller = new AbortController();
  const { signal } = controller;
  const deadline = setTimeout(
    () =>
      controller.abort(
        new Error("local batch wait deadline reached"),
      ),
    maxWaitMs,
  );
  // Also bound local waiting if a provider fails to settle after abort.
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(signal.reason),
      { once: true },
    );
  });
  // A synchronous provider error can occur before the first race is attached.
  void aborted.catch(() => {});
  const wait = <T>(
    pending: PromiseLike<T>,
  ): Promise<T> => Promise.race([pending, aborted]);
  let phase = batch ? "status" : "submission";
  try {
    if (!batch) {
      const started = await wait(
        operations.start(signal).then((accepted) => {
          batch = {
            version: accepted.version,
            type: accepted.type,
            id: accepted.id,
            provider: accepted.provider,
            modelId: accepted.modelId,
          };
          // Preserve even a late acknowledgment if an adapter ignores abort.
          onAccepted(batch);
          return accepted;
        }),
      );
      batch = {
        version: started.version,
        type: started.type,
        id: started.id,
        provider: started.provider,
        modelId: started.modelId,
      };
      status = started;
    }
    phase = "status";
    if (!status)
      status = await wait(
        operations.status(batch, signal),
      );
    while (status.status === "pending") {
      await wait(sleep(pollMs, undefined, { signal }));
      status = await wait(
        operations.status(batch, signal),
      );
    }
    if (status.status === "completed") {
      phase = "results";
      const iterator = operations
        .results(batch, signal)
        [Symbol.asyncIterator]();
      try {
        while (true) {
          const item = await wait(iterator.next());
          if (item.done) break;
          results.push(item.value);
        }
      } finally {
        // Do not let a stalled iterator's cleanup extend the local deadline.
        void iterator.return?.().catch(() => {});
      }
    }
    return {
      outcome: status.status,
      batch,
      status,
      results,
    };
  } catch (error) {
    return {
      outcome: signal.aborted
        ? "local-timeout"
        : "provider-error",
      phase,
      batch,
      status,
      results,
      error: String(error),
      nextAction: batch
        ? "Save this batch reference and resume status/results retrieval; do not submit a replacement. Local exit does not cancel remote work."
        : "Submission outcome is unknown. Inspect provider records before retrying; a lost acknowledgment may hide accepted work.",
    };
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
}
