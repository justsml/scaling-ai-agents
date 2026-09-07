// Offline provider simulation with real SQLite persistence. Prices are fixtures in cents.
// Only the trusted dispatcher/reconciler owns this object. An agent gets a job ID.
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Item = {
  id: string;
  job: string;
  state: string;
  held: number;
  spent: number;
  deadline: number;
};
type Attempt = {
  id: string;
  item: string;
  state: string;
  providerId: string | null;
  expires: number;
  epoch: number;
};
const PRICE = 10;
const MAX_ATTEMPTS = 2;

export class Admission {
  private db: Database;
  constructor(
    path: string,
    private now: () => number = Date.now,
  ) {
    this.db = new Database(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, cap INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, tenant TEXT NOT NULL, request TEXT NOT NULL,
        count INTEGER NOT NULL, deadline INTEGER NOT NULL, UNIQUE(tenant, request));
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, job TEXT NOT NULL, state TEXT NOT NULL,
        held INTEGER NOT NULL, spent INTEGER NOT NULL, deadline INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, item TEXT NOT NULL, state TEXT NOT NULL, providerId TEXT,
        expires INTEGER NOT NULL, epoch INTEGER NOT NULL, dispatched INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (item TEXT PRIMARY KEY, delivered INTEGER NOT NULL DEFAULT 0);`);
  }
  close() {
    this.db.close();
  }

  // Server-owned entitlement setup, not an input to the batch tool.
  provision(tenant: string, capCents: number) {
    if (!Number.isSafeInteger(capCents) || capCents < 0) throw new Error("invalid cap");
    this.db.query("INSERT INTO tenants VALUES (?, ?)").run(tenant, capCents);
  }

  snapshot(tenant: string) {
    const policy = this.db
      .query<{ cap: number }, [string]>("SELECT cap FROM tenants WHERE id=?")
      .get(tenant);
    if (!policy) throw new Error("unknown tenant");
    const totals = this.db
      .query<{ held: number; spent: number }, [string]>(`
      SELECT COALESCE(SUM(i.held),0) held, COALESCE(SUM(i.spent),0) spent
      FROM items i JOIN jobs j ON j.id=i.job WHERE j.tenant=?`)
      .get(tenant)!;
    return { ...totals, available: policy.cap - totals.held - totals.spent, cap: policy.cap };
  }

  // authenticatedTenant comes from the session. Never bind it from model/tool JSON.
  admit(authenticatedTenant: string, request: string, count: number, deadline: number) {
    if (
      !request ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > 10 ||
      !Number.isSafeInteger(deadline)
    )
      throw new Error("invalid batch");
    return this.db
      .transaction(() => {
        const prior = this.db
          .query<{ id: string; count: number; deadline: number }, [string, string]>(
            "SELECT id,count,deadline FROM jobs WHERE tenant=? AND request=?",
          )
          .get(authenticatedTenant, request);
        if (prior) {
          if (prior.count !== count || prior.deadline !== deadline)
            throw new Error("idempotency conflict");
          return {
            jobId: prior.id,
            accepted: this.items(prior.id).map((i) => i.id),
            reason: "deduplicated",
          };
        }
        if (this.now() >= deadline) return { jobId: null, accepted: [], reason: "deadline" };
        if (this.snapshot(authenticatedTenant).available < count * MAX_ATTEMPTS * PRICE) {
          return { jobId: null, accepted: [], reason: "budget-reserved-or-spent" };
        }
        const jobId = randomUUID();
        this.db
          .query("INSERT INTO jobs VALUES (?,?,?,?,?)")
          .run(jobId, authenticatedTenant, request, count, deadline);
        const accepted = Array.from({ length: count }, (_, index) => `${jobId}/${index}`);
        for (const id of accepted)
          this.db
            .query("INSERT INTO items VALUES (?,?,'queued',?,0,?)")
            .run(id, jobId, PRICE * MAX_ATTEMPTS, deadline);
        return { jobId, accepted, reason: "admitted" };
      })
      .immediate();
  }

  items(jobId: string): Item[] {
    return this.db.query<Item, [string]>("SELECT * FROM items WHERE job=? ORDER BY id").all(jobId);
  }

  // One fixed provider pool: 5 unresolved external attempts, 5 dispatches per second.
  // Persist intent BEFORE making the external call with attempt.id as idempotency key.
  dispatch(itemId: string): Attempt {
    return this.db
      .transaction(() => {
        const item = this.db.query<Item, [string]>("SELECT * FROM items WHERE id=?").get(itemId);
        if (!item || item.state !== "queued") throw new Error("item-not-queued");
        if (this.now() >= item.deadline) throw new Error("deadline");
        const count = this.db
          .query<{ n: number }, [string]>("SELECT COUNT(*) n FROM attempts WHERE item=?")
          .get(itemId)!.n;
        if (count >= MAX_ATTEMPTS || item.held < PRICE) throw new Error("attempt-or-budget-cap");
        const active = this.db
          .query<{ n: number }, []>(
            "SELECT COUNT(*) n FROM attempts WHERE state IN ('submitted','waiting','unresolved')",
          )
          .get()!.n;
        if (active >= 5) throw new Error("provider-concurrency");
        const recent = this.db
          .query<{ n: number }, [number]>("SELECT COUNT(*) n FROM attempts WHERE dispatched>?")
          .get(this.now() - 1000)!.n;
        if (recent >= 5) throw new Error("provider-rate");
        const attempt: Attempt = {
          id: `${itemId}/attempt-${count + 1}`,
          item: itemId,
          state: "submitted",
          providerId: null,
          epoch: 1,
          expires: Math.min(item.deadline, this.now() + 360_000),
        };
        this.db
          .query("INSERT INTO attempts VALUES (?,?,?,NULL,?,?,?)")
          .run(attempt.id, itemId, attempt.state, attempt.expires, attempt.epoch, this.now());
        this.db.query("UPDATE items SET state='submitted' WHERE id=?").run(itemId);
        return attempt;
      })
      .immediate();
  }

  acknowledge(attemptId: string, epoch: number, providerId: string) {
    if (!providerId) throw new Error("missing provider ID");
    this.db
      .transaction(() => {
        const a = this.attempt(attemptId);
        if (a.epoch !== epoch || this.now() >= a.expires || a.state !== "submitted")
          throw new Error("stale-worker");
        this.db
          .query("UPDATE attempts SET state='waiting',providerId=? WHERE id=?")
          .run(providerId, attemptId);
        this.db.query("UPDATE items SET state='waiting' WHERE id=?").run(a.item);
      })
      .immediate();
  }

  // Lost response, cancellation or reclaimed worker: revoke local ownership, keep holds.
  abandon(attemptId: string) {
    this.db
      .transaction(() => {
        const a = this.attempt(attemptId);
        if (!["submitted", "waiting"].includes(a.state)) return;
        this.db
          .query("UPDATE attempts SET state='unresolved',epoch=epoch+1 WHERE id=?")
          .run(attemptId);
        this.db.query("UPDATE items SET state='unresolved' WHERE id=?").run(a.item);
      })
      .immediate();
  }

  attempt(id: string): Attempt {
    const a = this.db.query<Attempt, [string]>("SELECT * FROM attempts WHERE id=?").get(id);
    if (!a) throw new Error("unknown attempt");
    return a;
  }

  // Trusted provider evidence only. A model's claim of success is not reconciliation.
  // This fixture charges exactly 10 cents for every confirmed attempt, including failure.
  reconcile(id: string, outcome: "completed" | "failed", retryable = false) {
    if (!["completed", "failed"].includes(outcome)) throw new Error("invalid provider outcome");
    this.db
      .transaction(() => {
        const a = this.attempt(id);
        if (["completed", "failed"].includes(a.state)) {
          if (a.state !== outcome) throw new Error("conflicting provider outcome");
          return;
        }
        const item = this.db.query<Item, [string]>("SELECT * FROM items WHERE id=?").get(a.item)!;
        const count = this.db
          .query<{ n: number }, [string]>("SELECT COUNT(*) n FROM attempts WHERE item=?")
          .get(a.item)!.n;
        const retry =
          outcome === "failed" && retryable && count < MAX_ATTEMPTS && this.now() < item.deadline;
        this.db.query("UPDATE attempts SET state=? WHERE id=?").run(outcome, id);
        this.db
          .query("UPDATE items SET state=?,spent=spent+?,held=? WHERE id=?")
          .run(retry ? "queued" : outcome, PRICE, retry ? item.held - PRICE : 0, item.id);
        if (outcome === "completed")
          this.db.query("INSERT OR IGNORE INTO outbox(item) VALUES (?)").run(item.id);
      })
      .immediate();
  }

  // Unsubmitted work may release its allowance. Submitted/unknown work cannot.
  expireQueued() {
    this.db
      .query("UPDATE items SET state='expired',held=0 WHERE state='queued' AND deadline<=?")
      .run(this.now());
  }
  notifications() {
    return this.db.query<{ item: string; delivered: number }, []>("SELECT * FROM outbox").all();
  }
  notificationDelivered(item: string) {
    this.db.query("UPDATE outbox SET delivered=1 WHERE item=?").run(item);
  }
}

export function demo() {
  const dir = mkdtempSync(join(tmpdir(), "admission-demo-"));
  const path = join(dir, "jobs.sqlite");
  let clock = 0;
  let store = new Admission(path, () => clock);
  try {
    store.provision("customer-4471", 200);
    const callers = Array.from({ length: 4 }, () =>
      store.admit("customer-4471", "batch-1042", 10, 600_000),
    );
    console.log(
      "four callers",
      callers.map((c) => ({ jobId: c.jobId, accepted: c.accepted.length, reason: c.reason })),
    );
    console.log("reserved", store.snapshot("customer-4471"));
    console.log("other request", store.admit("customer-4471", "batch-1043", 1, 600_000));
    for (const item of callers[0]!.accepted.slice(0, 9)) {
      const a = store.dispatch(item);
      store.acknowledge(a.id, a.epoch, `provider-${a.id}`);
      store.reconcile(a.id, "completed");
      clock += 1000;
    }
    const lost = store.dispatch(callers[0]!.accepted[9]!);
    store.abandon(lost.id);
    store.close();
    store = new Admission(path, () => clock);
    console.log(
      "after restart, unknown response",
      store.snapshot("customer-4471"),
      store.attempt(lost.id),
    );
    // Simulated lookup by saved attempt idempotency key confirms external completion.
    store.reconcile(lost.id, "completed");
    for (const notification of store.notifications())
      store.notificationDelivered(notification.item);
    console.log("reconciled", store.snapshot("customer-4471"), {
      notifications: store.notifications().length,
      modelCalls: 0,
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
if (import.meta.main) demo();
