import { describe, expect, test } from "bun:test";
import requests from "../src/fixtures/requests.json";
import { classify, planFor, type RoutableRequest } from "../src/lib/router";

describe("classify", () => {
  test("matches the class every fixture request is tagged with", () => {
    for (const r of requests as Array<{
      id: string;
      class: string;
      text: string;
      region: string;
      dataClass: string;
    }>) {
      const request: RoutableRequest = {
        id: r.id,
        text: r.text,
        region: r.region,
        dataClass: r.dataClass,
      };
      expect(classify(request)).toBe(r.class as ReturnType<typeof classify>);
    }
  });

  test("consequential requests always route through the human-approval reason", () => {
    const plan = planFor(
      {
        id: "r5",
        text: "Apply the winning readiness patch to main and push.",
        region: "us",
        dataClass: "internal",
      },
      0.05,
    );
    expect(plan.requestClass).toBe("consequential");
    expect(plan.reason).toMatch(/human approval/);
    expect(plan.contract.requestId).toBe("r5");
  });
});
