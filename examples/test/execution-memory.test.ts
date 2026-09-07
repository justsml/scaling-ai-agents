import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReportingRunner, UnknownOutcome } from "../src/13-execution-memory";
const ctx = { tenant: "acme", project: "billing", schema: "v8", toolVersion: "v1" };
const plan = { tenant: "acme", since: "2026-09-01" };
const adapter = { authorized: true, execute: () => 125, verify: (n: number) => n === 125 };
test("runner rejects omitted tenant even with a misleading past success", () => {
  const r = new ReportingRunner();
  let dispatched = 0;
  try {
    r.run(ctx, "prior", plan, adapter);
    expect(
      r.run(ctx, "missing", { since: plan.since }, { ...adapter, execute: () => ++dispatched }),
    ).toBe("rejected");
    expect(dispatched).toBe(0);
    expect(r.retrieve(ctx)).toMatchObject({
      attempts: 2,
      verified: 1,
      failedChecks: 1,
      knownTenantOmission: true,
    });
    expect(r.run(ctx, "corrected", plan, { ...adapter, correctionOf: "missing" })).toBe("verified");
    expect(r.retrieve(ctx).attempts).toBe(3);
  } finally {
    r.close();
  }
});
test("retrieval excludes other tenants and projects and marks stale versions", () => {
  const r = new ReportingRunner();
  try {
    r.run(ctx, "current", plan, adapter);
    r.run({ ...ctx, schema: "v7" }, "stale", plan, adapter);
    r.run({ ...ctx, tenant: "other" }, "other-tenant", { ...plan, tenant: "other" }, adapter);
    r.run({ ...ctx, project: "other" }, "other-project", plan, adapter);
    const found = r.retrieve(ctx);
    expect(found.attempts).toBe(1);
    expect(found.staleObservations).toBeGreaterThan(0);
    expect(found.observations.every((o) => o.attempt === "current")).toBe(true);
    expect(() =>
      r.run(ctx, "cross-correction", plan, { ...adapter, correctionOf: "other-tenant" }),
    ).toThrow("context");
  } finally {
    r.close();
  }
});
test("generated, executed, verified and unknown are different observations", () => {
  const r = new ReportingRunner();
  try {
    expect(r.run(ctx, "draft", plan, { ...adapter, generatedOnly: true })).toBe("generated");
    expect(r.run(ctx, "wrong", plan, { ...adapter, execute: () => 999 })).toBe(
      "executed-unverified",
    );
    expect(
      r.run(ctx, "timeout", plan, {
        ...adapter,
        execute: () => {
          throw new UnknownOutcome();
        },
      }),
    ).toBe("unknown");
    expect(
      r.run(ctx, "failed", plan, {
        ...adapter,
        execute: () => {
          throw new Error("SECRET");
        },
      }),
    ).toBe("execution-failed");
    expect(
      r.run(ctx, "check-crash", plan, {
        ...adapter,
        verify: () => {
          throw new Error("SECRET");
        },
      }),
    ).toBe("executed-unverified");
    const memory = r.retrieve(ctx);
    expect(memory).toMatchObject({ attempts: 5, verified: 0, unknown: 1 });
    expect(JSON.stringify(memory)).not.toContain("SECRET");
    expect(JSON.stringify(memory)).not.toContain("SELECT");
  } finally {
    r.close();
  }
});
test("remembered success cannot authorize another execution", () => {
  const r = new ReportingRunner();
  try {
    r.run(ctx, "success", plan, adapter);
    expect(r.run(ctx, "denied", plan, { ...adapter, authorized: false })).toBe("rejected");
  } finally {
    r.close();
  }
});
test("query builder binds tenant and date; intent is durable before execution", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-test-"));
  const path = join(dir, "memory.sqlite");
  const r = new ReportingRunner(path);
  try {
    r.run(ctx, "one", plan, {
      ...adapter,
      execute: (sql, bindings) => {
        expect(sql).toContain("tenant = ?");
        expect(bindings).toEqual([ctx.tenant, plan.since]);
        const observer = new ReportingRunner(path);
        try {
          expect(observer.retrieve(ctx).unknown).toBe(1);
        } finally {
          observer.close();
        }
        return 125;
      },
    });
    const reopened = new ReportingRunner(path);
    try {
      expect(reopened.retrieve(ctx)).toMatchObject({ attempts: 1, verified: 1, unknown: 0 });
    } finally {
      reopened.close();
    }
    expect(() => r.run(ctx, "one", plan, adapter)).toThrow();
    expect(r.retrieve(ctx).attempts).toBe(1);
  } finally {
    r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
