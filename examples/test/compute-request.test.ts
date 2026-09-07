import { expect, test } from "bun:test";
import { computeRequest, resolveCompute } from "../src/12-compute-request";
const policy = {
  tenant: "server-tenant",
  job: "server-job",
  region: "us-east",
  deadline: 600_000,
  availableCents: 150,
  maxCount: 8,
};
test("compute quote derives billing identity from server policy", () => {
  const output = resolveCompute(
    { ...computeRequest, billTo: "someone-else" } as typeof computeRequest,
    policy,
    0,
  );
  expect(output).toMatchObject({
    billedTo: "server-tenant",
    job: "server-job",
    reserveCents: 96,
    expiresAt: 360_000,
  });
});
test.each([
  { class: "gpu-huge" },
  { class: "__proto__" },
  { shape: "gpu" },
  { region: "eu-west" },
  { egress: ["attacker.example"] },
  { count: 9 },
  { count: -1 },
  { durationSeconds: 361 },
  { costCapCents: 95 },
  { count: Number.NaN },
])("rejects generated escalation %j", (change) => {
  expect(() => resolveCompute({ ...computeRequest, ...change }, policy, 0)).toThrow();
});
test("remaining budget and job deadline both constrain compute", () => {
  expect(() => resolveCompute(computeRequest, { ...policy, availableCents: 95 }, 0)).toThrow(
    "budget",
  );
  expect(() => resolveCompute(computeRequest, policy, 300_000)).toThrow("deadline");
});
