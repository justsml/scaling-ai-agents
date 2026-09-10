// The deterministic classifier used by the routing policy examples.
// (and by 03-compile.ts, which reuses it to decide when
// the compiled tool short-circuits the routine path).
// Deliberately simple keyword rules, not a model call:
// a router that needs an LLM to decide "lookup vs
// routine vs novel" has defeated the point of routing
// before spending money.
import { z } from "zod";

export type RequestClass =
  | "lookup"
  | "routine"
  | "novel"
  | "consequential";

export interface RoutableRequest {
  id: string;
  text: string;
  region: string;
  dataClass: string;
}

/** Call options every executor validates before running a plan. */
export const callContractSchema = z.object({
  requestId: z.string(),
  region: z.string(),
  dataClass: z.string(),
  budgetUsd: z.number().positive(),
});
export type CallContract = z.infer<
  typeof callContractSchema
>;

const CONSEQUENTIAL_RE =
  /\b(apply|deploy|push|delete|merge)\b.*\b(main|production|prod)\b/i;
const NOVEL_RE =
  /\b(why|investigate|fix|diagnose|root cause)\b/i;
const ROUTINE_RE =
  /\b(summarize|list|report on|compile)\b/i;
const LOOKUP_RE =
  /\b(what is|current status|status of|is .* (up|down|healthy))\b/i;

/** Deterministic classification over request text. No model call. */
export function classify(
  request: RoutableRequest,
): RequestClass {
  if (CONSEQUENTIAL_RE.test(request.text))
    return "consequential";
  if (NOVEL_RE.test(request.text)) return "novel";
  if (ROUTINE_RE.test(request.text)) return "routine";
  if (LOOKUP_RE.test(request.text)) return "lookup";
  // Default to novel: an unrecognized request should
  // get the most capable (and most supervised) path,
  // not be silently treated as a cheap lookup.
  return "novel";
}

export interface ExecutionPlan {
  requestClass: RequestClass;
  contract: CallContract;
  /** Human-readable reason this plan was chosen, printed alongside results. */
  reason: string;
}

/** Build the contract object the executor validates before running anything. */
export function planFor(
  request: RoutableRequest,
  budgetUsd: number,
): ExecutionPlan {
  const requestClass = classify(request);
  const contract = callContractSchema.parse({
    requestId: request.id,
    region: request.region,
    dataClass: request.dataClass,
    budgetUsd,
  });
  const reasons: Record<RequestClass, string> = {
    lookup:
      "matched a status/lookup phrase -> direct tool call, no model loop",
    routine:
      "matched a summarize/report phrase -> bounded ToolLoopAgent (isStepCount(3))",
    novel:
      "no lookup/routine phrase matched -> full tournament or investigation (01/02)",
    consequential:
      "matched an apply/push-to-main phrase -> requires human approval regardless of budget",
  };
  return {
    requestClass,
    contract,
    reason: reasons[requestClass],
  };
}
