import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { NodeProcessSpawner, delay } from "../src/pi/process";

describe("Node-hosted Pi extension runtime", () => {
  test("observes process exit when a grandchild inherits output pipes", async () => {
    const child = new NodeProcessSpawner().spawn(
      [
        process.execPath,
        "-e",
        "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},1000)'],{stdio:['ignore',1,2]}).unref()",
      ],
      { cwd: process.cwd(), env: process.env },
    );
    await child.closeStdin();
    const exitCode = await Promise.race([child.exited, delay(300).then(() => "timeout" as const)]);
    child.closeOutput?.();
    expect(exitCode).toBe(0);
  });

  test("health, evidence, and child-process adapters do not require Bun globals", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-node-runtime-"));
    const repoRoot = resolve(import.meta.dir, "../..");
    const script = String.raw`
      const { createJiti } = await import("jiti");
      const load = createJiti(import.meta.url);
      const [{ StackRunner }, { EvidenceStore }, { NodeProcessSpawner }, { collectUtf8 }] = await Promise.all([
        load.import("./src/pi/stack-runner.ts"),
        load.import("./src/pi/evidence-store.ts"),
        load.import("./src/pi/process.ts"),
        load.import("./src/pi/process.ts"),
      ]);
      const health = await new StackRunner(process.argv[2]).health("ai-sdk");
      const store = new EvidenceStore(process.argv[1]);
      const id = await store.put({ ok: true });
      const stored = await store.get(id);
      const child = new NodeProcessSpawner().spawn([process.execPath, "-e", "process.stdout.write('spawn-ok')"], {
        cwd: process.cwd(),
        env: process.env,
      });
      await child.closeStdin();
      const output = await collectUtf8(child.stdout, 1024);
      const exitCode = await child.exited;
      process.stdout.write(JSON.stringify({ health, stored, output, exitCode }));
    `;
    try {
      const child = Bun.spawn(["node", "--input-type=module", "-e", script, directory, repoRoot], {
        cwd: resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        health: { stack: "ai-sdk", entrypointExists: true, bunAvailable: true },
        stored: { ok: true },
        output: "spawn-ok",
        exitCode: 0,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
