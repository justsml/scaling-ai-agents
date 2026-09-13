# Scoped repair versus alert-and-wait

This offline paired exercise measures a **scripted policy under explicit virtual-time assumptions**. It makes no model calls. It does not measure model accuracy, model latency, operator response time, or production throughput.

Run from the repository root:

```sh
cd examples
bun src/evaluations/scoped-repair.ts
bun test ./test/scoped-repair-evaluation.test.ts ./test/scoped-repair.test.ts
```

The [full recorded output](results/scoped-repair.json) includes every record identity, completion time, disposition and correctness score. Reproduce that artifact from the root with `bun examples/src/evaluations/scoped-repair.ts > docs/results/scoped-repair.json`.

Both policies receive the same eight records, one per second starting at zero, and share the existing `MappingRegistry` implementation from [example 07](../examples/src/07-scoped-repair.ts). Scoped repair additionally uses `RepairJobs` for the restricted proposal/discovery/certification path before trusted promotion. Alert-and-wait pauses until an assumed operator response, then promotes the same certified mapping. Both drain the backlog through the same single worker at an assumed 100 ms per record. All eight records stay within the existing 100-record canary.

The scoped mapping becomes available at an assumed 2,000 ms; the operator mapping at an assumed 8,000 ms. These delays include response and activation and are inputs, not measured execution durations. The observation window ends at 6,000 ms. Recovery means the completion time of the first correctly accepted record after the incident at zero. A processed record has a completed disposition; accepted and quarantined counts are reported separately so quarantine cannot be mistaken for useful output. A false repair is an accepted record that should be quarantined or whose address differs from the independently specified expected value.

| Policy | Recovery (virtual ms) | Processed by 6,000 ms | Accepted | Quarantined | False repairs by horizon | Total processed | Total false repairs | Last completion (virtual ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Scoped repair | 2,100 | 6 | 3 | 3 | 0 | 8 | 0 | 7,100 |
| Alert-and-wait | 8,100 | 0 | 0 | 0 | 0 | 8 | 0 | 8,800 |

Both policies eventually accept four records and quarantine four. Neither produces an incorrect disposition. Fixtures include leading zeroes, alphanumeric postal codes, numeric coercion, conflicting fields, ambiguous semantics and missing data. Exact-output expectations are written independently of `mapAddress` and prevent counting a dropped leading zero as success. Several evaluation inputs also appear in the certification fixtures; these are fixed regression cases, not a held-out quality evaluation. Tests also deliberately supply a lossy result and an unsafe acceptance to verify that the false-repair scorer detects them.

Under these assumptions, scoped repair restores useful processing 6,000 virtual ms earlier and completes three useful records during the observation window. This benefit comes entirely from the assumed response delay. Equal delays produce identical results; an operator response at zero reverses the recovery advantage. Regression tests cover both controls. Zero false repairs on eight fixed cases provides no estimate of the error rate on unseen schemas.

A model-performance claim still requires paired trials using actual generated candidates, separately held-out fixtures, measured proposal/certification latency, and observed operator response times. This exercise establishes the consequence of a bounded scripted rename becoming available earlier, without asserting that a model can discover such a repair reliably.
