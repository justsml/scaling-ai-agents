import { createGateway } from "./gateway";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be a valid TCP port");

const gateway = createGateway({
  upstreamBaseUrl: process.env.POKEAPI_BASE_URL ?? "http://pokeapi:80/",
  cursorSecret: process.env.POKEDEX_CURSOR_SECRET ?? "local-conformance-cursor-v1",
  controlSecret: process.env.POKEDEX_CONTROL_SECRET,
});

Bun.serve({
  hostname: "0.0.0.0",
  port,
  fetch: gateway.fetch,
});

console.log(JSON.stringify({ event: "gateway-listening", port }));
