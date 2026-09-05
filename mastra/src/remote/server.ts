/**
 * Serves the remote Mastra instance over HTTP so its A2A endpoints are real.
 *
 * `mastra dev` would also work, but it bundles the project first and takes
 * several seconds; it also has no --port flag in the installed CLI (1.27.3),
 * so the port would have to come from config anyway. Mounting the Hono adapter
 * on Bun.serve starts in milliseconds and is what 06 spawns as a child process.
 */
import { Hono } from "hono";
import { MastraServer, type HonoBindings, type HonoVariables } from "@mastra/hono";
import { InMemoryTaskStore } from "@mastra/server/a2a/store";
import { remoteMastra } from "./index.js";

const port = Number(process.env.REMOTE_PORT ?? 4112);

const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>();
// The adapter does not create a task store for you. Without one, every
// message/stream request dies inside claimInterruptedTaskResume, and the
// client sees an empty stream rather than an error. A2A tasks live in memory,
// so a restart loses them.
const server = new MastraServer({ app, mastra: remoteMastra, taskStore: new InMemoryTaskStore() });
await server.init();

const listener = Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 120 });

// 06 waits for this exact line before it starts calling the agent card URL.
console.log(`REMOTE_READY http://127.0.0.1:${listener.port}`);

const shutdown = () => {
  void listener.stop(true).then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
