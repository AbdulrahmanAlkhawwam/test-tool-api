import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestApp, TestContext } from './test-app';

export interface McpTestContext extends TestContext {
  /** Absolute URL of the MCP endpoint, e.g. http://127.0.0.1:53421/api/mcp */
  mcpUrl: string;
}

/**
 * Builds the app and actually binds a port: a real MCP client talks to a URL over fetch, so
 * supertest's unbound server is not enough. `getUrl()` reports http://[::1]:<port> on Node 22,
 * which fetch cannot always resolve, so the host is rewritten to 127.0.0.1.
 */
export async function createMcpTestApp(): Promise<McpTestContext> {
  const ctx = await createTestApp();
  await ctx.app.listen(0);
  const base = (await ctx.app.getUrl()).replace('[::1]', '127.0.0.1').replace('::1', '127.0.0.1');
  return { ...ctx, mcpUrl: `${base}/api/mcp` };
}

/** Connects a real MCP client with a PAT. Always `await client.close()` in the test. */
export async function connectMcp(ctx: McpTestContext, token: string): Promise<Client> {
  const client = new Client({ name: 'ejad-e2e', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(ctx.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function firstText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
}

/** Calls a tool and parses its JSON text content. Throws if the tool reported an error. */
export async function callTool<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if ((result as { isError?: boolean }).isError) throw new Error(`tool ${name} failed: ${firstText(result)}`);
  return JSON.parse(firstText(result)) as T;
}

/** Calls a tool and returns the raw envelope, for asserting tool errors. */
export async function callToolRaw(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  return { isError: !!(result as { isError?: boolean }).isError, text: firstText(result) };
}
