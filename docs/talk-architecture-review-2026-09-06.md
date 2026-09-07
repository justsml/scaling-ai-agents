# Talk architecture review, September 6, 2026

The current talks put bounded parallel generation inside a larger job architecture. A job has a quality floor, a tool policy, a budget, a deadline and evidence for its next transition. Fan-out is a choice inside one component. It can feed a race, synthesis, ranking or failure inspection. The selected artifact still needs independent checks.

## Source scope

This review covers the current canonical outlines, changed implementation contracts, execution-memory handout and new short talks in the sibling `dans-blog` checkout. The [source snapshot](talk-source-snapshot-2026-09-06.json) records the commit and exact working-tree hashes. It supersedes the earlier two reviews in this file. Source links open the public talk repository; no sibling checkout is required.

- [Adaptive systems](https://github.com/justsml/dans-blog/blob/main/artifacts/speaking-portfolio-expanded/outlines/adaptive-systems-40min.md) and [contracts](https://github.com/justsml/dans-blog/blob/main/artifacts/speaking-portfolio-expanded/packets/adaptive-systems/contracts.md).
- [Dynamic scaling](https://github.com/justsml/dans-blog/blob/main/artifacts/speaking-portfolio-expanded/outlines/dynamic-scaling-40min.md), [the live slides covering Barrel of Monkeys and Council of Guards](https://danlevy.net/talks/dynamic-scaling.html).
- [Judgment](https://github.com/justsml/dans-blog/blob/main/artifacts/speaking-portfolio-expanded/outlines/judgment-40min.md), [failure improvement](https://github.com/justsml/dans-blog/blob/main/artifacts/speaking-portfolio-expanded/outlines/failure-improvement-40min.md), and [product engineering](https://github.com/justsml/dans-blog/blob/main/artifacts/speaking-portfolio-expanded/outlines/product-engineering-40min.md).
- [Benchmarks](https://github.com/justsml/dans-blog/blob/main/artifacts/speaking-portfolio-expanded/outlines/benchmarks-40min.md), [retrieval](https://github.com/justsml/dans-blog/blob/main/artifacts/speaking-portfolio-expanded/outlines/retrieval-40min.md), [evidence learning](https://github.com/justsml/dans-blog/blob/main/artifacts/speaking-portfolio-expanded/outlines/evidence-learning-40min.md), and [free-tier economics](https://github.com/justsml/dans-blog/blob/main/artifacts/speaking-portfolio-expanded/outlines/free-tier-40min.md).

## Clarifications reflected in code

| Argument | Implementation |
| --- | --- |
| Keep only the job's needed read-to-action paths live | `10` grants a fixed read-and-propose tool set. `run-fixtures` requires logged discovery before invocation. Every input has a disposition. |
| Admission and unknown work survive callers and workers | `11` has SQLite transactions, tenant/request deduplication, dispatch intent, provider reconciliation, retained unknown reservations and a separate notification outbox. |
| Compute is requested through policy | `12` resolves a fixed execution catalog and binds billing identity from trusted context. It is a quote, not provisioning. |
| Memory records what happened | `13` distinguishes generated, executed, verified and unknown; observations retain context versions and correction references. |
| Judges expose disagreement | `14` separates verdict splits, reason overlap, missing votes and costs. Gate failures reject regardless of agreement. |
| Evaluate the measuring instrument | `15` demonstrates misleading agreement, incomplete retrieval judgments, explicit sampling assumptions and review queue delay. |
| Cheap generation is local, reversible and has a next stage | `16` defaults fan-out to one and demonstrates race, synthesis, rank and inspection. Framework variants use native orchestration and return one selected artifact. |

The new judgment passage permits many machine-generated drafts while limiting what reaches a human. `16` distinguishes candidate review capacity from the human slot for the selected result. Product engineering also asks for an owner of recurring compute spend and a hypothesis with an exposure count and stop rule. Its generated-interface/channel passages are predictions, not requirements to add more agents to these demos.

## Removed assumptions and patterns

LangChain `05` no longer prints a tournament and calls an unrelated shipped patch its winner. It uses one reference implementation as both live code and certification input. Its finite request vocabulary is only demo routing, and exact source bytes are required. A cached lookup flows through an uncached certification node. Deadline checks prevent a late successful probe from starting work.

Mastra `05` no longer deletes registry entries to manufacture a miss, dynamically registers a workflow it never needed, or prints a gate result after returning unchecked code. A native `createStep(tool)` workflow exercises the serving tool; the tool throws if certification fails or is cancelled. Existing persisted winners remain available. The shipped reference has no claimed tournament provenance.

AI SDK `05` already uses an explicit offline registry replay. All three compile demos now describe their actual behavior. Historical `PLAN.md` proposals are not current API guidance. Current package READMEs and [framework notes](fanout-node.md) replace the obsolete compile instructions.

## Claims that need evidence

More attempts can expose another failure, but they cannot guarantee detection of rare mistakes. Distinct profiles or model names do not establish independent errors. Council disagreement is a triage signal; agreement does not prove correctness. The four-word gate in `16` validates only its toy output contract.

Judge cost depends on input, output, reasoning, retries, number of judges and provider pricing. A thousand input tokens and fifty output tokens are not enough to establish that a council costs less than generation. Fixture cents are neither provider prices nor live billing evidence.

Ten tools have 45 unordered pairs. That count is not a measured inventory of directed read-to-write paths. An orchestrator needs explicit tool grants and execution checks regardless of how the pathway count is presented.

The dynamic-scaling contract still says lazy retry reservation can overshoot. That requires a missing atomic admission check or an inaccurate cost bound; lazy reservation alone does not imply overspend. `11` demonstrates the pessimistic alternative and retains unresolved commitments.

Review queue arithmetic is a teaching model with stated assumptions. Retrieval relevance does not establish answer sufficiency or authority. The zero-failure bound needs representative IID observations. Clinical and flight-simulation findings cited by the talks are not measurements of this repository's reviewers.

## Limits and verification

The tests check deterministic contracts and framework orchestration. They do not measure an LLM learning from memory, compare live fan-out against a single strong model, calibrate a council, or justify an automatic policy increase. The runtime adaptation loop still needs recorded per-class outcomes and a reviewed policy before widening budgets or authority. The offline failure-collection and tracker-routing loop is also outside these examples.

No provider calls, infrastructure provisioning, customer messages or tracker writes were made for this review. See [the fan-out eval contract](fanout-node.md) for acceptance, cost, latency and unknown-outcome measurements required for a live comparison.

Validation for this pass: 84 tests passed, comprising 51 contract tests, 19 LangChain tests, six Mastra tests and eight AI SDK tests. All four packages passed their TypeScript checks. Each framework's `16` ran with fan-out one and three; LangChain and Mastra `05`, scoped repair `10`, and contract `16` ran offline. Targeted formatting, `git diff --check`, local document links, copied contract equality and unchanged source hashes passed. Existing unrelated edits were preserved.
