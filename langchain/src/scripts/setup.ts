/**
 * setup.ts — copy `shared/fixtures/` into
 * `src/fixtures/`.
 *
 *   bun run setup
 *
 * Copy, never import. Each stack in this repo owns its
 * fixtures outright so the three implementations can be
 * compared without being coupled: nothing in
 * `langchain/` reaches outside its own directory at
 * runtime.
 *
 * Re-running is safe and idempotent. It overwrites, so
 * local edits to `src/fixtures/` are lost — which is
 * intentional: the shared copy is the source of truth.
 */

import {
  cp,
  mkdir,
  readdir,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(
  new URL("../..", import.meta.url),
);
const SHARED = join(HERE, "..", "shared", "fixtures");
const LOCAL = join(HERE, "src", "fixtures");

const REQUIRED = [
  "readiness.ts",
  "readiness.test.ts",
  "rubric.md",
  "prices.json",
  "requests.json",
  "incident/network.log",
  "incident/app.log",
  "incident/state.json",
  "incident/ground-truth.md",
];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log(
    "setup: copying shared fixtures into src/fixtures/",
  );

  if (!(await exists(SHARED))) {
    console.log(`skipped: ${SHARED} does not exist.`);
    console.log(
      "  This package ships src/fixtures/ already; nothing to do.",
    );
    process.exit(0);
  }

  await mkdir(LOCAL, { recursive: true });
  await cp(SHARED, LOCAL, { recursive: true });

  const missing: string[] = [];
  for (const rel of REQUIRED) {
    if (!(await exists(join(LOCAL, rel))))
      missing.push(rel);
  }

  const listed = await readdir(LOCAL, {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of listed) {
    if (entry.isFile())
      console.log(
        `  ${entry.parentPath.replace(HERE, "./").replace("//", "/")}/${entry.name}`,
      );
  }

  if (missing.length > 0) {
    console.error(
      `\nsetup FAILED: missing ${missing.join(", ")}`,
    );
    process.exit(1);
  }
  console.log(
    "\nsetup ok: all required fixtures present.",
  );
}

if (import.meta.main) {
  await main();
}
