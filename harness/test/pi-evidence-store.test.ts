import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { EvidenceStore } from "../src/pi/evidence-store";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("Pi evidence store", () => {
  test("atomically stores generated IDs and rejects path-like IDs", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pokedex-evidence-"));
    directories.push(directory);
    const store = new EvidenceStore<{ answer: number }>(directory);
    const id = await store.put({ answer: 42 });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.get(id)).toEqual({ answer: 42 });
    expect(await store.get("../outside")).toBeUndefined();
    expect(await readdir(directory)).toEqual([`${id}.json`]);
  });
});
