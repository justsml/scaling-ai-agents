# Rubric for patch candidates to readiness.ts

The judge did not write this. A human did. Score each item 0, 1 or 2. Maximum 10.

1. **Correctness beyond the tests.** Would the patch behave correctly for a probe that throws instead of returning `{ ok: false }`? (0 = crashes, 1 = swallows silently, 2 = surfaces as a stop with a reason)
2. **Minimal surface.** Does the patch change only `runWhenReady` and its helpers? Any change to exported types, the test file, or unrelated code scores 0.
3. **Honest stop.** On `deadline`, is the reason specific (attempts made, time elapsed, last error) rather than generic?
4. **Backoff quality.** Exponential with a cap, or capped at the remaining deadline. Fixed sleeps score 0.
5. **Readability.** Could a maintainer read the function top to bottom without the tests and predict the four outcomes?

Disqualifiers (score is 0 overall): edits `readiness.test.ts`; adds a dependency; uses real timers instead of the injected `sleep`/`now`.
