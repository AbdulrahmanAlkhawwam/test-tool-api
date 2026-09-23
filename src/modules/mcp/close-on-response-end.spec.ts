import { EventEmitter } from 'events';
import { Closable, closeOnResponseEnd } from './close-on-response-end';

/** Flushes microtasks/macrotasks enough times for the fire-and-forget close() calls to settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('closeOnResponseEnd', () => {
  it('never produces an unhandled rejection when a closable rejects after the response closes', async () => {
    const res = new EventEmitter();
    const rejecting: Closable = { close: jest.fn().mockRejectedValue(new Error('transport already closing')) };
    const resolving: Closable = { close: jest.fn().mockResolvedValue(undefined) };

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      closeOnResponseEnd(res, rejecting, resolving);
      res.emit('close');
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('closes every closable even when an earlier one rejects', async () => {
    const res = new EventEmitter();
    const first: Closable = { close: jest.fn().mockRejectedValue(new Error('boom')) };
    const second: Closable = { close: jest.fn().mockResolvedValue(undefined) };

    closeOnResponseEnd(res, first, second);
    res.emit('close');
    await flush();

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it('closes every closable even when an earlier one throws synchronously instead of rejecting', async () => {
    const res = new EventEmitter();
    const throwing: Closable = {
      close: jest.fn(() => {
        throw new Error('boom, synchronously');
      }),
    };
    const resolving: Closable = { close: jest.fn().mockResolvedValue(undefined) };

    closeOnResponseEnd(res, throwing, resolving);
    // A synchronous throw from a 'close' listener would otherwise propagate straight out of
    // emit() (EventEmitter does not catch listener exceptions for a plain event like this one).
    expect(() => res.emit('close')).not.toThrow();
    await flush();

    expect(throwing.close).toHaveBeenCalledTimes(1);
    expect(resolving.close).toHaveBeenCalledTimes(1);
  });

  it('does nothing until the response closes', () => {
    const res = new EventEmitter();
    const closable: Closable = { close: jest.fn().mockResolvedValue(undefined) };
    closeOnResponseEnd(res, closable);
    expect(closable.close).not.toHaveBeenCalled();
  });
});
