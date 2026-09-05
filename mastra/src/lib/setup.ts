/**
 * bun run setup
 *
 * Copies ../shared/fixtures into src/fixtures. Copy, never import: the three
 * stacks must stay independent, so the only thing they share is the bytes of
 * the fixture files at setup time.
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = resolve(here, "..", "..");
export const FIXTURES_DIR = join(PKG_ROOT, "src", "fixtures");
const SHARED = resolve(PKG_ROOT, "..", "shared", "fixtures");

export async function copyFixtures(): Promise<string[]> {
  if (!existsSync(SHARED)) {
    throw new Error(`shared fixtures not found at ${SHARED}. Run from inside the monorepo checkout.`);
  }
  await mkdir(FIXTURES_DIR, { recursive: true });
  await cp(SHARED, FIXTURES_DIR, { recursive: true });
  return (await readdir(FIXTURES_DIR)).sort();
}

if (import.meta.main) {
  const files = await copyFixtures();
  console.log(`copied ${files.length} entries into src/fixtures:`);
  for (const f of files) console.log(`  ${f}`);
}
