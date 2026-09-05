# LLM routing patterns: source review and repo gaps

Date: 2026-09-05

## Scope and conclusion

This note reviews Dan Levy's [*Don't Marry Your Model*](https://danlevy.net/llm-routing-mastra-ai/) as an architectural prompt, then checks its technical claims against current first-party documentation. It compares those findings with `shared/MODEL-ROUTER.md` and `shared/fixtures/router/*`. It does not assess a stack implementation.

The shared design has the right overall shape and is materially stronger than the article's introductory supervisor example: specialists, a cheap decision tier, deterministic rules, abstention, explicit fallback, separate route evaluation, and live monitoring. Four issues should be fixed before implementation:

1. The decision contract cannot validly express clarification or approval because `route` is always required.
2. The proposed A/B experiment changes both rules and router model, so its result is not attributable.
3. Rule precedence currently misroutes realistic phrases such as “why the deploy failed” and “summarize this stack trace.”
4. The implementation guidance must use Mastra's current supervisor/subagent API; the older agent-network `.network()` API is deprecated.

## Source-traced patterns

### 1. Route by specialization, not one default model

The article's central pattern is a stable catalog of specialists whose models remain replaceable. This is supported directly by Mastra: a parent agent accepts specialists through `agents`, and the parent uses its instructions plus each subagent's `description` to decide when and how to delegate. The current invocation is `Agent.generate()` or `Agent.stream()`. [Mastra: Subagents](https://mastra.ai/docs/subagents)

Actionable pattern:

- Give every specialist a narrow purpose, explicit return shape, allowed tools, and success criteria.
- Treat `description` as executable routing metadata, not documentation.
- Select the model behind each specialist using workload-specific evaluations; keep the route name stable when the winning model changes.

Mastra's unified model interface accepts `provider/model` strings, supports different models for different tasks, and permits dynamic selection from request context. [Mastra: Models](https://mastra.ai/models#mix-and-match-models) [Mastra: Request context](https://mastra.ai/docs/server/request-context)

### 2. Separate classification from execution

The article shows a semantic supervisor, while the shared design improves the seam by making the routing decision an independently scorable object. That separation is sound. Mastra structured output accepts a schema and returns typed, validated results, which is a better mechanism than instructing a model to “return only JSON” and parsing free text. [Mastra: Structured output](https://mastra.ai/docs/agents/structured-output)

Actionable pattern:

- Produce a validated routing outcome before invoking a specialist.
- Persist the outcome and the dispatch result as distinct trace events.
- Score route selection independently from specialist correctness.

The outcome should be a discriminated union, not a route with optional escape fields:

```ts
type RouterOutcome =
  | { action: 'route'; route: 'code' | 'long-context' | 'general'; confidence: number; reason: string; source: 'rule' | 'model' }
  | { action: 'clarify'; question: string; confidence: number; reason: string; source: 'policy' }
  | { action: 'approval'; reason: string; source: 'rule' }
```

This makes illegal states unrepresentable: a consequential request cannot accidentally carry a normal route, and a clarification cannot silently downgrade into dispatch.

### 3. Use a layered router

The shared rules-first design is a useful extension of the article:

1. deterministic bypasses for compiled/cached or consequential work;
2. deterministic rules for unambiguous, high-frequency cases;
3. a small semantic decision model for the remaining cases;
4. a policy gate that routes, clarifies, downgrades, or escalates;
5. specialist dispatch under budgets and tool limits.

Mastra provides supervisor delegation and dynamic model configuration, but it does not define this business policy. Rule ordering, confidence thresholds, approval bypasses, and escalation signals remain application code and require ordinary unit tests. Dynamic agent options can be resolved from `requestContext`, including models, tools, agents, workflows, and scorers. [Mastra: Request context](https://mastra.ai/docs/server/request-context#accessing-values-with-agents)

Actionable pattern:

- Make precedence explicit: `approval/compiled bypass > deterministic route > semantic decision > confidence policy > dispatch`.
- Treat model confidence as a policy input, not a calibrated probability, until calibration is measured.
- Clarify below the abstention floor; only downgrade in the band between the abstention floor and the route's acceptance threshold.
- Require a second signal for expensive escalation, such as known-hard classification or a failed bounded attempt.

### 4. Keep routing configuration centralized and replaceable

Mastra model strings, runtime model functions, and fallback arrays support a centralized model policy rather than provider choices scattered through callers. Its fallback chain can cross providers and assign separate retry counts and settings to each entry. It advances on server errors, rate limits, or timeouts. [Mastra: Model fallbacks](https://mastra.ai/models#model-fallbacks)

Actionable pattern:

- Resolve route-to-model mapping in one policy module.
- Keep model IDs, prompt version, rules version, and fallback chain in run metadata.
- Distinguish two mechanisms: a model fallback retries the same specialist contract; a route fallback chooses a different specialist and changes semantics.
- Prefer a different provider in the fallback chain when provider resilience is the goal.

Registering multiple agents alone does not provide failover. The fallback condition and resulting model must be observable and tested.

### 5. Evaluate the decision, path, and answer separately

Mastra scorers support rule-based, statistical, and model-graded evaluation, can run in CI, and can also be attached to live traffic with sampling. [Mastra: Evals](https://mastra.ai/docs/evals/overview) Gates require a score of `1.0`; thresholds can enforce minimum or maximum aggregate scores and produce a final verdict. [Mastra: Gates and verdicts](https://mastra.ai/docs/evals/gates-and-verdicts)

Actionable pattern:

- Decision: schema validity, expected route, forbidden route, abstention, escalation, and actual model cost class.
- Path: specialist invoked, allowed tools, retry/fallback sequence, caps, and evidence preservation.
- Answer: task correctness, faithfulness, and completeness within the chosen route.
- Operations: end-to-end latency, router overhead, token use, estimated cost, and failures by class.

Use deterministic checks whenever the expected behavior is mechanical. Reserve an LLM judge for cases with genuinely defensible alternatives, and give those cases accepted outcomes or a rubric rather than simultaneously treating one route as exact truth.

### 6. Version real cases and compare controlled experiments

Mastra datasets are versioned collections: each mutation creates a new version that can be reused for reproducible experiments. [Mastra: Datasets](https://mastra.ai/docs/evals/datasets) Experiments run dataset items through an agent, workflow, or scorer; persist results; and support comparison across prompts, models, or code changes. [Mastra: Experiments](https://mastra.ai/docs/evals/experiments)

Actionable pattern:

- Give every case a stable ID and provenance.
- Promote production failures, boundary cases, prompt injections, and provider failures into the dataset.
- Record the dataset version, prompt version, rules version, policy version, model ID, and provider for every run.
- Compare by route and failure cluster, not only by global average.
- Change one independent variable per comparison, or use a factorial experiment.

### 7. Monitor production invariants without pretending they are ground truth

Mastra live scorers run asynchronously and support ratio sampling. [Mastra: Live evaluations](https://mastra.ai/docs/evals/overview#live-evaluations) Mastra observability records the span hierarchy, model and tool interactions, timing, token counts, and estimated cost, which is enough to inspect the decision path and compare model or prompt changes. [Mastra: Observability](https://mastra.ai/docs/observability/overview)

Actionable pattern:

- Sample cheap invariants such as outcome-schema validity, forbidden dispatches, missing evidence, and fallback activation.
- Derive latency, usage, and cost from actual spans, not static model labels.
- Do not report production route accuracy without labels; use corrections, human review, or later outcomes as feedback signals.
- Because live scoring is asynchronous, verify it through persisted scorer results or a trace event rather than assuming completion when the response returns.

### 8. Route freshness-sensitive work to grounding, not merely a “general” model

The article recommends retrieval when freshness or citations matter. Google's first-party documentation describes search grounding as a way to use real-time web content and return citations, while File Search provides retrieval over private corpora. [Gemini API: Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search) [Gemini API: File Search](https://ai.google.dev/gemini-api/docs/file-search)

Actionable pattern:

- Model freshness/citation requirements as capabilities or guardrails, even if they do not become another top-level route.
- A factual request requiring current sources should not silently go to an ungrounded general agent.
- Score citation presence and source support separately from route accuracy.

## Coverage in the shared router design

| Pattern | Current coverage | Assessment |
| --- | --- | --- |
| Stable specialist routes with task-selected models | `MODEL-ROUTER.md` maps `code`, `long-context`, and `general` to model tiers | Covered in design; specialist descriptions and I/O contracts are not fixtures |
| Cheap semantic decision tier | Decision agent, nano class, temperature zero | Covered; schema validation is not specified as the execution mechanism |
| Deterministic tier before model | Ordered regex rules and rule-hit reporting | Covered, with precedence defects described below |
| Abstention and escalation | Per-route confidence floors, `clarifyBelow`, hard second signal | Partly covered; policy semantics conflict and confidence is uncalibrated |
| Consequential bypass | Two cases and a rule action bypass routing | Covered conceptually; not representable by the current `RouterDecision` type |
| Separate router evaluation | Validity, accuracy, forbidden-route, cost-class, ambiguity judge | Strong coverage; ambiguous scoring and actual-dispatch evidence need repair |
| Versioned experiments | Mastra native datasets; `.runs/` fallback with version metadata | Covered conceptually; JSON cases lack stable IDs and a dataset version |
| Production monitoring | Live validity scorer and route-level cost/latency report | Covered conceptually; async completion and required trace fields are unspecified |
| Failure taxonomy | Provider/harness, route, specialist, and budget labels | Covered; synthetic tests need precise evidence predicates |
| Provider failover | Explicit retry and alternate-provider preference | Covered in prose; fallback-chain schema is absent |
| Freshness/retrieval | Mentioned only indirectly in source article | Missing from routes, policy, cases, and scorers |

## Concrete implementation gaps

### P0 — resolve before building stack implementations

1. **Replace `RouterDecision` with a total outcome union.** The current type requires `route`, while `needsClarification` is supposed to stand in for a route and consequential fixtures use `route: null`. Use `route`, `clarify`, and `approval` variants. Validate the union at the decision boundary.

2. **Align the prompt, schema, and enrichment stages.** `decision-instructions.md` asks for only `route`, `confidence`, and `reason`, while the contract requires `source` and permits clarification. Either make the model emit the complete model-decision variant or document that trusted application code adds `source: 'model'` and applies clarification afterward. Do not parse ad hoc JSON when the framework supports schema-constrained output.

3. **Define confidence policy order.** `allowDowngrade: true` currently causes all low-confidence code and long-context decisions to downgrade, leaving `clarifyBelow` without a clear role. Specify: clarify below `0.4`; downgrade or reject from `0.4` to the route floor; accept at or above the floor. Add boundary tests at `0`, `0.399`, `0.4`, `0.699`, `0.7`, and `1`.

4. **Fix rule collisions and encode priority.** The consequential pattern matches any occurrence of `deploy`, so “Read these logs and tell me why the deploy failed” can bypass routing as consequential. The code rule includes `stack trace`, so “Turn this stack trace into a one-line summary” can route to code despite general ground truth. Use explicit priorities and intent-sensitive patterns, then test every rule against every case for both expected hits and forbidden hits.

5. **Repair the experiment design.** Run A (`rules off`, mini model) versus Run B (`rules on`, nano model) changes two variables. Use at least:

   - A: rules off, mini;
   - B: rules on, mini, to isolate the rules;
   - C: rules off, nano, to isolate the model;
   - D: rules on, nano, to measure the proposed production combination.

6. **Define evaluation populations.** Exact route accuracy should cover unambiguous route cases. Consequential cases should score approval bypass. Ambiguous cases should either declare `acceptedRoutes`, score abstention, or use the reasonableness rubric; counting a single route as exact truth and also calling the case ambiguous produces contradictory signals.

7. **Use the current Mastra API.** Build semantic delegation with supervisor subagents and `generate()`/`stream()`. Mastra explicitly deprecates Agent Networks and `.network()`. [Mastra: Agent Networks deprecation](https://mastra.ai/docs/agents/networks)

### P1 — required for a credible routing experiment

1. **Add stable case IDs and dataset metadata.** Add `id`, `datasetVersion`, and an annotation policy. Preserve `source`, but distinguish synthetic cases, captured production regressions, and article-derived examples.

2. **Do not confound decision with dispatch.** The cost-class scorer must consume the actual dispatched model/provider from a trace or execution envelope. A correct decision followed by the wrong specialist is a path failure, not a routing success.

3. **Add a trace contract.** At minimum record `caseId`, `outcome`, `ruleId`, `route`, `routerModel`, `specialistModel`, `provider`, `promptVersion`, `rulesVersion`, `policyVersion`, fallback attempts, usage, estimated cost, latency, and terminal failure label.

4. **Specify fallback chains as data.** `fallbackRouterModelClass: 'nano'` does not identify a provider, order, retry limit, or trigger. Store an ordered list of model/provider entries and test rate-limit, timeout, server-error, invalid-output, and exhausted-chain behavior. Invalid output is a contract failure and should not automatically be treated as provider outage.

5. **Add specialist and trajectory evaluation.** Route accuracy alone can reward a router that dispatches correctly to a broken specialist. Add per-route task contracts and path checks for invoked specialist, allowed tools, caps, and fallback sequence.

6. **Add adversarial and boundary cases.** Include mixed-intent requests, prompt injection aimed at the router, quoted imperative text, negation, multilingual inputs, very short inputs, oversized inputs, and requests that need current/cited information.

7. **Make cross-stack fixture copies auditable.** Since the design requires copying rather than importing shared fixtures, add a version/hash parity test so AI SDK, Mastra, and LangChain cannot silently evaluate different datasets or prompts.

8. **Pin framework versions for reproducibility.** The stack package files currently use `latest` for core Mastra and LangChain dependencies. Pin the versions used for the baseline so a rerun changes models or prompts intentionally, not framework behavior accidentally.

### P2 — useful after the first trustworthy baseline

1. Measure confidence calibration and report accuracy at different coverage levels before interpreting `confidence` numerically.
2. Add shadow routing so a candidate router can be compared without controlling production dispatch.
3. Feed corrected production failures back into the versioned dataset with privacy review and deduplication.
4. Decide whether freshness is a new route or a capability attached to routes; either way, add grounding and citation scorers.

## Recommended acceptance criteria

- Every input produces exactly one schema-valid outcome variant.
- Consequential requests never invoke the semantic router or a specialist.
- No deterministic rule fires on a fixture whose expected outcome forbids that action.
- Exact-route gates use only unambiguous cases; ambiguity and abstention have their own scores.
- Rule impact and model-tier impact are measured in separate comparisons.
- Every dispatch records the selected route, actual model/provider, usage, latency, and fallback attempts.
- Provider failures, route errors, specialist failures, contract failures, and budget stops are mutually exclusive terminal labels.
- Mastra uses supervisor subagents through `generate()`/`stream()`, not `.network()`.
- Fixture copies across stacks have matching versions or hashes.
- At least one freshness-sensitive case proves that a cited/grounded path is selected.
