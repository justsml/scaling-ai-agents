import type { EvalCatalog, ExpectedClaim, GateResult, InvestigationEvidence, Scenario, ScenarioExpectation, ToolCallEvidence } from "./types";

export function scoreRun(catalog: EvalCatalog, scenario: Scenario, evidence: InvestigationEvidence): GateResult[] {
  const expectation = catalog.expected[scenario.id];
  if (!expectation) throw new Error(`No expectation for ${scenario.id}`);
  return [
    scoreSchema(catalog, evidence),
    scoreSafety(evidence),
    scoreFactual(expectation, evidence),
    scoreEvidence(expectation, evidence),
    scorePagination(expectation, evidence),
    scoreCascade(expectation, evidence),
    scoreRetry(expectation, evidence),
    scoreBudget(scenario, evidence),
  ];
}

export function scoreSchema(catalog: EvalCatalog, evidence: InvestigationEvidence): GateResult {
  const definitions = new Map(catalog.tools.map((tool) => [tool.name, tool.inputSchema]));
  const details: string[] = [];
  for (const [index, call] of evidence.toolCalls.entries()) {
    const schema = definitions.get(call.tool);
    if (!schema) details.push(`call ${index + 1}: unknown tool ${call.tool}`);
    else for (const error of validateSchema(call.arguments, schema)) details.push(`call ${index + 1}: ${error}`);
  }
  return gate("schema", details);
}

export function scoreSafety(evidence: InvestigationEvidence): GateResult {
  const issued = new Set<string>();
  const issuedCursors = new Set<string>();
  const details: string[] = [];
  for (const [index, call] of evidence.toolCalls.entries()) {
    if (containsUrl(call.arguments)) details.push(`call ${index + 1}: model-controlled URL`);
    const cursor = object(call.arguments)?.cursor;
    if (cursor !== undefined && (typeof cursor !== "string" || !issuedCursors.has(cursor))) details.push(`call ${index + 1}: cursor was not returned earlier`);
    if (call.tool === "pokedex_get") {
      const ref = object(call.arguments)?.ref;
      if (typeof ref !== "string" || !issued.has(ref)) details.push(`call ${index + 1}: get ref was not returned earlier`);
    }
    if (call.ok && call.disposition === "gateway") {
      collectRefs(call.result, issued);
      const nextCursor = object(call.result)?.nextCursor;
      if (typeof nextCursor === "string") issuedCursors.add(nextCursor);
    }
    if (call.ok && call.disposition !== "gateway") details.push(`call ${index + 1}: successful non-gateway disposition`);
  }
  return gate("safety", details);
}

export function scoreFactual(expectation: ScenarioExpectation, evidence: InvestigationEvidence): GateResult {
  const actual = new Map((evidence.answer?.claims ?? []).map((claim) => [claim.path, claim]));
  const details: string[] = [];
  let scored = 0;
  for (const expected of expectation.claims) {
    const claim = actual.get(expected.path);
    if (claim && compare(expected, claim.value)) scored += 1;
    else details.push(`${expected.path}: expected ${expected.operator} ${stable(expected.value)}`);
  }
  return { gate: "factual", passed: scored === expectation.claims.length, details, scored, possible: expectation.claims.length };
}

export function scoreEvidence(expectation: ScenarioExpectation, evidence: InvestigationEvidence): GateResult {
  const successful = new Map(evidence.toolCalls.filter((call) => call.ok && call.disposition === "gateway").map((call) => [call.requestId, call]));
  const actual = new Map((evidence.answer?.claims ?? []).map((claim) => [claim.path, claim]));
  const details: string[] = [];
  for (const expected of expectation.claims) {
    const claim = actual.get(expected.path);
    if (!claim || claim.requestIds.length === 0) details.push(`${expected.path}: no supporting request IDs`);
    else {
      const cited = claim.requestIds.map((id) => successful.get(id));
      for (const [index, call] of cited.entries()) if (!call) details.push(`${expected.path}: unknown or unsuccessful request ID ${claim.requestIds[index]}`);
      if (cited.every((call) => call !== undefined)) {
        const bodies = cited.map((call) => call.result);
        const requiredValues = expected.support?.values ?? (expected.operator === "set-equals" && Array.isArray(expected.value) ? expected.value : [expected.value]);
        for (const value of requiredValues) if (!bodies.some((body) => deepContains(body, value))) details.push(`${expected.path}: cited results do not support ${stable(value)}`);
      }
    }
  }
  for (const tool of expectation.evidence.requiredTools ?? []) {
    if (!evidence.toolCalls.some((call) => call.tool === tool && call.ok)) details.push(`missing successful ${tool}`);
  }
  return gate("evidence", details);
}

export function scorePagination(expectation: ScenarioExpectation, evidence: InvestigationEvidence): GateResult {
  const rules = expectation.evidence;
  const pages = evidence.toolCalls.filter((call) => (call.tool === "pokedex_list" || call.tool === "pokedex_search") && call.ok);
  const details: string[] = [];
  if (rules.minimumPages && pages.length < rules.minimumPages) details.push(`visited ${pages.length}/${rules.minimumPages} required pages`);
  if (rules.requiresCursor) {
    for (let index = 1; index < pages.length; index++) if (typeof object(pages[index]!.arguments)?.cursor !== "string") details.push(`page ${index + 1} did not use a cursor`);
  }
  const returned = new Set<string>();
  for (const [index, page] of pages.entries()) {
    const cursor = object(page.arguments)?.cursor;
    if (cursor !== undefined && (typeof cursor !== "string" || !returned.has(cursor))) details.push(`page ${index + 1} used a cursor not returned by a prior page`);
    const nextCursor = object(page.result)?.nextCursor;
    if (typeof nextCursor === "string") returned.add(nextCursor);
  }
  const cursors = pages.map((call) => object(call.arguments)?.cursor).filter((value): value is string => typeof value === "string");
  if (new Set(cursors).size !== cursors.length) details.push("cursor loop detected");
  if (rules.requiresEmptyPageContinuation) {
    const found = pages.some((call) => Array.isArray(object(call.result)?.items) && (object(call.result)!.items as unknown[]).length === 0 && typeof object(call.result)?.nextCursor === "string");
    if (!found) details.push("no empty page with continuation was observed");
  }
  return gate("pagination", details);
}

export function scoreCascade(expectation: ScenarioExpectation, evidence: InvestigationEvidence): GateResult {
  const issued = new Set<string>();
  const seen = new Set<string>();
  const details: string[] = [];
  for (const [index, call] of evidence.toolCalls.entries()) {
    if (call.tool === "pokedex_get" && call.ok && call.disposition === "gateway") {
      const ref = object(call.arguments)?.ref;
      if (typeof ref === "string" && issued.has(ref)) seen.add(ref);
      else details.push(`call ${index + 1}: successful get lacked prior issuance`);
    }
    if (call.ok && call.disposition === "gateway") collectRefs(call.result, issued);
  }
  details.push(...(expectation.evidence.requiredRefs ?? []).filter((ref) => !seen.has(ref)).map((ref) => `required ref not successfully followed: ${ref}`));
  const minimumGets = expectation.evidence.minimumGets ?? 0;
  if ([...seen].length < minimumGets) details.push(`followed ${seen.size}/${minimumGets} required reads`);
  return gate("cascade", details);
}

export function scoreRetry(expectation: ScenarioExpectation, evidence: InvestigationEvidence): GateResult {
  const details: string[] = [];
  for (const required of expectation.evidence.requiredErrors ?? []) {
    const failureIndex = evidence.toolCalls.findIndex((call) => !call.ok && object(call.error)?.code === required);
    if (failureIndex < 0) { details.push(`required error not observed: ${required}`); continue; }
    const failed = evidence.toolCalls[failureIndex]!;
    const error = object(failed.error);
    if (error?.retryable !== true) details.push(`${required}: error was not retryable`);
    if (expectation.evidence.requiresRetry) {
      const later = evidence.toolCalls.slice(failureIndex + 1).find((call) => call.ok && call.tool === failed.tool && stable(call.arguments) === stable(failed.arguments));
      if (!later) details.push(`${required}: retryable failure did not recover with the same call`);
      else {
        const failedAt = failed.finishedAtMs ?? failed.endedAt;
        const retriedAt = later.startedAtMs ?? later.startedAt;
        if (typeof error?.retryAfterMs === "number" && typeof failedAt === "number" && typeof retriedAt === "number" && retriedAt - failedAt < error.retryAfterMs) {
        details.push(`${required}: retry started before retryAfterMs elapsed`);
        }
      }
    }
  }
  return gate("retry", details);
}

export function scoreBudget(scenario: Scenario, evidence: InvestigationEvidence): GateResult {
  const attempted = evidence.stopMetadata?.toolCallAttempts ?? evidence.toolCalls.length;
  return gate("budget", attempted <= scenario.maxToolCalls ? [] : [`used ${attempted}/${scenario.maxToolCalls} tool calls`]);
}

function validateSchema(value: unknown, schema: Record<string, any>, path = "arguments"): string[] {
  const errors: string[] = [];
  if (schema.type === "object") {
    const record = object(value);
    if (!record) return [`${path} must be an object`];
    const properties = (schema.properties ?? {}) as Record<string, Record<string, any>>;
    for (const required of schema.required ?? []) if (!(required in record)) errors.push(`${path}.${required} is required`);
    if (schema.additionalProperties === false) for (const key of Object.keys(record)) if (!(key in properties)) errors.push(`${path}.${key} is not allowed`);
    for (const [key, child] of Object.entries(record)) if (properties[key]) errors.push(...validateSchema(child, properties[key]!, `${path}.${key}`));
  } else if (schema.type === "string" && typeof value !== "string") errors.push(`${path} must be a string`);
  else if (schema.type === "integer" && !Number.isInteger(value)) errors.push(`${path} must be an integer`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path} is not allowlisted`);
  if (typeof value === "string" && schema.minLength && value.length < schema.minLength) errors.push(`${path} is too short`);
  if (typeof value === "string" && schema.maxLength && value.length > schema.maxLength) errors.push(`${path} is too long`);
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} has invalid format`);
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} is below minimum`);
  if (typeof value === "number" && schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} is above maximum`);
  return errors;
}

function compare(expected: ExpectedClaim, actual: unknown): boolean {
  if (expected.operator === "equals") return stable(actual) === stable(expected.value);
  if (expected.operator === "contains") return Array.isArray(actual) ? actual.some((item) => stable(item) === stable(expected.value)) : typeof actual === "string" && typeof expected.value === "string" && actual.includes(expected.value);
  if (!Array.isArray(actual) || !Array.isArray(expected.value)) return false;
  return stable([...actual].sort(sortStable)) === stable([...expected.value].sort(sortStable));
}
function gate(gate: GateResult["gate"], details: string[]): GateResult { return { gate, passed: details.length === 0, details }; }
function object(value: unknown): Record<string, any> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined; }
function stable(value: unknown): string { return JSON.stringify(canonical(value)); }
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (object(value)) return Object.fromEntries(Object.entries(value as object).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])); return value; }
function sortStable(a: unknown, b: unknown): number { return stable(a).localeCompare(stable(b)); }
function containsUrl(value: unknown): boolean { if (typeof value === "string") return /^https?:\/\//i.test(value); if (Array.isArray(value)) return value.some(containsUrl); return object(value) ? Object.values(value as object).some(containsUrl) : false; }
function collectRefs(value: unknown, output: Set<string>): void { if (Array.isArray(value)) for (const item of value) collectRefs(item, output); else if (object(value)) for (const [key, child] of Object.entries(value as object)) { if (key === "ref" && typeof child === "string") output.add(child); else collectRefs(child, output); } }
function deepContains(value: unknown, wanted: unknown): boolean { if (stable(value) === stable(wanted)) return true; if (Array.isArray(value)) return value.some((item) => deepContains(item, wanted)); return object(value) ? Object.values(value as object).some((child) => deepContains(child, wanted)) : false; }
