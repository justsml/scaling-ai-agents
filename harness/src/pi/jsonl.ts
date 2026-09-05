export interface JsonlDecoderOptions {
  maximumFrameBytes?: number;
  maximumTotalBytes?: number;
}

/** Strict JSONL decoder for Pi RPC: LF is the only record delimiter. */
export class JsonlDecoder<T = unknown> {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #maximumFrameBytes: number;
  readonly #maximumTotalBytes: number;
  #buffer = "";
  #totalBytes = 0;
  #finished = false;

  constructor(options: JsonlDecoderOptions = {}) {
    this.#maximumFrameBytes = options.maximumFrameBytes ?? 1024 * 1024;
    this.#maximumTotalBytes = options.maximumTotalBytes ?? 16 * 1024 * 1024;
  }

  push(chunk: Uint8Array): T[] {
    if (this.#finished) throw new Error("JSONL decoder is already finished");
    this.#totalBytes += chunk.byteLength;
    if (this.#totalBytes > this.#maximumTotalBytes) {
      throw new Error(`JSONL stream exceeded ${this.#maximumTotalBytes} bytes`);
    }
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    return this.#drain();
  }

  finish(): T[] {
    if (this.#finished) return [];
    this.#finished = true;
    this.#buffer += this.#decoder.decode();
    const frames = this.#drain();
    if (this.#buffer.length > 0) {
      throw new Error("JSONL stream ended with an unterminated frame");
    }
    return frames;
  }

  #drain(): T[] {
    const frames: T[] = [];
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) {
        if (new TextEncoder().encode(this.#buffer).byteLength > this.#maximumFrameBytes) {
          throw new Error(`JSONL frame exceeded ${this.#maximumFrameBytes} bytes`);
        }
        return frames;
      }
      let line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (new TextEncoder().encode(line).byteLength > this.#maximumFrameBytes) {
        throw new Error(`JSONL frame exceeded ${this.#maximumFrameBytes} bytes`);
      }
      try {
        frames.push(JSON.parse(line) as T);
      } catch (error) {
        throw new Error(`Invalid JSONL frame: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
