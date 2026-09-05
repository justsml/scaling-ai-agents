/**
 * Agents that must be registered on the Mastra instance.
 *
 * Registration is not cosmetic. An agent reached through `mastra.getAgent()`
 * has the instance's storage, and without storage there is no snapshot, and
 * without a snapshot `approveToolCall()` / `declineToolCall()` cannot find the
 * suspended run. Any agent that uses human-in-the-loop or background tasks has
 * to live here rather than being constructed inline in a snippet.
 */
import { Agent } from "@mastra/core/agent";
import { WORKER_MODEL } from "../lib/models.js";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { applyPatchTool, probeServiceTool, slowAuditTool, statusTool } from "./tools.js";

/** Routine class in 00: one agent, read-only tools, three steps. */
export const routineAgent = new Agent({
  id: "routine-agent",
  name: "Routine Agent",
  description: "Answers a routine operational question from the status table.",
  instructions: `You answer operational questions in two sentences or fewer.
Use the service-status tool when the question is about a service's state.
If you do not have the evidence, say so plainly rather than guessing.`,
  model: WORKER_MODEL,
  tools: { statusTool },
});

/**
 * Consequential class in 00 and 03. The tool it holds carries
 * `requireApproval: true`, so this agent physically cannot complete the action
 * on its own however much budget is left.
 */
export const consequentialAgent = new Agent({
  id: "consequential-agent",
  name: "Consequential Agent",
  description: "Proposes a consequential action and stops for a human.",
  instructions: `You prepare consequential actions for human review.
When asked to apply a patch to a branch, call the apply-patch-to-main tool with a
one-line summary of the patch. Do not claim the action happened.`,
  model: WORKER_MODEL,
  tools: { applyPatchTool },
});

/**
 * 07 (a): one turn, several tool calls. The instructions push the model to
 * emit all four probes in a single step so the concurrency cap has something
 * to cap.
 */
export const probeAgent = new Agent({
  id: "probe-agent",
  name: "Probe Agent",
  description: "Probes several services in one turn.",
  instructions: `You check dependencies by calling the probe-service tool.
When asked about several services, call the tool once per service IN THE SAME
turn rather than one at a time. Then summarise in one line per service.`,
  model: WORKER_MODEL,
  tools: { probeServiceTool },
  // Background dispatch is opted in per tool; see 07 part (c).
  backgroundTasks: { tools: { probeServiceTool: false } },
});

/**
 * 07 (c): background tasks need BOTH a background task manager on the Mastra
 * instance and a memory backend, because a completed task writes its result to
 * memory and the loop is re-entered so the model can react to it. Without
 * memory, `stream({ untilIdle: true })` silently degrades to a plain stream.
 */
export const backgroundAgent = new Agent({
  id: "background-agent",
  name: "Background Agent",
  description: "Dispatches slow audits as background tasks and reacts when they finish.",
  instructions: `You audit evidence sources. When asked to audit several sources,
call the slow-audit tool once per source in the same turn. Report each result in
one line as the results arrive. Do not invent findings.`,
  model: WORKER_MODEL,
  tools: { slowAuditTool },
  memory: new Memory({
    storage: new LibSQLStore({
      id: "lab-memory",
      url: process.env.MASTRA_DB_URL ?? "file:./mastra.db",
    }),
  }),
  backgroundTasks: {
    tools: { slowAuditTool: { enabled: true, timeoutMs: 45_000 } },
    
  },
});
