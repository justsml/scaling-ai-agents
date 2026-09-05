// Two small pieces of parallelism plumbing shared across snippets:
//
// 1. `pLimit`: a bounded-concurrency pool, ~20 lines, no dependency (07
//    Batching fans a fixture list through this; the plan calls for exactly
//    this rather than pulling in the `p-limit` package).
// 2. `ProviderSlot` / `pickProviders`: the region/dataClass filter Distribute
//    (04) runs in code before any provider call, so a request tagged
//    region=eu, dataClass=restricted never reaches a US-only or public-only
//    slot regardless of what the model would have chosen.

export function pLimit(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    active--;
    queue.shift()?.();
  };

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(
          (value) => {
            next();
            resolve(value);
          },
          (err) => {
            next();
            reject(err);
          },
        );
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };
}

export interface ProviderSlot {
  id: string;
  kind: "openai" | "local" | "gateway" | "remote-a2a";
  regions: string[]; // ["*"] means any region
  dataClasses: string[]; // ["*"] means any data class
  available: boolean; // e.g. local slot only available when reachable
  registryId: string; // key used with registry.languageModel(registryId)
}

/** Filter the provider pool in code, before any network call. */
export function pickProviders(
  pool: ProviderSlot[],
  region: string,
  dataClass: string,
): ProviderSlot[] {
  return pool.filter(
    (slot) =>
      slot.available &&
      (slot.regions.includes("*") || slot.regions.includes(region)) &&
      (slot.dataClasses.includes("*") || slot.dataClasses.includes(dataClass)),
  );
}
