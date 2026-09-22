/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once, returning results in the
 * same order as `items` regardless of which call finishes first. A small worker-pool: each of
 * `min(limit, items.length)` workers repeatedly claims the next index and writes its result
 * straight into that slot, so completion order never affects the output order.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
