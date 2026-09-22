/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once, returning results in the
 * same order as `items` regardless of which call finishes first. A small worker-pool: each of
 * `min(limit, items.length)` workers repeatedly claims the next index and writes its result
 * straight into that slot, so completion order never affects the output order.
 *
 * Once any call fails, no worker claims a further item (a shared flag is checked right before each
 * claim) — calls already in flight still run to completion, but nothing new is started. The first
 * failure is what this function rejects with.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  // `!(limit >= 1)` (rather than `limit < 1`) also catches NaN: `NaN < 1` is false, which would
  // silently spawn zero workers and return an array of holes instead of rejecting.
  if (!(limit >= 1)) throw new Error('mapWithConcurrency: limit must be at least 1');
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
