import { createHmac, timingSafeEqual } from "node:crypto";
import { ToolError, type Resource } from "./contract";

interface CursorPayload {
  v: 1;
  operation: "list" | "search";
  resource: Resource;
  offset: number;
  query?: string;
}

function signature(encoded: string, secret: string): string {
  return createHmac("sha256", secret).update(encoded).digest("base64url");
}

export function encodeCursor(payload: CursorPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(encoded, secret)}`;
}

export function decodeCursor(
  cursor: unknown,
  expected: Omit<CursorPayload, "v" | "offset">,
  secret: string,
): CursorPayload {
  if (typeof cursor !== "string" || cursor.length > 2048) invalidCursor();
  const [encoded, supplied, extra] = cursor.split(".");
  if (!encoded || !supplied || extra !== undefined) invalidCursor();
  const wanted = signature(encoded, secret);
  const suppliedBytes = Buffer.from(supplied);
  const wantedBytes = Buffer.from(wanted);
  if (suppliedBytes.length !== wantedBytes.length || !timingSafeEqual(suppliedBytes, wantedBytes)) {
    invalidCursor();
  }

  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    invalidCursor();
  }
  if (
    payload.v !== 1 ||
    payload.operation !== expected.operation ||
    payload.resource !== expected.resource ||
    payload.query !== expected.query ||
    !Number.isSafeInteger(payload.offset) ||
    payload.offset < 0
  ) {
    invalidCursor();
  }
  return payload;
}

function invalidCursor(): never {
  throw new ToolError(400, {
    code: "INVALID_CURSOR",
    message: "cursor is invalid or belongs to a different query",
    retryable: false,
    retryAfterMs: null,
  });
}
