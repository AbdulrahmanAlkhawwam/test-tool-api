import { MCP_RATE_LIMIT, MCP_RATE_WINDOW_MS, TokenRateLimiter } from './token-rate-limiter';

describe('TokenRateLimiter', () => {
  it('allows the limit and blocks the next request in the same window', () => {
    const limiter = new TokenRateLimiter(3, 1000);
    expect([limiter.hit('t', 0), limiter.hit('t', 10), limiter.hit('t', 20)]).toEqual([true, true, true]);
    expect(limiter.hit('t', 30)).toBe(false);
    expect(limiter.hit('t', 999)).toBe(false);
  });

  it('starts a fresh window once the old one has passed', () => {
    const limiter = new TokenRateLimiter(2, 1000);
    expect(limiter.hit('t', 0)).toBe(true);
    expect(limiter.hit('t', 500)).toBe(true);
    expect(limiter.hit('t', 900)).toBe(false);
    expect(limiter.hit('t', 1000)).toBe(true);
    expect(limiter.hit('t', 1001)).toBe(true);
    expect(limiter.hit('t', 1002)).toBe(false);
  });

  it('counts every token separately', () => {
    const limiter = new TokenRateLimiter(1, 1000);
    expect(limiter.hit('a', 0)).toBe(true);
    expect(limiter.hit('b', 0)).toBe(true);
    expect(limiter.hit('a', 1)).toBe(false);
    expect(limiter.hit('b', 1)).toBe(false);
  });

  it('drops stale buckets so memory cannot grow without bound', () => {
    const limiter = new TokenRateLimiter(5, 1000, 3);
    for (const key of ['a', 'b', 'c', 'd']) limiter.hit(key, 0);
    expect(limiter.size).toBeLessThanOrEqual(3);
    limiter.hit('e', 5000);
    expect(limiter.size).toBeLessThanOrEqual(3);
    expect(limiter.hit('e', 5001)).toBe(true);
  });

  it('defaults to 120 requests per minute (spec §4)', () => {
    expect(MCP_RATE_LIMIT).toBe(120);
    expect(MCP_RATE_WINDOW_MS).toBe(60_000);
    const limiter = new TokenRateLimiter();
    for (let i = 0; i < MCP_RATE_LIMIT; i++) expect(limiter.hit('t', 0)).toBe(true);
    expect(limiter.hit('t', 0)).toBe(false);
  });
});
