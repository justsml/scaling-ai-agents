# Plan: Mastra implementation

Implements `../shared/TASK.md` on Mastra. APIs below were checked against `@mastra/core@1.34.0` embedded docs and https://mastra.ai/llms.txt on 2026-09-05. Re-verify each import before writing it; the framework changes weekly. A reference copy of the Mastra skill with lookup scripts is at `/Users/dan/code/oss/dans-blog/.claude/skills/mastra/` (read-only, do not import from it).

## Stack

- `@mastra/core`, `@mastra/libsql`, `@mastra/memory`, `@mastra/evals`, `@mastra/client-js`, `mastra` (CLI), `zod`
- Storage: `LibSQLStore({ id: 'lab', url: 'file:./mastra.db' })`, gitignored
- Observability: `new Observability({ configs: { default: { serviceName: 'agentic-parallelism-mastra', requestContextKeys: ['requestId','profile','region','dataClass'], exporters: [new MastraStorageExporter()] } } })`
- Models via the router string form. Default `openai/gpt-5.4-mini` for workers, `openai/gpt-5.4-nano` for the cheap judge steps, `openai/gpt-5.4` as the one "frontier" competitor. Read `MODEL_*` env overrides. Local slot: `LOCAL_OPENAI_BASE_URL`; when unset the local competitor is skipped and the ledger says so.
- tsconfig: ES2022, module ES2022, moduleResolution bundler. Bun runs the scripts directly.

## Layout

```
mastra/
├── PLAN.md  README.md  package.json  tsconfig.json  .env.example  presets.json
├── src/
│   ├── mastra/index.ts          Mastra instance (storage, observability, backgroundTasks, agents, workflows, scorers, server middleware)
│   ├── fixtures/                copied from ../shared/fixtures at setup (bun run setup)
│   ├── lib/                     extracted biggest-first: ledger.ts, sandbox.ts, judge.ts, profiles.ts, a2a.ts, print.ts
│   └── snippets/
│       ├── 00-router.ts
│       ├── 01-compete.ts
│       ├── 02-decompose.ts
│       ├── 03-constrain.ts
│       ├── 04-distribute.ts
│       ├── 05-compile.ts
│       ├── 06-remote-a2a.ts
│       └── 07-batching.ts
└── test/                        bun tests for lib/ (ledger, sandbox, router classifier, judge table)
```

`bun run setup` copies fixtures. `bun run all` runs 00 to 07 with `--budget-usd 0.25 --deadline-ms 90000` total. `bun run dev` starts `mastra dev --request-context-presets ./presets.json` for Studio.

## Snippet designs

**00 Router.** Deterministic classifier (`lib/router.ts`): regex and keyword rules over `requests.json` produce `{ class, strategy, caps, scopes }` as a zod-validated contract. Executor validates the contract, then dispatches: lookup runs `statusTool` directly with no agent; routine calls one `Agent` with `maxSteps: 3`; novel hands the contract to the tournament workflow; consequential hits a `requireApproval: true` tool and the script prints the `tool-call-approval` chunk and declines with a reason. Show that the planner proposes and the validator accepts. Span metadata: `strategyVersion`, `reason`.

**01 Compete.** `lib/profiles.ts` defines four competitors: three instruction profiles on the mini model plus one on the frontier model. Each is an `Agent` with one tool, `proposePatch`, whose output schema is `{ patch: string }` (full file contents of readiness.ts). Fan out with `Promise.allSettled`, each call carrying `abortSignal`, `requestContext` (`profile`), and `tracingOptions.metadata`. `lib/sandbox.ts` writes each candidate to a temp dir with the test file and runs `bun test --timeout 2000` in a child process; parse pass/fail counts. Survivors go to `rubricJudge`, a `createScorer` with a prompt-object `analyze` step whose `createPrompt` embeds `rubric.md` verbatim, and a function `generateScore`. Print the table. Pick by tests first, rubric second, cost third. One child span per competitor with `profile`, `costUsd`, `latencyMs`, `outcome`, `whyItExisted`.

**02 Decompose.** `createWorkflow` with `.parallel([networkStep, appStep, stateStep])` then `.then(reviewerStep)`. Each step is an `Agent` call with a tool that reads only its own log file (tool `inputSchema` fixes the path; the tool refuses other paths). Reviewer agent gets the three artifacts and the instruction to find evidence against the favored hypothesis; score against `ground-truth.md` with a function scorer that checks both causes are named. Then the same thing as a supervisor agent (`agents: { network, app, state }`) to show the tradeoff: the workflow is explicit and cheap to trace; the supervisor decides the split at runtime and costs more. Merge record printed as JSON: which artifacts, which reviewer verdict, which files were touched by whom.

**03 Constrain.** Re-run 01 under `lib/ledger.ts`: `reserve(profile, estimateUsd)` before dispatch, throws `BudgetExhausted` if the sum would exceed `--budget-usd`; `reconcile(profile, usage)` after, using `prices.json`. Deadline via `AbortSignal.timeout(deadlineMs)` passed as `abortSignal`, plus `modelSettings.timeout: { totalMs, stepMs }` on each agent call so the SDK enforces it too. Catch `MastraTimeoutError` and abort errors, record `billedAnyway` from whatever usage came back. Consequential path: `applyPatchTool` with `requireApproval: true`; the script shows the approval chunk and that budget remaining does not auto-approve. Print ledger and stop reason. Run twice: once generous, once at `0.02` USD to show an honest stop with partial artifacts.

**04 Distribute.** Provider pool in `lib/pool.ts`: entries `{ id, model, region: ['us','eu'], dataClasses: ['public','internal','restricted'], kind: 'cloud'|'local' }`. Filter by the request's `region` and `dataClass` in code before any call; a `restricted` + `eu` request must resolve to the local slot or fail with a clear reason. Model chosen per competitor through `model: ({ requestContext }) => ...` on the `Agent`. Fallback: pass `models` array where the generate options support it (verify in the `generate` reference; if not present in this version, implement fallback in code and say so). One competitor runs remotely via `06`'s A2A server: start it as a child process on port 4112, call it through `MastraClient.getA2A('competitor-remote').sendMessageStream(...)`, and stream task events into the same span tree. Print: per worker, which provider and why.

**05 Compile.** Take the 01 winner's patch. Register `compiledReadinessTool` (a `createTool` that applies the known transformation, or returns the stored patch keyed by a hash of the buggy file) with the fixture tests as its contract. Persist a dynamic workflow via `mastra.addDynamicWorkflow({ graph: [{ type: 'tool', id: 'apply', toolId: 'compiled-readiness' }] })` to LibSQL. Router now checks the compiled registry first. Run request `r4`: first time tournament, second time zero model calls. Include the negative case: a different buggy file with a similar error message must not match. Gate with `runEvals({ target: compiledTool wrapper, gates: [checks.noToolErrors()], scorers: [fixturePassScorer] })`.

**06 Remote A2A.** A second Mastra instance file `src/remote/index.ts` with one agent `competitor-remote`. Start with `mastra dev --port 4112` (or `mastra build && node`); the snippet spawns it, waits for `/.well-known/competitor-remote/agent-card.json`, prints the card, sends `message/stream`, prints status and artifact events, calls `tasks/cancel` on a second long task, and shuts down. Document what the card hides: tools, memory, prompt.

**07 Batching.** Three parts. (a) One agent turn with a tool `probeService` that the model calls several times in one step; execute concurrently with a semaphore of 3 in the tool wrapper and show timing. (b) `.foreach()` over the fixture list in a workflow with the concurrency option if the installed version supports it (check control-flow docs); otherwise a bounded pool in code. (c) `backgroundTasks: { enabled: true, globalConcurrency: 4, perAgentConcurrency: 2, backpressure: 'queue' }` on the Mastra instance with a background-eligible tool and `streamUntilIdle()` to show queued fan-out. Provider batch APIs are not part of the Mastra router; say so.

## Verification

- `bun run check` clean.
- `bun test` covers ledger math, sandbox pass/fail parsing on the buggy fixture (expect 2 pass, 3 fail), router classification of all six requests, judge tie-break order.
- `bun run all` completes with the OpenAI key; every snippet prints its table; total spend printed at the end.
- Studio shows one trace per snippet with per-worker spans carrying `profile`, `costUsd`, `latencyMs`, `outcome`, `whyItExisted`.

## Known gaps to state in README

Agent networks are deprecated in favor of supervisor agents; use supervisors. Costs are estimates from usage and `prices.json`. A2A push notifications are not exercised. Temporal and Inngest runners exist for durable execution and are referenced, not used.
