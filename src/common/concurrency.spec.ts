import { mapWithConcurrency } from './concurrency';

describe('mapWithConcurrency', () => {
  it('never runs more than `limit` calls at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrency(items, 6, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Vary the delay so calls don't all finish in submission order.
      await new Promise((resolve) => setTimeout(resolve, (item % 3) + 1));
      inFlight--;
      return item;
    });
    expect(maxInFlight).toBeLessThanOrEqual(6);
    expect(maxInFlight).toBe(6);
  });

  it('returns results in input order regardless of which call finishes first', async () => {
    const items = [50, 10, 30, 5, 40, 20, 1, 2, 3];
    const result = await mapWithConcurrency(items, 3, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item));
      return item;
    });
    expect(result).toEqual(items);
  });

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapWithConcurrency([], 6, async (item) => item)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 6, async (item) => item * 2)).toEqual([2, 4]);
  });

  it('propagates a rejection from any call', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom');
        return item;
      }),
    ).rejects.toThrow('boom');
  });

  it('stops claiming new items once a call has failed', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (item) => {
        started.push(item);
        if (item === 2) throw new Error('boom');
        await new Promise((resolve) => setTimeout(resolve, 20));
        return item;
      }),
    ).rejects.toThrow('boom');
    // Only the two items already claimed by the two workers when the failure happened started;
    // nothing past that point was claimed.
    expect(started).toEqual([1, 2]);
  });

  it('rejects a limit below 1', async () => {
    await expect(mapWithConcurrency([1, 2], 0, async (item) => item)).rejects.toThrow('mapWithConcurrency: limit must be at least 1');
    await expect(mapWithConcurrency([1, 2], -1, async (item) => item)).rejects.toThrow('mapWithConcurrency: limit must be at least 1');
  });
});
