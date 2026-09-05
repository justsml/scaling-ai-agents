import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const EVIDENCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class EvidenceStore<T> {
  readonly #memory = new Map<string, T>();

  constructor(
    readonly directory: string,
    readonly maximumReadBytes = 4 * 1024 * 1024,
  ) {}

  async put(value: T): Promise<string> {
    const id = crypto.randomUUID();
    await mkdir(this.directory, { recursive: true });
    const destination = this.#path(id);
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    const body = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
    this.#memory.set(id, value);
    return id;
  }

  async get(id: string): Promise<T | undefined> {
    if (!EVIDENCE_ID.test(id)) return undefined;
    const cached = this.#memory.get(id);
    if (cached !== undefined) return cached;
    const file = Bun.file(this.#path(id));
    if (!(await file.exists())) return undefined;
    if (file.size > this.maximumReadBytes) throw new Error(`Evidence ${id} exceeds the read bound`);
    const value = JSON.parse(await readFile(this.#path(id), "utf8")) as T;
    this.#memory.set(id, value);
    return value;
  }

  #path(id: string): string {
    if (!EVIDENCE_ID.test(id)) throw new Error("Invalid evidence id");
    return resolve(this.directory, `${id}.json`);
  }
}

