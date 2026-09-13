# Code examples as articles and learning resources

Reviewed 8 September 2026. Code snapshot: `851e60d`; adjacent `dans-blog` snapshot: `562bc747e`. Both working trees were clean when inspected. This is a review of the current examples, not a commit-diff review. No implementation changes or paid model calls were made.

**Verdict: a useful reference collection with several strong article seeds, but an uneven learning sequence and some broken connections between examples.** The smaller examples expose orchestration clearly. The offline contracts teach unusually useful distinctions about authority, uncertainty, and acceptance. The weakest points are the older routers, the implied compete-to-certify pipeline, and documentation that still describes an earlier version of the talks.

For latest intent, I compared the September 8 canonical outlines, scripts, contracts and correction records in `dans-blog/artifacts/speaking-portfolio-expanded/talks/`, especially dynamic-scaling, adaptive-systems and judgment. The [intent extraction](../../dans-blog/docs/research/2026-09-08-talk-intent-codex.md) adds context but explicitly is not approved final architecture. The dynamic-scaling and judgment `formats.md` files say the decks have not yet been rebuilt; old browser HTML is therefore not the authority for these revised concepts. This review does not certify presentation rendering or every talk's external factual claims.

## High-priority resolutions — 13 September 2026

The findings below describe the September 8 snapshot; its snippet names and line links are historical. The subsequent consolidation renamed Compile to 03, bounded fan-out to 11, and the advice council to 12, and removed the old router and Compete snippets. The three High findings are resolved in the current examples:

| Finding | Resolution and current evidence |
| --- | --- |
| High 1: dropped router constraints | Removed the surviving `runTournament` compatibility adapter from [the LangGraph council](../langchain/src/snippets/12-business-advice.ts). The old router has no replacement caller. The council exposes its actual brief, cancellation signal, call implementation and mode; it does not accept or claim to enforce dollar caps, ledgers or competitor profiles. |
| High 2: rejected candidate selected from prose | Council select mode validates the complete returned advisor ID against the proposals and returns that proposal unchanged. [Regression tests](../langchain/test/business-advice.test.ts) reject prose mentioning both rejected and preferred advisors and reject unknown IDs. [Bounded fan-out](../langchain/src/snippets/11-fanout-node.ts) separately ranks only drafts that pass its fixture gate. |
| High 3: proposal comparison presented as certification | Compile misses now point to the [readiness certification procedure](readiness-certification.md). It runs complete candidate source against fixed tests using each stack's existing certification API. The guide distinguishes fixture certification, preference selection, changed-input review and replay; the advice council does not certify readiness patches. Root and shared challenge guidance use the current example names and preserve that boundary. |

Validation for this fix pass: `bun test ./test` passed in all four packages (AI SDK 67, LangChain 93, Mastra 87, shared examples 50; **297 total**), and all four `bun run check` commands passed. Each certification guide command accepted its shipped reference with five passing tests and rejected the buggy fixture with a nonzero exit status. Changed TypeScript files passed formatting checks. Loopback-server tests required permission to bind local ports. No live model calls were made.

The original review and its validation results are retained below. Talk-alignment recommendations remain separate from these correctness fixes.

## Medium-priority resolutions — 13 September 2026

- **Medium 4:** The old AI SDK router and its routine/consequential execution paths were removed during consolidation. [Current model routing](../ai-sdk/src/snippets/06-model-router.ts) only classifies requests; it accepts no spending cap or caller deadline and does not execute a selected specialist. Its header now distinguishes observed successful-call estimates from complete billing evidence, including potentially billed failed attempts. The scoped routing suite passed all 22 tests.
- **Medium 5:** [Provider batching](../ai-sdk/src/lib/provider-batch.ts) separates import errors from submission, polling and result errors, preserving the original diagnosis, accepted batch reference and partial results. A shared 30-second local deadline bounds submission, polling and retrieval without cancelling the remote batch. [Example 04](../ai-sdk/src/snippets/04-batching.ts) prints the accepted reference immediately and supports `BATCH_REFERENCE` resume without submitting another batch or repeating its local paid examples. Unknown submissions require provider reconciliation before retry. Thirteen offline regression tests cover these boundaries, including stalled operations, synchronous errors and late acknowledgments; no live provider batch was submitted.
- **Medium 6:** All four example packages now scope their test scripts to `./test`; quick starts use `bun run test`. Each framework exposes the deliberately broken readiness fixture through `bun run test:challenge`. All three challenge commands were verified to report two passes, three failures and exit status 1. The fixture remains a negative control and is excluded from the normal package suite.

Final package-script validation: `bun run test` passed in AI SDK (80), LangChain (93), Mastra (87) and shared examples (50), **310 tests total**. AI SDK typechecking passed after the implementation changes; the other packages' earlier typechecks remain applicable because their subsequent changes only affect test commands and documentation. The batching tests use injected operations and establish local control flow, not live provider behavior.

## Standards: correctness, clarity and promises to readers

### 1. High — LangGraph drops the router's constraints at the competition boundary

[The compatibility entrypoint](../langchain/src/snippets/01-compete.ts#L140) accepts arbitrary options but forwards only `request` to `runCompetition`. [Its router caller](../langchain/src/snippets/00-router.ts#L434) supplies caps, ledger, callbacks and two selected profiles. Those inputs are ignored: the entrypoint uses three competitors and a judge, a new default deadline, and no ledger charging. The caller then reports three model calls and a zero ledger delta.

An offline mock reproduced four calls and three candidates with a zero budget, zero deadline, and only one requested profile; the ledger stayed unchanged. This is an integration defect, not merely the absence of production billing. It contradicts the lesson that the executor owns the limits.

Fix the boundary with explicit, enforced inputs and complete usage reporting. If the simplified competition is deliberately unmetered, remove the incompatible router path and its claims. The catch-all options type is a possible speculative-generality smell: it accepts controls that the implementation cannot honor.

### 2. High — LangGraph can choose a candidate the judge rejected

[Winner extraction](../langchain/src/snippets/01-compete.ts#L147) finds the first candidate whose ID appears anywhere in the judge's prose. Mentioning a rejected candidate qualifies it. In an offline mock, `defensive is unsafe; minimal-diff wins.` returned `defensive` as the winner.

Return a structured `winnerId`, validate it against eligible candidate IDs, and keep explanatory prose separate. A learning example should not teach prose substring matching as a decision protocol.

### 3. High for the claimed learning path — Compete does not certify the artifact that Compile requests

[AI SDK example 05](../ai-sdk/src/snippets/05-compile.ts#L62) directs a cache miss to “request independent certification via 01-compete.ts.” [Example 01](../ai-sdk/src/snippets/01-compete.ts#L79) produces prose proposals and a prose judgment. It never extracts a patch and executes the independent challenge tests. The other frameworks' 01 examples have the same proposal-comparison shape.

This conflicts with the [domain definition](../CONTEXT.md) of a certified artifact and the root README's common gate-before-ranking contract. Example 05 does test the shipped reference; that part is useful. What is missing is the transition from newly generated work to a certified reusable artifact.

Either provide a small generation → artifact → fixed tests → selection → replay path, or relabel 01 as proposal comparison and point 05 to an actual certification procedure. Also audit neighboring cross-references: [AI SDK 00](../ai-sdk/src/snippets/00-router.ts#L203) promises a “full ledger + approval flow” in 03, but [03](../ai-sdk/src/snippets/03-constrain.ts#L53) now demonstrates a call count and deadline.

### 4. Medium — AI SDK router blurs budget measurement and enforcement

[The routine route](../ai-sdk/src/snippets/00-router.ts#L134) dispatches first, computes cost afterward, and labels the result within or over budget. That cannot enforce the input spending cap. [The consequential route](../ai-sdk/src/snippets/00-router.ts#L175) also calls the model without the supplied deadline and does not return its model-call count or cost for aggregation.

Teach these separately: admission before dispatch, actual usage afterward, unresolved charges when evidence is missing. If this remains a routing-only example, describe its dollar figures as observed estimates and include every route. A broad nonproduction disclaimer does not correct a misleading local contract.

### 5. Medium — The optional provider-batch path misdiagnoses operational failures

[AI SDK 07](../ai-sdk/src/snippets/07-batching.ts#L111) wraps import, submission, polling and result retrieval in one catch. Every error becomes `@ai-sdk/gateway not installed`, including invalid credentials or a network failure after submission. Readers receive the wrong troubleshooting advice and lose information about potentially submitted work.

Separate module-loading errors from provider errors, preserve the batch identifier, and give polling a bounded local wait or resumable exit. Do not imply that ending local polling cancels the remote batch.

One suspected issue was rejected during verification: cancelled/expired *item* statuses are not batch polling statuses. The installed provider normalizes OpenAI batch cancellation and expiry to `failed`; the batch status union is pending/completed/failed. The [official AI SDK batch contract](https://github.com/vercel/ai/blob/main/packages/provider/src/batch/v4/batch-v4.ts) confirms the distinction. Cancellation/expiry therefore is not evidence of an infinite loop here.

### 6. Medium — The documented test entrypoint can make a healthy checkout look broken

The [AI SDK quick start](../ai-sdk/README.md#L11) and equivalent framework guides say `bun test`. The [LangChain test script](../langchain/package.json#L11) uses `bun test test/`. A bare `test` filter also matches `src/fixtures/readiness.test.ts`, which intentionally runs against broken challenge code.

Observed with Bun 1.3.1: `bun test test` produced three challenge-fixture failures in both AI SDK and LangChain. `bun test ./test` passed their actual package suites. Make the package test script and documentation use the explicit directory, and expose the intentionally failing challenge under a separately named command. Keep the broken challenge; fix its discovery boundary.

Cross-framework duplication is intentional under the independent-package design. Extracting everything into one shared orchestration library would weaken the comparison and should not be a review recommendation.

## Spec: alignment with the latest talks

### 1. The judgment-talk mapping is now wrong, not just renamed

[README](../README.md#L130) still describes *Code Is Cheap. Judgment Is Expensive.* through reviewer capacity and time to acceptance. The current [judgment outline](../../dans-blog/artifacts/speaking-portfolio-expanded/talks/judgment/index.md#L14), *Turn Your Thinkin' Tokens Up to 11*, centers the customer's attention and relearning costs: which features should exist, who should see them, and when.

Example 15's queue arithmetic remains useful, but it does not substantiate that revised thesis. Update the link label and conceptual mapping. A release-cadence/customer-session exercise could support the new talk if desired; do not imply that this repository needs code for every portfolio topic.

### 2. Durable admission no longer reproduces the talk's worked numbers

[The guide](../examples/README.md#L35) says its ledger follows the talk. The executable example admits ten items under a 200-cent cap for four callers. The [current walkthrough](../../dans-blog/artifacts/speaking-portfolio-expanded/talks/dynamic-scaling/index.md#L166) has two callers, a 150-cent cap, seven admitted items holding 140 cents, and three refused.

This is more than changing constants: current `admit()` accepts an entire batch or refuses it. Asking it for ten items under 150 cents admits zero, not seven. To reproduce the talk, add explicit partial admission with accepted/refused identities, or label the executable as a separate all-or-nothing scenario and stop saying its ledger matches.

The accounting and unknown-outcome lesson remains sound. Its CLI simulates callers sequentially; the tests separately verify competing OS processes. Preserve that evidence distinction.

### 3. The council demonstrates perspectives, but not the talk's stronger synthesis stage

[Example 17's guide](../docs/business-advice.md) explicitly uses Luna for all four roles. The [current scaling outline](../../dans-blog/artifacts/speaking-portfolio-expanded/talks/dynamic-scaling/index.md#L208) describes cheap generation followed, in the synthesis variant, by a frontier model. The intent extraction also describes higher reasoning effort at synthesis.

The same-model choice is an openly documented economical variant, not a hidden defect or permission to change the selected models. It should be labeled as such when linked from the talk. A separately configurable worker/chair comparison would let an article investigate the claim. The chair instruction—choose a base and graft compatible ideas—is already a strong teaching example. Do not infer independent errors from different persona prompts or higher quality from a stronger model without measurement.

### 4. The central composition lesson remains an exercise for the reader

The latest scaling material connects nested parallelism, shared admission at external dispatch, app-requested compute, throttling and recovery. Examples 07, 11 and 12 show local pools, durable fixed limits and a compute quote separately. Example 12 explicitly stops before reservation/provisioning; it is not an executable lease lifecycle. The current [throttle discussion](../../dans-blog/artifacts/speaking-portfolio-expanded/talks/dynamic-scaling/index.md#L150) also has no corresponding adaptive scheduling example.

The most useful addition is one narrow offline composition exercise: multiple callers request internally parallel work; one admission service accounts for all resulting items; a scripted throttle reduces admission; a restart retains unresolved attempts; notifications retry independently. Include the same input under a naive policy and the corrected policy. This makes the talk's nested-work argument inspectable without cloud setup.

Streaming is partly represented by remote example 06. A short annotated event transcript would help explain progress, final completion, and unknown state; another framework implementation is less valuable than that explanation.

### 5. The examples explain mechanisms better than they demonstrate benefit

Example 10 predefines one allowed rename and its implementation; example 13 applies a scripted correction; example 14 consumes stipulated gate/judge evidence; example 16 checks four requirement words. These are legitimate, mostly well-labeled teaching fixtures. They do not establish adaptive repair of unforeseen schemas, learned correction, judge validity, or improved model quality.

The [adaptive script](../../dans-blog/artifacts/speaking-portfolio-expanded/talks/adaptive-systems/script-30min.md#L33) asks whether adaptation beats alert-and-wait on recovery time, records kept moving and false repairs. The memory and fan-out guides already outline useful paired evaluations. Execute and publish those comparisons before using the examples to claim an improvement. An architecture article can explain the mechanism now without claiming those results.

## Article and learning-resource assessment

| Examples | Best use | Editorial treatment |
| --- | --- | --- |
| 00 router | Advanced integration reading | Repair the constraint/accounting seams first. At 304/754/642 lines across stacks, it is a poor first lesson despite its number. |
| 01 compete | Parallel proposal comparison | Good compact orchestration; separate preference from certification and fix the LangGraph adapter. |
| 02 decompose | Introductory article | Clear independent evidence ownership and join. Show which facts each branch receives and what the lead must not infer. |
| 03 constrain | Introductory article | Clear admission by call count and shared deadline. Explicitly distinguish count caps from dollar reservations. |
| 04 distribute | Framework comparison | Concrete model lanes; explain that model placement is not geographic compute provisioning. |
| 05 compile | Reusable-artifact article | Strong exact-input and independent-check lesson; explain shipped-reference provenance and repair the discovery-to-certification handoff. |
| 06 remote | Focused advanced article | Useful protocol and stream handling, but setup obscures the first lesson. Publish a request/event/output transcript and restart boundary. |
| 07 batching | Layers-of-parallelism article | Valuable distinction between tool concurrency, local pools and provider batches. Fix error reporting and show the shared-admission connection. |
| 08 Pokédex / 09 routing | Evaluation case studies | Useful deeper references. Add a copyable minimal input, expected output and one failure trace beside the main index; harness-oriented input is an onboarding hurdle. |
| 10 scoped repair | Adaptive-systems article | Strong semantic counterexample: leading zeroes survive and ambiguity is quarantined. Show the lossy candidate failing before the accepted mapping. |
| 11 durable admission | Strongest substantial supporting example | Real SQLite transactions, restart, unknown outcomes and outbox behavior. Use a state/ledger walkthrough rather than printing 490 lines in an article. Align or distinguish the scenario. |
| 12 compute request | Short sidebar | Clear policy resolver; title and output must retain the quote-only boundary. |
| 13 execution memory | Focused architecture article | Generated/executed/verified/unknown distinctions are useful. Show paired observations and correction provenance; call the correction scripted. |
| 14 guards / 15 validity | Evaluation-literacy article | Strong examples of gate precedence, misleading agreement and missing judgments. Split 15's four calculations into separate article excerpts. |
| 16 fan-out | First runnable exercise and syntax comparison | Excellent no-key entrypoint; four-word membership is only a stand-in for acceptance checks. Fixed scores and drafts cannot demonstrate diversity or quality gains. |
| 17 advice council | Most approachable live article seed | Recognizable problem, meaningful contrasting roles and explicit synthesis. Add an annotated output and counterexample; retain the all-or-fail panel semantics. |

The root README's direct source links, no-key start and comparison table are worth preserving. The next improvement should be a reading path rather than more catalog entries: 16 → 02/03 → 17, then 10/11/13 for contracts and recovery, then 14/15 for evaluation. Offer one framework as the main article implementation, with the other two linked as comparisons.

For each article, include five concrete things: the decision the example teaches, the small code excerpt that makes it, one runnable command, an annotated result, and a change for the reader to try with a predicted consequence. For example, make the highest-scoring draft fail, lose a provider response, or remove the tenant binding. Those exercises teach more than adding framework boilerplate.

## Validation

| Check | Result |
| --- | --- |
| `examples`: `bun test test` | 48 passed |
| `ai-sdk`: `bun test ./test` | 67 passed |
| `langchain`: `bun test ./test` | 90 passed |
| `mastra`: `bun test ./test` | 87 passed |
| `bun run check` in all four packages | Passed |
| Offline example 16 with fan-out 1 and 3 | No winner for 1; valid fixture winner for 3 |
| Offline example 11 | Deduplication, held unknown outcome after reopen, reconciliation and ten notifications observed |
| LangGraph tournament seam with mocked provider | Ignored constraints and incorrect winner reproduced |
| Broad `bun test test` in AI SDK / LangChain | Three deliberate challenge-fixture failures each; explicit-directory reruns pass |

Total: 292 passing tests in the scoped suites. No live quality evaluation, provider spending comparison, cloud provisioning, public-site deployment verification, deck rendering or full conformance-harness run was performed. Passing suites did not catch the compatibility-boundary defects above.

Standards: six findings; the most serious is the lost router admission/accounting contract. Spec: five findings; the clearest current-source mismatch is the changed judgment thesis, with the durable-admission walkthrough also requiring a behavior decision to match it.
