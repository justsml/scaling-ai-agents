/**
 * 09 — Model router (AI SDK)
 *
 * Compare the same model router with deterministic
 * rules off and on. Approval rules always stay on: a
 * model must never route a destructive request around
 * human review.
 *
 *   bun run snippet:09
 *
 * Up to two paid calls per fixture case. Needs
 * OPENAI_API_KEY.
 */
import casesFixture from "../fixtures/router/cases.json";
import {
  createAiSdkDecisionAgent,
  type Route,
  routeRequest,
} from "../lib/model-router";

type RouterCase = {
  input: string;
  groundTruth: {
    route?: Route;
    acceptedRoutes?: Route[];
    preferredRoute?: Route;
    action?: "approval";
  };
};

const instructions = await Bun.file(
  new URL(
    "../fixtures/router/decision-instructions.md",
    import.meta.url,
  ),
).text();
const cases = casesFixture as RouterCase[];

for (const experiment of [
  { name: "rules off", rules: false },
  { name: "rules on", rules: true },
]) {
  const decide = createAiSdkDecisionAgent({
    instructions,
    modelId: "openai/gpt-5.6-luna",
  });
  let correct = 0;

  for (const item of cases) {
    const { outcome } = await routeRequest(
      item.input,
      decide,
      { rulesEnabled: experiment.rules },
    );
    const expected = item.groundTruth;
    if (
      (expected.action === "approval" &&
        outcome.action === "approval") ||
      (outcome.action === "route" &&
        (expected.acceptedRoutes?.includes(
          outcome.route,
        ) ??
          outcome.route ===
            (expected.route ??
              expected.preferredRoute)))
    )
      correct++;
  }

  console.log(
    `${experiment.name}: ${correct}/${cases.length} ` +
      `(model=openai/gpt-5.6-luna)`,
  );
}
