import { createOpenAI, openai } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { z } from "zod";
import policyFixture from "../fixtures/router/policy.json";
import rulesFixture from "../fixtures/router/rules.json";
import { costUsd } from "./prices";

export const ROUTES = ["code", "long-context", "general"] as const;
export type Route = (typeof ROUTES)[number];
export type ModelClass = "nano" | "mini" | "frontier";

const routeOutcomeSchema = z
  .object({
    action: z.literal("route"),
    route: z.enum(ROUTES),
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().min(1),
    source: z.enum(["rule", "model"]),
  })
  .strict();
const clarifyOutcomeSchema = z
  .object({
    action: z.literal("clarify"),
    question: z.string().trim().min(1),
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().min(1),
    source: z.literal("policy"),
  })
  .strict();
const approvalOutcomeSchema = z
  .object({
    action: z.literal("approval"),
    reason: z.string().trim().min(1),
    source: z.literal("rule"),
  })
  .strict();
export const routerOutcomeSchema = z.discriminatedUnion("action", [
  routeOutcomeSchema,
  clarifyOutcomeSchema,
  approvalOutcomeSchema,
]);
export type RouterOutcome = z.infer<typeof routerOutcomeSchema>;
export type RouteOutcome = z.infer<typeof routeOutcomeSchema>;

const modelCandidateSchema = z
  .object({
    route: z.enum(ROUTES),
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().min(1),
  })
  .strict();
export type ModelCandidate = z.infer<typeof modelCandidateSchema>;

export interface DecisionMetrics {
  modelId: string;
  providerSlot: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
export interface ModelDecisionResult {
  decision: ModelCandidate;
  metrics: DecisionMetrics;
}
export type ModelDecisionAgent = (input: string) => Promise<ModelDecisionResult>;
export type FallbackReason = "timeout" | "rate-limit" | "server-error";

interface RuleFixture {
  version: string;
  rules: Array<{
    id: string;
    priority: number;
    pattern: string;
    flags?: string;
    action?: "approval";
    route?: Route;
    tags?: string[];
  }>;
}
interface RouterFallback {
  providerSlot: string;
  modelClass: ModelClass;
  maxRetries: number;
  on: FallbackReason[];
}
interface PolicyFixture {
  version: string;
  routes: Record<
    Route,
    {
      minConfidence: number;
      costClass: ModelClass;
      escalateTo?: ModelClass;
      escalationNeeds?: string[];
    }
  >;
  allowDowngrade: boolean;
  clarifyBelow: number;
  routerModelClass: ModelClass;
  routerFallbacks: RouterFallback[];
  liveScorerSamplingRate: number;
}
export const ROUTER_POLICY = policyFixture as PolicyFixture;
export const ROUTER_RULES = rulesFixture as RuleFixture;

export interface SpecialistDescriptor {
  route: Route;
  specialist: string;
  modelClass: ModelClass;
  providerSlot: string;
  useFor: string;
  guardrail: string;
}
const SPECIALISTS: Record<Route, Omit<SpecialistDescriptor, "modelClass" | "providerSlot">> = {
  code: {
    route: "code",
    specialist: "readiness-patch competitor",
    useFor: "implementation, refactoring, debugging, APIs, and tests",
    guardrail: "frontier requires confidence >= 0.85 plus hard or failed-first-attempt",
  },
  "long-context": {
    route: "long-context",
    specialist: "incident evidence reviewer",
    useFor: "large documents, logs, transcripts, and incident evidence",
    guardrail: "below-floor decisions downgrade or clarify",
  },
  general: {
    route: "general",
    specialist: "status lookup / short summarizer",
    useFor: "status, classification, extraction, formatting, and short Q&A",
    guardrail: "actual dispatch must remain on the nano cost class",
  },
};

export interface RoutingResult {
  outcome: RouterOutcome;
  specialist?: SpecialistDescriptor;
  ruleId?: string;
  ruleTags: string[];
  metrics: DecisionMetrics | null;
  fallbackAttempts: Array<{ providerSlot: string; reason: FallbackReason }>;
  fallbackNote?: string;
}
export interface LiveScoreEvent {
  scorer: "valid-router-json";
  score: 0 | 1;
  fired: true;
  outcome: unknown;
}
export interface RouteOptions {
  rulesEnabled?: boolean;
  hard?: boolean;
  failedFirstAttempt?: boolean;
  fallbackDecisionAgent?: ModelDecisionAgent;
  liveScorer?: (event: LiveScoreEvent) => void;
  random?: () => number;
}

const orderedRules = [...ROUTER_RULES.rules].sort(
  (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
);
function matchRule(input: string) {
  return orderedRules.find((rule) => new RegExp(rule.pattern, rule.flags).test(input));
}

function specialistFor(
  outcome: RouteOutcome,
  signals: { hard: boolean; failedFirstAttempt: boolean },
): SpecialistDescriptor {
  const configured = ROUTER_POLICY.routes[outcome.route];
  const canEscalate =
    outcome.route === "code" &&
    outcome.confidence >= 0.85 &&
    Boolean(configured.escalateTo) &&
    (signals.hard || signals.failedFirstAttempt);
  return {
    ...SPECIALISTS[outcome.route],
    modelClass: canEscalate ? configured.escalateTo! : configured.costClass,
    providerSlot: "primary",
  };
}

export function applyConfidencePolicy(candidate: RouteOutcome): RouterOutcome {
  const parsed = routeOutcomeSchema.parse(candidate);
  const floor = ROUTER_POLICY.routes[parsed.route].minConfidence;
  if (parsed.confidence < ROUTER_POLICY.clarifyBelow) {
    return {
      action: "clarify",
      question:
        "Which outcome matters most: code changes, reviewing extensive evidence, or a short general answer?",
      confidence: parsed.confidence,
      reason: `${parsed.reason}; confidence is below the clarification boundary`,
      source: "policy",
    };
  }
  if (parsed.confidence >= floor) return parsed;
  if (ROUTER_POLICY.allowDowngrade && parsed.route !== "general") {
    return {
      ...parsed,
      route: "general",
      reason: `${parsed.reason}; downgraded to general because ${parsed.confidence.toFixed(3)} is below the ${floor.toFixed(3)} route floor`,
    };
  }
  return {
    action: "clarify",
    question: `Please clarify whether this needs the ${parsed.route} specialist.`,
    confidence: parsed.confidence,
    reason: `${parsed.reason}; the route is below its confidence floor and downgrade is unavailable`,
    source: "policy",
  };
}

export function fallbackReason(error: unknown): FallbackReason | null {
  const value = error as { status?: number; statusCode?: number; name?: string; message?: string };
  const status = value?.status ?? value?.statusCode;
  const message = `${value?.name ?? ""} ${value?.message ?? String(error)}`.toLowerCase();
  if (status === 408 || /timeout|timed out|aborterror/.test(message)) return "timeout";
  if (status === 429 || /rate.?limit|too many requests/.test(message)) return "rate-limit";
  if (
    (status !== undefined && status >= 500) ||
    /\b5\d\d\b|server error|service unavailable/.test(message)
  )
    return "server-error";
  return null;
}
function fallbackAllowed(reason: FallbackReason) {
  return ROUTER_POLICY.routerFallbacks.some(
    (item) => item.on.includes(reason) && item.maxRetries > 0,
  );
}

export async function routeRequest(
  input: string,
  decisionAgent: ModelDecisionAgent,
  options: RouteOptions = {},
): Promise<RoutingResult> {
  const matchedRule = matchRule(input);
  // Approval is safety policy and stays enabled in rules-off experiments.
  if (matchedRule?.action === "approval") {
    return {
      outcome: {
        action: "approval",
        reason: `matched approval rule ${matchedRule.id}`,
        source: "rule",
      },
      ruleId: matchedRule.id,
      ruleTags: matchedRule.tags ?? [],
      metrics: null,
      fallbackAttempts: [],
    };
  }
  const rule = options.rulesEnabled === false ? undefined : matchedRule;
  let routeCandidate: RouteOutcome;
  let metrics: DecisionMetrics | null = null;
  const fallbackAttempts: RoutingResult["fallbackAttempts"] = [];
  let fallbackNote: string | undefined;
  if (rule?.route) {
    routeCandidate = {
      action: "route",
      route: rule.route,
      confidence: 1,
      reason: `matched deterministic rule ${rule.id}`,
      source: "rule",
    };
  } else {
    try {
      const result = await decisionAgent(input);
      routeCandidate = {
        action: "route",
        ...modelCandidateSchema.parse(result.decision),
        source: "model",
      };
      metrics = result.metrics;
    } catch (primaryError) {
      const reason = fallbackReason(primaryError);
      if (!reason || !fallbackAllowed(reason) || !options.fallbackDecisionAgent) throw primaryError;
      fallbackAttempts.push({ providerSlot: "primary", reason });
      const result = await options.fallbackDecisionAgent(input);
      routeCandidate = {
        action: "route",
        ...modelCandidateSchema.parse(result.decision),
        source: "model",
      };
      metrics = result.metrics;
      fallbackNote = `primary router ${reason}; used ${result.metrics.providerSlot} fallback slot`;
    }
  }
  const outcome = applyConfidencePolicy(routeCandidate);
  if ((options.random?.() ?? Math.random()) < ROUTER_POLICY.liveScorerSamplingRate)
    options.liveScorer?.({
      scorer: "valid-router-json",
      score: scoreValidRouterJson(outcome),
      fired: true,
      outcome,
    });
  const ruleTags = rule?.tags ?? [];
  const specialist =
    outcome.action === "route"
      ? specialistFor(outcome, {
          hard: options.hard === true || ruleTags.includes("hard"),
          failedFirstAttempt: options.failedFirstAttempt === true,
        })
      : undefined;
  return {
    outcome,
    ...(specialist ? { specialist } : {}),
    ...(rule ? { ruleId: rule.id } : {}),
    ruleTags,
    metrics,
    fallbackAttempts,
    ...(fallbackNote ? { fallbackNote } : {}),
  };
}

export function createAiSdkDecisionAgent(options: {
  instructions: string;
  modelId?: string;
  providerSlot?: string;
  apiKey?: string;
  baseURL?: string;
  onLiveFinishScore?: (event: LiveScoreEvent) => void;
}): ModelDecisionAgent {
  const modelId = options.modelId ?? process.env.MODEL_ROUTER ?? "openai/gpt-5.6-luna";
  const providerSlot = options.providerSlot ?? "primary";
  const bareModelId = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
  const provider =
    options.apiKey || options.baseURL
      ? createOpenAI({ apiKey: options.apiKey, baseURL: options.baseURL })
      : openai;
  return async (input) => {
    const started = performance.now();
    const result = await generateText({
      model: provider(bareModelId),
      output: Output.object({ schema: modelCandidateSchema }),
      system: options.instructions,
      prompt: input,
      temperature: 0,
      providerOptions: { openai: { reasoningEffort: "none", store: false } },
      // Production lacks route labels; this live hook scores only validity.
      onFinish: ({ text }) => {
        let candidate: unknown;
        try {
          candidate = JSON.parse(text);
        } catch {
          candidate = text;
        }
        const outcome =
          typeof candidate === "object" && candidate !== null
            ? { action: "route", ...candidate, source: "model" }
            : candidate;
        options.onLiveFinishScore?.({
          scorer: "valid-router-json",
          score: scoreValidRouterJson(outcome),
          fired: true,
          outcome,
        });
      },
    });
    const inputTokens = result.totalUsage.inputTokens ?? 0;
    const outputTokens = result.totalUsage.outputTokens ?? 0;
    return {
      decision: modelCandidateSchema.parse(result.output),
      metrics: {
        modelId,
        providerSlot,
        latencyMs: performance.now() - started,
        inputTokens,
        outputTokens,
        costUsd: costUsd(modelId, { inputTokens, outputTokens }),
      },
    };
  };
}

export interface ReasonablenessScore {
  score: number;
  rationale: string;
  metrics?: DecisionMetrics;
}
export type ReasonablenessJudge = (
  input: string,
  outcome: RouteOutcome,
  acceptedRoutes: Route[],
) => Promise<ReasonablenessScore>;
export async function scoreAmbiguousRoute(
  item: { input: string; groundTruth: { acceptedRoutes?: Route[] } },
  outcome: RouterOutcome,
  judge: ReasonablenessJudge,
): Promise<ReasonablenessScore | null> {
  const accepted = item.groundTruth.acceptedRoutes;
  if (!accepted || outcome.action !== "route") return null;
  if (!accepted.includes(outcome.route))
    return { score: 0, rationale: `route ${outcome.route} is outside acceptedRoutes` };
  return judge(item.input, outcome, accepted);
}
export function createAiSdkReasonablenessJudge(options: {
  rubric: string;
  modelId?: string;
}): ReasonablenessJudge {
  const modelId = options.modelId ?? process.env.MODEL_JUDGE ?? "openai/gpt-5.6-luna";
  const bareModelId = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
  const outputSchema = z.object({
    score: z.number().min(0).max(1),
    rationale: z.string().trim().min(1),
  });
  return async (input, outcome, acceptedRoutes) => {
    const started = performance.now();
    const result = await generateText({
      model: openai(bareModelId),
      output: Output.object({ schema: outputSchema }),
      system: options.rubric,
      prompt: JSON.stringify({ input, outcome, acceptedRoutes }),
      temperature: 0,
      providerOptions: { openai: { reasoningEffort: "none", store: false } },
    });
    const score = outputSchema.parse(result.output);
    const inputTokens = result.totalUsage.inputTokens ?? 0;
    const outputTokens = result.totalUsage.outputTokens ?? 0;
    return {
      ...score,
      metrics: {
        modelId,
        providerSlot: "primary",
        latencyMs: performance.now() - started,
        inputTokens,
        outputTokens,
        costUsd: costUsd(modelId, { inputTokens, outputTokens }),
      },
    };
  };
}

export function scoreValidRouterJson(value: unknown): 0 | 1 {
  return routerOutcomeSchema.safeParse(value).success ? 1 : 0;
}
export function scoreRouteAccuracy(outcome: RouterOutcome, expected: Route): 0 | 1 {
  return outcome.action === "route" && outcome.route === expected ? 1 : 0;
}
export function scoreForbiddenRoute(outcome: RouterOutcome, forbidden: Route[] = []): 0 | 1 {
  return outcome.action === "route" && forbidden.includes(outcome.route) ? 0 : 1;
}
export function scoreApprovalBypass(
  outcome: RouterOutcome,
  modelCalls: number,
  specialistCalls: number,
): 0 | 1 {
  return outcome.action === "approval" && modelCalls === 0 && specialistCalls === 0 ? 1 : 0;
}
export function scoreCostClass(outcome: RouterOutcome, actualModelClass: ModelClass): 0 | 1 {
  return outcome.action === "route" && outcome.route === "general" && actualModelClass !== "nano"
    ? 0
    : 1;
}

export type FailureLabel =
  | "provider/harness failure"
  | "route error"
  | "specialist failure"
  | "budget stop";
export interface FailureEvidence {
  httpError?: boolean;
  timeout?: boolean;
  usageTokens?: number;
  emptyStream?: boolean;
  budgetStopped?: boolean;
  routeCorrect?: boolean;
  specialistContractPassed?: boolean;
}
export function labelFailure(evidence: FailureEvidence): FailureLabel {
  if (evidence.budgetStopped) return "budget stop";
  if (
    (evidence.httpError || evidence.timeout || evidence.emptyStream) &&
    (evidence.usageTokens ?? 0) === 0
  )
    return "provider/harness failure";
  if (evidence.routeCorrect === false) return "route error";
  return "specialist failure";
}

export interface RouteObservation {
  caseId: string;
  expected: Route;
  outcome: RouteOutcome;
  specialist: SpecialistDescriptor;
  latencyMs: number;
  costUsd: number;
  forbidden?: Route[];
  failureLabel?: FailureLabel;
}
export interface RouteReportRow {
  route: Route;
  cases: number;
  accuracy: number;
  costUsd: number;
  latencyMs: number;
  failures: string;
}
export function reportByRoute(observations: RouteObservation[]): RouteReportRow[] {
  return ROUTES.map((route) => {
    const rows = observations.filter((row) => row.expected === route);
    const failures = new Map<FailureLabel, number>();
    for (const row of rows)
      if (row.failureLabel)
        failures.set(row.failureLabel, (failures.get(row.failureLabel) ?? 0) + 1);
    return {
      route,
      cases: rows.length,
      accuracy:
        rows.length === 0
          ? 0
          : rows.reduce((sum, row) => sum + scoreRouteAccuracy(row.outcome, row.expected), 0) /
            rows.length,
      costUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
      latencyMs:
        rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.latencyMs, 0) / rows.length,
      failures:
        [...failures.entries()].map(([label, count]) => `${label}:${count}`).join(", ") || "none",
    };
  });
}
export function thresholdVerdict(observations: RouteObservation[]) {
  const unambiguous = observations.filter((row) => row.caseId.startsWith("route-"));
  const valid = observations.every((row) => scoreValidRouterJson(row.outcome) === 1);
  const accuracy =
    unambiguous.length === 0
      ? 0
      : unambiguous.reduce((sum, row) => sum + scoreRouteAccuracy(row.outcome, row.expected), 0) /
        unambiguous.length;
  const forbiddenHits = observations.filter(
    (row) => scoreForbiddenRoute(row.outcome, row.forbidden) === 0,
  ).length;
  return {
    validRouterJson: valid ? 1 : 0,
    routeAccuracy: accuracy,
    forbiddenRouteHits: forbiddenHits,
    pass: valid && accuracy >= 0.9 && forbiddenHits === 0,
  };
}
