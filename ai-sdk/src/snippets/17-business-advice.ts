import { runBusinessAdvice } from "../lib/business-advice";
import { exampleBrief } from "../lib/business-advice-profiles";

if (import.meta.main) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY to run this live example");
  const brief =
    process.argv
      .slice(2)
      .filter((arg) => arg !== "--")
      .join(" ") || exampleBrief;
  const started = Date.now();
  const result = await runBusinessAdvice(brief, undefined, AbortSignal.timeout(90000));
  console.log(JSON.stringify({ ...result, latencyMs: Date.now() - started }, null, 2));
}
