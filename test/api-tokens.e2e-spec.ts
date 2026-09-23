import { seedActors, seedApiToken } from './utils/factories';
import { createTestApp, resetDb, TestContext } from './utils/test-app';

describe('API tokens (e2e)', () => {
  let ctx: TestContext;
  let actors: Awaited<ReturnType<typeof seedActors>>;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    actors = await seedActors(ctx);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('creates a token, shows it once, and lists metadata without the secret', async () => {
    const created = await ctx.http().post('/api/users/me/tokens').set(actors.testerAuth)
      .send({ name: 'Claude Code', expiresInDays: 30 }).expect(201);

    expect(created.body.token).toMatch(/^ejad_pat_[0-9A-Za-z]{32}$/);
    expect(created.body).toMatchObject({ name: 'Claude Code', purpose: 'MCP', lastUsedAt: null, revokedAt: null });
    expect(created.body.prefix).toBe(created.body.token.slice(9, 17));
    expect(created.body).not.toHaveProperty('tokenHash');
    const expiresInDays = Math.round((new Date(created.body.expiresAt).getTime() - Date.now()) / 86_400_000);
    expect(expiresInDays).toBe(30);

    const list = await ctx.http().get('/api/users/me/tokens').set(actors.testerAuth).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: created.body.id, name: 'Claude Code', prefix: created.body.prefix });
    expect(JSON.stringify(list.body)).not.toContain(created.body.token.slice(9));
    expect(list.body[0]).not.toHaveProperty('token');
    expect(list.body[0]).not.toHaveProperty('tokenHash');
  });

  it('defaults to 90 days and rejects a bad name or expiry', async () => {
    const created = await ctx.http().post('/api/users/me/tokens').set(actors.testerAuth).send({ name: 'Cursor' }).expect(201);
    expect(Math.round((new Date(created.body.expiresAt).getTime() - Date.now()) / 86_400_000)).toBe(90);

    for (const payload of [
      { name: '' },
      { name: '   ' },
      { name: 'x', expiresInDays: 45 },
      { name: 'x', expiresInDays: 0 },
      { name: 'x', expiresInDays: null },
      {},
    ]) {
      const res = await ctx.http().post('/api/users/me/tokens').set(actors.testerAuth).send(payload).expect(400);
      expect(res.body.message).toBe('Validation failed');
    }
  });

  it('trims the name before validating and storing it', async () => {
    const created = await ctx.http().post('/api/users/me/tokens').set(actors.testerAuth)
      .send({ name: '  Claude Code  ' }).expect(201);
    expect(created.body.name).toBe('Claude Code');
  });

  it('rejects a userId in the create body instead of silently ignoring it', async () => {
    const res = await ctx.http().post('/api/users/me/tokens').set(actors.testerAuth)
      .send({ name: 'Spoofed', userId: actors.admin.id }).expect(400);
    expect(res.body.message).toBe('Validation failed');
    expect(await ctx.prisma.apiToken.count({ where: { userId: actors.admin.id } })).toBe(0);
  });

  it('revokes only the caller’s own tokens, and list() is scoped to the caller', async () => {
    const mine = await seedApiToken(ctx.prisma, actors.tester.id);
    const theirs = await seedApiToken(ctx.prisma, actors.admin.id);

    await ctx.http().delete(`/api/users/me/tokens/${mine.record.id}`).set(actors.testerAuth).expect(204);
    const revoked = await ctx.prisma.apiToken.findUniqueOrThrow({ where: { id: mine.record.id } });
    expect(revoked.revokedAt).not.toBeNull();

    const res = await ctx.http().delete(`/api/users/me/tokens/${theirs.record.id}`).set(actors.testerAuth).expect(404);
    expect(res.body.message).toBe('Token not found');
    await ctx.http().delete(`/api/users/me/tokens/${mine.record.id}`).set(actors.testerAuth).expect(404);
    expect(await ctx.prisma.apiToken.count({ where: { userId: actors.tester.id } })).toBe(1);

    const list = await ctx.http().get('/api/users/me/tokens').set(actors.testerAuth).expect(200);
    expect(list.body.map((t: { id: string }) => t.id)).not.toContain(theirs.record.id);
    expect(list.body.map((t: { id: string }) => t.id)).toContain(mine.record.id);
  });

  it('needs a browser JWT: a PAT cannot manage tokens', async () => {
    const { token } = await seedApiToken(ctx.prisma, actors.tester.id);
    const res = await ctx.http().get('/api/users/me/tokens').set({ Authorization: `Bearer ${token}` }).expect(401);
    expect(res.body).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired access token' });

    await ctx.http().get('/api/users/me/tokens').expect(401);
  });
});
