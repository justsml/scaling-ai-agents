import { spawn } from "node:child_process";
import type { ChildProcessHandle, ProcessSpawner, SpawnOptions } from "./types";

/** Process adapter that works in both Bun controllers and Node-hosted Pi extensions. */
export class NodeProcessSpawner implements ProcessSpawner {
  spawn(argv: string[], options: SpawnOptions): ChildProcessHandle {
    const [command, ...args] = argv;
    if (!command) throw new Error("process command is required");
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      // `close` can wait forever when a grandchild inherits Pi's output pipes.
      // Process lifecycle is represented by `exit`; stream draining is bounded
      // independently by the RPC client.
      child.once("exit", (code, signal) => {
        if (code !== null) resolve(code);
        else resolve(signal === "SIGKILL" ? 137 : 143);
      });
    });

    return {
      writeStdin(data) {
        return new Promise<void>((resolve, reject) => {
          child.stdin.write(data, (error) => error ? reject(error) : resolve());
        });
      },
      closeStdin() {
        return new Promise<void>((resolve, reject) => {
          child.stdin.once("error", reject);
          child.stdin.end(resolve);
        });
      },
      stdout: child.stdout as AsyncIterable<Uint8Array>,
      stderr: child.stderr as AsyncIterable<Uint8Array>,
      exited,
      kill(signal) {
        child.kill(signal);
      },
      closeOutput() {
        child.stdout.destroy();
        child.stderr.destroy();
      },
    };
  }
}

export async function collectUtf8(
  stream: AsyncIterable<Uint8Array>,
  maximumBytes: number,
): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) throw new Error(`process output exceeded ${maximumBytes} bytes`);
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
