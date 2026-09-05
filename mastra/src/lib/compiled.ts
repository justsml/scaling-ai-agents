/**
 * The compiled registry: the Compile axis in one file.
 *
 * Once a tournament has produced a patch that goes green against the fixture
 * tests, the winning path stops being a search problem. We key it by a hash of
 * the exact buggy source it was compiled from and store it on disk. The next
 * matching request runs a pure function and makes zero model calls.
 *
 * The hash is the guard, not a fuzzy match. A different broken file with a
 * similar error message hashes differently and misses the rule, which is the
 * negative case 05 prints on purpose.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PKG_ROOT } from "./setup.js";
import type { ReferenceArtifact } from "./readiness-challenge.js";

const REGISTRY_PATH = join(PKG_ROOT, ".compiled", "registry.json");

export interface CompiledRule {
  sourceHash: string;
  patch: string;
  /** Which competitor produced it, and when. Provenance is part of the artifact. */
  wonBy: string;
  compiledAt: string;
  testsPassed: number;
  testsFailed: number;
}

export function hashSource(source: string): string {
  // Normalise whitespace so trailing-newline noise does not create a new key.
  return createHash("sha256").update(source.trim().replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);
}

function loadRegistry(): Record<string, CompiledRule> {
  if (!existsSync(REGISTRY_PATH)) return {};
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as Record<string, CompiledRule>;
  } catch {
    return {};
  }
}

function saveRegistry(reg: Record<string, CompiledRule>): void {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2), "utf8");
}

export function registerCompiled(rule: CompiledRule): void {
  const reg = loadRegistry();
  reg[rule.sourceHash] = rule;
  saveRegistry(reg);
}

export function lookupCompiled(sourceHash: string): CompiledRule | null {
  return loadRegistry()[sourceHash] ?? null;
}

export function listCompiled(): CompiledRule[] {
  return Object.values(loadRegistry());
}

export function clearCompiled(): void {
  saveRegistry({});
}

/**
 * Return the patch for a hash, falling back to the explicitly loaded Reference
 * artifact when the hash is its target fixture. The caller owns loading that
 * artifact through the Readiness challenge; this registry owns no fixtures.
 */
export function compiledPatchFor(sourceHash: string, fallback?: ReferenceArtifact): string {
  const stored = lookupCompiled(sourceHash);
  if (stored) return stored.patch;
  if (fallback && sourceHash === fallback.targetIdentity) return fallback.source;
  return "";
}
