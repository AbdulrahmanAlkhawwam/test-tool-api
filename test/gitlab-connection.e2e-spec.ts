import { createHash } from 'crypto';
import { TokenCipher } from '../src/common/crypto/token-cipher';
import { FakeGitlab } from './utils/fake-gitlab';
import { seedActors } from './utils/factories';
import { createGitlabTestApp, seedGitlabConnection, waitForRequests } from './utils/gitlab';
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

  it('invalidates an older unused state as soon as a new OAuth flow is started', async () => {
    const oldUrl = await startOAuth();
    const oldState = oldUrl.searchParams.get('state')!;
    await startOAuth(); // starts a second flow for the same user

    const gitlabUser = fake.addUser({ username: 'tess' });
    const code = fake.issueAuthCode(gitlabUser, oldUrl.searchParams.get('code_challenge')!, REDIRECT_URI);
    const res = await complete(actors.testerAuth, { code, state: oldState }).expect(400);
    expect(res.body.details).toEqual({ reason: 'invalid_state' });
    expect(fake.requestsTo('/oauth/token')).toHaveLength(0);
  });

  it('reports exchange_failed and stores nothing when GitLab rejects the code exchange', async () => {
    const url = await startOAuth();
    const gitlabUser = fake.addUser({ username: 'tess' });
    const code = fake.issueAuthCode(gitlabUser, url.searchParams.get('code_challenge')!, REDIRECT_URI);
    const state = url.searchParams.get('state')!;
    fake.forceNextTokenResponse(500, { error: 'server_error' });

    const res = await complete(actors.testerAuth, { code, state }).expect(400);
    expect(res.body.details).toEqual({ reason: 'exchange_failed' });
    expect(await ctx.prisma.gitlabConnection.count()).toBe(0);
  });

  it('revokes the freshly issued token when getCurrentUser fails after a successful exchange', async () => {
    const url = await startOAuth();
    const gitlabUser = fake.addUser({ username: 'tess' });
    const code = fake.issueAuthCode(gitlabUser, url.searchParams.get('code_challenge')!, REDIRECT_URI);
    const state = url.searchParams.get('state')!;
    fake.breakNextUserFetch();

    const res = await complete(actors.testerAuth, { code, state }).expect(400);
    expect(res.body.details).toEqual({ reason: 'exchange_failed' });
    expect(await ctx.prisma.gitlabConnection.count()).toBe(0);
    const issued = fake.issued.at(-1)!;
    expect(fake.revoked).toContain(issued.accessToken);
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

  it("revokes the old identity's token when a user re-links to a different GitLab identity", async () => {
    const { accessToken: oldAccessToken } = await seedGitlabConnection(ctx, fake, actors.tester.id, { username: 'old-identity' });

    const url = await startOAuth();
    const newGitlabUser = fake.addUser({ username: 'new-identity' });
    const code = fake.issueAuthCode(newGitlabUser, url.searchParams.get('code_challenge')!, REDIRECT_URI);
    const state = url.searchParams.get('state')!;

    const res = await complete(actors.testerAuth, { code, state }).expect(200);
    expect(res.body).toEqual({ status: 'connected', username: 'new-identity' });

    const conn = await ctx.prisma.gitlabConnection.findUniqueOrThrow({ where: { userId: actors.tester.id } });
    expect(conn.gitlabUserId).toBe(newGitlabUser.id);
    expect(fake.revoked).toContain(oldAccessToken);
  });

  it('revokes the previous token when a user re-authorizes the same GitLab identity', async () => {
    const { gitlabUser, accessToken: oldAccessToken } = await seedGitlabConnection(ctx, fake, actors.tester.id, { username: 'tess' });

    const url = await startOAuth();
    const code = fake.issueAuthCode(gitlabUser, url.searchParams.get('code_challenge')!, REDIRECT_URI);
    const state = url.searchParams.get('state')!;

    const res = await complete(actors.testerAuth, { code, state }).expect(200);
    expect(res.body).toEqual({ status: 'connected', username: 'tess' });

    const issued = fake.issued.at(-1)!;
    expect(fake.revoked).toContain(oldAccessToken);
    expect(fake.revoked).not.toContain(issued.accessToken);
    const conn = await ctx.prisma.gitlabConnection.findUniqueOrThrow({ where: { userId: actors.tester.id } });
    expect(ctx.app.get(TokenCipher).decrypt(conn.accessTokenEnc)).toBe(issued.accessToken);
  });

  it("does not 500 when the previous connection's stored token can't be decrypted (best-effort revoke)", async () => {
    const { gitlabUser } = await seedGitlabConnection(ctx, fake, actors.tester.id, { username: 'tess' });
    // Corrupt the stored token so `this.cipher.decrypt(...)` throws when the service tries to
    // best-effort revoke it during the relink below.
    await ctx.prisma.gitlabConnection.update({ where: { userId: actors.tester.id }, data: { accessTokenEnc: 'v1:not-valid-ciphertext' } });

    const url = await startOAuth();
    const code = fake.issueAuthCode(gitlabUser, url.searchParams.get('code_challenge')!, REDIRECT_URI);
    const state = url.searchParams.get('state')!;

    const res = await complete(actors.testerAuth, { code, state }).expect(200);
    expect(res.body).toEqual({ status: 'connected', username: 'tess' });
    const conn = await ctx.prisma.gitlabConnection.findUniqueOrThrow({ where: { userId: actors.tester.id } });
    expect(conn.state).toBe('ACTIVE');
  });

  it('detects a gitlabUserId conflict introduced after the pre-check passed (a real P2002 race) and revokes the new token', async () => {
    const url = await startOAuth(actors.testerAuth);
    const racer = fake.addUser({ username: 'racer' });
    const code = fake.issueAuthCode(racer, url.searchParams.get('code_challenge')!, REDIRECT_URI);
    const state = url.searchParams.get('state')!;
    const cipher = ctx.app.get(TokenCipher);

    // completeOAuth's own pre-check (`findUnique({ where: { gitlabUserId } })`) finds nothing, then
    // a concurrent completion links this same GitLab identity to a different tool user before this
    // call's `upsert` runs — so the real unique index (not the pre-check) is what has to catch it.
    // Intercepting the pre-check itself to insert the conflicting row is the deterministic way to
    // force that exact race every time, without depending on timing.
    const originalFindUnique = ctx.prisma.gitlabConnection.findUnique.bind(ctx.prisma.gitlabConnection);
    const spy = jest.spyOn(ctx.prisma.gitlabConnection, 'findUnique').mockImplementation((async (args: unknown) => {
      const where = (args as { where?: { gitlabUserId?: number } }).where;
      if (where?.gitlabUserId === racer.id) {
        spy.mockRestore();
        await ctx.prisma.gitlabConnection.create({
          data: {
            userId: actors.admin.id,
            gitlabUserId: racer.id,
            username: racer.username,
            avatarUrl: null,
            accessTokenEnc: cipher.encrypt('racer-access'),
            refreshTokenEnc: cipher.encrypt('racer-refresh'),
            expiresAt: new Date(Date.now() + 7_200_000),
            state: 'ACTIVE',
          },
        });
        return null;
      }
      return originalFindUnique(args as never);
    }) as any);

    const res = await complete(actors.testerAuth, { code, state }).expect(400);
    expect(res.body.details).toEqual({ reason: 'already_linked' });

    const issued = fake.issued.at(-1)!;
    expect(fake.revoked).toContain(issued.accessToken);
    expect(await ctx.prisma.gitlabConnection.count({ where: { userId: actors.tester.id } })).toBe(0);
    const adminConn = await ctx.prisma.gitlabConnection.findUniqueOrThrow({ where: { userId: actors.admin.id } });
    expect(adminConn.gitlabUserId).toBe(racer.id);
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

  it("does not 500 when the stored token can't be decrypted (best-effort revoke on disconnect)", async () => {
    await seedGitlabConnection(ctx, fake, actors.tester.id);
    // Corrupt the stored token so `this.cipher.decrypt(...)` throws when disconnect tries to
    // best-effort revoke it — that must not turn an otherwise-completed delete into a 500.
    await ctx.prisma.gitlabConnection.update({ where: { userId: actors.tester.id }, data: { accessTokenEnc: 'v1:not-valid-ciphertext' } });

    await ctx.http().delete('/api/gitlab/connection').set(actors.testerAuth).expect(204);
    expect(await ctx.prisma.gitlabConnection.count()).toBe(0);
    expect(fake.revoked).toEqual([]);
  });

  it('revokes the freshly refreshed token when disconnect races an in-flight refresh', async () => {
    const { gitlabUser, accessToken: oldAccessToken } = await seedGitlabConnection(ctx, fake, actors.admin.id, {
      username: 'admin',
      expired: true,
    });
    fake.addProject({ id: 101, path: 'mobile/ninja-store', members: [gitlabUser] });

    // Delay GitLab's answer to the refresh call, disconnect while it's in flight, then let it land.
    // `.then()` (not a bare assignment) is what actually dispatches a supertest request, so the
    // in-flight call and the disconnect below can race as intended.
    const release = fake.holdTokenResponses();
    const refreshingRequest = ctx.http().get('/api/gitlab/projects').set(actors.adminAuth).then((r) => r);
    await waitForRequests(fake, '/oauth/token');
    await ctx.http().delete('/api/gitlab/connection').set(actors.adminAuth).expect(204);
    release();

    const res = await refreshingRequest;
    expect(res.status).toBe(403);
    expect(res.body.details).toEqual({ code: 'GITLAB_NOT_CONNECTED' });

    // The token disconnect revoked (the old, pre-refresh one) and the token the in-flight refresh
    // went on to fetch (now unrevoked-nowhere-to-live) must both end up revoked at GitLab.
    const newlyIssued = fake.issued.at(-1)!;
    expect(fake.revoked).toEqual(expect.arrayContaining([oldAccessToken, newlyIssued.accessToken]));
    expect(await ctx.prisma.gitlabConnection.count()).toBe(0);
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

  it('refreshes exactly once when two requests race past expiry', async () => {
    const { gitlabUser } = await seedGitlabConnection(ctx, fake, actors.admin.id, { username: 'admin', expired: true });
    fake.addProject({ id: 101, path: 'mobile/ninja-store', members: [gitlabUser] });

    const [a, b] = await Promise.all([
      ctx.http().get('/api/gitlab/projects').set(actors.adminAuth),
      ctx.http().get('/api/gitlab/projects').set(actors.adminAuth),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(fake.requestsTo('/oauth/token')).toHaveLength(1);
    const conn = await ctx.prisma.gitlabConnection.findUniqueOrThrow({ where: { userId: actors.admin.id } });
    expect(conn.state).toBe('ACTIVE');
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

  it('uses another refresher\'s winning token instead of failing when this refresh\'s rejection is stale', async () => {
    const { gitlabUser } = await seedGitlabConnection(ctx, fake, actors.admin.id, { username: 'admin', expired: true });
    fake.addProject({ id: 101, path: 'mobile/ninja-store', members: [gitlabUser] });

    // GitLab will answer this refresh with invalid_grant, but only after another refresher (that
    // we simulate directly against the DB) has already rotated the tokens.
    fake.forceNextTokenResponse(400, { error: 'invalid_grant', error_description: 'The provided authorization grant is invalid' });
    const release = fake.holdTokenResponses();

    // `.then()` (not a bare assignment) is what actually dispatches a supertest request.
    const req = ctx.http().get('/api/gitlab/projects').set(actors.adminAuth).then((r) => r);
    await waitForRequests(fake, '/oauth/token');

    const winnerTokens = fake.issueTokens(gitlabUser);
    const cipher = ctx.app.get(TokenCipher);
    await ctx.prisma.gitlabConnection.update({
      where: { userId: actors.admin.id },
      data: {
        accessTokenEnc: cipher.encrypt(winnerTokens.accessToken),
        refreshTokenEnc: cipher.encrypt(winnerTokens.refreshToken),
        expiresAt: new Date(Date.now() + 7_200_000),
      },
    });

    release();
    const res = await req;
    expect(res.status).toBe(200);
    expect(fake.requestsTo('/api/v4/projects').at(-1)!.token).toBe(winnerTokens.accessToken);

    const conn = await ctx.prisma.gitlabConnection.findUniqueOrThrow({ where: { userId: actors.admin.id } });
    expect(conn.state).toBe('ACTIVE');
    expect(ctx.app.get(TokenCipher).decrypt(conn.accessTokenEnc)).toBe(winnerTokens.accessToken);
  });

  it('leaves the connection ACTIVE and answers 502 on a GitLab 5xx during refresh (not NEEDS_RECONNECT)', async () => {
    const { gitlabUser } = await seedGitlabConnection(ctx, fake, actors.admin.id, { username: 'admin', expired: true });
    fake.addProject({ id: 101, path: 'mobile/ninja-store', members: [gitlabUser] });
    fake.forceNextTokenResponse(500, { error: 'server_error' });

    const res = await ctx.http().get('/api/gitlab/projects').set(actors.adminAuth).expect(502);
    expect(res.body.details).toEqual({ source: 'gitlab' });

    const conn = await ctx.prisma.gitlabConnection.findUniqueOrThrow({ where: { userId: actors.admin.id } });
    expect(conn.state).toBe('ACTIVE');
  });

  it("revokes its own freshly issued (never-stored) token, and returns the winner's, when a refresh loses to a concurrent relink", async () => {
    const { gitlabUser } = await seedGitlabConnection(ctx, fake, actors.admin.id, { username: 'admin', expired: true });
    fake.addProject({ id: 101, path: 'mobile/ninja-store', members: [gitlabUser] });
    const cipher = ctx.app.get(TokenCipher);
    const winnerTokens = fake.issueTokens(fake.addUser({ username: 'winner-identity' }));

    // Simulate a concurrent relink landing between this refresh's re-read and its own conditional
    // write: by the time that write runs, the row's tokens have already been replaced, so its
    // WHERE clause (bound to the refresh token it originally saw) naturally matches zero rows.
    const originalUpdateMany = ctx.prisma.gitlabConnection.updateMany.bind(ctx.prisma.gitlabConnection);
    const spy = jest.spyOn(ctx.prisma.gitlabConnection, 'updateMany').mockImplementation((async (args: unknown) => {
      const a = args as { data?: { state?: string }; where?: { refreshTokenEnc?: string } };
      if (a.data?.state === 'ACTIVE' && a.where?.refreshTokenEnc) {
        spy.mockRestore();
        await ctx.prisma.gitlabConnection.update({
          where: { userId: actors.admin.id },
          data: {
            accessTokenEnc: cipher.encrypt(winnerTokens.accessToken),
            refreshTokenEnc: cipher.encrypt(winnerTokens.refreshToken),
            expiresAt: new Date(Date.now() + 7_200_000),
            state: 'ACTIVE',
          },
        });
      }
      return originalUpdateMany(args as never);
    }) as any);

    const issuedBefore = fake.issued.length;
    const res = await ctx.http().get('/api/gitlab/projects').set(actors.adminAuth).expect(200);
    expect(res.status).toBe(200);

    const loserTokens = fake.issued[issuedBefore]!;
    expect(fake.revoked).toContain(loserTokens.accessToken);
    expect(fake.revoked).not.toContain(winnerTokens.accessToken);

    const conn = await ctx.prisma.gitlabConnection.findUniqueOrThrow({ where: { userId: actors.admin.id } });
    expect(conn.state).toBe('ACTIVE');
    expect(cipher.decrypt(conn.accessTokenEnc)).toBe(winnerTokens.accessToken);
  });

  it('answers 403 (not the stale token) when a refresh loses to a concurrent NEEDS_RECONNECT mark', async () => {
    const { gitlabUser } = await seedGitlabConnection(ctx, fake, actors.admin.id, { username: 'admin', expired: true });
    fake.addProject({ id: 101, path: 'mobile/ninja-store', members: [gitlabUser] });
    const cipher = ctx.app.get(TokenCipher);

    const originalUpdateMany = ctx.prisma.gitlabConnection.updateMany.bind(ctx.prisma.gitlabConnection);
    const spy = jest.spyOn(ctx.prisma.gitlabConnection, 'updateMany').mockImplementation((async (args: unknown) => {
      const a = args as { data?: { state?: string }; where?: { refreshTokenEnc?: string } };
      if (a.data?.state === 'ACTIVE' && a.where?.refreshTokenEnc) {
        spy.mockRestore();
        // Change refreshTokenEnc too, so the pending write's WHERE clause misses (count 0) instead
        // of clobbering this NEEDS_RECONNECT mark back to ACTIVE.
        await ctx.prisma.gitlabConnection.update({
          where: { userId: actors.admin.id },
          data: { state: 'NEEDS_RECONNECT', refreshTokenEnc: cipher.encrypt('someone-elses-refresh-token') },
        });
      }
      return originalUpdateMany(args as never);
    }) as any);

    const issuedBefore = fake.issued.length;
    const res = await ctx.http().get('/api/gitlab/projects').set(actors.adminAuth).expect(403);
    expect(res.body.details).toEqual({ code: 'GITLAB_NEEDS_RECONNECT' });

    const loserTokens = fake.issued[issuedBefore]!;
    expect(fake.revoked).toContain(loserTokens.accessToken);
  });
});
