import { createHash } from 'crypto';
import { TokenCipher } from '../src/common/crypto/token-cipher';
import { FakeGitlab } from './utils/fake-gitlab';
import { seedActors } from './utils/factories';
import { createGitlabTestApp, seedGitlabConnection } from './utils/gitlab';
import { resetDb, TestContext } from './utils/test-app';

// GitLab redirects the browser to the WEB app, which then calls POST /api/gitlab/oauth/complete.
const REDIRECT_URI = 'http://localhost:3001/gitlab/callback';

describe('GitLab connection (e2e)', () => {
  let ctx: TestContext;
  let fake: FakeGitlab;
  let actors: Awaited<ReturnType<typeof seedActors>>;

  beforeAll(async () => {
    ({ ctx, fake } = await createGitlabTestApp());
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    fake.reset();
    actors = await seedActors(ctx);
  });
  afterAll(async () => {
    await ctx.app.close();
    await fake.close();
  });

  const startOAuth = async (auth = actors.testerAuth) => {
    const res = await ctx.http().get('/api/gitlab/oauth/start').set(auth).expect(200);
    return new URL(res.body.authorizeUrl as string);
  };

  const complete = (auth: Record<string, string>, body: { code?: string; state: string; error?: string }) =>
    ctx.http().post('/api/gitlab/oauth/complete').set(auth).send(body);

  it('reports the connection status', async () => {
    const before = await ctx.http().get('/api/gitlab/status').set(actors.testerAuth).expect(200);
    expect(before.body).toEqual({ enabled: true, connection: null });
    await seedGitlabConnection(ctx, fake, actors.tester.id, { username: 'tess' });
    const after = await ctx.http().get('/api/gitlab/status').set(actors.testerAuth).expect(200);
    expect(after.body).toEqual({ enabled: true, connection: { username: 'tess', avatarUrl: null, state: 'ACTIVE' } });
  });

  it('starts OAuth with PKCE and a hashed, user-bound state', async () => {
    const url = await startOAuth();
    expect(`${url.origin}${url.pathname}`).toBe(`${fake.url}/oauth/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'test-client',
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'api',
      code_challenge_method: 'S256',
    });
    const state = url.searchParams.get('state')!;
    const row = await ctx.prisma.gitlabOAuthState.findFirstOrThrow();
    expect(row.userId).toBe(actors.tester.id);
    expect(row.stateHash).toBe(createHash('sha256').update(state).digest('hex'));
    expect(row.codeVerifierEnc.startsWith('v1:')).toBe(true);
    const ttl = row.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
  });

  it('completes the OAuth flow for the signed-in user, storing encrypted tokens', async () => {
    const url = await startOAuth();
    const gitlabUser = fake.addUser({ username: 'tess', avatar_url: 'https://git.test/tess.png' });
    const code = fake.issueAuthCode(gitlabUser, url.searchParams.get('code_challenge')!, REDIRECT_URI);
    const state = url.searchParams.get('state')!;

    const res = await complete(actors.testerAuth, { code, state }).expect(200);
    expect(res.body).toEqual({ status: 'connected', username: 'tess' });

    const conn = await ctx.prisma.gitlabConnection.findUniqueOrThrow({ where: { userId: actors.tester.id } });
    expect(conn).toMatchObject({ username: 'tess', gitlabUserId: gitlabUser.id, avatarUrl: 'https://git.test/tess.png', state: 'ACTIVE' });
    const issued = fake.issued.at(-1)!;
    expect(conn.accessTokenEnc).not.toContain(issued.accessToken);
    expect(ctx.app.get(TokenCipher).decrypt(conn.accessTokenEnc)).toBe(issued.accessToken);
    expect(ctx.app.get(TokenCipher).decrypt(conn.refreshTokenEnc)).toBe(issued.refreshToken);
    expect(conn.expiresAt.getTime()).toBeGreaterThan(Date.now() + 7_000_000);

    // The state is single-use.
    const again = await complete(actors.testerAuth, { code, state }).expect(400);
    expect(again.body.details).toEqual({ reason: 'invalid_state' });
  });

  it('rejects unknown and expired states without calling GitLab', async () => {
    const unknown = await complete(actors.testerAuth, { code: 'x', state: 'forged' }).expect(400);
    expect(unknown.body.details).toEqual({ reason: 'invalid_state' });

    const url = await startOAuth();
    await ctx.prisma.gitlabOAuthState.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await complete(actors.testerAuth, { code: 'x', state: url.searchParams.get('state')! }).expect(400);
    expect(expired.body.details).toEqual({ reason: 'invalid_state' });
    expect(fake.requestsTo('/oauth/token')).toHaveLength(0);
  });

  it('reports a denied authorization', async () => {
    const url = await startOAuth();
    const res = await complete(actors.testerAuth, { error: 'access_denied', state: url.searchParams.get('state')! }).expect(400);
    expect(res.body.details).toEqual({ reason: 'denied' });
    expect(await ctx.prisma.gitlabConnection.count()).toBe(0);
  });

  it("does not let a different tool user complete someone else's OAuth state", async () => {
    const url = await startOAuth(actors.testerAuth);
    const state = url.searchParams.get('state')!;
    const gitlabUser = fake.addUser({ username: 'tess' });
    const code = fake.issueAuthCode(gitlabUser, url.searchParams.get('code_challenge')!, REDIRECT_URI);

    // Admin tries to complete tester's state (e.g. tester sent them the authorizeUrl).
    const stolen = await complete(actors.adminAuth, { code, state }).expect(400);
    expect(stolen.body.details).toEqual({ reason: 'invalid_state' });
    expect(fake.requestsTo('/oauth/token')).toHaveLength(0);
    expect(await ctx.prisma.gitlabConnection.count()).toBe(0);

    // The state was never consumed: its rightful owner can still complete it.
    const res = await complete(actors.testerAuth, { code, state }).expect(200);
    expect(res.body).toEqual({ status: 'connected', username: 'tess' });
    const conn = await ctx.prisma.gitlabConnection.findUniqueOrThrow({ where: { userId: actors.tester.id } });
    expect(conn.gitlabUserId).toBe(gitlabUser.id);
  });

  it('refuses to link a GitLab account already connected to a different tool user', async () => {
    const { gitlabUser, accessToken: adminAccessToken } = await seedGitlabConnection(ctx, fake, actors.admin.id, { username: 'shared' });

    const url = await startOAuth(actors.testerAuth);
    const code = fake.issueAuthCode(gitlabUser, url.searchParams.get('code_challenge')!, REDIRECT_URI);
    const state = url.searchParams.get('state')!;

    const res = await complete(actors.testerAuth, { code, state }).expect(400);
    expect(res.body.details).toEqual({ reason: 'already_linked' });

    expect(await ctx.prisma.gitlabConnection.count({ where: { userId: actors.tester.id } })).toBe(0);
    const adminConn = await ctx.prisma.gitlabConnection.findUniqueOrThrow({ where: { userId: actors.admin.id } });
    expect(ctx.app.get(TokenCipher).decrypt(adminConn.accessTokenEnc)).toBe(adminAccessToken);
    const newlyIssued = fake.issued.at(-1)!;
    expect(fake.revoked).toContain(newlyIssued.accessToken);
  });

  it('requires authentication to complete OAuth', async () => {
    await ctx.http().post('/api/gitlab/oauth/complete').send({ state: 'whatever' }).expect(401);
  });

  it('disconnects, revoking the token at GitLab', async () => {
    const { accessToken } = await seedGitlabConnection(ctx, fake, actors.tester.id);
    await ctx.http().delete('/api/gitlab/connection').set(actors.testerAuth).expect(204);
    expect(fake.revoked).toEqual([accessToken]);
    expect(await ctx.prisma.gitlabConnection.count()).toBe(0);
    const status = await ctx.http().get('/api/gitlab/status').set(actors.testerAuth).expect(200);
    expect(status.body.connection).toBeNull();
  });

  it('searches GitLab projects for admins only', async () => {
    const { gitlabUser } = await seedGitlabConnection(ctx, fake, actors.admin.id, { username: 'admin' });
    fake.addProject({ id: 101, path: 'mobile/ninja-store', members: [gitlabUser] });
    fake.addProject({ id: 102, path: 'secret/ninja-admin', members: [] });

    const res = await ctx.http().get('/api/gitlab/projects').query({ search: 'ninja' }).set(actors.adminAuth).expect(200);
    expect(res.body).toEqual([
      { id: 101, name: 'ninja-store', pathWithNamespace: 'mobile/ninja-store', webUrl: `${fake.url}/mobile/ninja-store`, defaultBranch: 'main' },
    ]);
    // Proves role gating specifically (not just "tester happens to lack a connection").
    const forbidden = await ctx.http().get('/api/gitlab/projects').set(actors.testerAuth).expect(403);
    expect(forbidden.body.message).toBe('You do not have permission to perform this action');
  });

  it('asks users without a connection to connect GitLab', async () => {
    const res = await ctx.http().get('/api/gitlab/projects').set(actors.adminAuth).expect(403);
    expect(res.body).toEqual({
      statusCode: 403,
      error: 'Forbidden',
      message: 'Connect GitLab to use automation',
      details: { code: 'GITLAB_NOT_CONNECTED' },
    });
  });

  it('refreshes an expired token before calling GitLab', async () => {
    const { gitlabUser, accessToken } = await seedGitlabConnection(ctx, fake, actors.admin.id, { username: 'admin', expired: true });
    fake.addProject({ id: 101, path: 'mobile/ninja-store', members: [gitlabUser] });

    await ctx.http().get('/api/gitlab/projects').set(actors.adminAuth).expect(200);
    expect(fake.requestsTo('/oauth/token')).toHaveLength(1);
    const conn = await ctx.prisma.gitlabConnection.findUniqueOrThrow({ where: { userId: actors.admin.id } });
    const newToken = ctx.app.get(TokenCipher).decrypt(conn.accessTokenEnc);
    expect(newToken).not.toBe(accessToken);
    expect(fake.requestsTo('/api/v4/projects').at(-1)!.token).toBe(newToken);
    expect(conn.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3_600_000);
  });

  it('marks the connection NEEDS_RECONNECT when the refresh fails', async () => {
    await seedGitlabConnection(ctx, fake, actors.admin.id, { username: 'admin', expired: true });
    fake.refreshTokens.clear();

    const res = await ctx.http().get('/api/gitlab/projects').set(actors.adminAuth).expect(403);
    expect(res.body.details).toEqual({ code: 'GITLAB_NEEDS_RECONNECT' });
    const status = await ctx.http().get('/api/gitlab/status').set(actors.adminAuth).expect(200);
    expect(status.body.connection).toMatchObject({ username: 'admin', state: 'NEEDS_RECONNECT' });
  });

  it('marks the connection NEEDS_RECONNECT when GitLab answers 401', async () => {
    const { accessToken } = await seedGitlabConnection(ctx, fake, actors.admin.id, { username: 'admin' });
    fake.tokens.delete(accessToken);

    const res = await ctx.http().get('/api/gitlab/projects').set(actors.adminAuth).expect(403);
    expect(res.body.message).toBe('Your GitLab connection expired – reconnect GitLab to continue');
    const conn = await ctx.prisma.gitlabConnection.findUniqueOrThrow({ where: { userId: actors.admin.id } });
    expect(conn.state).toBe('NEEDS_RECONNECT');
  });
});
