import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Admission, computeRequest } from "../src/08-durable-admission";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function setup(cap = 200) {
  const dir = mkdtempSync(join(tmpdir(), "admission-test-"));
  const path = join(dir, "jobs.sqlite");
  let now = 0;
  const connections: Admission[] = [];
  const open = () => {
    const db = new Admission(path, () => now);
    connections.push(db);
    return db;
  };
  const db = open();
  db.provision("tenant", cap);
  cleanups.push(() => {
    for (const c of connections) c.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    db,
    open,
    path,
    tick: (n: number) => {
      now = n;
    },
  };
}
test("four callers share one job; another request cannot spend its reservation", () => {
  const s = setup();
  const first = s.db.admit("tenant", "same", 10, 600_000);
  for (let i = 0; i < 3; i++)
    expect(s.open().admit("tenant", "same", 10, 600_000).jobId).toBe(first.jobId);
  expect(s.db.items(first.jobId!)).toHaveLength(10);
  expect(s.db.snapshot("tenant")).toEqual({ held: 200, spent: 0, available: 0, cap: 200 });
  expect(s.db.admit("tenant", "different", 1, 600_000).accepted).toHaveLength(0);
  expect(() => s.db.admit("tenant", "same", 9, 600_000)).toThrow("idempotency conflict");
});
test("concurrent processes cannot reserve the same remaining budget", async () => {
  const s = setup();
  const module = new URL("../src/08-durable-admission.ts", import.meta.url).pathname;
  const processes = Array.from({ length: 4 }, (_, i) =>
    Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { Admission } from ${JSON.stringify(module)}; const db = new Admission(process.argv[1], () => 0); console.log(JSON.stringify(db.admit('tenant', process.argv[2], 10, 600000))); db.close();`,
        s.path,
        `caller-${i}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    ),
  );
  const rows = await Promise.all(
    processes.map(async (p) => {
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      expect(err).toBe("");
      expect(code).toBe(0);
      return JSON.parse(out) as { accepted: string[] };
    }),
  );
  expect(rows.reduce((sum, row) => sum + row.accepted.length, 0)).toBe(10);
  expect(s.db.snapshot("tenant").held).toBe(200);
});
test("tenant request identities and balances are separate", () => {
  const { db } = setup();
  db.provision("other", 200);
  const a = db.admit("tenant", "same", 10, 600_000);
  const b = db.admit("other", "same", 10, 600_000);
  expect(a.jobId).not.toBe(b.jobId);
  expect(db.snapshot("other").held).toBe(200);
  expect(() => db.admit("forged", "x", 1, 600_000)).toThrow("unknown tenant");
});
test("lost response retains allowance across restart and blocks blind resubmission", () => {
  const s = setup();
  const a = s.db.dispatch(s.db.admit("tenant", "job", 1, 600_000).accepted[0]!);
  s.db.abandon(a.id);
  const restarted = s.open();
  expect(restarted.attempt(a.id).state).toBe("unresolved");
  expect(() => restarted.dispatch(a.item)).toThrow("not-queued");
  expect(() => restarted.acknowledge(a.id, a.epoch, "late-provider-id")).toThrow("stale-worker");
  expect(restarted.snapshot("tenant").held).toBe(20);
  restarted.reconcile(a.id, "completed");
  restarted.reconcile(a.id, "completed");
  expect(restarted.snapshot("tenant")).toEqual({ held: 0, spent: 10, available: 190, cap: 200 });
  expect(restarted.notifications()).toHaveLength(1);
  expect(() => restarted.reconcile(a.id, "failed")).toThrow("conflicting");
});
test("crash after intent but before provider ID remains uncertain", () => {
  const s = setup();
  const a = s.db.dispatch(s.db.admit("tenant", "job", 1, 1000).accepted[0]!);
  const restarted = s.open();
  expect(restarted.attempt(a.id)).toMatchObject({ state: "submitted", providerId: null });
  expect(() => restarted.dispatch(a.item)).toThrow("not-queued");
  s.tick(1000);
  expect(() => restarted.acknowledge(a.id, a.epoch, "late")).toThrow("stale");
  restarted.expireQueued();
  expect(restarted.snapshot("tenant").held).toBe(20);
});
test("concurrency and rate are separate; unresolved attempts retain provider slots", () => {
  const s = setup();
  const items = s.db.admit("tenant", "job", 10, 600_000).accepted;
  const active = items.slice(0, 5).map((i) => s.db.dispatch(i));
  active.forEach((a) => s.db.abandon(a.id));
  expect(() => s.db.dispatch(items[5]!)).toThrow("provider-concurrency");
  active.forEach((a) => s.db.reconcile(a.id, "completed"));
  expect(() => s.db.dispatch(items[5]!)).toThrow("provider-rate");
  s.tick(1000);
  expect(s.db.dispatch(items[5]!).state).toBe("submitted");
});
test("retry requires confirmed failure and stops at two attempts", () => {
  const { db } = setup();
  const item = db.admit("tenant", "job", 1, 600_000).accepted[0]!;
  const a = db.dispatch(item);
  db.reconcile(a.id, "failed", true);
  expect(db.snapshot("tenant")).toMatchObject({ held: 10, spent: 10 });
  const b = db.dispatch(item);
  expect(b.id).not.toBe(a.id);
  db.reconcile(b.id, "failed", true);
  expect(db.attempt(a.id).state).toBe("failed");
  expect(db.snapshot("tenant")).toMatchObject({ held: 0, spent: 20 });
  expect(() => db.dispatch(item)).toThrow("not-queued");
});
test("deadline releases only unsubmitted reservations", () => {
  const s = setup();
  const items = s.db.admit("tenant", "job", 2, 100).accepted;
  s.db.dispatch(items[0]!);
  s.tick(100);
  expect(() => s.db.dispatch(items[1]!)).toThrow("deadline");
  s.db.expireQueued();
  expect(s.db.snapshot("tenant").held).toBe(20);
  expect(s.db.admit("tenant", "late", 1, 100).reason).toBe("deadline");
});
test("notification retry only updates delivery state", () => {
  const { db } = setup();
  const a = db.dispatch(db.admit("tenant", "job", 1, 1000).accepted[0]!);
  db.reconcile(a.id, "completed");
  const before = db.snapshot("tenant");
  db.notificationDelivered(a.item);
  db.notificationDelivered(a.item);
  expect(db.snapshot("tenant")).toEqual(before);
  expect(db.notifications()).toEqual([{ item: a.item, delivered: 1 }]);
});

test("compute quote derives identity and atomically reserves shared budget", () => {
  const s = setup(120);
  const job = s.db.admit("tenant", "job", 1, 600_000);
  const lease = s.db.reserveCompute("tenant", job.jobId!, "workers-1", {
    ...computeRequest,
    billTo: "someone-else",
  } as typeof computeRequest);
  expect(lease).toMatchObject({
    job: job.jobId,
    billedTo: "tenant",
    state: "reserved",
    held: 96,
    expiresAt: 360_000,
    teardownRequired: true,
  });
  expect(s.db.snapshot("tenant")).toMatchObject({
    held: 116,
    available: 4,
  });
  expect(() => s.open().reserveCompute("tenant", job.jobId!, "workers-2", computeRequest)).toThrow(
    "compute-budget",
  );
  expect(() => s.db.reserveCompute("other", job.jobId!, "forged", computeRequest)).toThrow(
    "unknown job",
  );
});

test("compute reservation is idempotent and survives provisioning restart", () => {
  const s = setup();
  const jobId = s.db.admit("tenant", "job", 1, 600_000).jobId!;
  const first = s.db.reserveCompute("tenant", jobId, "workers", computeRequest);
  expect(s.open().reserveCompute("tenant", jobId, "workers", computeRequest).id).toBe(first.id);
  expect(() =>
    s.db.reserveCompute("tenant", jobId, "workers", {
      ...computeRequest,
      count: 7,
    }),
  ).toThrow("idempotency conflict");
  s.db.provisionCompute(first.id, "provider-lease");
  const restarted = s.open();
  expect(restarted.computeLease(first.id)).toMatchObject({
    state: "provisioned",
    providerId: "provider-lease",
    teardownRequired: true,
  });
  restarted.confirmComputeTeardown(first.id, 80);
  restarted.confirmComputeTeardown(first.id, 80);
  expect(restarted.computeLease(first.id)).toMatchObject({
    state: "reconciled",
    held: 0,
    spent: 80,
    teardownRequired: false,
  });
  expect(restarted.snapshot("tenant")).toMatchObject({
    held: 20,
    spent: 80,
    available: 100,
  });
  expect(() => restarted.confirmComputeTeardown(first.id, 81)).toThrow("conflicting");
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
])("compute admission rejects generated escalation %j", (change) => {
  const { db } = setup();
  const jobId = db.admit("tenant", "job", 1, 600_000).jobId!;
  expect(() =>
    db.reserveCompute("tenant", jobId, "workers", {
      ...computeRequest,
      ...change,
    }),
  ).toThrow();
});

test("job deadline constrains compute and teardown cannot exceed its hold", () => {
  const s = setup();
  const jobId = s.db.admit("tenant", "job", 1, 600_000).jobId!;
  s.tick(300_000);
  expect(() => s.db.reserveCompute("tenant", jobId, "late", computeRequest)).toThrow("deadline");
  s.tick(0);
  const lease = s.db.reserveCompute("tenant", jobId, "workers", computeRequest);
  s.db.provisionCompute(lease.id, "provider-lease");
  expect(() => s.db.confirmComputeTeardown(lease.id, 97)).toThrow("outside reservation");
});
