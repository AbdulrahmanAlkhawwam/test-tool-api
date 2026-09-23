import { FakeGitlab } from './utils/fake-gitlab';
import { seedActors, seedCase, seedModule } from './utils/factories';
import { CART_SPEC, createGitlabTestApp, GITLAB_PROJECT_ID as P, seedGitlabConnection, seedLinkedProject } from './utils/gitlab';
import { resetDb, TestContext } from './utils/test-app';

describe('Automation coverage (e2e)', () => {
  let ctx: TestContext;
  let fake: FakeGitlab;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let projectId: string;
  let ids: Record<string, string>;

  beforeAll(async () => {
    ({ ctx, fake } = await createGitlabTestApp());
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    fake.reset();
    actors = await seedActors(ctx);
    const { gitlabUser } = await seedGitlabConnection(ctx, fake, actors.tester.id, { username: 'tess' });
    projectId = (await seedLinkedProject(ctx, fake, actors.admin.id, [gitlabUser])).project.id;
    const auth = await seedModule(ctx.prisma, projectId, { code: 'AUTH' });
    const cart = await seedModule(ctx.prisma, projectId, { code: 'CART', name: 'Cart' });
    ids = {};
    for (const [moduleId, code] of [
      [auth.id, 'TC-AUTH-001'],
      [auth.id, 'TC-AUTH-002'],
      [auth.id, 'TC-AUTH-003'],
      [cart.id, 'TC-CART-001'],
      [cart.id, 'TC-CART-002'],
    ]) {
      ids[code] = (await seedCase(ctx.prisma, { projectId, moduleId, userId: actors.admin.id, code })).id;
    }
    await ctx.prisma.testCase.update({ where: { id: ids['TC-CART-002'] }, data: { deletedAt: new Date() } });
  });
  afterAll(async () => {
    await ctx.app.close();
    await fake.close();
  });

  const coverage = (query: Record<string, string> = {}) =>
    ctx.http().get(`/api/projects/${projectId}/automation/coverage`).query(query).set(actors.testerAuth);

  it('reports covered cases per file, unknown tags and cases not automated yet', async () => {
    const res = await coverage().expect(200);
    expect(res.body.ref).toBe('main');
    expect(res.body.commitId).toBe(fake.branch(P, 'main')!.commitId);
    expect(res.body.files).toEqual([
      {
        path: 'e2e/auth/login.spec.ts',
        cases: [
          { id: ids['TC-AUTH-001'], code: 'TC-AUTH-001', name: 'Case TC-AUTH-001' },
          { id: ids['TC-AUTH-002'], code: 'TC-AUTH-002', name: 'Case TC-AUTH-002' },
        ],
        unknownCodes: ['TC-AUTH-999'],
      },
      { path: 'e2e/cart/cart.spec.ts', cases: [], unknownCodes: [] },
      { path: 'e2e/fixtures/users.ts', cases: [], unknownCodes: [] },
    ]);
    expect(res.body.notAutomated.map((c: { code: string }) => c.code)).toEqual(['TC-AUTH-003', 'TC-CART-001']);
    expect(res.body.notAutomated[0]).toEqual({
      id: ids['TC-AUTH-003'],
      code: 'TC-AUTH-003',
      name: 'Case TC-AUTH-003',
      module: { code: 'AUTH', name: 'Authentication' },
    });
    expect(res.body.skippedFiles).toEqual([]);
  });

  it('caches the scan per commit and rescans after a new commit', async () => {
    await coverage().expect(200);
    // A HEAD size check plus a GET per scanned file: 3 files, so 6 requests.
    expect(fake.requestsTo('/repository/files/')).toHaveLength(6);
    await coverage().expect(200);
    expect(fake.requestsTo('/repository/files/')).toHaveLength(6);

    fake.setFile(P, 'main', 'e2e/cart/cart.spec.ts', CART_SPEC.replace('adds an item to the cart', 'adds an item to the cart @TC-CART-001'));
    const res = await coverage().expect(200);
    expect(fake.requestsTo('/repository/files/')).toHaveLength(12);
    expect(res.body.notAutomated.map((c: { code: string }) => c.code)).toEqual(['TC-AUTH-003']);
  });

  it('returns 404 for an unknown branch', async () => {
    const res = await coverage({ ref: 'nope' }).expect(404);
    expect(res.body.message).toBe('Branch "nope" was not found');
  });

  it('skips files over 1 MB without downloading them, and reports them separately', async () => {
    fake.setFile(P, 'main', 'e2e/huge/huge.spec.ts', 'x'.repeat(1024 * 1024 + 1));
    const res = await coverage().expect(200);
    expect(res.body.skippedFiles).toEqual(['e2e/huge/huge.spec.ts']);
    expect(res.body.files.map((f: { path: string }) => f.path)).not.toContain('e2e/huge/huge.spec.ts');
    // The huge file gets a HEAD request but never a GET for its content.
    const getsForHugeFile = fake.requests.filter((r) => r.method === 'GET' && r.path.includes('huge.spec.ts'));
    expect(getsForHugeFile).toHaveLength(0);
    const headsForHugeFile = fake.requests.filter((r) => r.method === 'HEAD' && r.path.includes('huge.spec.ts'));
    expect(headsForHugeFile).toHaveLength(1);
  });

  it('ignores AI drafts: they are not automated yet and their tags stay unknown', async () => {
    const auth = await ctx.prisma.projectModule.findFirstOrThrow({ where: { projectId, code: 'AUTH' } });
    await seedCase(ctx.prisma, {
      projectId, moduleId: auth.id, userId: actors.admin.id, code: 'TC-AUTH-004',
      reviewState: 'AI_DRAFT', createdVia: 'AI',
    });
    // TC-AUTH-999 is tagged in LOGIN_SPEC; as a draft it must still count as an unknown tag.
    await seedCase(ctx.prisma, {
      projectId, moduleId: auth.id, userId: actors.admin.id, code: 'TC-AUTH-999',
      reviewState: 'AI_DRAFT', createdVia: 'AI',
    });

    const res = await coverage().expect(200);
    expect(res.body.notAutomated.map((c: { code: string }) => c.code)).toEqual(['TC-AUTH-003', 'TC-CART-001']);
    expect(res.body.files[0].unknownCodes).toEqual(['TC-AUTH-999']);
    expect(JSON.stringify(res.body)).not.toContain('TC-AUTH-004');
  });
});
