# Bounded generation inside one node

Run in any framework directory:

```sh
AGENT_FANOUT=1 bun run snippet:16
AGENT_FANOUT=3 bun run snippet:16
```

The default is one. Invalid values fail before dispatch. The CLI always uses fixed outputs and makes no provider calls, even when credentials are present. A local 20-cent teaching budget includes two cents per draft, one cent per machine review, four cents for a possible synthesis and one for its new check. It admits at most five drafts. These are stipulated costs; the quote is not a durable reservation.

The fixed task returns four lifecycle requirement words. Draft zero omits `deadline`, yet has the highest preference score. It loses. Each framework returns the same winner and failure accounting for the same inputs.

| Stack | Native pattern | Why it fits |
| --- | --- | --- |
| AI SDK | `generateText` adapter and bounded `Promise.all` over attempts that capture failures | A one-shot generation needs no tool-loop agent. `maxRetries: 0` avoids hidden retry multiplication; `maxOutputTokens` and `abortSignal` bound the call. |
| LangGraph | `Send` within a compiled subgraph, explicit task input, append reducer, `maxConcurrency: 3` | Each draft has its own input; parallel writes accumulate. The subgraph can be one node of the parent application. |
| Mastra | `createStep` inside `.foreach(..., { concurrency: 3 })`, then selection | The same operation runs over an array with bounded concurrency and a typed result per attempt. |

Mastra's installed docs specify that `.foreach()` is a barrier. LangGraph likewise gathers the superstep before downstream selection. These examples therefore implement batch ranking. They do not claim first-result race latency. API references checked September 6 against installed declarations and [AI SDK generateText](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text), [LangGraph graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api), and [Mastra control flow](https://mastra.ai/docs/workflows/control-flow).

`examples/16` demonstrates four consumers using the same fixture contract:

- Race returns the first draft that passes the gate. Its separate settlement promise retains every started attempt. Aborting a loser does not prove the provider stopped or waive its charge.
- Synthesis consumes drafts and applies a fresh gate to its new artifact. It cannot inherit a parent's passing result.
- Rank selects one whole passing artifact, then applies the fixture preference and a stable ID tie-break.
- Inspection retains rejected drafts and unknown outcomes. Finding a failure in this fixture does not estimate real-world failure prevalence.

Machine review slots bound candidate inspection. One human slot is needed for the selected artifact. Neither spare tokens nor many passing drafts create more reviewer capacity. The returned accounting distinguishes undispatched work, unknown responses, known fixture cost and unknown charges. `examples/11` owns durable reconciliation; these in-process demos do not survive a restart.

## Eval contract

Given a fixed task class and policy, return at most one artifact satisfying independent checks. Compare fan-out one with higher counts on the same recorded inputs. Keep model IDs, task and rubric versions, environment, dispatch count, usage, outcome and gate evidence with each run.

| Axis | Measure | Required evidence |
| --- | --- | --- |
| Quality | Accepted fraction and per-class failure counts | Gates fixed before candidates; include cases where no answer is acceptable; review failures as well as winners |
| Cost | All generation, retry, judge, synthesis and human-review costs per accepted artifact | Include losing attempts and unknown charges; zero accepted artifacts has no finite cost per acceptance |
| Speed | Time to accepted artifact and time to settle all attempts | Do not report fastest generation as accepted latency; batch includes the join, merge and gates |
| Other | Unknown outcomes, review arrivals and recovery | Fan-out one must dispatch exactly once; failed branches cannot erase peers; no fresh authority from a passing score |

Offline checks require exact fixture behavior: rejected fast draft, eligible slower draft, all-fail result, branch exception, late loser charge, rejected synthesis, malformed fan-out value, exhausted review capacity and repeated compile-cache hit after certification is revoked. Live improvement is unmeasured until a paired run meets predeclared quality and cost/latency limits.

`shared/fanout-contract.ts` is the source for identical independent package copies. No stack imports another stack. Keep changes synchronized when extending the contract.
