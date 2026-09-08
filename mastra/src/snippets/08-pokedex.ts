/**
 * 08 — Pokédex investigator (Mastra)
 *
 * The model investigates through four local tools. The
 * session owns deadlines, call limits, opaque cursors,
 * and citation checks; the model only chooses calls.
 *
 *   bun run snippet:08 < request.json
 *
 * One paid agent loop, with the tool-call count set by
 * request.json. Needs OPENAI_API_KEY and the local
 * Pokédex gateway named in that request.
 */
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import {
  answerSchema,
  type InvestigationEvidence,
  type InvestigationRequest,
  investigationRequestSchema,
  loadPokedexToolContract,
  POKEDEX_TOOLS,
  PokedexGatewaySession,
} from "../lib/pokedex.js";

export function createPokedexTools(
  contract: Awaited<
    ReturnType<typeof loadPokedexToolContract>
  >,
  session: PokedexGatewaySession,
) {
  return Object.fromEntries(
    POKEDEX_TOOLS.map((name) => [
      name,
      createTool({
        id: name,
        description: contract[name].description,
        inputSchema: contract[name]
          .inputSchema as never,
        execute: async (args) =>
          session.call(name, args),
      }),
    ]),
  );
}

export async function investigatePokedex(
  input: InvestigationRequest,
): Promise<InvestigationEvidence> {
  const request =
    investigationRequestSchema.parse(input);
  const session = new PokedexGatewaySession(request);
  try {
    const contract = await loadPokedexToolContract();
    const tools = createPokedexTools(contract, session);
    const agent = new Agent({
      id: `pokedex-${request.runId}`,
      name: "Pokédex Investigator",
      model: "openai/gpt-5.6-luna",
      tools,
      instructions: `Investigate only with the supplied Pokédex tools. Follow normalized refs; never construct URLs. Call pokedex_list_resources only when the request explicitly asks for resource discovery. When the request starts from a named entity rather than a page, search once and then get the exact returned ref; do not fall back to listing. Omit cursor entirely on the first pokedex_list or pokedex_search call—there is no starting cursor. For later pages, copy the exact nextCursor byte-for-byte; never invent, decode, edit, or shorten a cursor. Retry only errors marked retryable. Every factual claim must cite requestIds from successful tool results. For comparisons and filters, put citations for ALL examined records on the conclusion claim itself, including excluded candidates. Return only the requested claim paths; examination scope belongs in the summary, not extra names claims. Preserve exact raw API names, casing, numbers, and PokéAPI units; never capitalize names or convert units. Use only the requested canonical lowerCamelCase claim paths without namespace prefixes: searchable, listOnly, name, height, weight, types, abilities, hiddenAbility, heavier, difference, names, laterSpecies, region, pokedexes, baseExperience, or color. Use searchable/listOnly for resource discovery and laterSpecies for evolution descendants. When the useful followups depend on a search or list result, make that single call first and wait for its result. Read only returned refs whose detail fields are needed; if the result already answers the question, stop. Each tool result includes remainingToolCalls from the local session. If it is zero, return your final supported answer immediately without calling any more tools. Before each tool turn, use that remaining count, or the total allowance before the first call. Once independent useful refs are known, choose at most min(4, remaining calls, useful refs) and request only that selected set together. A page of four candidates does not authorize four reads if fewer calls remain. The allowance counts individual tool calls, not model turns. Dependent relationship reads must wait for their issuing result; do not guess future refs or spend calls just because they remain. If limits prevent a complete investigation, report only supported findings and state which records were not examined. Total tool-call allowance: ${request.maxToolCalls}; count every attempt, including failed calls.`,
    });
    const result = await agent.generate(
      request.prompt,
      {
        maxSteps: request.maxToolCalls + 1,
        abortSignal: session.signal,
        structuredOutput: { schema: answerSchema },
        providerOptions: {
          openai: {
            reasoningEffort: "none",
            store: false,
          },
        },
      },
    );
    const usage = result.usage as unknown as {
      inputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
    };
    const finishReason = String(
      (result as { finishReason?: string })
        .finishReason ?? "completed",
    );
    return session.finish({
      answer: result.object ?? null,
      usage: normalizeUsage(usage),
      finishReason,
    });
  } catch (error) {
    return session.finish({
      error,
      usage: usageFromError(error),
    });
  }
}
function normalizeUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}) {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(usage.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: usage.reasoningTokens }),
  };
}
function usageFromError(error: unknown) {
  const value = error as {
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
    };
    result?: {
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        reasoningTokens?: number;
      };
    };
  };
  return normalizeUsage(
    value?.usage ?? value?.result?.usage ?? {},
  );
}

if (import.meta.main) {
  const request = investigationRequestSchema.parse(
    JSON.parse(await Bun.stdin.text()),
  );
  console.log(
    JSON.stringify(await investigatePokedex(request)),
  );
}
