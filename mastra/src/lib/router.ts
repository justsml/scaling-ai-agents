/**
 * The router runs before any axis.
 *
 * The classifier is deterministic on purpose. A model that decides how much to
 * spend deciding is a model with an unbounded budget, and it is the one call in
 * the whole system you cannot cap by capping the thing after it.
 *
 * The output is a *contract*: a zod-validated object naming the strategy, the
 * caps and the scopes. The planner proposes it; the executor validates it and
 * refuses anything it did not ask for. That split is what stops "the plan said
 * so" from being a privilege escalation.
 */
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FIXTURES_DIR } from "./setup.js";

export const STRATEGY_VERSION = "router-2026-09-05";

export const requestSchema = z.object({
  id: z.string(),
  class: z.string().optional(),
  text: z.string(),
  region: z.enum(["us", "eu"]),
  dataClass: z.enum(["public", "internal", "restricted"]),
});
export type FixtureRequest = z.infer<typeof requestSchema>;

export const requestClassSchema = z.enum(["lookup", "routine", "novel", "consequential"]);
export type RequestClass = z.infer<typeof requestClassSchema>;

export const strategySchema = z.enum(["tool-only", "single-agent", "tournament", "human-approval"]);
export type Strategy = z.infer<typeof strategySchema>;

/**
 * The contract. Everything the executor is allowed to do is in here, and
 * nothing the executor does may exceed it.
 */
export const planContractSchema = z.object({
  requestId: z.string(),
  class: requestClassSchema,
  strategy: strategySchema,
  caps: z.object({
    budgetUsd: z.number().nonnegative(),
    deadlineMs: z.number().int().positive(),
    maxWorkers: z.number().int().min(0).max(8),
    maxSteps: z.number().int().min(0).max(12),
  }),
  scopes: z.array(z.enum(["read:status", "read:logs", "write:patch", "write:main", "model:call"])),
  region: z.enum(["us", "eu"]),
  dataClass: z.enum(["public", "internal", "restricted"]),
  reason: z.string(),
  strategyVersion: z.literal(STRATEGY_VERSION),
});
export type PlanContract = z.infer<typeof planContractSchema>;

/** Rules are ordered; the first match wins, and the matched rule is the reason. */
interface Rule {
  name: string;
  test: (text: string) => boolean;
  cls: RequestClass;
}

const RULES: Rule[] = [
  {
    name: "consequential-verbs",
    cls: "consequential",
    test: (t) =>
      /\b(apply|push|deploy|delete|merge|revert|rotate|refund|charge)\b/.test(t) &&
      /\b(main|prod|production|push)\b/.test(t),
  },
  {
    name: "lookup-status-question",
    cls: "lookup",
    test: (t) => /\b(status|health|up|down|version)\b/.test(t) && /\b(what|is|current)\b/.test(t),
  },
  {
    name: "novel-investigation",
    cls: "novel",
    test: (t) => /\b(why|investigate|root cause|diagnose|keep\s+\w+ing)\b/.test(t),
  },
  {
    name: "novel-repair",
    cls: "novel",
    test: (t) => /\b(fix|repair|patch)\b/.test(t) && /\b(test|tests|failing|bug)\b/.test(t),
  },
  {
    name: "routine-summarise",
    cls: "routine",
    test: (t) => /\b(summari[sz]e|list|report|recap|last\s+\w+)\b/.test(t),
  },
];

export interface Classification {
  class: RequestClass;
  rule: string;
}

/** Deterministic. Same input, same output, no network, no tokens. */
export function classify(text: string): Classification {
  const t = text.toLowerCase();
  for (const rule of RULES) {
    if (rule.test(t)) return { class: rule.cls, rule: rule.name };
  }
  return { class: "routine", rule: "default-routine" };
}

const STRATEGY_FOR: Record<RequestClass, Strategy> = {
  lookup: "tool-only",
  routine: "single-agent",
  novel: "tournament",
  consequential: "human-approval",
};

/**
 * Caps scale with the class. A lookup gets no model budget at all, which is the
 * cheapest possible correct answer to most questions a system is asked.
 */
function capsFor(cls: RequestClass, budgetUsd: number, deadlineMs: number): PlanContract["caps"] {
  switch (cls) {
    case "lookup":
      return { budgetUsd: 0, deadlineMs: Math.min(deadlineMs, 2_000), maxWorkers: 0, maxSteps: 0 };
    case "routine":
      return {
        budgetUsd: budgetUsd * 0.15,
        deadlineMs: Math.min(deadlineMs, 20_000),
        maxWorkers: 1,
        maxSteps: 3,
      };
    case "novel":
      return { budgetUsd: budgetUsd * 0.7, deadlineMs, maxWorkers: 4, maxSteps: 2 };
    case "consequential":
      return { budgetUsd: 0, deadlineMs: Math.min(deadlineMs, 10_000), maxWorkers: 0, maxSteps: 1 };
  }
}

function scopesFor(cls: RequestClass): PlanContract["scopes"] {
  switch (cls) {
    case "lookup":
      return ["read:status"];
    case "routine":
      return ["read:status", "read:logs", "model:call"];
    case "novel":
      return ["read:logs", "write:patch", "model:call"];
    case "consequential":
      // Note what is NOT here: model:call. A consequential request does not get
      // a model to argue itself into approval.
      return ["write:main"];
  }
}

/** The planner. Proposes a contract; does not execute anything. */
export function plan(req: FixtureRequest, budgetUsd: number, deadlineMs: number): PlanContract {
  const { class: cls, rule } = classify(req.text);
  return {
    requestId: req.id,
    class: cls,
    strategy: STRATEGY_FOR[cls],
    caps: capsFor(cls, budgetUsd, deadlineMs),
    scopes: scopesFor(cls),
    region: req.region,
    dataClass: req.dataClass,
    reason: `matched rule "${rule}"`,
    strategyVersion: STRATEGY_VERSION,
  };
}

export class ContractRejected extends Error {
  constructor(message: string) {
    super(`ContractRejected: ${message}`);
    this.name = "ContractRejected";
  }
}

/**
 * The executor's half. Validates the shape, then re-derives the classification
 * itself and refuses a contract that disagrees. A planner that could relabel a
 * consequential request as routine would be the whole exploit.
 */
export function validateContract(candidate: unknown, req: FixtureRequest): PlanContract {
  const parsed = planContractSchema.safeParse(candidate);
  if (!parsed.success)
    throw new ContractRejected(parsed.error.issues.map((i) => i.message).join("; "));

  const contract = parsed.data;
  if (contract.requestId !== req.id)
    throw new ContractRejected("contract is for a different request id");

  const recomputed = classify(req.text);
  if (recomputed.class !== contract.class) {
    throw new ContractRejected(
      `class "${contract.class}" does not match the deterministic classification "${recomputed.class}"`,
    );
  }
  if (contract.strategy !== STRATEGY_FOR[contract.class]) {
    throw new ContractRejected(
      `strategy "${contract.strategy}" is not the strategy for class "${contract.class}"`,
    );
  }
  if (contract.class === "consequential" && contract.scopes.includes("model:call")) {
    throw new ContractRejected("a consequential request may not carry model:call scope");
  }
  return contract;
}

export async function loadRequests(): Promise<FixtureRequest[]> {
  const raw = await readFile(join(FIXTURES_DIR, "requests.json"), "utf8");
  return z.array(requestSchema).parse(JSON.parse(raw));
}
