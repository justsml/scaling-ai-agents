// Offline runner observations. Memory is evidence, not an executable instruction.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export type Context = { tenant: string; project: string; schema: string; toolVersion: string };
export type State =
  | "generated"
  | "rejected"
  | "execution-failed"
  | "executed-unverified"
  | "verified"
  | "unknown";
type Event = { attempt: string; state: State; check: string; at: number };
export type ReportPlan = { tenant?: string; since: string };
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class ReportingRunner {
  private db: Database;
  constructor(
    path = ":memory:",
    private now = Date.now,
  ) {
    this.db = new Database(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, tenant TEXT, project TEXT, schema_version TEXT, tool_version TEXT,
      artifact_hash TEXT, correction_of TEXT);
      CREATE TABLE IF NOT EXISTS observations (
      sequence INTEGER PRIMARY KEY, attempt TEXT, state TEXT, check_name TEXT, at INTEGER);`);
  }
  close() {
    this.db.close();
  }
  private record(attempt: string, state: State, check: string) {
    this.db
      .query("INSERT INTO observations(attempt,state,check_name,at) VALUES (?,?,?,?)")
      .run(attempt, state, check, this.now());
  }
  // Bound by the authenticated application, not an agent-controlled tool argument.
  run(
    context: Context,
    id: string,
    plan: ReportPlan,
    options: {
      authorized: boolean;
      generatedOnly?: boolean;
      correctionOf?: string;
      // These adapters belong to the runner. A model cannot supply its own results/checks.
      execute: (sql: string, bindings: readonly string[]) => number;
      verify: (total: number) => boolean;
    },
  ) {
    if (options.correctionOf) {
      const parent = this.db
        .query<
          { tenant: string; project: string; schema_version: string; tool_version: string },
          [string]
        >("SELECT * FROM attempts WHERE id=?")
        .get(options.correctionOf);
      if (
        !parent ||
        parent.tenant !== context.tenant ||
        parent.project !== context.project ||
        parent.schema_version !== context.schema ||
        parent.tool_version !== context.toolVersion
      )
        throw new Error("correction-context-mismatch");
    }
    this.db.transaction(() => {
      this.db
        .query("INSERT INTO attempts VALUES (?,?,?,?,?,?,?)")
        .run(
          id,
          context.tenant,
          context.project,
          context.schema,
          context.toolVersion,
          fingerprint(plan),
          options.correctionOf ?? null,
        );
      this.record(id, "generated", "not-executed");
    })();
    if (options.generatedOnly) return "generated";
    // A fixed query builder makes this a report-plan example, not a regex SQL firewall.
    if (
      !options.authorized ||
      plan.tenant !== context.tenant ||
      !/^\d{4}-\d{2}-\d{2}$/.test(plan.since)
    ) {
      this.record(
        id,
        "rejected",
        !options.authorized
          ? "authorization"
          : plan.tenant !== context.tenant
            ? "tenant-scope"
            : "date-shape",
      );
      return "rejected";
    }
    this.record(id, "unknown", "dispatch-intent");
    let total: number;
    try {
      total = options.execute(
        "SELECT SUM(amount) AS total FROM invoices WHERE tenant = ? AND day >= ?",
        [context.tenant, plan.since],
      );
    } catch (error) {
      // A lost response does not establish failure of an external operation.
      const state = error instanceof UnknownOutcome ? "unknown" : "execution-failed";
      this.record(id, state, state === "unknown" ? "outcome-unconfirmed" : "runner-error");
      return state;
    }
    this.record(id, "executed-unverified", "runner-returned");
    // Validation errors are also observations, and cannot be promoted to success.
    try {
      if (!Number.isFinite(total) || !options.verify(total)) {
        this.record(id, "executed-unverified", "result-invariant-failed");
        return "executed-unverified";
      }
    } catch {
      this.record(id, "executed-unverified", "validator-error");
      return "executed-unverified";
    }
    this.record(id, "verified", "expected-total");
    return "verified";
  }
  retrieve(context: Context) {
    const rows = this.db
      .query<Event & { schema_version: string; tool_version: string }, [string, string]>(`
      SELECT o.attempt,o.state,o.check_name AS "check",o.at,a.schema_version,a.tool_version,
        a.artifact_hash AS artifactHash,a.correction_of AS correctionOf
      FROM observations o JOIN attempts a ON a.id=o.attempt
      WHERE a.tenant=? AND a.project=? ORDER BY o.sequence`)
      .all(context.tenant, context.project);
    const current = rows.filter(
      (r) => r.schema_version === context.schema && r.tool_version === context.toolVersion,
    );
    const latest = new Map(current.map((row) => [row.attempt, row]));
    return {
      observations: current,
      staleObservations: rows.length - current.length,
      attempts: latest.size,
      verified: [...latest.values()].filter((r) => r.state === "verified").length,
      unknown: [...latest.values()].filter((r) => r.state === "unknown").length,
      failedChecks: current.filter((r) =>
        ["tenant-scope", "result-invariant-failed", "validator-error"].includes(r.check),
      ).length,
      // A fixed hint, never a retrieved command or permission. Preflight still runs.
      knownTenantOmission: current.some((r) => r.check === "tenant-scope"),
    };
  }
}
export class UnknownOutcome extends Error {}

if (import.meta.main) {
  const runner = new ReportingRunner();
  const context = { tenant: "acme", project: "billing", schema: "v8", toolVersion: "report-v1" };
  const adapter = {
    authorized: true,
    execute: () => 125,
    verify: (total: number) => total === 125,
  };
  try {
    runner.run(context, "missing-tenant", { since: "2026-09-01" }, adapter);
    const memory = runner.retrieve(context);
    const draft = {
      since: "2026-09-01",
      ...(memory.knownTenantOmission ? { tenant: context.tenant } : {}),
    };
    runner.run(context, "corrected", draft, { ...adapter, correctionOf: "missing-tenant" });
    runner.run(context, "plausible-wrong-total", draft, { ...adapter, execute: () => 999 });
    runner.run(context, "lost-response", draft, {
      ...adapter,
      execute: () => {
        throw new UnknownOutcome();
      },
    });
    const { observations, ...summary } = runner.retrieve(context);
    console.table(observations.map(({ attempt, state, check }) => ({ attempt, state, check })));
    console.log({ fixture: true, modelCalls: 0, ...summary });
  } finally {
    runner.close();
  }
}
