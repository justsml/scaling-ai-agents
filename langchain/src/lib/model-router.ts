import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
export const Route = z.enum(["code", "long-context", "general"]);
export const Outcome = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("route"),
      route: Route,
      confidence: z.number().min(0).max(1),
      reason: z.string().min(1),
      source: z.enum(["rule", "model"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("clarify"),
      question: z.string().min(1),
      confidence: z.number().min(0).max(1),
      reason: z.string().min(1),
      source: z.literal("policy"),
    })
    .strict(),
  z
    .object({ action: z.literal("approval"), reason: z.string().min(1), source: z.literal("rule") })
    .strict(),
]);
export type RouterOutcome = z.infer<typeof Outcome>;
export type RouterCase = {
  id: string;
  input: string;
  groundTruth: {
    route?: string | null;
    action?: string;
    acceptedRoutes?: string[];
    forbidden?: string[];
    ambiguous?: boolean;
    source: string;
    hard?: boolean;
  };
};
export type ModelDecision = {
  route: "code" | "long-context" | "general";
  confidence: number;
  reason: string;
};
export type DecisionModel = (input: string) => Promise<ModelDecision>;
const DecisionSchema = z.object({
  route: Route,
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});
export function langchainDecision(
  modelId = "openai/gpt-5.6-luna",
  instructions = "Select the best specialist route without answering the request.",
): DecisionModel {
  const chat = new ChatOpenAI({
    model: modelId.replace(/^openai[/:]/, ""),
    reasoning: { effort: "none" },
  });
  return async (input) =>
    (await chat.withStructuredOutput(DecisionSchema).invoke([
      { role: "system", content: instructions },
      { role: "user", content: input },
    ])) as ModelDecision;
}
const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/router/${name}`, import.meta.url));
export async function loadRouterCases(): Promise<RouterCase[]> {
  return JSON.parse(await readFile(fixture("cases.json"), "utf8"));
}
export async function loadRules(): Promise<any[]> {
  return (JSON.parse(await readFile(fixture("rules.json"), "utf8")) as any).rules;
}
export async function loadDecisionInstructions(): Promise<string> {
  return readFile(fixture("decision-instructions.md"), "utf8");
}
export function deterministic(input: string, rules: any[]): RouterOutcome | undefined {
  for (const rule of [...rules].sort((a, b) => b.priority - a.priority))
    if (new RegExp(rule.pattern, rule.flags ?? "i").test(input.trim()))
      return rule.action === "approval"
        ? { action: "approval", reason: `rule ${rule.id}`, source: "rule" }
        : {
            action: "route",
            route: rule.route,
            confidence: 1,
            reason: `rule ${rule.id}`,
            source: "rule",
          };
}
export async function decide(
  input: string,
  rules: any[],
  model: DecisionModel,
  options: { rulesEnabled?: boolean; fallback?: DecisionModel } = {},
): Promise<RouterOutcome> {
  const matched = deterministic(input, rules);
  if (matched?.action === "approval") return matched;
  if (options.rulesEnabled !== false && matched) return matched;
  try {
    return applyPolicy({ action: "route", ...(await model(input)), source: "model" });
  } catch (error) {
    if (!options.fallback || !isProviderFailure(error)) throw error;
    return applyPolicy({ action: "route", ...(await options.fallback(input)), source: "model" });
  }
}
export function applyPolicy(decision: RouterOutcome): RouterOutcome {
  if (decision.action !== "route") return decision;
  if (decision.confidence < 0.4)
    return {
      action: "clarify",
      question: "Which kind of specialist should handle this request?",
      confidence: decision.confidence,
      reason: "below abstention floor",
      source: "policy",
    };
  if (decision.confidence < 0.7 && decision.route !== "general")
    return { ...decision, route: "general", reason: "downgraded below route acceptance threshold" };
  return decision;
}
export function score(outcome: RouterOutcome, truth: RouterCase["groundTruth"]) {
  const route = outcome.action === "route" ? outcome.route : null;
  const accepted = truth.acceptedRoutes ?? (truth.route ? [truth.route] : []);
  return {
    valid: Outcome.safeParse(outcome).success,
    accurate:
      truth.action === "approval"
        ? outcome.action === "approval"
        : truth.ambiguous
          ? accepted.includes(route ?? "")
          : route === truth.route,
    forbidden: route && truth.forbidden?.includes(route) ? 0 : 1,
  };
}
function isProviderFailure(error: unknown): boolean {
  const value = error as { status?: number; message?: string };
  return (
    value?.status === 408 ||
    value?.status === 429 ||
    (value?.status !== undefined && value.status >= 500) ||
    /timeout|rate.?limit|server error|service unavailable/i.test(value?.message ?? "")
  );
}
