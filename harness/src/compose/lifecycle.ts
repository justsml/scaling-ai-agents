import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const harnessDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const composeFile = resolve(harnessDirectory, "compose.yaml");
const action = process.argv[2];
const gatewayPort = process.env.POKEDEX_GATEWAY_PORT ?? "3210";
const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}`;

if (!action || !["up", "ci-up", "test", "down", "clean", "reset"].includes(action)) {
  console.error("Usage: bun run src/compose/lifecycle.ts <up|ci-up|test|down|clean|reset>");
  process.exit(2);
}

async function compose(args: string[], inherit = true): Promise<number> {
  const child = Bun.spawn(["docker", "compose", "-f", composeFile, ...args], {
    cwd: harnessDirectory,
    stdin: inherit ? "inherit" : "ignore",
    stdout: inherit ? "inherit" : "pipe",
    stderr: inherit ? "inherit" : "pipe",
  });
  return child.exited;
}

async function diagnostics(): Promise<void> {
  console.error("\nCompose status:");
  await compose(["ps"], true);
  console.error("\nRecent bounded logs:");
  await compose(
    ["logs", "--no-color", "--tail", "80", "db", "cache", "seed", "pokeapi", "gateway"],
    true,
  );
}

async function waitForGateway(): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  let lastMessage = "gateway not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${gatewayBaseUrl}/healthz`, {
        signal: AbortSignal.timeout(3_000),
      });
      const body = (await response.json()) as { ok?: boolean; upstream?: string; message?: string };
      if (response.ok && body.ok && body.upstream === "bulbasaur") return;
      lastMessage = body.message ?? `health returned ${response.status}`;
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`Gateway did not become ready: ${lastMessage}`);
}

async function resetRuns(): Promise<void> {
  const response = await fetch(`${gatewayBaseUrl}/control/reset`, {
    method: "POST",
    headers: {
      "x-pokedex-control-secret":
        process.env.POKEDEX_CONTROL_SECRET ?? "local-conformance-control-v1",
    },
  });
  if (!response.ok) throw new Error(`Could not reset gateway run state (${response.status})`);
}

try {
  if (action === "up" || action === "ci-up") {
    if (action === "ci-up") {
      if (!process.env.COMPOSE_PROJECT_NAME)
        throw new Error("ci-up requires a unique COMPOSE_PROJECT_NAME");
      const cleaned = await compose(["down", "--volumes", "--remove-orphans"]);
      if (cleaned !== 0) throw new Error(`docker compose clean exited ${cleaned}`);
    }
    const status = await compose(["up", "-d", "--build", "--wait", "--wait-timeout", "600"]);
    if (status !== 0) throw new Error(`docker compose up exited ${status}`);
    await waitForGateway();
    console.log(`Local Pokédex gateway is ready at ${gatewayBaseUrl}`);
  } else if (action === "test") {
    await waitForGateway();
    await resetRuns();
    const child = Bun.spawn(["bun", "test", "test/"], {
      cwd: harnessDirectory,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, POKEDEX_INTEGRATION: "1", POKEDEX_GATEWAY_URL: gatewayBaseUrl },
    });
    process.exitCode = await child.exited;
  } else if (action === "down") {
    process.exitCode = await compose(["down", "--remove-orphans"]);
  } else if (action === "clean") {
    process.exitCode = await compose(["down", "--volumes", "--remove-orphans"]);
  } else {
    await resetRuns();
    console.log("Gateway run and fault state reset");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  if (action === "up" || action === "ci-up") await diagnostics();
  process.exitCode = 1;
}
