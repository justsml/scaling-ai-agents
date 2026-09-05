import type { ChildProcessHandle, ProcessSpawner, SpawnOptions } from "./types";

export class BunProcessSpawner implements ProcessSpawner {
  spawn(argv: string[], options: SpawnOptions): ChildProcessHandle {
    const child = Bun.spawn(argv, {
      cwd: options.cwd,
      env: options.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      async writeStdin(data) {
        child.stdin.write(data);
        await child.stdin.flush();
      },
      async closeStdin() {
        child.stdin.end();
      },
      stdout: child.stdout,
      stderr: child.stderr,
      exited: child.exited,
      kill(signal) {
        child.kill(signal);
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

