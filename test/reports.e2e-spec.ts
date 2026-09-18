import { Priority, ResultStatus, RunStatus } from '@prisma/client';
import { seedActors, seedCase, seedModule, seedProject } from './utils/factories';
import { createTestApp, resetDb, TestContext } from './utils/test-app';

describe('Reports (e2e)', () => {
  let ctx: TestContext;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let projectId: string;
  let ids: Record<string, string>;
  let authId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    actors = await seedActors(ctx);
    projectId = (await seedProject(ctx.prisma, actors.admin.id)).id;
    authId = (await seedModule(ctx.prisma, projectId, { code: 'AUTH' })).id;
    const cartId = (await seedModule(ctx.prisma, projectId, { code: 'CART', name: 'Cart' })).id;
    const u = actors.admin.id;
    ids = {
      a1: (await seedCase(ctx.prisma, { projectId, moduleId: authId, userId: u, code: 'TC-AUTH-001', priority: Priority.HIGH })).id,
      a2: (await seedCase(ctx.prisma, { projectId, moduleId: authId, userId: u, code: 'TC-AUTH-002', priority: Priority.HIGH })).id,
      c1: (await seedCase(ctx.prisma, { projectId, moduleId: cartId, userId: u, code: 'TC-CART-001', priority: Priority.LOW })).id,
    };

    const sprint1 = await ctx.prisma.testRun.create({
      data: { projectId, name: 'Sprint 1', createdById: u, status: RunStatus.COMPLETED, startedAt: new Date('2026-01-01') },
    });
    const sprint2 = await ctx.prisma.testRun.create({ data: { projectId, name: 'Sprint 2', createdById: u, startedAt: new Date('2026-02-01') } });
    await ctx.prisma.testResult.createMany({
      data: [
        { runId: sprint1.id, testCaseId: ids.a1, status: ResultStatus.FAILED, executedAt: new Date('2026-01-02') },
        { runId: sprint1.id, testCaseId: ids.a2, status: ResultStatus.PASSED, executedAt: new Date('2026-01-02') },
        { runId: sprint1.id, testCaseId: ids.c1, status: ResultStatus.PASSED, executedAt: new Date('2026-01-02') },
        { runId: sprint2.id, testCaseId: ids.a1, status: ResultStatus.PASSED, executedAt: new Date('2026-02-02') },
        { runId: sprint2.id, testCaseId: ids.a2, status: ResultStatus.FAILED, actualResult: 'Error not shown', executedAt: new Date('2026-02-03') },
        { runId: sprint2.id, testCaseId: ids.c1 },
      ],
    });
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('builds trend, module and priority breakdowns and the failing list', async () => {
    const res = await ctx.http().get(`/api/projects/${projectId}/reports`).set(actors.testerAuth).expect(200);

    expect(res.body.trend.map((t: { name: string }) => t.name)).toEqual(['Sprint 1', 'Sprint 2']);
    expect(res.body.trend[0].summary).toMatchObject({ total: 3, passed: 2, failed: 1, passRate: 66.7 });
    expect(res.body.trend[1].summary).toMatchObject({ total: 3, executed: 2, notExecuted: 1, passRate: 50 });

    expect(res.body.byModule).toEqual([
      { moduleId: authId, name: 'Authentication', code: 'AUTH', summary: expect.objectContaining({ total: 2, passed: 1, failed: 1 }) },
      { moduleId: expect.any(String), name: 'Cart', code: 'CART', summary: expect.objectContaining({ total: 1, passed: 1 }) },
    ]);
    expect(res.body.byPriority.map((p: { priority: string }) => p.priority)).toEqual(['HIGH', 'LOW']);
    expect(res.body.byPriority[0].summary).toMatchObject({ total: 2, failed: 1 });

    expect(res.body.failing).toEqual([
      {
        id: ids.a2, code: 'TC-AUTH-002', name: 'Case TC-AUTH-002',
        module: { id: authId, name: 'Authentication', code: 'AUTH' },
        actualResult: 'Error not shown', executedAt: '2026-02-03T00:00:00.000Z',
        run: { id: expect.any(String), name: 'Sprint 2' },
      },
    ]);
  });

  it('adds latest run and last tested time to the project list', async () => {
    const res = await ctx.http().get('/api/projects').set(actors.testerAuth).expect(200);
    expect(res.body[0]).toMatchObject({
      key: 'NINJA',
      caseCount: 3,
      lastTestedAt: '2026-02-03T00:00:00.000Z',
      latestRun: { name: 'Sprint 2', status: 'IN_PROGRESS', summary: expect.objectContaining({ total: 3, notExecuted: 1 }) },
    });

    await seedProject(ctx.prisma, actors.admin.id, { key: 'DINAR', name: 'Dinar' });
    const both = await ctx.http().get('/api/projects').set(actors.testerAuth).expect(200);
    expect(both.body[0]).toMatchObject({ key: 'DINAR', latestRun: null, lastTestedAt: null, caseCount: 0 });
  });

  it('returns the home dashboard', async () => {
    const res = await ctx.http().get('/api/dashboard').set(actors.testerAuth).expect(200);
    expect(res.body).toMatchObject({ projectCount: 1, testCaseCount: 3, runsInProgress: 1 });
    expect(res.body.recentRuns.map((r: { name: string }) => r.name)).toEqual(['Sprint 2', 'Sprint 1']);
    expect(res.body.recentRuns[0].project).toEqual({ id: projectId, key: 'NINJA', name: 'Ninja Store' });
  });

  it('returns 404 for reports of an unknown project', async () => {
    await ctx.http().get('/api/projects/7a1d0c5e-0000-4000-8000-000000000000/reports').set(actors.testerAuth).expect(404);
  });
});
