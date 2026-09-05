import { describe, expect, test } from "bun:test";
import { JsonlDecoder } from "../src/pi/jsonl";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("Pi RPC JSONL decoder", () => {
  test("decodes frames split at arbitrary chunk boundaries", () => {
    const decoder = new JsonlDecoder<{ n: number }>();
    expect(decoder.push(bytes('{"n":'))).toEqual([]);
    expect(decoder.push(bytes('1}\n{"n":2}\r'))).toEqual([{ n: 1 }]);
    expect(decoder.push(bytes("\n"))).toEqual([{ n: 2 }]);
    expect(decoder.finish()).toEqual([]);
  });

  test("preserves Unicode line and paragraph separators inside JSON strings", () => {
    const decoder = new JsonlDecoder<{ text: string }>();
    const frames = decoder.push(bytes('{"text":"a\u2028b\u2029c"}\n'));
    expect(frames).toEqual([{ text: "a\u2028b\u2029c" }]);
  });

  test("rejects malformed and unterminated frames", () => {
    expect(() => new JsonlDecoder().push(bytes("nope\n"))).toThrow("Invalid JSONL frame");
    const decoder = new JsonlDecoder();
    decoder.push(bytes('{"ok":true}'));
    expect(() => decoder.finish()).toThrow("unterminated frame");
  });

  test("enforces frame and stream bounds", () => {
    expect(() => new JsonlDecoder({ maximumFrameBytes: 4 }).push(bytes("12345"))).toThrow("frame exceeded");
    expect(() => new JsonlDecoder({ maximumTotalBytes: 4 }).push(bytes("12345"))).toThrow("stream exceeded");
  });
});

