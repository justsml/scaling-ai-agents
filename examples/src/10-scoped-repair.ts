/**
 * 10 — Scoped repair
 *
 * An agent proposes a tiny data repair. The server
 * limits its tools, tests the proposal, canaries it,
 * and keeps rollback outside the agent's authority.
 *
 *   bun run snippet:10
 *
 * No model calls. No API key.
 */
import { strict as assert } from "node:assert";

const contract = "vendor-address-v8";
const policy = "equivalent-address-rename-canary-v1";
const tools = [
  "read-contract",
  "propose-mapping",
  "run-fixtures",
] as const;

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

const record = (
  value: unknown,
): Record<string, unknown> | null =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Accept one data-only operation—not generated code. */
export function parseCandidate(
  value: unknown,
): Candidate {
  const candidate = record(value);
  const keys = [
    "version",
    "parent",
    "contract",
    "from",
    "to",
    "operation",
  ];
  if (
    !candidate ||
    Object.keys(candidate).length !== keys.length ||
    keys.some(
      (key) => typeof candidate[key] !== "string",
    )
  )
    throw new Error("invalid mapping artifact");
  if (
    !/^address-map-v8-[a-z0-9-]+$/.test(
      candidate.version as string,
    ) ||
    candidate.contract !== contract ||
    candidate.from !== "postal_code" ||
    candidate.to !== "postalCode" ||
    candidate.operation !== "copy-string"
  )
    throw new Error(
      "mapping outside approved rename policy",
    );
  return candidate as Candidate;
}

export function mapAddress(
  input: unknown,
): Disposition {
  const row = record(input);
  if (
    !row ||
    typeof row.country !== "string" ||
    !row.country.trim()
  )
    return {
      kind: "quarantined",
      reason: "missing-country",
    };
  if ("status" in row)
    return {
      kind: "quarantined",
      reason: "ambiguous-semantics",
    };
  if (
    typeof row.postal_code !== "string" ||
    !row.postal_code.trim()
  )
    return {
      kind: "quarantined",
      reason: "postal-code-must-be-a-string",
    };
  if (
    ("zip" in row && row.zip !== row.postal_code) ||
    ("postalCode" in row &&
      row.postalCode !== row.postal_code)
  )
    return {
      kind: "quarantined",
      reason: "conflicting-postal-fields",
    };
  return {
    kind: "accepted",
    value: {
      country: row.country,
      postalCode: row.postal_code,
    },
  };
}

// The server owns both the cases and expected results.
const fixtures: Array<[unknown, Disposition]> = [
  [
    { country: "US", postal_code: "02108" },
    {
      kind: "accepted",
      value: { country: "US", postalCode: "02108" },
    },
  ],
  [
    { country: "CA", postal_code: "K1A 0B1" },
    {
      kind: "accepted",
      value: { country: "CA", postalCode: "K1A 0B1" },
    },
  ],
  [
    { postal_code: "02108" },
    { kind: "quarantined", reason: "missing-country" },
  ],
  [
    { country: "US", postal_code: 2108 },
    {
      kind: "quarantined",
      reason: "postal-code-must-be-a-string",
    },
  ],
  [
    {
      country: "US",
      postal_code: "02108",
      zip: "99999",
    },
    {
      kind: "quarantined",
      reason: "conflicting-postal-fields",
    },
  ],
  [
    {
      country: "US",
      postal_code: "02108",
      status: "pending",
    },
    {
      kind: "quarantined",
      reason: "ambiguous-semantics",
    },
  ],
];

export function certify(value: unknown) {
  const candidate = parseCandidate(value);
  for (const [input, expected] of fixtures)
    assert.deepEqual(mapAddress(input), expected);
  return { ...candidate };
}

/** The agent sees only this job-scoped tool surface. */
export class RepairJobs {
  private jobs = new Map<
    string,
    {
      deadline: number;
      callsLeft: number;
      grants: Set<string>;
    }
  >();
  readonly audit: Array<{
    jobId: string;
    tool: string;
    allowed: boolean;
    reason: string;
  }> = [];

  constructor(private now: () => number = Date.now) {}

  create(
    jobId: string,
    deadline: number,
    maxCalls = 3,
  ) {
    if (
      this.jobs.has(jobId) ||
      deadline <= this.now() ||
      !Number.isSafeInteger(maxCalls) ||
      maxCalls < 1
    )
      throw new Error("invalid job");
    this.jobs.set(jobId, {
      deadline,
      callsLeft: maxCalls,
      grants: new Set([
        "read-contract",
        "propose-mapping",
      ]),
    });
    return Object.freeze({
      jobId,
      tools: ["read-contract", "propose-mapping"],
      policy,
      riskClass: "read-and-propose",
    });
  }

  request(
    jobId: string,
    tool: string,
    args?: unknown,
    discovery = false,
  ): unknown {
    const job = this.jobs.get(jobId);
    const reason = !job
      ? "unknown-job"
      : this.now() >= job.deadline
        ? "deadline"
        : job.callsLeft <= 0
          ? "attempt-cap"
          : !tools.includes(
                tool as (typeof tools)[number],
              )
            ? "outside-job-tools"
            : !discovery && !job.grants.has(tool)
              ? "tool-not-granted"
              : "granted";
    this.audit.push({
      jobId,
      tool,
      allowed: reason === "granted",
      reason,
    });
    if (reason !== "granted") throw new Error(reason);
    job!.callsLeft--;
    if (discovery) {
      job!.grants.add(tool);
      return { tool, policy };
    }
    if (tool === "read-contract")
      return {
        contract,
        rename: "postal_code -> postalCode",
        operation: "copy-string",
      };
    if (tool === "propose-mapping")
      return parseCandidate(args);
    return {
      candidate: certify(args),
      fixturesPassed: fixtures.length,
    };
  }
}

/** Promotion and rollback stay on the trusted side. */
export class MappingRegistry {
  private active = "address-map-v7";
  private versions = new Map<string, Candidate>();
  private canary?: {
    version: string;
    parent: string;
    remaining: number;
  };

  get activeVersion() {
    return this.active;
  }

  promote(value: unknown, expectedParent: string) {
    const candidate = certify(value);
    if (
      this.active !== expectedParent ||
      candidate.parent !== expectedParent ||
      this.canary
    )
      throw new Error("stale-parent-or-active-canary");
    if (this.versions.has(candidate.version))
      throw new Error("version-already-exists");
    this.versions.set(candidate.version, candidate);
    this.active = candidate.version;
    this.canary = {
      version: candidate.version,
      parent: expectedParent,
      remaining: 100,
    };
    return {
      version: this.active,
      maxRecords: 100,
      policy,
    };
  }

  process(inputContract: string, inputs: unknown[]) {
    if (
      !this.canary ||
      inputContract !== contract ||
      inputs.length > this.canary.remaining
    )
      throw new Error("outside-canary-scope");
    this.canary.remaining -= inputs.length;
    return inputs.map(mapAddress);
  }

  rollback(version: string) {
    if (!this.canary || this.active !== version)
      throw new Error("stale-rollback");
    this.active = this.canary.parent;
    this.canary = undefined;
    return {
      active: this.active,
      reconcilePriorOutputs: true,
    };
  }
}

export const renameCandidate: Candidate = {
  version: "address-map-v8-candidate-1",
  parent: "address-map-v7",
  contract,
  from: "postal_code",
  to: "postalCode",
  operation: "copy-string",
};

if (import.meta.main) {
  const jobs = new RepairJobs(() => 0);
  const job = jobs.create("ingest-1042", 120_000, 4);
  const proposal = jobs.request(
    job.jobId,
    "propose-mapping",
    renameCandidate,
  );
  jobs.request(
    job.jobId,
    "run-fixtures",
    undefined,
    true,
  );
  jobs.request(job.jobId, "run-fixtures", proposal);

  const registry = new MappingRegistry();
  const activation = registry.promote(
    proposal,
    "address-map-v7",
  );
  const dispositions = registry.process(contract, [
    { country: "US", postal_code: "02108" },
    {
      country: "US",
      postal_code: "02108",
      status: "pending",
    },
  ]);
  console.log({
    activation,
    dispositions,
    rollback: registry.rollback(activation.version),
    modelCalls: 0,
  });
}
