export interface GatewayControl {
  health(signal?: AbortSignal): Promise<boolean>;
  configureRun(runId: string, scenarioId: string, faults: unknown[], signal?: AbortSignal): Promise<void>;
  readEvents(runId: string, signal?: AbortSignal): Promise<unknown[]>;
}

export class HttpGatewayControl implements GatewayControl {
  readonly #baseUrl: string;

  constructor(baseUrl: string, readonly controlSecret: string, readonly fetcher: typeof fetch = fetch) {
    const parsed = new URL(baseUrl);
    if (
      parsed.protocol !== "http:" || parsed.username || parsed.password ||
      !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    ) {
      throw new Error("Gateway control URL must be credential-free loopback HTTP");
    }
    this.#baseUrl = baseUrl.replace(/\/$/, "");
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.fetcher(`${this.#baseUrl}/healthz`, { signal });
      return response.ok;
    } catch {
      return false;
    }
  }

  async configureRun(
    runId: string,
    scenarioId: string,
    faults: unknown[],
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.fetcher(`${this.#baseUrl}/control/runs/${encodeURIComponent(runId)}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-pokedex-control-secret": this.controlSecret,
      },
      body: JSON.stringify({ scenarioId, faults }),
      signal,
    });
    if (!response.ok) throw new Error(`Gateway rejected run configuration (${response.status})`);
  }

  async readEvents(runId: string, signal?: AbortSignal): Promise<unknown[]> {
    const response = await this.fetcher(`${this.#baseUrl}/control/runs/${encodeURIComponent(runId)}/events`, {
      headers: { "x-pokedex-control-secret": this.controlSecret },
      signal,
    });
    if (!response.ok) throw new Error(`Gateway event read failed (${response.status})`);
    const body = await response.json() as { events?: unknown };
    if (!Array.isArray(body.events)) throw new Error("Gateway returned malformed events");
    return body.events;
  }
}

