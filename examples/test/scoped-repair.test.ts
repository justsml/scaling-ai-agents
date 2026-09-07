import { expect, test } from "bun:test";
import {
  certify,
  mapAddress,
  MappingRegistry,
  renameCandidate,
  RepairJobs,
} from "../src/10-scoped-repair";
test("discovery and invocation reject tools outside the server job", () => {
  const jobs = new RepairJobs(() => 0);
  const contract = jobs.create("job", 100);
  contract.tools.push("send-email" as never);
  expect(() => jobs.request("job", "send-email", undefined, true)).toThrow("outside-job-tools");
  expect(() => jobs.request("job", "send-email")).toThrow("outside-job-tools");
  expect(() => jobs.request("forged", "read-contract")).toThrow("unknown-job");
  expect(jobs.audit.filter((e) => !e.allowed)).toHaveLength(3);
});
test("deadline and call cap apply before handlers execute", () => {
  let now = 0;
  const jobs = new RepairJobs(() => now);
  jobs.create("limited", 100, 1);
  jobs.request("limited", "read-contract");
  expect(() => jobs.request("limited", "read-contract")).toThrow("attempt-cap");
  jobs.create("expired", 100);
  now = 100;
  expect(() => jobs.request("expired", "read-contract")).toThrow("deadline");
});
test("certification rejects changed semantics and forged scores", () => {
  expect(certify(renameCandidate)).toEqual(renameCandidate);
  expect(() => certify({ ...renameCandidate, operation: "parse-number" })).toThrow("outside");
  expect(() => certify({ ...renameCandidate, fixturesPassed: 100 })).toThrow("invalid");
  expect(() => certify({ ...renameCandidate, contract: "vendor-address-v9" })).toThrow("outside");
});
test("every input gets a disposition without losing leading zeroes", () => {
  const result = [
    { country: "US", postal_code: "02108" },
    { country: "US", postal_code: "02108", status: "pending" },
    { country: "US", postal_code: "02108", postalCode: "99999" },
    null,
  ].map(mapAddress);
  expect(result).toHaveLength(4);
  expect(result[0]).toEqual({ kind: "accepted", value: { country: "US", postalCode: "02108" } });
  expect(result.slice(1).every((r) => r.kind === "quarantined")).toBe(true);
});
test("promotion revalidates, rejects stale parents, and owns a copy", () => {
  const registry = new MappingRegistry();
  expect(() =>
    registry.promote({ ...renameCandidate, operation: "execute-code" }, "address-map-v7"),
  ).toThrow();
  const proposed = { ...renameCandidate };
  registry.promote(proposed, "address-map-v7");
  proposed.version = "attacker";
  expect(registry.activeVersion).toBe(renameCandidate.version);
  expect(() =>
    registry.promote(
      { ...renameCandidate, version: "address-map-v8-candidate-2" },
      "address-map-v7",
    ),
  ).toThrow("stale");
});
test("canary counts across calls; rollback requires output reconciliation", () => {
  const registry = new MappingRegistry();
  registry.promote(renameCandidate, "address-map-v7");
  expect(() => registry.process("vendor-address-v9", [{}])).toThrow("scope");
  registry.process("vendor-address-v8", Array(60).fill({ country: "US", postal_code: "02108" }));
  registry.process("vendor-address-v8", Array(40).fill({ country: "US", postal_code: "02108" }));
  expect(() => registry.process("vendor-address-v8", [{}])).toThrow("scope");
  expect(() => registry.rollback("stale-version")).toThrow("stale");
  expect(registry.rollback(renameCandidate.version)).toEqual({
    active: "address-map-v7",
    reconcilePriorOutputs: true,
  });
});

test("fixtures require a logged discovery grant before execution", () => {
  const jobs = new RepairJobs(() => 0);
  const job = jobs.create("discover", 100);
  expect(job.tools).not.toContain("run-fixtures");
  expect(() => jobs.request(job.jobId, "run-fixtures", renameCandidate)).toThrow(
    "tool-not-granted",
  );
  jobs.request(job.jobId, "run-fixtures", undefined, true);
  expect(jobs.request(job.jobId, "run-fixtures", renameCandidate)).toMatchObject({
    fixturesPassed: 6,
  });
  expect(jobs.audit.map((row) => row.allowed)).toEqual([false, true, true]);
});
