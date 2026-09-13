/** Offline policy exercise. Logical milliseconds and fixture cents, no model calls. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Admission,
  computeRequest,
} from "./08-durable-admission";

export const branches = [
  ["a/0", "a/1", "a/2", "a/3", "a/4"],
  ["b/0", "b/1", "b/2", "b/3", "b/4"],
];

// Provider and notification service survive the worker. Only the first
// generation of a/1 fails. The first generation response and notification
// acknowledgment for a/0 are lost after the remote side effect succeeds.
class Services {
  generations = new Map<
    string,
    {
      identity: string;
      outcome: "completed" | "failed";
    }
  >();
  // A fixed one-minute fixture rental is charged on provisioning. The remote
  // resource survives worker restarts until explicitly torn down.
  workers = new Map<
    string,
    { active: boolean; costCents: number }
  >();
  provisionWorkers() {
    const id = "remote-workers";
    this.workers.set(id, {
      active: true,
      costCents: 4,
    });
    return id;
  }
  teardownWorkers(id: string) {
    const worker = this.workers.get(id);
    if (!worker)
      throw new Error("unknown remote workers");
    worker.active = false;
    return worker.costCents;
  }
  deliveries = new Set<string>();
  notificationAttempts = 0;
  throttles = 0;
  private starts: number[] = [];
  generate(key: string, identity: string, now: number) {
    const prior = this.generations.get(key);
    if (prior) return prior;
    this.starts = this.starts.filter(
      (t) => t > now - 1000,
    );
    if (this.starts.length >= 5) {
      this.throttles++;
      throw new Error("provider-rate");
    }
    this.starts.push(now);
    const first = ![...this.generations.values()].some(
      (g) => g.identity === identity,
    );
    const result = {
      identity,
      outcome:
        identity === "a/1" && first
          ? ("failed" as const)
          : ("completed" as const),
    };
    this.generations.set(key, result);
    return result;
  }
  notify(identity: string) {
    this.notificationAttempts++;
    const first = !this.deliveries.has(identity);
    this.deliveries.add(identity);
    return !(identity === "a/0" && first);
  }
}

export function runCapstone(
  policy: "naive" | "corrected",
) {
  const dir = mkdtempSync(join(tmpdir(), "capstone-"));
  const path = join(dir, "ledger.sqlite");
  let now = 0;
  let ledger = new Admission(path, () => now);
  const remote = new Services();
  const cap = 150;
  const events: string[] = [];
  let localThrottles = 0;
  let restartCount = 0;
  let peakCommitted = 0;
  const accepted: string[] = [];
  const refused: string[] = [];
  const work: { id: string; identity: string }[] = [];
  const track = () => {
    const s = ledger.snapshot("customer");
    peakCommitted = Math.max(
      peakCommitted,
      s.held + s.spent,
    );
  };
  try {
    ledger.provision("customer", cap);
    let leaseId = "";
    // Root -> two branches -> five leaf tasks each. Branches compete for one
    // ledger in the corrected policy; naive branches each copy the root cap.
    for (const [
      index,
      identities,
    ] of branches.entries()) {
      if (policy === "corrected") {
        const decision = ledger.admit(
          "customer",
          `branch-${index}`,
          identities,
          600_000,
        );
        accepted.push(...decision.acceptedIdentities);
        refused.push(...decision.refused);
        work.push(
          ...decision.accepted.map((id, i) => ({
            id,
            identity: decision.acceptedIdentities[i]!,
          })),
        );
        if (index === 0) {
          const lease = ledger.reserveCompute(
            "customer",
            decision.jobId!,
            "workers",
            {
              ...computeRequest,
              count: 2,
              durationSeconds: 60,
              costCapCents: 4,
            },
          );
          leaseId = lease.id;
          ledger.provisionCompute(
            lease.id,
            remote.provisionWorkers(),
          );
        }
        track();
      } else {
        const admitted = identities.slice(
          0,
          Math.floor(cap / 20),
        );
        accepted.push(...admitted);
        work.push(
          ...admitted.map((identity) => ({
            id: identity,
            identity,
          })),
        );
      }
    }
    if (policy === "naive") {
      remote.provisionWorkers();
      peakCommitted = work.length * 20 + 4;
    }
    events.push(
      `nested admission: ${accepted.length} accepted, ${refused.length} refused`,
    );
    let sequence = 0;
    const naiveGenerate = (identity: string) => {
      const key = `fresh-${sequence++}`;
      for (;;) {
        try {
          return remote.generate(key, identity, now);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "provider-rate"
          )
            throw error;
          now += 1000;
        }
      }
    };
    for (const item of work) {
      let done = false;
      while (!done) {
        if (policy === "corrected") {
          let attempt: ReturnType<
            Admission["dispatch"]
          >;
          try {
            attempt = ledger.dispatch(item.id);
          } catch (error) {
            if (
              !(error instanceof Error) ||
              ![
                "provider-rate",
                "provider-concurrency",
              ].includes(error.message)
            )
              throw error;
            localThrottles++;
            now += 1000;
            continue;
          }
          const response = remote.generate(
            attempt.id,
            item.identity,
            now,
          );
          if (
            item.identity === "a/0" &&
            restartCount === 0
          ) {
            ledger.abandon(attempt.id);
            ledger.close();
            ledger = new Admission(path, () => now);
            restartCount++;
            if (
              !ledger.computeLease(leaseId)
                .teardownRequired
            )
              throw new Error(
                "lost teardown obligation",
              );
            events.push(
              `restart retained ${ledger.snapshot("customer").held} cents and compute teardown`,
            );
            // Trusted provider lookup by saved attempt key; never regenerate.
            const evidence = remote.generations.get(
              attempt.id,
            )!;
            ledger.reconcile(
              attempt.id,
              evidence.outcome,
              true,
            );
          } else {
            ledger.acknowledge(
              attempt.id,
              attempt.epoch,
              `provider/${attempt.id}`,
            );
            ledger.reconcile(
              attempt.id,
              response.outcome,
              true,
            );
          }
          done = response.outcome === "completed";
          track();
        } else {
          let response = naiveGenerate(item.identity);
          if (
            item.identity === "a/0" &&
            restartCount === 0
          ) {
            ledger.close();
            ledger = new Admission(path, () => now);
            restartCount++;
            events.push(
              "restart regenerated work after lost response",
            );
            response = naiveGenerate(item.identity);
          }
          done = response.outcome === "completed";
        }
      }
      if (
        policy === "naive" &&
        !remote.notify(item.identity)
      ) {
        naiveGenerate(item.identity);
        remote.notify(item.identity);
        events.push(
          "notification retry regenerated completed work",
        );
      }
    }
    if (policy === "corrected") {
      for (const notification of ledger.notifications()) {
        const identity = work.find(
          (item) => item.id === notification.item,
        )!.identity;
        if (!remote.notify(identity)) {
          // Simulate retry from a fresh process against the durable outbox.
          ledger.close();
          ledger = new Admission(path, () => now);
          remote.notify(identity);
        }
        ledger.notificationDelivered(notification.item);
      }
      const lease = ledger.computeLease(leaseId);
      const actualCost = remote.teardownWorkers(
        lease.providerId!,
      );
      ledger.confirmComputeTeardown(
        leaseId,
        actualCost,
      );
      track();
    }
    const generations = [
      ...remote.generations.values(),
    ];
    const completed = new Set(
      generations
        .filter((g) => g.outcome === "completed")
        .map((g) => g.identity),
    );
    const computeSpend = [
      ...remote.workers.values(),
    ].reduce(
      (sum, worker) => sum + worker.costCents,
      0,
    );
    const spend =
      generations.length * 10 + computeSpend;
    return {
      policy,
      evidence: "scripted offline fixture" as const,
      modelCalls: 0,
      accepted,
      refused,
      capCents: cap,
      peakCommittedCents: peakCommitted,
      spentCents: spend,
      budgetExceeded: spend > cap,
      generationAttempts: generations.length,
      duplicateCompletions:
        generations.filter(
          (g) => g.outcome === "completed",
        ).length - completed.size,
      completedRecords: completed.size,
      notifications: remote.deliveries.size,
      notificationAttempts: remote.notificationAttempts,
      providerThrottles: remote.throttles,
      localThrottles,
      restartCount,
      logicalElapsedMs: now,
      ledger:
        policy === "corrected"
          ? ledger.snapshot("customer")
          : null,
      computeSpentCents: computeSpend,
      computeTeardownRequired: [
        ...remote.workers.values(),
      ].some((worker) => worker.active),
      ledgerTeardownRequired:
        policy === "corrected"
          ? ledger.computeLease(leaseId)
              .teardownRequired
          : null,
      events,
    };
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main)
  console.log(
    JSON.stringify(
      [runCapstone("naive"), runCapstone("corrected")],
      null,
      2,
    ),
  );
