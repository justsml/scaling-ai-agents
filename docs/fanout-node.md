# Bounded generation inside one node

Run in any framework directory:

```sh
AGENT_FANOUT=1 bun run snippet:11
AGENT_FANOUT=3 bun run snippet:11
```

The default is one. Invalid values fail before dispatch. The CLI always uses fixed outputs and makes no provider calls, even when credentials are present.

The fixed task returns four lifecycle requirement words. Draft zero omits `deadline`, yet has the highest preference score. It loses. Each framework returns the same winner for the same inputs, and one failed branch does not erase the others.

| Stack | Native pattern | Why it fits |
| --- | --- | --- |
| AI SDK | `generateText` adapter and bounded `Promise.all` | A one-shot generation needs no tool-loop agent. `maxRetries: 0`, `maxOutputTokens` and `abortSignal` bound the call. |
| LangGraph | `Send` within a compiled subgraph, explicit task input, append reducer, `maxConcurrency: 3` | Each draft has its own input; parallel writes accumulate. The subgraph can be one node of the parent application. |
| Mastra | `createStep` inside `.foreach(..., { concurrency: 3 })`, then selection | The same operation runs over an array with bounded concurrency and a typed result per attempt. |

Mastra's `.foreach()` is a barrier. LangGraph likewise gathers the superstep before downstream selection. These examples therefore implement batch ranking, not first-result racing. API references: [AI SDK generateText](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text), [LangGraph graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api), and [Mastra control flow](https://mastra.ai/docs/workflows/control-flow).

Each numbered snippet now contains its fixture, gate, fan-out and selection in one file. `examples/08` owns the separate lesson about durable admission and uncertain provider outcomes.

## Eval contract

Given a fixed task class and policy, return at most one artifact satisfying independent checks. Compare fan-out one with higher counts on the same recorded inputs. Keep model IDs, task and rubric versions, environment, dispatch count, usage, outcome and gate evidence with each run.

| Axis | Measure | Required evidence |
| --- | --- | --- |
| Quality | Accepted fraction and per-class failure counts | Gates fixed before candidates; include cases where no answer is acceptable; review failures as well as winners |
| Cost | All generation, retry, judge, synthesis and human-review costs per accepted artifact | Include losing attempts and unknown charges; zero accepted artifacts has no finite cost per acceptance |
| Speed | Time to accepted artifact and time to settle all attempts | Do not report fastest generation as accepted latency; batch includes the join, merge and gates |
| Other | Unknown outcomes, review arrivals and recovery | Fan-out one must dispatch exactly once; failed branches cannot erase peers; no fresh authority from a passing score |

Offline checks require exact fixture behavior: the highest-scoring invalid draft loses, all branches join, one branch exception does not erase its peers, and malformed fan-out values fail before dispatch. Live improvement is unmeasured until a paired run meets predeclared quality and cost/latency limits.
