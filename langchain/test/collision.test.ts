/**
 * "Two workers must never write the same file."
 *
 * That rule is worth nothing as a convention. Here it is a reducer, and a reducer is a
 * function you can hand two colliding inputs and watch fail. These tests are the proof.
 */

import { describe, expect, test } from "bun:test";
import { START, StateGraph } from "@langchain/langgraph";
import {
  ArtifactCollision,
  DecomposeState,
  mergeArtifacts,
  scoreAgainstGroundTruth,
  type Artifact,
} from "../src/graphs/evidence.ts";

const artifact = (source: Artifact["source"], finding = "x"): Artifact => ({
  source,
  question: "q",
  finding,
  citations: [],
  exitCondition: "e",
  costUsd: 0,
  latencyMs: 1,
});

describe("artifact collision reducer", () => {
  test("merges disjoint keys", () => {
    const merged = mergeArtifacts({ network: artifact("network") }, { app: artifact("app") });
    expect(Object.keys(merged).sort()).toEqual(["app", "network"]);
  });

  test("THROWS ArtifactCollision when two workers write the same key", () => {
    expect(() => mergeArtifacts({ network: artifact("network") }, { network: artifact("network") })).toThrow(
      ArtifactCollision,
    );
  });

  test("the thrown error names the contested key and says why it matters", () => {
    try {
      mergeArtifacts({ state: artifact("state") }, { state: artifact("state") });
      throw new Error("expected a collision");
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactCollision);
      const e = error as ArtifactCollision;
      expect(e.key).toBe("state");
      expect(e.message).toContain("'state'");
      expect(e.message).toContain("decomposition is wrong");
    }
  });

  test("does not mutate the accumulated state", () => {
    const left = { network: artifact("network") };
    const merged = mergeArtifacts(left, { app: artifact("app") });
    expect(Object.keys(left)).toEqual(["network"]);
    expect(merged).not.toBe(left);
  });

  test("a collision inside a real graph surfaces, it is not swallowed", async () => {
    // Two nodes writing the same artifact key in the same superstep. This is the shape of
    // the mistake the rule exists to catch.
    const graph = new StateGraph(DecomposeState)
      .addNode("workerA", () => ({ artifacts: { network: artifact("network", "A") } }))
      .addNode("workerB", () => ({ artifacts: { network: artifact("network", "B") } }))
      .addEdge(START, "workerA")
      .addEdge(START, "workerB")
      .compile();

    let caught: unknown = null;
    try {
      await graph.invoke({ incident: "i" });
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect(String((caught as Error).message)).toContain("ArtifactCollision");
  });

  test("three distinct workers merge cleanly, which is the intended shape", async () => {
    // Node names cannot contain ":" — LangGraph reserves it for subgraph namespacing.
    const compiled = new StateGraph(DecomposeState)
      .addNode("worker_network", () => ({ artifacts: { network: artifact("network") } }))
      .addNode("worker_app", () => ({ artifacts: { app: artifact("app") } }))
      .addNode("worker_state", () => ({ artifacts: { state: artifact("state") } }))
      .addEdge(START, "worker_network")
      .addEdge(START, "worker_app")
      .addEdge(START, "worker_state")
      .compile();
    const final = await compiled.invoke({ incident: "i" });
    expect(Object.keys(final.artifacts as Record<string, Artifact>).sort()).toEqual(["app", "network", "state"]);
  });
});

describe("ground truth scoring", () => {
  test("recognises both independent causes when both are present", async () => {
    const score = await scoreAgainstGroundTruth(
      "CAUSES: proxy idle_timeout 60s vs heartbeat 90s; subscriptions not replayed after reconnect",
      {},
    );
    expect(score.foundProxyTimeout).toBe(true);
    expect(score.foundSubscriptionReplay).toBe(true);
    expect(score.score).toBe("2/2 causes");
  });

  test("catches the failure mode: proxy timeout alone is only half the answer", async () => {
    const score = await scoreAgainstGroundTruth(
      "VERDICT: the proxy closes idle connections after 60s; raise the idle_timeout and it is fixed.",
      {},
    );
    expect(score.foundProxyTimeout).toBe(true);
    expect(score.foundSubscriptionReplay).toBe(false);
    expect(score.verdict).toContain("found one cause and stopped");
  });
});
