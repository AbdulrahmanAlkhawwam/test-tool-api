export interface Closable {
  close(): Promise<void>;
}

/**
 * Registers cleanup for the per-request MCP transport/server pair once the HTTP response ends.
 * `close()` on either one may reject — e.g. the client aborted the connection mid-teardown — and
 * an unhandled rejection here would crash the whole Node 22 process, turning one aborted MCP
 * request into a denial of service for every other client. `.catch(() => {})` on each closable
 * makes a failed close a no-op: there is nothing more a listener firing after the response is
 * already gone can usefully do about it.
 */
export function closeOnResponseEnd(res: { on(event: 'close', listener: () => void): unknown }, ...closables: Closable[]): void {
  res.on('close', () => {
    for (const closable of closables) void closable.close().catch(() => {});
  });
}
