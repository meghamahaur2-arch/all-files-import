/**
 * Lightweight per-IP rate limiter for unauthenticated POST endpoints.
 *
 * This is an in-memory sliding-window counter that runs in the worker process.
 * It is not a distributed rate limit. For a hardened production deploy, swap
 * the backing store for a Cloudflare Durable Object or a Redis key.
 */

const buckets = new Map<string, { count: number; windowStart: number }>();

const DEFAULT_WINDOW_MS = 60_000;

export type RateLimitOptions = {
  limit: number;
  windowMs?: number;
  scope: string;
};

/**
 * Picks the best available client identifier from headers. We prefer headers
 * the platform sets that an attacker cannot forge:
 *
 *   1. `x-vercel-forwarded-for` — set by Vercel's edge, opaque to clients.
 *   2. `cf-connecting-ip` — Cloudflare-only, same property.
 *   3. The LAST hop of `x-forwarded-for` — proxies append, so the rightmost
 *      entry is the most-recent-trusted proxy IP. The leftmost is whatever
 *      the client claimed and is spoofable.
 *
 * Falling back to user-agent is purely a courtesy so bucket isolation still
 * happens at all when the request bypasses the edge — it is not a security
 * boundary.
 */
function clientKey(request: Request, scope: string) {
  const headers = request.headers;
  const vercel = headers.get("x-vercel-forwarded-for")?.trim();
  const cfConnecting = headers.get("cf-connecting-ip")?.trim();
  const realIp = headers.get("x-real-ip")?.trim();

  const forwardedChain = headers.get("x-forwarded-for") ?? "";
  const forwardedHops = forwardedChain
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  // Last hop = closest to our edge, hardest to forge.
  const lastForwardedHop = forwardedHops.length
    ? forwardedHops[forwardedHops.length - 1]
    : undefined;

  const fallback = `ua:${(headers.get("user-agent") ?? "anonymous").slice(0, 64)}`;
  const ip = vercel || cfConnecting || realIp || lastForwardedHop || fallback;
  return `${scope}:${ip}`;
}

export function checkRateLimit(
  request: Request,
  options: RateLimitOptions,
): { ok: true } | { ok: false; retryAfter: number; response: Response } {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const key = clientKey(request, options.scope);
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || now - existing.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    if (buckets.size > 5000) {
      const cutoff = now - windowMs;
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.windowStart < cutoff) buckets.delete(bucketKey);
      }
    }
    return { ok: true };
  }

  if (existing.count >= options.limit) {
    const retryAfter = Math.max(1, Math.ceil((existing.windowStart + windowMs - now) / 1000));
    return {
      ok: false,
      retryAfter,
      response: Response.json(
        {
          error: "Too many requests. Slow down.",
          retryAfterSeconds: retryAfter,
        },
        { status: 429, headers: { "retry-after": String(retryAfter) } },
      ),
    };
  }

  existing.count += 1;
  return { ok: true };
}
