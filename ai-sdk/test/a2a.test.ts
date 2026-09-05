import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createA2AServer } from "../src/snippets/06-remote-a2a";
import { A2AClient, type A2AMessage } from "../src/lib/a2a-client";

let server: ReturnType<typeof createA2AServer>;
let client: A2AClient;

beforeAll(() => {
  server = createA2AServer(0);
  client = new A2AClient(`http://localhost:${server.port}`);
});

afterAll(() => {
  server.stop(true);
});

describe("A2A client against the local 06 server", () => {
  test("agent card is reachable", async () => {
    const card = await client.getAgentCard();
    expect(card.name).toBe("competitor-remote");
    expect(card.capabilities.streaming).toBe(true);
  });

  test("tasks/get 404s for an unknown task", async () => {
    await expect(client.getTask("nonexistent")).rejects.toThrow();
  });

  test("tasks/cancel transitions a task to canceled", async () => {
    const message: A2AMessage = { role: "user", parts: [{ type: "text", text: "Patch it (will be cancelled)." }] };
    const pending = client.sendMessage(message, "cancel-me").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    const cancelled = await client.cancelTask("cancel-me");
    expect(cancelled.status.state).toBe("canceled");
    await pending;
  });
});
