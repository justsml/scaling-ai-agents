# Capstone: compose the narrow contracts

The repository no longer has one oversized router example. A production request crosses several independently testable boundaries, and the smaller examples make those boundaries easier to inspect.

## One request through the system

1. **Route by policy.** Example `06` compares model routing with deterministic rules disabled and enabled. Routing chooses a lane; it does not authorize spending or tools.
2. **Admit bounded work.** Example `02` sets the call count and one shared deadline before dispatch.
3. **Decompose and place.** Example `01` gives independent evidence to explicitly selected worker lanes, runs those branches concurrently, and joins them into one report.
4. **Gate generated artifacts.** Example `11` keeps failed branches isolated and ranks only drafts that pass the independent fixture gate.
5. **Select or synthesize.** Example `12` shows both endings. Selection returns one proposal unchanged. Synthesis creates a new artifact that must pass a fresh check.
6. **Reserve and recover durably.** Example `08` resolves requested compute, reserves it atomically with the job, and retains unresolved provider work across restarts.
7. **Measure the evaluators.** Example `10` keeps deterministic gates above model votes and reports disagreement, missing evidence, calibration, coverage, and review pressure.
8. **Record observations, not authority.** Example `09` records generated, executed, verified, and unknown outcomes without letting old success grant new permissions.
9. **Replay only an exact certified artifact.** Example `03` uses exact-input lookup and fresh deterministic checks without a model call.

This is an integration map, not a claim that every request needs every stage. Start with the smallest boundary that can reject unsafe or unaffordable work, then add later stages only when their evidence changes a decision.

## Suggested reading path

Start with `11`, then read `01`, `02`, and `12`. Continue with `08`, `07`, `09`, and `10` for durable safety and evaluation. Examples `03`, `04`, `05`, and `06` are deeper studies of replay, batching, evidence collection, and routing.

Remote-agent protocols are intentionally outside this main sequence. See [Remote-agent protocol appendix](advanced-remote-agents.md) when the process or network boundary itself is the lesson.
