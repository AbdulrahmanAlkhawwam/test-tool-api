import { Injectable, Optional } from '@nestjs/common';

/** Spec §4: 120 MCP requests per minute per token. */
export const MCP_RATE_LIMIT = 120;
export const MCP_RATE_WINDOW_MS = 60_000;
/** Above this many tracked tokens the map is pruned; a single container never needs more. */
const DEFAULT_MAX_KEYS = 10_000;

interface Bucket {
  windowStart: number;
  count: number;
}

/**
 * Fixed-window counter, in memory. The API runs as a single container (see README), so there is
 * no shared store to keep in sync. A restart forgives everyone's current window, which is the
 * right trade for a politeness limit.
 */
@Injectable()
export class TokenRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  // `@Optional()` on each param: NestJS DI otherwise tries to resolve a provider for these
  // constructor arguments (their design-time type is ambiguous because they carry default
  // values instead of explicit type annotations) and throws instead of falling back to the
  // default. `@Optional()` makes an unresolved dependency come through as `undefined`, which
  // is exactly when a JS default parameter applies — so DI-constructed instances still get
  // MCP_RATE_LIMIT / MCP_RATE_WINDOW_MS / DEFAULT_MAX_KEYS, while unit tests can still call
  // `new TokenRateLimiter(3, 1000)` directly.
  constructor(
    @Optional() private readonly limit: number = MCP_RATE_LIMIT,
    @Optional() private readonly windowMs: number = MCP_RATE_WINDOW_MS,
    @Optional() private readonly maxKeys: number = DEFAULT_MAX_KEYS,
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  /** True when the request is allowed; false when this key is over its limit for this window. */
  hit(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      if (this.buckets.size >= this.maxKeys) this.prune(now);
      this.buckets.set(key, { windowStart: now, count: 1 });
      return true;
    }
    if (bucket.count >= this.limit) return false;
    bucket.count++;
    return true;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs) this.buckets.delete(key);
    }
    // Still full: every bucket is live, so start over rather than grow forever.
    if (this.buckets.size >= this.maxKeys) this.buckets.clear();
  }
}
