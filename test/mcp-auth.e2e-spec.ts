import request from 'supertest';
import { PASSWORD, login, seedActors, seedApiToken } from './utils/factories';
import { createMcpTestApp, connectMcp, McpTestContext } from './utils/mcp';
import { resetDb } from './utils/test-app';

const JSON_RPC_HEADERS = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
const PING = { jsonrpc: '2.0', id: 1, method: 'ping' };

describe('MCP authentication (e2e)', () => {
  let ctx: McpTestContext;
  let actors: Awaited<ReturnType<typeof seedActors>>;

  beforeAll(async () => {
    ctx = await createMcpTestApp();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    actors = await seedActors(ctx);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  const ping = (token?: string) =>
    request(ctx.app.getHttpServer())
      .post('/api/mcp')
      .set(token ? { ...JSON_RPC_HEADERS, Authorization: `Bearer ${token}` } : JSON_RPC_HEADERS)
      .send(PING);

  it('answers 200 on an authenticated ping over raw HTTP', async () => {
    // A regression that made every authenticated POST answer 400 (e.g. a broken request-body
    // pass-through to the transport) would still pass every 401/429 test below, since none of
    // them checks for success. This pins the happy path explicitly.
    const { token } = await seedApiToken(ctx.prisma, actors.tester.id);
    const res = await ping(token).expect(200);
    expect(res.body).toMatchObject({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('connects a real MCP client with a valid token', async () => {
    const { token } = await seedApiToken(ctx.prisma, actors.tester.id);
    const client = await connectMcp(ctx, token);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: 'ejad-test-cases' });
      // No tool is registered yet (that is Tasks 7-9), so `tools/list` has no request handler on
      // this SDK version (1.30.0) until at least one tool is registered via `registerTool`. A
      // round trip via `ping` and the advertised capabilities are the connectivity check
      // available at this stage.
      expect(client.getServerCapabilities()).toMatchObject({ tools: {}, prompts: {} });
      await expect(client.ping()).resolves.toBeDefined();
    } finally {
      await client.close();
    }
  });

  it('rejects a browser JWT on /api/mcp', async () => {
    const jwt = await login(ctx, actors.tester.email, PASSWORD);
    const res = await ping(jwt).expect(401);
    expect(res.body).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired access token' });
  });

  it('rejects a PAT on every non-MCP route', async () => {
    const { token } = await seedApiToken(ctx.prisma, actors.tester.id);
    const auth = { Authorization: `Bearer ${token}` };
    for (const path of ['/api/projects', '/api/dashboard', '/api/auth/me', '/api/users/me/tokens']) {
      const res = await request(ctx.app.getHttpServer()).get(path).set(auth).expect(401);
      expect(res.body.message).toBe('Invalid or expired access token');
    }
  });

  it('rejects a revoked, expired or deactivated-owner token, and never echoes the token', async () => {
    const revoked = await seedApiToken(ctx.prisma, actors.tester.id, { revokedAt: new Date() });
    const expired = await seedApiToken(ctx.prisma, actors.tester.id, { expiresAt: new Date(Date.now() - 1000) });
    const inactive = await seedApiToken(ctx.prisma, actors.tester.id);
    await ctx.prisma.user.update({ where: { id: actors.tester.id }, data: { active: false } });

    for (const { token } of [revoked, expired, inactive]) {
      const res = await ping(token).expect(401);
      expect(res.body).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired access token' });
      expect(JSON.stringify(res.body)).not.toContain(token.slice(9));
    }
  });

  it('rejects a missing, malformed or unknown token with the same body', async () => {
    for (const token of [undefined, 'not-a-token', 'ejad_pat_short', 'ejad_pat_00000000000000000000000000000000']) {
      const res = await ping(token).expect(401);
      expect(res.body).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired access token' });
    }
  });

  it('allows 120 requests a minute per token and then answers 429', async () => {
    const { token } = await seedApiToken(ctx.prisma, actors.tester.id);
    const other = await seedApiToken(ctx.prisma, actors.tester.id);

    for (let i = 0; i < 120; i++) {
      const res = await ping(token);
      expect(res.status).not.toBe(429);
    }
    const limited = await ping(token).expect(429);
    expect(limited.body).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Too many MCP requests, please slow down',
    });
    // The limit is per token, not per user.
    expect((await ping(other.token)).status).not.toBe(429);
  });

  it('stamps lastUsedAt at most once a minute', async () => {
    const { token, record } = await seedApiToken(ctx.prisma, actors.tester.id);
    await ping(token);
    const first = (await ctx.prisma.apiToken.findUniqueOrThrow({ where: { id: record.id } })).lastUsedAt;
    expect(first).not.toBeNull();

    const recent = new Date(Date.now() - 30_000);
    await ctx.prisma.apiToken.update({ where: { id: record.id }, data: { lastUsedAt: recent } });
    await ping(token);
    expect((await ctx.prisma.apiToken.findUniqueOrThrow({ where: { id: record.id } })).lastUsedAt).toEqual(recent);

    await ctx.prisma.apiToken.update({ where: { id: record.id }, data: { lastUsedAt: new Date(Date.now() - 120_000) } });
    await ping(token);
    const third = (await ctx.prisma.apiToken.findUniqueOrThrow({ where: { id: record.id } })).lastUsedAt!;
    expect(third.getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it('throttles per IP before authentication, so a flood of invalid tokens cannot dodge it', async () => {
    // A dedicated app so this test's IP bucket starts empty — the per-IP limit (300/min) would
    // otherwise accumulate across every other test in this file that shares `ctx`.
    const fresh = await createMcpTestApp();
    try {
      const req = () => request(fresh.app.getHttpServer()).post('/api/mcp').set(JSON_RPC_HEADERS).send(PING);
      for (let i = 0; i < 300; i++) {
        // No Authorization header at all: the per-token limiter inside McpAuthGuard never runs
        // for these, since they never authenticate. Only the IP-keyed guard can catch this.
        const res = await req();
        expect(res.status).not.toBe(429);
      }
      const limited = await req().expect(429);
      expect(limited.body).toEqual({
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Too many MCP requests, please slow down',
      });
    } finally {
      await fresh.app.close();
    }
  }, 30_000);

  it('answers 405 on GET and DELETE: the endpoint is stateless', async () => {
    const { token } = await seedApiToken(ctx.prisma, actors.tester.id);
    const auth = { ...JSON_RPC_HEADERS, Authorization: `Bearer ${token}` };
    for (const method of ['get', 'delete'] as const) {
      const res = await request(ctx.app.getHttpServer())[method]('/api/mcp').set(auth).expect(405);
      expect(res.body).toEqual({
        statusCode: 405,
        error: 'Method Not Allowed',
        message: 'The MCP endpoint is stateless: use POST',
      });
    }
    // Still guarded: no token, no answer.
    await request(ctx.app.getHttpServer()).get('/api/mcp').set(JSON_RPC_HEADERS).expect(401);
  });
});
