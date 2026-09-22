import { seedActors, seedProject } from './utils/factories';
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

  it('hides the repository link endpoints', async () => {
    const project = await seedProject(ctx.prisma, actors.admin.id);
    await expectHidden('put', `/api/projects/${project.id}/repository`, { gitlabProjectId: 101, testsPath: 'e2e' });
    await expectHidden('delete', `/api/projects/${project.id}/repository`);
  });

  it('hides the automation file endpoints', async () => {
    const project = await seedProject(ctx.prisma, actors.admin.id, { key: 'AUTO' });
    const base = `/api/projects/${project.id}/automation`;
    await expectHidden('get', `${base}/branches`);
    await expectHidden('get', `${base}/tree`);
    await expectHidden('get', `${base}/file?path=e2e/a.spec.ts`);
    await expectHidden('put', `${base}/file`, { path: 'e2e/a.spec.ts', content: 'x', branchSlug: 'x' });
    await expectHidden('get', `${base}/coverage`);
  });

  it('hides the automated run trigger', async () => {
    const project = await seedProject(ctx.prisma, actors.admin.id, { key: 'RUNS' });
    await expectHidden('post', `/api/projects/${project.id}/runs/automated`, { branch: 'main', scope: { mode: 'ALL' } });
  });

  it('hides the CI snippet and create-case endpoints', async () => {
    const project = await seedProject(ctx.prisma, actors.admin.id, { key: 'SNIP' });
    await expectHidden('get', `/api/projects/${project.id}/automation/ci-snippet`);
    await expectHidden(
      'post',
      '/api/runs/7a1d0c5e-0000-4000-8000-000000000000/results/7a1d0c5e-0000-4000-8000-000000000001/create-case',
      { moduleId: '7a1d0c5e-0000-4000-8000-000000000002' },
    );
  });
});
