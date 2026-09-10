/**
 * 11 — Durable admission
 *
 * A SQLite ledger admits work and compute before
 * dispatch. It reserves budget once, survives restarts,
 * and keeps uncertain provider attempts from being
 * retried or leaked.
 *
 *   bun run snippet:11
 *
 * Local simulation with fixture prices. No API key.
 */
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
export interface ComputeRequest {
  shape: string;
  class: string;
  count: number;
  durationSeconds: number;
  region: string;
  egress: readonly string[];
  costCapCents: number;
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
export type ComputeLease = {
  id: string;
  job: string;
  billedTo: string;
  state: string;
  class: string;
  count: number;
  region: string;
  egress: string[];
  expiresAt: number;
  held: number;
  spent: number;
  providerId: string | null;
  teardownRequired: boolean;
};
const PRICE = 10;
const MAX_ATTEMPTS = 2;
const COMPUTE_CATALOG = {
  "sandbox-small": {
    shape: "provider-wait",
    regions: ["us-east"],
    maxDurationSeconds: 360,
    egress: [
      "provider.example",
      "storage.example",
      "callbacks.example",
    ],
    centsPerWorkerMinute: 2,
  },
} as const;

function validateCompute(
  request: ComputeRequest,
  region: string,
  deadline: number,
  now: number,
  maxCount: number,
) {
  if (!Object.hasOwn(COMPUTE_CATALOG, request.class))
    throw new Error("unknown-compute-class");
  const entry =
    COMPUTE_CATALOG[
      request.class as keyof typeof COMPUTE_CATALOG
    ];
  if (
    !Number.isSafeInteger(request.count) ||
    request.count < 1 ||
    request.count > maxCount ||
    !Number.isSafeInteger(request.durationSeconds) ||
    request.durationSeconds < 1 ||
    request.durationSeconds >
      entry.maxDurationSeconds ||
    !Number.isSafeInteger(request.costCapCents) ||
    request.costCapCents < 0
  )
    throw new Error("invalid-compute-size-or-cap");
  if (
    request.shape !== entry.shape ||
    request.region !== region ||
    !(entry.regions as readonly string[]).includes(
      request.region,
    )
  )
    throw new Error("shape-or-residency-denied");
  if (
    !Array.isArray(request.egress) ||
    request.egress.some(
      (host) =>
        !(entry.egress as readonly string[]).includes(
          host,
        ),
    )
  )
    throw new Error("egress-denied");
  const expiresAt =
    now + request.durationSeconds * 1000;
  if (
    !Number.isSafeInteger(now) ||
    expiresAt > deadline
  )
    throw new Error("job-deadline");
  const reserveCents =
    request.count *
    Math.ceil(request.durationSeconds / 60) *
    entry.centsPerWorkerMinute;
  if (reserveCents > request.costCapCents)
    throw new Error("compute-budget");
  return {
    expiresAt,
    reserveCents,
    input: {
      shape: request.shape,
      class: request.class,
      count: request.count,
      durationSeconds: request.durationSeconds,
      region: request.region,
      egress: [...new Set(request.egress)].sort(),
      costCapCents: request.costCapCents,
    },
  };
}

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
      CREATE TABLE IF NOT EXISTS compute_leases (
        id TEXT PRIMARY KEY, job TEXT NOT NULL, request TEXT NOT NULL,
        requestJson TEXT NOT NULL, state TEXT NOT NULL, class TEXT NOT NULL,
        count INTEGER NOT NULL, region TEXT NOT NULL, egress TEXT NOT NULL,
        expiresAt INTEGER NOT NULL, held INTEGER NOT NULL, spent INTEGER NOT NULL,
        providerId TEXT, teardownRequired INTEGER NOT NULL,
        UNIQUE(job, request));
      CREATE TABLE IF NOT EXISTS outbox (item TEXT PRIMARY KEY, delivered INTEGER NOT NULL DEFAULT 0);`);
  }
  close() {
    this.db.close();
  }

  // Server-owned entitlement setup, not an input to the
  // batch tool.
  provision(tenant: string, capCents: number) {
    if (!Number.isSafeInteger(capCents) || capCents < 0)
      throw new Error("invalid cap");
    this.db
      .query("INSERT INTO tenants VALUES (?, ?)")
      .run(tenant, capCents);
  }

  snapshot(tenant: string) {
    const policy = this.db
      .query<{ cap: number }, [string]>(
        "SELECT cap FROM tenants WHERE id=?",
      )
      .get(tenant);
    if (!policy) throw new Error("unknown tenant");
    const totals = this.db
      .query<
        { held: number; spent: number },
        [string, string, string, string]
      >(`
      SELECT
        COALESCE((SELECT SUM(i.held) FROM items i JOIN jobs j ON j.id=i.job WHERE j.tenant=?),0)
          + COALESCE((SELECT SUM(c.held) FROM compute_leases c JOIN jobs j ON j.id=c.job WHERE j.tenant=?),0) held,
        COALESCE((SELECT SUM(i.spent) FROM items i JOIN jobs j ON j.id=i.job WHERE j.tenant=?),0)
          + COALESCE((SELECT SUM(c.spent) FROM compute_leases c JOIN jobs j ON j.id=c.job WHERE j.tenant=?),0) spent`)
      .get(tenant, tenant, tenant, tenant)!;
    return {
      ...totals,
      available:
        policy.cap - totals.held - totals.spent,
      cap: policy.cap,
    };
  }

  // authenticatedTenant comes from the session. Never
  // bind it from model/tool JSON.
  admit(
    authenticatedTenant: string,
    request: string,
    count: number,
    deadline: number,
  ) {
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
          .query<
            {
              id: string;
              count: number;
              deadline: number;
            },
            [string, string]
          >(
            "SELECT id,count,deadline FROM jobs WHERE tenant=? AND request=?",
          )
          .get(authenticatedTenant, request);
        if (prior) {
          if (
            prior.count !== count ||
            prior.deadline !== deadline
          )
            throw new Error("idempotency conflict");
          return {
            jobId: prior.id,
            accepted: this.items(prior.id).map(
              (i) => i.id,
            ),
            reason: "deduplicated",
          };
        }
        if (this.now() >= deadline)
          return {
            jobId: null,
            accepted: [],
            reason: "deadline",
          };
        if (
          this.snapshot(authenticatedTenant).available <
          count * MAX_ATTEMPTS * PRICE
        ) {
          return {
            jobId: null,
            accepted: [],
            reason: "budget-reserved-or-spent",
          };
        }
        const jobId = randomUUID();
        this.db
          .query("INSERT INTO jobs VALUES (?,?,?,?,?)")
          .run(
            jobId,
            authenticatedTenant,
            request,
            count,
            deadline,
          );
        const accepted = Array.from(
          { length: count },
          (_, index) => `${jobId}/${index}`,
        );
        for (const id of accepted)
          this.db
            .query(
              "INSERT INTO items VALUES (?,?,'queued',?,0,?)",
            )
            .run(
              id,
              jobId,
              PRICE * MAX_ATTEMPTS,
              deadline,
            );
        return { jobId, accepted, reason: "admitted" };
      })
      .immediate();
  }

  items(jobId: string): Item[] {
    return this.db
      .query<Item, [string]>(
        "SELECT * FROM items WHERE job=? ORDER BY id",
      )
      .all(jobId);
  }

  // The agent proposes a shape; authenticated identity,
  // residency, entitlement and job deadline remain
  // server-owned. Validation and reservation happen in
  // the same immediate transaction.
  reserveCompute(
    authenticatedTenant: string,
    jobId: string,
    requestId: string,
    request: ComputeRequest,
  ): ComputeLease {
    if (!requestId)
      throw new Error("missing compute request ID");
    return this.db
      .transaction(() => {
        const job = this.db
          .query<
            { tenant: string; deadline: number },
            [string]
          >(
            "SELECT tenant,deadline FROM jobs WHERE id=?",
          )
          .get(jobId);
        if (!job || job.tenant !== authenticatedTenant)
          throw new Error("unknown job");
        const normalized = validateCompute(
          request,
          "us-east",
          job.deadline,
          this.now(),
          8,
        );
        const requestJson = JSON.stringify(
          normalized.input,
        );
        const prior = this.db
          .query<
            {
              id: string;
              requestJson: string;
            },
            [string, string]
          >(
            "SELECT id,requestJson FROM compute_leases WHERE job=? AND request=?",
          )
          .get(jobId, requestId);
        if (prior) {
          if (prior.requestJson !== requestJson)
            throw new Error("idempotency conflict");
          return this.computeLease(prior.id);
        }
        if (
          normalized.reserveCents >
          this.snapshot(authenticatedTenant).available
        )
          throw new Error("compute-budget");
        const id = `${jobId}/compute/${requestId}`;
        this.db
          .query(`INSERT INTO compute_leases
            VALUES (?,?,?,?,'reserved',?,?,?,?,?,?,0,NULL,1)`)
          .run(
            id,
            jobId,
            requestId,
            requestJson,
            request.class,
            request.count,
            request.region,
            JSON.stringify(normalized.input.egress),
            normalized.expiresAt,
            normalized.reserveCents,
          );
        return this.computeLease(id);
      })
      .immediate();
  }

  computeLease(id: string): ComputeLease {
    const row = this.db
      .query<
        Omit<
          ComputeLease,
          "egress" | "teardownRequired"
        > & {
          egress: string;
          teardownRequired: number;
        },
        [string]
      >(
        `SELECT c.id,c.job,j.tenant billedTo,c.state,c.class,c.count,c.region,
          c.egress,c.expiresAt,c.held,c.spent,c.providerId,c.teardownRequired
          FROM compute_leases c JOIN jobs j ON j.id=c.job WHERE c.id=?`,
      )
      .get(id);
    if (!row) throw new Error("unknown compute lease");
    return {
      ...row,
      egress: JSON.parse(row.egress),
      teardownRequired: row.teardownRequired === 1,
    };
  }

  provisionCompute(id: string, providerId: string) {
    if (!providerId)
      throw new Error("missing provider ID");
    this.db
      .transaction(() => {
        const lease = this.computeLease(id);
        if (
          lease.state !== "reserved" ||
          this.now() >= lease.expiresAt
        )
          throw new Error(
            "compute lease not provisionable",
          );
        this.db
          .query(
            "UPDATE compute_leases SET state='provisioned',providerId=? WHERE id=?",
          )
          .run(providerId, id);
      })
      .immediate();
  }

  // Only trusted provider teardown/billing evidence can
  // clear the obligation and convert the hold to spend.
  confirmComputeTeardown(
    id: string,
    actualCostCents: number,
  ) {
    if (
      !Number.isSafeInteger(actualCostCents) ||
      actualCostCents < 0
    )
      throw new Error("invalid compute charge");
    this.db
      .transaction(() => {
        const lease = this.computeLease(id);
        if (lease.state === "reconciled") {
          if (lease.spent !== actualCostCents)
            throw new Error(
              "conflicting compute charge",
            );
          return;
        }
        if (
          lease.state !== "provisioned" ||
          actualCostCents > lease.held
        )
          throw new Error(
            "compute charge outside reservation",
          );
        this.db
          .query(`UPDATE compute_leases
            SET state='reconciled',held=0,spent=?,teardownRequired=0
            WHERE id=?`)
          .run(actualCostCents, id);
      })
      .immediate();
  }

  // One fixed provider pool: 5 unresolved external
  // attempts, 5 dispatches per second. Persist intent
  // BEFORE making the external call with attempt.id as
  // idempotency key.
  dispatch(itemId: string): Attempt {
    return this.db
      .transaction(() => {
        const item = this.db
          .query<Item, [string]>(
            "SELECT * FROM items WHERE id=?",
          )
          .get(itemId);
        if (!item || item.state !== "queued")
          throw new Error("item-not-queued");
        if (this.now() >= item.deadline)
          throw new Error("deadline");
        const count = this.db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) n FROM attempts WHERE item=?",
          )
          .get(itemId)!.n;
        if (count >= MAX_ATTEMPTS || item.held < PRICE)
          throw new Error("attempt-or-budget-cap");
        const active = this.db
          .query<{ n: number }, []>(
            "SELECT COUNT(*) n FROM attempts WHERE state IN ('submitted','waiting','unresolved')",
          )
          .get()!.n;
        if (active >= 5)
          throw new Error("provider-concurrency");
        const recent = this.db
          .query<{ n: number }, [number]>(
            "SELECT COUNT(*) n FROM attempts WHERE dispatched>?",
          )
          .get(this.now() - 1000)!.n;
        if (recent >= 5)
          throw new Error("provider-rate");
        const attempt: Attempt = {
          id: `${itemId}/attempt-${count + 1}`,
          item: itemId,
          state: "submitted",
          providerId: null,
          epoch: 1,
          expires: Math.min(
            item.deadline,
            this.now() + 360_000,
          ),
        };
        this.db
          .query(
            "INSERT INTO attempts VALUES (?,?,?,NULL,?,?,?)",
          )
          .run(
            attempt.id,
            itemId,
            attempt.state,
            attempt.expires,
            attempt.epoch,
            this.now(),
          );
        this.db
          .query(
            "UPDATE items SET state='submitted' WHERE id=?",
          )
          .run(itemId);
        return attempt;
      })
      .immediate();
  }

  acknowledge(
    attemptId: string,
    epoch: number,
    providerId: string,
  ) {
    if (!providerId)
      throw new Error("missing provider ID");
    this.db
      .transaction(() => {
        const a = this.attempt(attemptId);
        if (
          a.epoch !== epoch ||
          this.now() >= a.expires ||
          a.state !== "submitted"
        )
          throw new Error("stale-worker");
        this.db
          .query(
            "UPDATE attempts SET state='waiting',providerId=? WHERE id=?",
          )
          .run(providerId, attemptId);
        this.db
          .query(
            "UPDATE items SET state='waiting' WHERE id=?",
          )
          .run(a.item);
      })
      .immediate();
  }

  // Lost response, cancellation or reclaimed worker:
  // revoke local ownership, keep holds.
  abandon(attemptId: string) {
    this.db
      .transaction(() => {
        const a = this.attempt(attemptId);
        if (!["submitted", "waiting"].includes(a.state))
          return;
        this.db
          .query(
            "UPDATE attempts SET state='unresolved',epoch=epoch+1 WHERE id=?",
          )
          .run(attemptId);
        this.db
          .query(
            "UPDATE items SET state='unresolved' WHERE id=?",
          )
          .run(a.item);
      })
      .immediate();
  }

  attempt(id: string): Attempt {
    const a = this.db
      .query<Attempt, [string]>(
        "SELECT * FROM attempts WHERE id=?",
      )
      .get(id);
    if (!a) throw new Error("unknown attempt");
    return a;
  }

  // Trusted provider evidence only. A model's claim of
  // success is not reconciliation. This fixture charges
  // exactly 10 cents for every confirmed attempt,
  // including failure.
  reconcile(
    id: string,
    outcome: "completed" | "failed",
    retryable = false,
  ) {
    if (!["completed", "failed"].includes(outcome))
      throw new Error("invalid provider outcome");
    this.db
      .transaction(() => {
        const a = this.attempt(id);
        if (["completed", "failed"].includes(a.state)) {
          if (a.state !== outcome)
            throw new Error(
              "conflicting provider outcome",
            );
          return;
        }
        const item = this.db
          .query<Item, [string]>(
            "SELECT * FROM items WHERE id=?",
          )
          .get(a.item)!;
        const count = this.db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) n FROM attempts WHERE item=?",
          )
          .get(a.item)!.n;
        const retry =
          outcome === "failed" &&
          retryable &&
          count < MAX_ATTEMPTS &&
          this.now() < item.deadline;
        this.db
          .query(
            "UPDATE attempts SET state=? WHERE id=?",
          )
          .run(outcome, id);
        this.db
          .query(
            "UPDATE items SET state=?,spent=spent+?,held=? WHERE id=?",
          )
          .run(
            retry ? "queued" : outcome,
            PRICE,
            retry ? item.held - PRICE : 0,
            item.id,
          );
        if (outcome === "completed")
          this.db
            .query(
              "INSERT OR IGNORE INTO outbox(item) VALUES (?)",
            )
            .run(item.id);
      })
      .immediate();
  }

  // Unsubmitted work may release its allowance.
  // Submitted/unknown work cannot.
  expireQueued() {
    this.db
      .query(
        "UPDATE items SET state='expired',held=0 WHERE state='queued' AND deadline<=?",
      )
      .run(this.now());
  }
  notifications() {
    return this.db
      .query<{ item: string; delivered: number }, []>(
        "SELECT * FROM outbox",
      )
      .all();
  }
  notificationDelivered(item: string) {
    this.db
      .query(
        "UPDATE outbox SET delivered=1 WHERE item=?",
      )
      .run(item);
  }
}

export function demo() {
  const dir = mkdtempSync(
    join(tmpdir(), "admission-demo-"),
  );
  const path = join(dir, "jobs.sqlite");
  let clock = 0;
  let store = new Admission(path, () => clock);
  try {
    store.provision("customer-4471", 200);
    const callers = Array.from({ length: 4 }, () =>
      store.admit(
        "customer-4471",
        "batch-1042",
        10,
        600_000,
      ),
    );
    console.log(
      "four callers",
      callers.map((c) => ({
        jobId: c.jobId,
        accepted: c.accepted.length,
        reason: c.reason,
      })),
    );
    console.log(
      "reserved",
      store.snapshot("customer-4471"),
    );
    console.log(
      "other request",
      store.admit(
        "customer-4471",
        "batch-1043",
        1,
        600_000,
      ),
    );
    for (const item of callers[0]!.accepted.slice(
      0,
      9,
    )) {
      const a = store.dispatch(item);
      store.acknowledge(
        a.id,
        a.epoch,
        `provider-${a.id}`,
      );
      store.reconcile(a.id, "completed");
      clock += 1000;
    }
    const lost = store.dispatch(
      callers[0]!.accepted[9]!,
    );
    store.abandon(lost.id);
    store.close();
    store = new Admission(path, () => clock);
    console.log(
      "after restart, unknown response",
      store.snapshot("customer-4471"),
      store.attempt(lost.id),
    );
    // Simulated lookup by saved attempt idempotency key
    // confirms external completion.
    store.reconcile(lost.id, "completed");
    const lease = store.reserveCompute(
      "customer-4471",
      callers[0]!.jobId!,
      "worker-pool-1",
      computeRequest,
    );
    console.log("compute reserved", lease);
    store.provisionCompute(
      lease.id,
      "provider-lease-1",
    );
    // Simulated provider billing and teardown evidence.
    store.confirmComputeTeardown(lease.id, 80);
    for (const notification of store.notifications())
      store.notificationDelivered(notification.item);
    console.log(
      "reconciled",
      store.snapshot("customer-4471"),
      {
        notifications: store.notifications().length,
        modelCalls: 0,
      },
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
if (import.meta.main) demo();
