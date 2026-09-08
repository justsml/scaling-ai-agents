/**
 * pool.ts — DISTRIBUTE: hardware, providers, regions.
 *
 * The important part of this file is that `region` and
 * `dataClass` filter the pool **in code, before any
 * call is made**. A request tagged `restricted` never
 * gets as far as building a hosted model — not "the
 * prompt says don't", not "a middleware catches it",
 * but a filter that removes the provider from the list.
 *
 * Providers are declared with the properties a router
 * actually needs: where they run, what data classes
 * they may see, and what they cost.
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  FRONTIER_MODEL,
  JUDGE_MODEL,
  WORKER_MODEL,
  localModel,
  localSlot,
  localSlotAlive,
  model,
} from "./models.ts";

export type Region = "us" | "eu" | "any";
export type DataClass =
  | "public"
  | "internal"
  | "restricted";

export interface ProviderSpec {
  id: string;
  /** The `initChatModel` id, or `local` for the OpenAI-compatible slot. */
  modelId: string;
  kind: "hosted" | "local" | "remote";
  regions: Region[];
  /** Data classes this provider is allowed to see. */
  allows: DataClass[];
  /** Lower is preferred when several providers qualify. */
  rank: number;
  whyItExists: string;
}

export const PROVIDERS: ProviderSpec[] = [
  {
    id: "openai-primary",
    modelId: WORKER_MODEL,
    kind: "hosted",
    regions: ["us"],
    allows: ["public", "internal"],
    rank: 0,
    whyItExists:
      "default worker: cheapest hosted model that can do the task",
  },
  {
    id: "openai-frontier",
    modelId: FRONTIER_MODEL,
    kind: "hosted",
    regions: ["us"],
    allows: ["public", "internal"],
    rank: 2,
    whyItExists:
      "fallback when the primary fails, and the frontier competitor",
  },
  {
    id: "openai-nano",
    modelId: JUDGE_MODEL,
    kind: "hosted",
    regions: ["us", "eu"],
    allows: ["public", "internal"],
    rank: 1,
    whyItExists: "cheap fallback; also the judge",
  },
  {
    id: "local-slot",
    modelId: "local",
    kind: "local",
    regions: ["us", "eu"],
    // The local slot is the only provider allowed to
    // see restricted data, because it is the only one
    // where the bytes do not leave the machine.
    allows: ["public", "internal", "restricted"],
    rank: 3,
    whyItExists:
      "on-device slot: the only provider cleared for restricted data",
  },
];

export interface Requirement {
  region: Region;
  dataClass: DataClass;
}

export interface PoolDecision {
  provider: ProviderSpec | null;
  /** Every provider considered, and why it was kept or dropped. */
  considered: {
    id: string;
    kept: boolean;
    why: string;
  }[];
  reason: string;
}

/**
 * Pure function: no I/O, no model construction. This is
 * what makes the filter auditable — `test/pool.test.ts`
 * can assert that `restricted` can only ever reach the
 * local slot.
 */
export function selectProvider(
  req: Requirement,
  opts: {
    localAvailable: boolean;
    exclude?: string[];
  } = { localAvailable: false },
): PoolDecision {
  const considered: PoolDecision["considered"] = [];
  const kept: ProviderSpec[] = [];

  for (const p of PROVIDERS) {
    if (opts.exclude?.includes(p.id)) {
      considered.push({
        id: p.id,
        kept: false,
        why: "excluded by caller (already tried)",
      });
      continue;
    }
    if (!p.allows.includes(req.dataClass)) {
      considered.push({
        id: p.id,
        kept: false,
        why: `not cleared for dataClass=${req.dataClass}`,
      });
      continue;
    }
    // `region: "any"` on the REQUEST means "anywhere is
    // fine". A provider never claims "any" — it lists
    // the regions it actually runs in, so the filter
    // cannot be defeated by a wildcard on the wrong
    // side.
    if (
      req.region !== "any" &&
      !p.regions.includes(req.region)
    ) {
      considered.push({
        id: p.id,
        kept: false,
        why: `not available in region=${req.region}`,
      });
      continue;
    }
    if (p.kind === "local" && !opts.localAvailable) {
      considered.push({
        id: p.id,
        kept: false,
        why: "local slot not running",
      });
      continue;
    }
    considered.push({
      id: p.id,
      kept: true,
      why: p.whyItExists,
    });
    kept.push(p);
  }

  kept.sort((a, b) => a.rank - b.rank);
  const chosen = kept[0] ?? null;
  return {
    provider: chosen,
    considered,
    reason: chosen
      ? `region=${req.region} dataClass=${req.dataClass} -> ${chosen.id} (${chosen.whyItExists})`
      : `region=${req.region} dataClass=${req.dataClass} -> no provider qualifies; stopping rather than downgrading the requirement`,
  };
}

/** The ordered chain a request may fall back through, after filtering. */
export function fallbackChain(
  req: Requirement,
  localAvailable: boolean,
): ProviderSpec[] {
  const chain: ProviderSpec[] = [];
  const tried: string[] = [];
  for (;;) {
    const decision = selectProvider(req, {
      localAvailable,
      exclude: tried,
    });
    if (!decision.provider) break;
    chain.push(decision.provider);
    tried.push(decision.provider.id);
  }
  return chain;
}

export interface ResolvedProvider {
  spec: ProviderSpec;
  llm: BaseChatModel;
}

/** Build the actual model for a chosen provider. Only called after the filter has run. */
export async function buildModel(
  spec: ProviderSpec,
): Promise<ResolvedProvider> {
  if (spec.kind === "local") {
    const slot = localSlot();
    if (!slot)
      throw new Error(
        "local slot selected but LOCAL_OPENAI_BASE_URL is unset",
      );
    return { spec, llm: localModel(slot) };
  }
  return { spec, llm: await model(spec.modelId) };
}

/** One probe, cached for the process, so every snippet agrees on whether local is up. */
let localProbe: Promise<boolean> | null = null;
export function isLocalAvailable(): Promise<boolean> {
  localProbe ??= (async () => {
    const slot = localSlot();
    if (!slot) return false;
    return localSlotAlive(slot);
  })();
  return localProbe;
}

export function describePool(
  localAvailable: boolean,
): (string | number)[][] {
  return PROVIDERS.map((p) => [
    p.id,
    p.kind,
    p.regions.join("/"),
    p.allows.join("/"),
    p.kind === "local"
      ? localAvailable
        ? "up"
        : "absent"
      : "assumed up",
    p.whyItExists,
  ]);
}
