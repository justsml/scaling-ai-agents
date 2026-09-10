/**
 * 04 — Two kinds of batching (LangChain)
 *
 * An agent can emit several tool calls in one turn;
 * Runnable.batch sends several independent model inputs.
 * Both are client-side concurrency, not a provider's
 * offline Batch API.
 *
 *   bun run snippet:04
 *
 * Eight paid calls: a two-call agent loop plus six
 * batched classifications. Needs OPENAI_API_KEY.
 */
import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, tool } from "langchain";
import { z } from "zod";

const services = [
  "ws-app",
  "proxy",
  "auth",
  "billing",
  "search",
  "queue",
];

class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(readonly limit: number) {}

  async run<T>(work: () => Promise<T>) {
    if (this.active === this.limit)
      await new Promise<void>((ready) =>
        this.waiting.push(ready),
      );
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

const timeline: Array<{
  service: string;
  event: "start" | "finish";
  atMs: number;
}> = [];
const started = Date.now();
const threeAtATime = new Semaphore(3);

const probe = tool(
  ({ service }) =>
    threeAtATime.run(async () => {
      timeline.push({
        service,
        event: "start",
        atMs: Date.now() - started,
      });
      await Bun.sleep(150);
      timeline.push({
        service,
        event: "finish",
        atMs: Date.now() - started,
      });
      return `${service}: ok`;
    }),
  {
    name: "probe_service",
    description: "Probe one named service.",
    schema: z.object({ service: z.string() }),
  },
);

const agent = createAgent({
  model: "openai:gpt-5.6-luna",
  tools: [probe],
  systemPrompt: `Call probe_service once for every
named service. Emit all calls in one turn.`,
});
const agentResult = await agent.invoke({
  messages: [
    new HumanMessage(`Probe: ${services.join(", ")}.`),
  ],
});
console.log("parallel tool calls", {
  messages: agentResult.messages.length,
  concurrency: 3,
  timeline,
});

const classifier = new ChatOpenAI({
  model: "gpt-5.6-luna",
  maxRetries: 0,
});
const classifications = await classifier.batch(
  services.map(
    (service) =>
      `Classify ${service} as infra, product, or unknown. ` +
      "Reply with one word.",
  ),
  { maxConcurrency: 3 },
);
console.log(
  "Runnable.batch",
  services.map((service, index) => ({
    service,
    classification: classifications[index]?.text.trim(),
  })),
);
