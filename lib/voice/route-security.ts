import { NextRequest, NextResponse } from "next/server";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;
const counters = new Map<string, { startedAt: number; count: number }>();

function address(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || "unknown";
}

/** Process-local guard; put an equivalent limiter at the edge for multi-instance deployments. */
export function voiceRateLimit(request: NextRequest): NextResponse | null {
  const now = Date.now();
  const key = address(request);
  const previous = counters.get(key);
  const entry = !previous || now - previous.startedAt >= WINDOW_MS
    ? { startedAt: now, count: 1 }
    : { startedAt: previous.startedAt, count: previous.count + 1 };
  counters.set(key, entry);
  if (counters.size > 10_000) {
    for (const [itemKey, item] of counters) {
      if (now - item.startedAt >= WINDOW_MS) counters.delete(itemKey);
    }
  }
  if (entry.count <= MAX_REQUESTS) return null;
  return NextResponse.json({ error: "Too many voice requests. Please wait before trying again." }, {
    status: 429,
    headers: { "Retry-After": String(Math.ceil((WINDOW_MS - (now - entry.startedAt)) / 1000)) },
  });
}
