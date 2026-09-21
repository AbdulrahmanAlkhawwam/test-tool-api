import { seedActors } from './utils/factories';
import { createTestApp, resetDb, TestContext } from './utils/test-app';

describe('GitLab disabled (e2e)', () => {
  let ctx: TestContext;
  let actors: Awaited<ReturnType<typeof seedActors>>;

  beforeAll(async () => {
    // Explicitly unset, even if a developer's .env configures GitLab.
    ctx = await createTestApp({ GITLAB_URL: undefined });
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    actors = await seedActors(ctx);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  const expectHidden = async (method: 'get' | 'put' | 'post' | 'delete', url: string, body: object = {}) => {
    const req = ctx.http()[method](url).set(actors.adminAuth);
    const res = await (method === 'get' || method === 'delete' ? req : req.send(body)).expect(404);
    expect(res.body.message).toBe('GitLab integration is not configured');
  };

  it('reports GitLab as disabled', async () => {
    const res = await ctx.http().get('/api/gitlab/status').set(actors.testerAuth).expect(200);
    expect(res.body).toEqual({ enabled: false, connection: null });
  });

  it('hides OAuth, connection and project search endpoints', async () => {
    await expectHidden('get', '/api/gitlab/oauth/start');
    await expectHidden('post', '/api/gitlab/oauth/complete', { state: 'x' });
    await expectHidden('delete', '/api/gitlab/connection');
    await expectHidden('get', '/api/gitlab/projects?search=ninja');
  });
});
