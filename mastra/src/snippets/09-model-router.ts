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
const model = mastraDecision(
  "openai/gpt-5.6-luna",
  instructions,
);
for (const c of [
  { name: "A", on: false, modelClass: "mini-policy" },
  { name: "B", on: true, modelClass: "mini-policy" },
  { name: "C", on: false, modelClass: "nano-policy" },
  { name: "D", on: true, modelClass: "nano-policy" },
]) {
  let good = 0;
  for (const item of cases) {
    const outcome = await decide(
      item.input,
      rules,
      model,
      { rulesEnabled: c.on },
    );
    if (score(outcome, item.groundTruth).accurate)
      good++;
  }
  console.log(
    `${c.name}: ${good}/${cases.length} (${c.modelClass}, rules=${c.on}, model=openai/gpt-5.6-luna, reasoning=none)`,
  );
}
