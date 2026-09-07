// Offline policy example. Proposed mappings are untrusted data, never executable code.
// A framework agent may propose this JSON; authorization and validation stay here.
import { strict as assert } from "node:assert";

const CONTRACT = "vendor-address-v8";
const POLICY = "equivalent-address-rename-canary-v1";
const TOOLS = ["read-contract", "propose-mapping", "run-fixtures"] as const;
type ToolName = (typeof TOOLS)[number];
export type Candidate = {
  version: string;
  parent: string;
  contract: string;
  from: string;
  to: string;
  operation: string;
};
type Address = { country: string; postalCode: string };
export type Disposition =
  | { kind: "accepted"; value: Address }
  | { kind: "quarantined"; reason: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseCandidate(value: unknown): Candidate {
  const r = record(value);
  const keys = ["version", "parent", "contract", "from", "to", "operation"];
  if (!r || Object.keys(r).length !== keys.length || keys.some((k) => typeof r[k] !== "string")) {
    throw new Error("invalid mapping artifact");
  }
  if (
    !/^address-map-v8-[a-z0-9-]+$/.test(r.version as string) ||
    r.contract !== CONTRACT ||
    r.from !== "postal_code" ||
    r.to !== "postalCode" ||
    r.operation !== "copy-string"
  ) {
    throw new Error("mapping outside approved rename policy");
  }
  return r as Candidate;
}

export function mapAddress(input: unknown): Disposition {
  const r = record(input);
  if (!r || typeof r.country !== "string" || !r.country.trim()) {
    return { kind: "quarantined", reason: "missing-country" };
  }
  // The contract fixture gives no approved interpretation for a status field.
  if ("status" in r) return { kind: "quarantined", reason: "ambiguous-semantics" };
  if (typeof r.postal_code !== "string" || !r.postal_code.trim()) {
    return { kind: "quarantined", reason: "postal-code-must-be-a-string" };
  }
  if (
    ("zip" in r && r.zip !== r.postal_code) ||
    ("postalCode" in r && r.postalCode !== r.postal_code)
  ) {
    return { kind: "quarantined", reason: "conflicting-postal-fields" };
  }
  return { kind: "accepted", value: { country: r.country, postalCode: r.postal_code } };
}

// Server-owned cases. A proposer cannot submit a passing score or replace this suite.
const FIXTURES: Array<[unknown, Disposition]> = [
  [
    { country: "US", postal_code: "02108" },
    { kind: "accepted", value: { country: "US", postalCode: "02108" } },
  ],
  [
    { country: "CA", postal_code: "K1A 0B1" },
    { kind: "accepted", value: { country: "CA", postalCode: "K1A 0B1" } },
  ],
  [{ postal_code: "02108" }, { kind: "quarantined", reason: "missing-country" }],
  [
    { country: "US", postal_code: 2108 },
    { kind: "quarantined", reason: "postal-code-must-be-a-string" },
  ],
  [
    { country: "US", postal_code: "02108", zip: "99999" },
    { kind: "quarantined", reason: "conflicting-postal-fields" },
  ],
  [
    { country: "US", postal_code: "02108", status: "pending" },
    { kind: "quarantined", reason: "ambiguous-semantics" },
  ],
];

export function certify(value: unknown): Candidate {
  const candidate = parseCandidate(value);
  // This DSL only permits the server-owned copy-string implementation above.
  // Adding an operation requires new independent expected outputs, not an agent score.
  for (const [input, expected] of FIXTURES) assert.deepEqual(mapAddress(input), expected);
  return { ...candidate };
}

export class RepairJobs {
  private jobs = new Map<string, { deadline: number; callsLeft: number; grants: Set<string> }>();
  readonly audit: Array<{ jobId: string; tool: string; allowed: boolean; reason: string }> = [];
  constructor(private now: () => number = Date.now) {}

  // Called by the authenticated orchestrator, never exposed as an agent tool.
  create(jobId: string, deadline: number, maxCalls = 3) {
    if (
      this.jobs.has(jobId) ||
      !Number.isFinite(deadline) ||
      deadline <= this.now() ||
      !Number.isSafeInteger(maxCalls) ||
      maxCalls < 1
    )
      throw new Error("invalid job");
    this.jobs.set(jobId, {
      deadline,
      callsLeft: maxCalls,
      grants: new Set(["read-contract", "propose-mapping"]),
    });
    return Object.freeze({
      jobId,
      tools: ["read-contract", "propose-mapping"],
      qualityFloor: "every record repaired, quarantined or unresolved",
      policy: POLICY,
      riskClass: "read-and-propose",
    });
  }

  // Discovery and invocation use the same check. Tool names do not confer permission.
  request(jobId: string, tool: string, args?: unknown, discovery = false): unknown {
    const job = this.jobs.get(jobId);
    const reason = !job
      ? "unknown-job"
      : this.now() >= job.deadline
        ? "deadline"
        : job.callsLeft <= 0
          ? "attempt-cap"
          : !TOOLS.includes(tool as ToolName)
            ? "outside-job-tools"
            : !discovery && !job.grants.has(tool)
              ? "tool-not-granted"
              : "granted";
    this.audit.push({ jobId, tool, allowed: reason === "granted", reason });
    if (reason !== "granted") throw new Error(reason);
    job!.callsLeft--;
    if (discovery) {
      job!.grants.add(tool);
      return { tool, policy: POLICY };
    }
    if (tool === "read-contract")
      return { contract: CONTRACT, rename: "postal_code -> postalCode", operation: "copy-string" };
    if (tool === "propose-mapping") return parseCandidate(args);
    return { candidate: certify(args), fixturesPassed: FIXTURES.length };
  }
}

export class MappingRegistry {
  private active = "address-map-v7";
  private versions = new Map<string, Candidate>();
  private canary: { version: string; parent: string; remaining: number } | undefined;

  get activeVersion() {
    return this.active;
  }

  // Trusted promotion job only. No generated agent receives this method as a tool.
  promote(value: unknown, expectedParent: string) {
    const candidate = certify(value);
    if (this.active !== expectedParent || candidate.parent !== expectedParent || this.canary)
      throw new Error("stale-parent-or-active-canary");
    if (this.versions.has(candidate.version)) throw new Error("version-already-exists");
    this.versions.set(candidate.version, candidate);
    this.active = candidate.version;
    this.canary = { version: candidate.version, parent: expectedParent, remaining: 100 };
    return { version: this.active, maxRecords: 100, policy: POLICY };
  }

  process(contract: string, inputs: unknown[]): Disposition[] {
    if (!this.canary || contract !== CONTRACT || inputs.length > this.canary.remaining)
      throw new Error("outside-canary-scope");
    this.canary.remaining -= inputs.length;
    return inputs.map(mapAddress);
  }

  rollback(version: string) {
    if (!this.canary || this.active !== version) throw new Error("stale-rollback");
    this.active = this.canary.parent;
    this.canary = undefined;
    // The caller must retain raw input and disposition IDs for replay/reconciliation.
    return { active: this.active, reconcilePriorOutputs: true };
  }
}

export const renameCandidate: Candidate = {
  version: "address-map-v8-candidate-1",
  parent: "address-map-v7",
  contract: CONTRACT,
  from: "postal_code",
  to: "postalCode",
  operation: "copy-string",
};

export function demo() {
  const jobs = new RepairJobs(() => 0);
  const contract = jobs.create("ingest-1042", 120_000, 4);
  const proposal = jobs.request(contract.jobId, "propose-mapping", renameCandidate);
  jobs.request(contract.jobId, "run-fixtures", undefined, true);
  jobs.request(contract.jobId, "run-fixtures", proposal);
  try {
    jobs.request(contract.jobId, "send-email");
  } catch {
    /* Printed in the denied-request log. */
  }
  const registry = new MappingRegistry();
  const activation = registry.promote(proposal, "address-map-v7");
  const dispositions = registry.process(CONTRACT, [
    { country: "US", postal_code: "02108" },
    { country: "US", postal_code: "02108", status: "pending" },
  ]);
  assert.equal(dispositions.length, 2);
  console.log(
    JSON.stringify(
      {
        contract,
        activation,
        dispositions,
        audit: jobs.audit,
        rollback: registry.rollback(activation.version),
        modelCalls: 0,
        costUsd: 0,
      },
      null,
      2,
    ),
  );
}
if (import.meta.main) demo();
