// Shipped reference artifact, with separate intent and
// source-identity checks.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
export {
  runWhenReady,
  type Probe,
} from "./readiness.ts";
export const COMPILED_PATCH = readFileSync(
  new URL("./readiness.ts", import.meta.url),
  "utf8",
);
export const TARGET_SOURCE = readFileSync(
  new URL("../fixtures/readiness.ts", import.meta.url),
  "utf8",
);
export function matchesCompiledSource(
  source: string,
): boolean {
  return source === TARGET_SOURCE;
}
// The demo accepts a finite vocabulary. This is not an
// authorization classifier.
export interface MatchResult {
  matched: boolean;
  reason: string;
}
const FIX_REQUESTS = new Set([
  "fix runwhenready",
  "fix runwhenready so all readiness tests pass.",
  "please fix runwhenready — the readiness tests need to go green.",
  "can you repair runwhenready? the suite is red.",
]);
export function matchesCompiledFix(
  request: string,
): MatchResult {
  const text = request.trim().toLowerCase();
  if (
    /\b(apply|push|deploy|merge|revert)\b/.test(text)
  ) {
    return {
      matched: false,
      reason:
        "consequential action is outside this read-only demo",
    };
  }
  if (FIX_REQUESTS.has(text))
    return {
      matched: true,
      reason:
        "recognized demo wording; exact source still required",
    };
  return {
    matched: false,
    reason: text.includes("runwhenready")
      ? "does not ask for a fix in the supported demo vocabulary"
      : "does not name runWhenReady",
  };
}
