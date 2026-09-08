/**
 * The one Mastra instance every snippet shares.
 *
 * Storage is LibSQL on disk (gitignored) because three
 * separate features need persistence: human-in-the-loop
 * snapshots (03), background tasks (07), and dynamic
 * workflow definitions (05). An in-memory store would
 * make those snippets lie about what they demonstrate.
 */
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import {
  MastraStorageExporter,
  Observability,
  SensitiveDataFilter,
} from "@mastra/observability";
import {
  applyPatchTool,
  compiledReadinessTool,
  probeServiceTool,
  slowAuditTool,
  statusTool,
} from "./tools.js";
import {
  backgroundAgent,
  consequentialAgent,
  probeAgent,
  routineAgent,
} from "./agents.js";
import {
  fixtureScorer,
  rubricJudgeScorer,
} from "../lib/judge.js";

export const SERVICE_NAME = "scaling-ai-agents-mastra";

export const storage = new LibSQLStore({
  id: "lab",
  url: "file:./mastra.db",
});

/**
 * requestContextKeys lift these four values out of the
 * RequestContext and onto every span, so a trace in
 * Studio can be filtered by profile or region without
 * the snippet passing them again on each call.
 */
export const observability = new Observability({
  configs: {
    default: {
      serviceName: SERVICE_NAME,
      requestContextKeys: [
        "requestId",
        "profile",
        "region",
        "dataClass",
      ],
      exporters: [new MastraStorageExporter()],
      spanOutputProcessors: [new SensitiveDataFilter()],
    },
  },
});

export const mastra = new Mastra({
  storage,
  observability,
  agents: {
    routineAgent,
    consequentialAgent,
    probeAgent,
    backgroundAgent,
  },
  tools: {
    statusTool,
    applyPatchTool,
    probeServiceTool,
    slowAuditTool,
    compiledReadinessTool,
  },
  scorers: { rubricJudgeScorer, fixtureScorer },
  // 07 (c): background-eligible tools queue here
  // instead of blocking the loop.
  backgroundTasks: {
    enabled: true,
    globalConcurrency: 4,
    perAgentConcurrency: 2,
    backpressure: "queue",
    defaultTimeoutMs: 60_000,
  },
  server: {
    port: Number(process.env.PORT ?? 4111),
    middleware: [
      // Studio and any HTTP caller get the same
      // request-context keys the snippets set by hand,
      // so traces from both look the same.
      async (context: any, next: any) => {
        const rc = context.get("requestContext");
        if (rc && typeof rc.set === "function") {
          if (!rc.has?.("requestId"))
            rc.set("requestId", crypto.randomUUID());
          if (!rc.has?.("region"))
            rc.set(
              "region",
              context.req.header("x-region") ?? "us",
            );
          if (!rc.has?.("dataClass"))
            rc.set(
              "dataClass",
              context.req.header("x-data-class") ??
                "internal",
            );
        }
        await next();
      },
    ],
  },
});
