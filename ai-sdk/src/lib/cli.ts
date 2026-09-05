// Shared CLI parsing: every snippet accepts --budget-usd and --deadline-ms
// and must stop honestly when either is hit.
export interface CliCaps {
  budgetUsd: number;
  deadlineMs: number;
}

export function parseCaps(argv: string[], defaults: CliCaps = { budgetUsd: 0.5, deadlineMs: 60_000 }): CliCaps {
  let budgetUsd = defaults.budgetUsd;
  let deadlineMs = defaults.deadlineMs;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--budget-usd" && argv[i + 1]) {
      budgetUsd = Number(argv[++i]);
    } else if (argv[i]?.startsWith("--budget-usd=")) {
      budgetUsd = Number(argv[i]!.split("=")[1]);
    } else if (argv[i] === "--deadline-ms" && argv[i + 1]) {
      deadlineMs = Number(argv[++i]);
    } else if (argv[i]?.startsWith("--deadline-ms=")) {
      deadlineMs = Number(argv[i]!.split("=")[1]);
    }
  }
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error("--budget-usd must be a positive number");
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new Error("--deadline-ms must be a positive number");
  return { budgetUsd, deadlineMs };
}

/** An AbortSignal that fires when the deadline elapses. */
export function deadlineSignal(deadlineMs: number): AbortSignal {
  return AbortSignal.timeout(deadlineMs);
}
