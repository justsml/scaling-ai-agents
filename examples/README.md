# Scaling AI Agents: offline contracts

[All examples](../README.md#example-index) · [Talk slides](https://danlevy.net/talks/)

Offline, executable examples of the boundaries around a generated agent. These use Bun and TypeScript, make no model or cloud calls, and require no credentials. They complement the three framework implementations without importing from them.

```bash
cd examples
bun install
bun run snippet:07
bun run snippet:08
bun run snippet:09
bun run snippet:10
AGENT_FANOUT=3 bun run snippet:11
bun run test
bun run check
```

No install is needed to run the snippets themselves with Bun. The development dependencies provide TypeScript checks. The batch demo creates and removes its own temporary SQLite database.

| Example | What to watch | Checks |
| --- | --- | --- |
| [07: scoped repair](src/07-scoped-repair.ts) | A rename proposal passes fixed semantic fixtures; email is denied; an unknown status is quarantined; promotion has a 100-record canary | Tool discovery and invocation, deadline, attempt cap, forged scores, leading zeroes, stale parent, canary exhaustion, rollback |
| [08: durable admission](src/08-durable-admission.ts) | Four callers get one job; requested compute is resolved and reserved atomically; a lost response remains unresolved after restart | Competing OS processes, tenant accounting, compute policy, idempotent leases, stale workers, unknown charges, teardown, retry cap, outbox deduplication |
| [09: execution memory](src/09-execution-memory.ts) | A missing tenant predicate is recorded and corrected; execution and result verification remain separate | Tenant/project/version isolation, denied execution, wrong totals, unknown responses, durable intent, correction references |
| [10: council reliability](src/10-council-of-guards.ts) | Three judges disagree, every original design still fails a gate, and evaluator evidence determines whether the council is ready | Missing judges, model identity, reason disagreement, fresh evidence, calibration, IID assumptions, judgment coverage, and review queues |
| [11: bounded fan-out](src/11-fanout-node.ts) | Generate a bounded set concurrently and select only a draft that passes the lifecycle gate | Fan-out bounds, invalid high scorer, failed-branch isolation |

Example 07 accepts a tiny mapping grammar instead of executing generated code. Only `postal_code` to `postalCode` by string copy is allowed under the fixture contract. Expected outputs belong to the validator. All input records receive an accepted or quarantined disposition. The proposing job cannot promote its own artifact; the demo calls promotion separately as the trusted owner.

Example 08 uses integer cents and reserves two ten-cent attempts per item. Its printed ledger follows the talk:

| State | Settled | Held | Available |
| --- | ---: | ---: | ---: |
| Ten items admitted | 0 | 200 | 0 |
| Nine complete; final response unknown | 90 | 20 | 90 |
| Final completion reconciled | 100 | 0 | 100 |

A provider slot represents outstanding remote work. Abandoning a local worker leaves that slot and its money held. The persisted intent contains the stable attempt key even when the provider response was lost before its job ID could be recorded. Only confirmed failure can create a retry. Completing an item and creating its notification record happen in one transaction; notification delivery never dispatches generation.

Transactions use Bun's [SQLite immediate transactions](https://bun.com/docs/runtime/sqlite#transactions). The tests exercise a shared database across separate Bun processes. Production authentication and remote provider behavior are outside this example.

Example 08 also resolves compute against a server-owned catalog and identity. The quote and job reservation are written in one immediate transaction, so concurrent callers cannot spend the same available budget. Provisioning is restart-safe and records an explicit teardown obligation. Worker expiry still does not settle unknown provider charges; only provider-confirmed reconciliation does that. The fixture catalog permits only `sandbox-small` in `us-east` with named egress hosts.

See the [architecture review](../docs/talk-architecture-review-2026-09-06.md) for source talks, integration points, evaluation criteria and the limits of these demonstrations.

## Execution evidence and evaluation

Example 09 implements the smaller memory pattern added to the adaptive talk. The
[copyable prompt](src/fixtures/execution-memory-instructions.txt) comes from the handout;
it complements the runner checks and grants no execution permissions. The
runner writes append-only observations to SQLite and logs dispatch intent before
calling the execution adapter. The fixture query builder binds the authenticated
tenant; it does not attempt to validate arbitrary SQL with a regular expression.
The model-facing input is a report plan. Execution and verification adapters belong
to the trusted runner. Observations contain hashes, named checks and correction
references, without raw query results or exception bodies. Retrieval restricts the
tenant and project, excludes stale schema/tool versions from current counts, and
reports how much historical evidence it excluded. Old successes grant no authority.

The demo uses a scripted correction and result adapters. It demonstrates bookkeeping
and preflight enforcement, not measured learning. For a live memory comparison,
replay the same tasks with and without retrieval. Include stale versions, a misleading
success, denied authority and a lost response. Compare recurring mistakes, false
corrections, verified results and unresolved outcomes, plus lookup/logging cost and
elapsed time. Keep the checks identical in both arms.

Example 10 consumes stipulated council outputs and gate evidence. Majority disagreement
is the minority share of known verdicts. Reason overlap is pairwise Jaccard overlap
of fixed rubric issue IDs, not textual similarity of private reasoning. Both-empty
reason sets provide no evidence of agreement. Missing results, unknown charges,
repeated model identity or disagreement require review. A failed gate still rejects
the candidate. Evidence includes the artifact hash so a synthesized design needs
fresh checks. The output is eligibility for selection, never deployment approval.
Generation planning includes all judges and available review slots under a fixture
budget. It can select zero alternatives when money or review capacity is exhausted.
This is a planning calculation, not a second durable reservation service.

The same example audits the measuring instrument with tested arithmetic. It distinguishes
unjudged from judged nonrelevant documents, and shows the misleading score alongside
judgment coverage. It keeps false approvals visible even when raw agreement is high.
The zero-failure bound is returned only when the caller explicitly asserts representative
IID sampling; that flag records an assumption and cannot establish it. Queue waiting
time excludes hands-on service time. These are teaching fixtures, not population
estimates from the repository's unit tests.

## 11: one bounded fan-out node

`AGENT_FANOUT=1` runs the baseline; `3` adds contrasting fixed drafts. The first draft omits a deadline and gets rejected despite having the highest preference score. One failed branch becomes `null` without erasing the surviving drafts. This is a four-word lifecycle fixture, not an evaluator for architecture prose.

The example bounds fan-out at nine and collapses the joined batch to at most one passing artifact. It does not reserve provider funds or tune its own policy from measured outcomes. [Each framework implements the same batch node](../docs/fanout-node.md).

The scoped-repair example now starts without `run-fixtures`. Execution fails until tool discovery records a policy-approved grant. Discovery and invocation both check the job deadline and call cap; the quality floor keeps every input record accounted for.
