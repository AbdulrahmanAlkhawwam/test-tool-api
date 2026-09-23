export interface Closable {
  close(): Promise<void>;
}

/**
 * Registers cleanup for the per-request MCP transport/server pair once the HTTP response ends.
 * `close()` on either one may reject — e.g. the client aborted the connection mid-teardown — and
 * an unhandled rejection here would crash the whole Node 22 process, turning one aborted MCP
 * request into a denial of service for every other client. `.catch(() => {})` on each closable
 * makes a failed close a no-op: there is nothing more a listener firing after the response is
 * already gone can usefully do about it. `close()` is also allowed to throw synchronously instead
 * of returning a rejected promise (e.g. a getter/proxy blowing up before any awaiting happens), so
 * each call is wrapped in try/catch as well — otherwise that throw would escape the `close`
 * listener as an uncaught exception (the same crash this function exists to prevent) and would
 * also abort the loop, skipping every closable after it.
 */
export function closeOnResponseEnd(res: { on(event: 'close', listener: () => void): unknown }, ...closables: Closable[]): void {
  res.on('close', () => {
    for (const closable of closables) {
      try {
        void closable.close().catch(() => {});
      } catch {
        // A synchronous throw from close() itself — nothing more to do.
      }
    }
  });
}
