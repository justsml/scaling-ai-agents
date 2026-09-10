/**
 * 06 — Model router (Mastra)
 *
 * Compare one model router with deterministic rules
 * off and on. Approval rules always stay on: a model
 * must never route a destructive request around human
 * review.
 *
 *   bun run snippet:06
 *
 * Up to two paid calls per fixture case. Needs
 * OPENAI_API_KEY.
 */
import {
  decide,
  loadDecisionInstructions,
  loadRouterCases,
  loadRules,
  mastraDecision,
  score,
} from "../lib/model-router.js";

const rules = await loadRules();
const cases = await loadRouterCases();
const instructions = await loadDecisionInstructions();

for (const experiment of [
  { name: "rules off", rules: false },
  { name: "rules on", rules: true },
]) {
  const route = mastraDecision(
    "openai/gpt-5.6-luna",
    instructions,
  );
  let correct = 0;

  for (const item of cases) {
    const outcome = await decide(
      item.input,
      rules,
      route,
      {
        rulesEnabled: experiment.rules,
      },
    );
    if (score(outcome, item.groundTruth).accurate)
      correct++;
  }

  console.log(
    `${experiment.name}: ${correct}/${cases.length} ` +
      `(model=openai/gpt-5.6-luna)`,
  );
}
