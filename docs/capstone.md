# Capstone: compose the narrow contracts

The repository no longer has one oversized router example. A production request crosses several independently testable boundaries, and the smaller examples make those boundaries easier to inspect.

## One request through the system

1. **Route by policy.** Example `09` compares model routing with deterministic rules disabled and enabled. Routing chooses a lane; it does not authorize spending or tools.
2. **Admit bounded work.** Example `03` sets the call count and one shared deadline before dispatch.
3. **Decompose and place.** Example `02` gives independent evidence to explicitly selected worker lanes, runs those branches concurrently, and joins them into one report.
4. **Gate generated artifacts.** Example `16` keeps failed branches isolated and ranks only drafts that pass the independent fixture gate.
5. **Select or synthesize.** Example `17` shows both endings. Selection returns one proposal unchanged. Synthesis creates a new artifact that must pass a fresh check.
6. **Reserve and recover durably.** Example `11` resolves requested compute, reserves it atomically with the job, and retains unresolved provider work across restarts.
7. **Measure the evaluators.** Example `14` keeps deterministic gates above model votes and reports disagreement, missing evidence, calibration, coverage, and review pressure.
8. **Record observations, not authority.** Example `13` records generated, executed, verified, and unknown outcomes without letting old success grant new permissions.
9. **Replay only an exact certified artifact.** Example `05` uses exact-input lookup and fresh deterministic checks without a model call.

This is an integration map, not a claim that every request needs every stage. Start with the smallest boundary that can reject unsafe or unaffordable work, then add later stages only when their evidence changes a decision.

## Suggested reading path

Start with `16`, then read `02`, `03`, and `17`. Continue with `11`, `10`, `13`, and `14` for durable safety and evaluation. Examples `05`, `07`, `08`, and `09` are deeper studies of replay, batching, evidence collection, and routing.

Remote-agent protocols are intentionally outside this main sequence. See [Remote-agent protocol appendix](advanced-remote-agents.md) when the process or network boundary itself is the lesson.
