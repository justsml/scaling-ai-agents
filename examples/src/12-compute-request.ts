// Resolve generated compute requests against server-owned policy. No cloud API calls.
// Resolution is a quote; the scheduler must atomically reserve it before provisioning.
export interface ComputeRequest {
  shape: string;
  class: string;
  count: number;
  durationSeconds: number;
  region: string;
  egress: readonly string[];
  costCapCents: number;
}
export interface ComputePolicy {
  tenant: string;
  job: string;
  region: string;
  deadline: number;
  availableCents: number;
  maxCount: number;
}
const catalog = {
  "sandbox-small": {
    shape: "provider-wait",
    regions: ["us-east"],
    maxDurationSeconds: 360,
    egress: ["provider.example", "storage.example", "callbacks.example"],
    centsPerWorkerMinute: 2,
  },
} as const;

export function resolveCompute(request: ComputeRequest, policy: ComputePolicy, now: number) {
  if (!Object.hasOwn(catalog, request.class)) throw new Error("unknown-compute-class");
  const entry = catalog[request.class as keyof typeof catalog];
  if (
    !Number.isSafeInteger(request.count) ||
    request.count < 1 ||
    request.count > policy.maxCount ||
    !Number.isSafeInteger(request.durationSeconds) ||
    request.durationSeconds < 1 ||
    request.durationSeconds > entry.maxDurationSeconds ||
    !Number.isSafeInteger(request.costCapCents) ||
    request.costCapCents < 0
  )
    throw new Error("invalid-compute-size-or-cap");
  if (
    request.shape !== entry.shape ||
    request.region !== policy.region ||
    !entry.regions.includes(request.region as "us-east")
  )
    throw new Error("shape-or-residency-denied");
  if (
    !Array.isArray(request.egress) ||
    request.egress.some((host) => !(entry.egress as readonly string[]).includes(host))
  )
    throw new Error("egress-denied");
  const expiresAt = now + request.durationSeconds * 1000;
  if (!Number.isSafeInteger(now) || expiresAt > policy.deadline) throw new Error("job-deadline");
  const reserveCents =
    request.count * Math.ceil(request.durationSeconds / 60) * entry.centsPerWorkerMinute;
  if (reserveCents > request.costCapCents || reserveCents > policy.availableCents)
    throw new Error("compute-budget");
  return {
    job: policy.job,
    billedTo: policy.tenant,
    class: request.class,
    count: request.count,
    region: request.region,
    egress: [...new Set(request.egress)],
    expiresAt,
    reserveCents,
    nextAction:
      "atomically reserve compute cost, provision, and record the lease and teardown obligation",
  };
}

export const computeRequest: ComputeRequest = {
  shape: "provider-wait",
  class: "sandbox-small",
  count: 8,
  durationSeconds: 360,
  region: "us-east",
  egress: ["provider.example", "storage.example"],
  costCapCents: 150,
};
if (import.meta.main) {
  console.log(
    JSON.stringify(
      resolveCompute(
        computeRequest,
        {
          tenant: "customer-4471",
          job: "batch-1042",
          region: "us-east",
          deadline: 600_000,
          availableCents: 150,
          maxCount: 8,
        },
        0,
      ),
      null,
      2,
    ),
  );
  console.log(
    "Fixture prices. No compute was provisioned. Worker teardown cannot release unknown provider charges.",
  );
}
