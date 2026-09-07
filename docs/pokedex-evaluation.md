# Pokédex investigation checks

Each stack owns its investigation completion. The session's `finish` operation normalizes the answer, revalidates its schema and citation IDs, assembles the final evidence, and closes the deadline timer. Framework snippets supply the raw answer, usage, finish reason, or error. Deadline and tool-call limits take precedence; valid partial answers remain available. Rejected answers stay in diagnostic metadata rather than appearing as completed evidence.

Citation validity is distinct from factual support. Completion requires nonempty citations to successful gateway calls. The conformance harness separately checks expected facts and their cited operands. Citation repair matches exact values, not substrings or numbers embedded in text.

The ten existing scenarios remain regression anchors. Four additional scenarios test how a stack agent chooses followups from a returned candidate set:

| Scenario | Useful calls | Reasoning requirement |
| --- | --- | --- |
| `reasoning-four-records` | One list, then four independent reads | Filter all four by weight greater than 100; cite the records used to include or exclude candidates. |
| `reasoning-limited-followups` | One list, then two reads | Three-call total allowance; examine only the first two returned records and state that scope. |
| `reasoning-selective-comparison` | One list, then two reads | Select only Bulbasaur and Charmander from four candidates; compare their weights and cite both operands. |
| `reasoning-no-followup` | One list | Answer a name-suffix question from the page itself; avoid detail reads. |

Each stack’s system instructions allow up to four independent followups at once, further bounded by the remaining call allowance and the useful refs already returned. A relationship read must wait for the result that supplies its ref. The tool-call cap counts attempts, including failures and locally blocked calls. Tool results expose the local remainingToolCalls count so the next decision can use the actual allowance. Recorded gateway payloads retain their original contents.

## Evaluation gates

- Quality: exact expected claims and supporting evidence must pass. An incorrect difference or an unsupported exclusion fails even if every tool call is valid.
- Cost: the efficiency gate rejects duplicate or unnecessary reads; the budget gate uses at least the observed attempt count, regardless of underreported metadata.
- Speed: independent followups must overlap in the configured scenarios. Each detail read has a 200 ms delay fault so overlap is observable. This measures execution overlap, not model-turn identity.
- Other: refs must have been returned by an earlier completed call. Efficiency scenarios require valid timestamps; partial results must not imply that unread candidates were checked.

All configured efficiency checks must pass. Existing report thresholds remain unchanged, including the per-stack factual threshold of 90%. The summary's statement of partial scope needs inspection in a live run; deterministic gates cover the selected records and supported claims, not the meaning of free-form prose.

New expected weights come from the [immutable Pokémon CSV used by the Compose seed](https://github.com/PokeAPI/pokeapi/blob/41c48560b317ce91020c18cddb44adedb13a576d/data/v2/csv/pokemon.csv): Bulbasaur 69, Ivysaur 130, Venusaur 1000, Charmander 85, in PokéAPI weight units. Local scorer tests obtain normalized responses through the real gateway with a small upstream stand-in. They use scripted intervals for deterministic scheduling checks.

## Running

From each stack directory:

```sh
bun test test/pokedex.test.ts test/pokedex-completion.test.ts
bun run check
```

From `harness/`:

```sh
bun test test/pokedex-reasoning.test.ts test/eval.test.ts test/fixtures.test.ts
bun run check
```

With the Compose gateway healthy and Pi/model credentials configured, `bun run eval --repetitions 1` runs the live matrix.

The offline tests validate completion and scorer behavior without model calls. A live conformance run is still required to measure whether each stack agent follows the revised prompts. Its report retains tokens, estimated cost when prices are provided, and latency distributions. Fixtures are copied into each stack; setup and byte-identity tests preserve that arrangement.


## Validation on 2026-09-05

The full stack and harness test suites passed; the two Compose integration tests were skipped because the Compose gateway was not running. All four TypeScript checks passed.

A live check ran the four new scenarios once per stack against a loopback gateway with the pinned four-record upstream stand-in. All 12 runs passed call selection, timing, and budget checks. Eleven passed every gate. LangChain's limited-followup answer omitted the excluded Bulbasaur record from its conclusion citations, so the evidence gate failed even though the answer and call pattern were correct. Keep that gate strict; it is a useful model regression case. This small check does not establish a general pass rate or replace the full Pi/Compose conformance run.
