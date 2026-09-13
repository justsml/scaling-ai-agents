/** Offline by default; --live requires explicit --chair-model MODEL.
 * Run from ai-sdk: bun src/evals/council-placement.ts
 */
import {
  ask,
  advisorModel,
  runCouncil,
  type Ask,
} from "../snippets/12-business-advice";

const cases = [
  {
    id: "false-economy",
    brief:
      "Cut backups and monitoring to save $100 monthly on a revenue-critical system?",
  },
  { id: "missing-context", brief: "Should we grow?" },
  {
    id: "vendor-overlap",
    brief:
      "Two tools cost $300 and $500 monthly with overlapping but unspecified features. Which should we remove?",
  },
];

export async function comparePlacement(
  chairModel: string,
  call: Ask,
  evidence: "scripted" | "live",
  repeats = 3,
) {
  if (!Number.isInteger(repeats) || repeats < 1)
    throw new Error(
      "repeats must be a positive integer",
    );
  if (!chairModel.trim())
    throw new Error("Chair model is empty");
  const runs = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const fixture of cases) {
      // Alternate order to reduce systematic provider-load/order effects.
      const variants = [advisorModel, chairModel];
      if (repeat % 2) variants.reverse();
      for (const chair of variants) {
        const calls: {
          role: string;
          model: string;
          latencyMs: number;
          inputTokens: number | null;
          outputTokens: number | null;
          error: string | null;
          output: string | null;
        }[] = [];
        const pending: Promise<unknown>[] = [];
        const started = performance.now();
        let result: Awaited<
          ReturnType<typeof runCouncil>
        > | null = null;
        let error: string | null = null;
        try {
          result = await runCouncil(
            fixture.brief,
            AbortSignal.timeout(90_000),
            (role, prompt, signal) => {
              const operation = (async () => {
                const start = performance.now();
                let usage: {
                  inputTokens?: number;
                  outputTokens?: number;
                } = {};
                let failure: string | null = null;
                let output: string | null = null;
                try {
                  output = await call(
                    role,
                    prompt,
                    signal,
                    (value) => {
                      usage = value;
                    },
                  );
                  return output;
                } catch (err) {
                  failure = String(err);
                  throw err;
                } finally {
                  calls.push({
                    role: role.id,
                    model: role.model ?? advisorModel,
                    latencyMs:
                      performance.now() - start,
                    inputTokens:
                      usage.inputTokens ?? null,
                    outputTokens:
                      usage.outputTokens ?? null,
                    error: failure,
                    output,
                  });
                }
              })();
              pending.push(operation);
              return operation;
            },
            "synthesize",
            chair,
          );
        } catch (err) {
          error = String(err);
        }
        await Promise.allSettled(pending);
        runs.push({
          caseId: fixture.id,
          brief: fixture.brief,
          repeat,
          chairModel: chair,
          evidence,
          latencyMs: performance.now() - started,
          calls,
          providerCostUsd: null,
          semanticQuality: null,
          structuralPass:
            result?.mode === "synthesize" &&
            result.recheck.passed,
          result,
          error,
        });
      }
    }
  }
  return {
    evidence,
    note: "Scripted results test wiring only. Semantic quality requires blinded rubric review; dollar cost requires reconciled provider charges. Missing usage is unknown, never zero.",
    runs,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const chairIndex = args.indexOf("--chair-model");
  const chair =
    chairIndex === -1
      ? undefined
      : args[chairIndex + 1];
  if (live && (!chair || chair.startsWith("--")))
    throw new Error(
      "--live requires --chair-model MODEL; runs 72 paid calls at most (18 councils)",
    );
  const scripted: Ask = async (role) =>
    role.id.startsWith("chair-")
      ? JSON.stringify({
          baseId: "operator",
          compatibleSourceIds: [],
          advice:
            "Scripted placeholder; no quality evidence.",
        })
      : "Scripted proposal";
  console.log(
    JSON.stringify(
      await comparePlacement(
        chair ?? "scripted-chair",
        live ? ask : scripted,
        live ? "live" : "scripted",
      ),
      null,
      2,
    ),
  );
}
