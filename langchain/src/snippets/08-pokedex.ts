#!/usr/bin/env bun
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { createAgent } from "langchain";
import {
  POKEDEX_TOOLS,
  PokedexGatewaySession,
  answerSchema,
  investigationRequestSchema,
  loadPokedexToolContract,
  type InvestigationEvidence,
  type InvestigationRequest,
} from "../lib/pokedex.ts";

export function createPokedexTools(
  contract: Awaited<
    ReturnType<typeof loadPokedexToolContract>
  >,
  session: PokedexGatewaySession,
) {
  return POKEDEX_TOOLS.map((name) =>
    tool(
      async (args) =>
        JSON.stringify(await session.call(name, args)),
      {
        name,
        description: contract[name].description,
        schema: contract[name].inputSchema as never,
      },
    ),
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
    const model = new ChatOpenAI({
      model: "gpt-5.6-luna",
      reasoning: { effort: "none" },
    });
    const agent = createAgent({
      model,
      tools,
      responseFormat: answerSchema,
      systemPrompt: `Investigate only with the supplied Pokédex tools. Follow normalized refs; never construct URLs. Call pokedex_list_resources only when the request explicitly asks for resource discovery. When the request starts from a named entity rather than a page, search once and then get the exact returned ref; do not fall back to listing. Omit cursor entirely on the first pokedex_list or pokedex_search call—there is no starting cursor. For later pages, copy the exact nextCursor byte-for-byte; never invent, decode, edit, or shorten a cursor. Retry only errors marked retryable. Every factual claim must cite requestIds from successful tool results. For comparisons and filters, put citations for ALL examined records on the conclusion claim itself, including excluded candidates. Return only the requested claim paths; examination scope belongs in the summary, not extra names claims. Preserve exact raw API names, casing, numbers, and PokéAPI units; never capitalize names or convert units. Use only the requested canonical lowerCamelCase claim paths without namespace prefixes: searchable, listOnly, name, height, weight, types, abilities, hiddenAbility, heavier, difference, names, laterSpecies, region, pokedexes, baseExperience, or color. Use searchable/listOnly for resource discovery and laterSpecies for evolution descendants. When the useful followups depend on a search or list result, make that single call first and wait for its result. Read only returned refs whose detail fields are needed; if the result already answers the question, stop. Each tool result includes remainingToolCalls from the local session. If it is zero, return your final supported answer immediately without calling any more tools. Before each tool turn, use that remaining count, or the total allowance before the first call. Once independent useful refs are known, choose at most min(4, remaining calls, useful refs) and request only that selected set together. A page of four candidates does not authorize four reads if fewer calls remain. The allowance counts individual tool calls, not model turns. Dependent relationship reads must wait for their issuing result; do not guess future refs or spend calls just because they remain. If limits prevent a complete investigation, report only supported findings and state which records were not examined. Total tool-call allowance: ${request.maxToolCalls}; count every attempt, including failed calls.`,
    });
    const result = await agent.invoke(
      {
        messages: [
          { role: "user", content: request.prompt },
        ],
      },
      {
        signal: session.signal,
        recursionLimit: request.maxToolCalls * 2 + 4,
      },
    );
    const usage = collectUsage(
      result.messages as Array<{
        usage_metadata?: {
          input_tokens?: number;
          output_tokens?: number;
        };
        response_metadata?: {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            output_tokens_details?: {
              reasoning_tokens?: number;
            };
          };
        };
      }>,
    );
    return session.finish({
      answer: result.structuredResponse ?? null,
      usage: usage,
      finishReason: "completed",
    });
  } catch (error) {
    const messages =
      (
        error as {
          messages?: unknown[];
          state?: { messages?: unknown[] };
        }
      )?.messages ??
      (error as { state?: { messages?: unknown[] } })
        ?.state?.messages ??
      [];
    return session.finish({
      error,
      usage: collectUsage(
        messages as Parameters<typeof collectUsage>[0],
      ),
    });
  }
}
function collectUsage(
  messages: Array<{
    usage_metadata?: {
      input_tokens?: number;
      output_tokens?: number;
    };
    response_metadata?: {
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        output_tokens_details?: {
          reasoning_tokens?: number;
        };
      };
    };
  }>,
) {
  let inputTokens = 0,
    outputTokens = 0,
    reasoningTokens = 0;
  for (const m of messages) {
    const u =
      m.usage_metadata ?? m.response_metadata?.usage;
    inputTokens += u?.input_tokens ?? 0;
    outputTokens += u?.output_tokens ?? 0;
    reasoningTokens +=
      m.response_metadata?.usage?.output_tokens_details
        ?.reasoning_tokens ?? 0;
  }
  return {
    inputTokens,
    outputTokens,
    ...(reasoningTokens ? { reasoningTokens } : {}),
  };
}
if (import.meta.main) {
  const request = investigationRequestSchema.parse(
    JSON.parse(await Bun.stdin.text()),
  );
  console.log(
    JSON.stringify(await investigatePokedex(request)),
  );
}
