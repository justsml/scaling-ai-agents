/**
 * 06 — Remote graph (LangGraph)
 *
 * Start a second LangGraph process, probe its network
 * protocol, then invoke its worker through RemoteGraph
 * as if it were a local Runnable.
 *
 * The local dev server exposes Agent Protocol, not A2A;
 * the probe makes that boundary visible at runtime.
 *
 *   bun run snippet:06
 *
 * One paid remote call. Needs OPENAI_API_KEY.
 */
import { HumanMessage } from "@langchain/core/messages";
import { RemoteGraph } from "@langchain/langgraph/remote";
import { probeA2A } from "../lib/a2a.ts";
import { startDevServer } from "../lib/devserver.ts";

const server = await startDevServer();
if (!server.ok) throw new Error(server.reason);

try {
  const probe = await probeA2A(
    process.env.A2A_BASE_URL ?? server.baseUrl,
    "competitor-remote",
  );
  console.log("protocol probe", {
    a2aAvailable: probe.available,
    attempts: probe.attempts,
    conclusion: probe.conclusion,
  });

  const worker = new RemoteGraph({
    graphId: "competitor-remote",
    url: server.baseUrl,
  });
  const result = (await worker.invoke(
    {
      messages: [
        new HumanMessage(
          "Fix runWhenReady so all readiness tests pass.",
        ),
      ],
    },
    {
      configurable: { thread_id: crypto.randomUUID() },
    },
  )) as { patch?: string };

  console.log("remote result", {
    graph: "competitor-remote",
    returnedPatch: Boolean(result.patch),
    patch: result.patch,
  });
} finally {
  await server.stop();
}
