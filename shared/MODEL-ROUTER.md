# Snippet 08: the model router pattern

Source articles (Dan Levy, danlevy.net): *Don't Marry Your Model* (2026-01), *Don't Fear the Model Router* (2026-07), *Security Agents Need Model Routers, Not Model Rankings* (2026-06, draft). Every stack implements this the same way so the three snippets compare. Copy the fixtures in `shared/fixtures/router/` into `<stack>/src/fixtures/router/`; do not import.

## The pattern in one paragraph

Specialists are agents with a `description` and a model chosen by evals, not by a leaderboard. A small, cheap **decision agent** does nothing but emit a structured `RouterDecision`. Deterministic lexical rules run **before** the decision agent and take a growing share of traffic over time. Expensive routes need higher confidence or a second signal; low-confidence ambiguous requests ask a clarifying question instead of guessing. The decision is scored separately from the answer: deterministic scorers for valid JSON and route accuracy, an LLM judge only for reasonableness on ambiguous cases, thresholds that fail the run, a versioned dataset with experiments, and a cheap live scorer on the production path. Provider failures are labelled as harness failures, never as route errors, and fallback is explicit code, ideally with the fallback router on a different provider.

## The contract

```ts
type Route = 'code' | 'long-context' | 'general'
type RouterDecision = {
  route: Route
  confidence: number        // 0..1
  reason: string            // cites task signals, not vibes
  source: 'rule' | 'model'  // which tier decided
  needsClarification?: string // set instead of route when confidence < floor on an ambiguous request
}
```

Route to specialist mapping for this repo's task:

| Route | Specialist here | Model tier | Bad route example |
| --- | --- | --- | --- |
| `code` | the readiness-patch competitor (from 01 Compete, single profile) | mini, escalate to frontier on `confidence >= 0.85 && hard` | log summarization |
| `long-context` | the incident evidence reviewer (from 02 Decompose) | mini with large context | "format this JSON" |
| `general` | status lookup / short summarization | nano | fixing a failing test |

`consequential` is not a route. Requests matching the consequential rules bypass the router and go to the approval path from 00.

## Tiers, in order

1. **Rules.** Regex and keyword rules over the request text produce a decision with `source: 'rule'`, `confidence: 1`. Rules live in `fixtures/router/rules.json`. Any case a rule handles is a case the model never sees; the printout shows the rule hit rate.
2. **Decision agent.** Structured output only, instructions taken verbatim from `fixtures/router/decision-instructions.md`. Cheapest model in the pool. `temperature: 0`.
3. **Confidence gate.** `fixtures/router/policy.json` gives per-route `minConfidence` and `costClass`. Below the floor on `code` or `long-context`, downgrade to `general` if `policy.allowDowngrade`, else return `needsClarification`. Never escalate on confidence alone; escalation to the frontier model needs a second signal (a rule flag such as `hard`, or a failed first attempt).
4. **Dispatch** to the specialist, with the 03 ledger and caps.

## Scoring (the part that makes it a hypothesis, not a dispatch table)

Deterministic, no model:
- `valid-router-json`: route is one of three, confidence in [0,1], reason non-empty.
- `route-accuracy`: decision.route equals groundTruth.route.
- `forbidden-route`: 0 if the request hit a route listed in groundTruth.forbidden.
- `cost-class`: 0 if a `general`-truth request was served by a non-nano model.

LLM judge, ambiguous items only (`groundTruth.ambiguous: true`): `route-reasonableness`, rubric in `fixtures/router/reasonableness-rubric.md`, returns `{ score, rationale }`.

Thresholds that end the run with a non-zero exit: `valid-router-json < 1`, `route-accuracy < 0.9`, any `forbidden-route` hit.

Report by route, not by average: a per-route table of accuracy, cost, latency, and the failure cluster.

## Dataset and experiment

`fixtures/router/cases.json`: 16 items with `input`, `groundTruth: { route, forbidden?, ambiguous?, hard?, source }`. Ten are clear, four are ambiguous, two are consequential (must never reach a route).

Run A: rules off, decision agent on the mini model. Run B: rules on, decision agent on the nano model. Print both, compare by route, and print the rule hit rate. Where the stack has native datasets and experiments (Mastra), use them and record `metadata: { routerModel, promptVersion, rulesVersion }`. Elsewhere, persist runs as JSON under `.runs/` with the same fields so the compare step is identical.

## Live scorer

Attach `valid-router-json` to the production decision path with sampling rate 1 (Mastra: `scorers` on the Agent; AI SDK: `onFinish`/middleware; LangChain: callback handler). Print that it fired. State in a comment that live scoring cannot measure route accuracy because production has no ground truth.

## Routing policy table and failure policy

Print a policy table like the security article's: route, primary model, use for, guardrail, and the measured cost and latency from this run. Then apply the failure policy when classifying any error:

| Label | Test | Never confuse with |
| --- | --- | --- |
| provider/harness failure | HTTP or timeout error, zero usage, empty stream | model capability |
| route error | valid decision, wrong route | specialist quality |
| specialist failure | right route, failed contract | route error |
| budget stop | ledger or deadline fired | any of the above |

Fallback: if the decision agent's provider fails, retry once on the fallback router model (a different provider slot when `LOCAL_OPENAI_BASE_URL` or a second key exists, otherwise the nano model with a note that same-provider fallback is not resilience).

## Output

One screen: tier hit counts, per-route accuracy table for runs A and B, the threshold verdicts, the policy table, the failure-policy label counts, total cost.

## Verification

- Unit tests: rules match every clear case; confidence gate downgrades and clarifies correctly; the four deterministic scorers on hand-written decisions; failure-policy labeller on four synthetic errors.
- The snippet runs under `--budget-usd 0.05` and prints both runs.
