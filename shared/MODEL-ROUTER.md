# Snippet 09: the model router pattern

Source articles (Dan Levy, danlevy.net): *Don't Marry Your Model* (2026-01), *Don't Fear the Model Router* (2026-07), *Security Agents Need Model Routers, Not Model Rankings* (2026-06, draft). Every stack implements this the same way so the three snippets compare. Copy the fixtures in `shared/fixtures/router/` into `<stack>/src/fixtures/router/`; do not import.

## The pattern in one paragraph

Specialists are agents with a `description` and a model chosen by evals, not by a leaderboard. A small, cheap **decision agent** emits only a structured route candidate. Deterministic lexical rules run **before** that agent. Trusted policy turns the candidate into exactly one `RouterOutcome`: route, clarification, or approval. Expensive routes need higher confidence or a second signal; low-confidence ambiguous requests ask a clarifying question instead of guessing. The decision, dispatch path, and answer are scored separately. Provider failures are labelled as harness failures, never as route errors, and fallback is explicit data, ideally crossing providers.

## The contract

```ts
type Route = 'code' | 'long-context' | 'general'
type RouterOutcome =
  | { action: 'route'; route: Route; confidence: number; reason: string; source: 'rule' | 'model' }
  | { action: 'clarify'; question: string; confidence: number; reason: string; source: 'policy' }
  | { action: 'approval'; reason: string; source: 'rule' }
```

Route to specialist mapping for this repo's task:

| Route | Specialist here | Model tier | Bad route example |
| --- | --- | --- | --- |
| `code` | the readiness-patch competitor (from 01 Compete, single profile) | mini, escalate to frontier on `confidence >= 0.85 && hard` | log summarization |
| `long-context` | the incident evidence reviewer (from 02 Decompose) | mini with large context | "format this JSON" |
| `general` | status lookup / short summarization | nano | fixing a failing test |

Every input produces exactly one validated variant. Consequential work is not a route: matching requests bypass both the semantic router and specialists and produce `action: 'approval'`.

## Tiers, in order

1. **Approval/compiled bypass.** Ordered rules have explicit priority. Approval intent must be imperative and target `main`, `production`, or `prod`; diagnostic text that merely mentions a failed deploy is not consequential.
2. **Deterministic routes.** Regex and keyword rules produce `action: 'route'`, `source: 'rule'`, `confidence: 1`. Any handled case never reaches the model; print the hit rate and rule ID.
3. **Decision agent.** Structured output only, instructions taken verbatim from `fixtures/router/decision-instructions.md`. The model emits `route`, `confidence`, and `reason`; trusted code validates it and adds the action/source fields. Use the cheapest evaluated model at temperature zero.
4. **Confidence policy.** Clarify below `clarifyBelow`. From that boundary up to the route floor, downgrade to `general` when allowed, otherwise clarify. Accept at or above the route floor. Boundary tests cover `0`, `0.399`, `0.4`, `0.699`, `0.7`, and `1`.
5. **Dispatch.** Invoke the specialist under the 03 ledger and caps. Never escalate on confidence alone: frontier escalation also requires `hard` or a failed bounded attempt.
4. **Dispatch** to the specialist, with the 03 ledger and caps.

## Scoring (the part that makes it a hypothesis, not a dispatch table)

Deterministic, no model:
- `valid-router-json`: exactly one outcome variant validates; route confidence is in [0,1] and reasons are non-empty.
- `route-accuracy`: on unambiguous route cases only, decision.route equals `groundTruth.route`.
- `forbidden-route`: 0 if the request hit a route listed in groundTruth.forbidden.
- `approval-bypass`: consequential cases produce approval and invoke neither router model nor specialist.
- `cost-class`: 0 if an actual `general` dispatch used a non-nano model. Read the dispatched model/provider from trace evidence, not the intended route.

LLM judge, ambiguous items only (`groundTruth.ambiguous: true`): deterministic acceptance first checks `acceptedRoutes`; `route-reasonableness` judges the explanation only when multiple outcomes remain defensible.

Thresholds that end the run with a non-zero exit: `valid-router-json < 1`, `route-accuracy < 0.9`, any `forbidden-route` hit.

Report by route, not by average: a per-route table of accuracy, cost, latency, and the failure cluster.

## Dataset and experiment

`fixtures/router/dataset.json` identifies dataset version `router-cases-2026-09-05.2`; `cases.json` contains 16 stable IDs—ten exact-route cases, four cases with `acceptedRoutes`, and two approval cases. Preserve the case ID and provenance in every trace and promoted regression.

Use a 2×2 comparison so rules and model class are independently attributable: A = rules off/mini, B = rules on/mini, C = rules off/nano, D = rules on/nano. Print all four by route plus rule hit rate. Where the stack has native datasets and experiments (Mastra), use current versioned datasets and experiments; invoke supervisor/subagents through `generate()` or `stream()`—never the deprecated `.network()` API. Elsewhere, persist equivalent JSON under `.runs/`. Record dataset, prompt, rules, policy, router model/provider, specialist model/provider, fallback attempts, usage, cost, latency, and terminal failure label.

## Live scorer

Attach `valid-router-json` to the production decision path with sampling rate 1 (Mastra: `scorers` on the Agent; AI SDK: `onFinish`/middleware; LangChain: callback handler). Persist or trace scorer completion because live scoring can be asynchronous. Live scoring cannot measure route accuracy without labels; corrections and later outcomes become versioned evaluation cases.

## Routing policy table and failure policy

Print a policy table like the security article's: route, primary model, use for, guardrail, and the measured cost and latency from this run. Then apply the failure policy when classifying any error:

| Label | Test | Never confuse with |
| --- | --- | --- |
| provider/harness failure | HTTP or timeout error, zero usage, empty stream | model capability |
| route error | valid decision, wrong route | specialist quality |
| specialist failure | right route, failed contract | route error |
| budget stop | ledger or deadline fired | any of the above |

Fallback: follow `policy.routerFallbacks` only for timeout, rate-limit, or server errors. Prefer a different provider slot. Invalid structured output is a contract failure, not automatically a provider outage. Model fallback retries the same specialist contract; route fallback changes semantics and must be recorded separately.

Every stack now has a native model-fallback mechanism, and every one of them is configuration executed by the harness, never a supervisor or subagent deciding to retry: Mastra `model: ModelWithRetries[]` on the Agent, LangChain `modelFallbackMiddleware` on `createAgent`, AI SDK via AI Gateway `providerOptions.gateway.models`. Use the native one for model fallback and record the attempt trail on the span yourself where the stack does not (only AI Gateway returns `modelAttempts`). Keep a run-level cap over the whole chain: per-entry `maxRetries` bounds one model, not the chain. Escalation on a contract failure (mini fails structured output twice, hand to frontier) is a route change and may involve the decision agent; a 503 never should.

## Output

One screen: tier hit counts, per-route accuracy table for runs A and B, the threshold verdicts, the policy table, the failure-policy label counts, total cost.

## Verification

- Unit tests: every fixture has a stable ID; rule priority produces no forbidden collision; confidence boundaries behave exactly; outcome variants reject illegal states; deterministic scorers cover route, approval, cost, and failure labels; copied fixture hashes match shared.
- The snippet runs under `--budget-usd 0.05` and prints both runs.
