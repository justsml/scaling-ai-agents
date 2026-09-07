// One bounded parallel node. Inject generateText for live one-shot generation.
import { generateText, type LanguageModel } from "ai";
import {
  attempt,
  fanoutCount,
  fixtureGenerate,
  inspect,
  planFanout,
  rank,
  type Generate,
} from "../lib/fanout-contract";

export const modelGenerator =
  (model: LanguageModel): Generate =>
  async (id, signal) => {
    const result = await generateText({
      model,
      prompt: "Return the four words: dedupe tenant notify deadline",
      maxRetries: 0,
      maxOutputTokens: 32,
      abortSignal: signal,
    });
    // Live output has no preference score and no verified price in this demo.
    return { id, text: result.text.trim(), score: 0, cents: null };
  };
export async function runFanoutNode(generate: Generate, count: number, signal: AbortSignal) {
  const plan = planFanout(count);
  const attempts = await Promise.all(
    Array.from({ length: plan.count }, (_, id) => attempt(id, generate, signal)),
  );
  return { plan, winner: rank(attempts), evidence: inspect(attempts) };
}
if (import.meta.main)
  console.log(await runFanoutNode(fixtureGenerate, fanoutCount(), AbortSignal.timeout(1000)));
