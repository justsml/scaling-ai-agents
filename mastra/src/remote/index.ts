/**
 * A second Mastra instance, in its own process, exposed
 * over A2A.
 *
 * This is deliberately a separate file from
 * src/mastra/index.ts. The point of a remote worker is
 * that the caller cannot see inside it: not its tools,
 * not its instructions, not its memory, not its model.
 * The agent card publishes a name, a description and a
 * skill list, and that is all.
 */
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { LibSQLStore } from "@mastra/libsql";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { WORKER_MODEL } from "../lib/models.js";

/**
 * A private tool. It exists on the remote side only;
 * nothing about it appears on the agent card beyond the
 * fact that the agent has *a* skill.
 */
const backoffAdviceTool = createTool({
  id: "backoff-advice",
  description:
    "Return the recommended backoff shape for a readiness loop.",
  inputSchema: z.object({
    baseDelayMs: z.number().default(50),
    deadlineMs: z.number().default(5000),
  }),
  outputSchema: z.object({
    shape: z.string(),
    capNote: z.string(),
  }),
  execute: async ({ baseDelayMs, deadlineMs }) => ({
    shape: `exponential from ${baseDelayMs}ms, doubling, capped at 5000ms`,
    capNote: `each sleep additionally clamped to the time left of the ${deadlineMs}ms deadline`,
  }),
});

export const competitorRemote = new Agent({
  id: "competitor-remote",
  name: "Remote Competitor",
  description:
    "Proposes a corrected readiness.ts. Runs on separate infrastructure; its prompt and tools are private.",
  instructions: `You are a remote patch competitor for a TypeScript module named readiness.ts.

Return the COMPLETE new file contents. No diff, no markdown fences, no prose.
Do not import anything. Do not mention the test file. Use the injected now/sleep
from options rather than Date.now or setTimeout when they are provided.

The four outcomes are: ran, denied (EACCES, first probe, no retry), deadline
(partial: true and a specific reason), and ECONNREFUSED/ETIMEDOUT retried with
exponential backoff.`,
  model: WORKER_MODEL,
  tools: { backoffAdviceTool },
});

export const remoteMastra = new Mastra({
  agents: { competitorRemote },
  storage: new LibSQLStore({
    id: "remote",
    url:
      process.env.REMOTE_DB_URL ?? "file:./remote.db",
  }),
  server: {
    port: Number(process.env.REMOTE_PORT ?? 4112),
    host: "127.0.0.1",
  },
});
