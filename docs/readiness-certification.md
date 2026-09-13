# Certify a readiness candidate

Compile (`03`) rechecks a shipped reference artifact before replaying it for an exact known input. A cache miss returns to the caller. It does not generate a replacement, register one, or delegate certification to the advice council (`12`). Selecting a proposal is a preference decision; certification requires executing the complete candidate module against the fixed readiness tests.

## Run the fixed checks

Save a complete replacement for `readiness.ts` as a local TypeScript file, without Markdown fences. Keep `src/fixtures/readiness.test.ts` unchanged. From your chosen framework package, set `CANDIDATE` to that file and run its command below. These existing runners use temporary directories and child processes with timeouts; they are not security sandboxes. Review generated code before running it locally.

AI SDK:

```sh
CANDIDATE=src/compiled/readiness.ts bun -e '
import { runSandbox } from "./src/lib/sandbox.ts";
const result = await runSandbox(await Bun.file(process.env.CANDIDATE!).text(), 6000);
console.log(result);
process.exitCode = result.ok && result.passed === 5 && result.failed === 0 && !result.timedOut ? 0 : 1;
'
```

LangChain + LangGraph:

```sh
CANDIDATE=src/fixtures/readiness.reference.ts bun -e '
import { certifyCompiledPatch } from "./src/snippets/03-compile.ts";
console.log(await certifyCompiledPatch(await Bun.file(process.env.CANDIDATE!).text(), AbortSignal.timeout(6000)));
'
```

Mastra:

```sh
CANDIDATE=src/fixtures/readiness.reference.ts bun -e '
import { readinessChallenge } from "./src/lib/readiness-challenge.ts";
const result = await readinessChallenge.certify(await Bun.file(process.env.CANDIDATE!).text(), { abortSignal: AbortSignal.timeout(6000) });
console.log(result);
process.exitCode = result.outcome === "certified" ? 0 : 1;
'
```

The supplied paths exercise the shipped references: expect five passing tests and exit status zero. Replace the path with your candidate to test it. As a negative control, use `src/fixtures/readiness.ts`: expect three failures and a nonzero exit status. A timeout, execution error, missing test result, or failing test cannot certify a candidate.

## From a passing candidate to replay

For multiple candidates, run the same fixed checks on each and exclude every failure before ranking. Retain the exact source and test results for the selected candidate; changing or synthesizing its code requires fresh checks. These fixtures certify only the stated readiness contract, not general correctness for a different problem.

Registration is a separate code change: bind the exact original input to the exact tested artifact, preserve its provenance, add matching-input and changed-input replay tests, and rerun the fixed checks before serving it. The three packages intentionally keep their own replay representations. No snippet automatically promotes a newly generated candidate into them. Running `bun run snippet:03` demonstrates the existing shipped-reference replay, not replay of the candidate you just tested.
