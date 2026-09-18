import { Priority, ResultStatus } from '@prisma/client';
import { seedActors, seedCase, seedModule, seedProject } from './utils/factories';
import { createTestApp, resetDb, TestContext } from './utils/test-app';

describe('Runs (e2e)', () => {
  let ctx: TestContext;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let projectId: string;
  let authId: string;
  let cartId: string;
  let caseIds: string[];

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    actors = await seedActors(ctx);
    projectId = (await seedProject(ctx.prisma, actors.admin.id)).id;
    authId = (await seedModule(ctx.prisma, projectId, { code: 'AUTH' })).id;
    cartId = (await seedModule(ctx.prisma, projectId, { code: 'CART', name: 'Cart' })).id;
    const u = actors.admin.id;
    caseIds = [
      (await seedCase(ctx.prisma, { projectId, moduleId: authId, userId: u, code: 'TC-AUTH-002', priority: Priority.HIGH })).id,
      (await seedCase(ctx.prisma, { projectId, moduleId: authId, userId: u, code: 'TC-AUTH-001', priority: Priority.LOW })).id,
      (await seedCase(ctx.prisma, { projectId, moduleId: cartId, userId: u, code: 'TC-CART-001', priority: Priority.HIGH })).id,
    ];
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  const createRun = (selection: Record<string, unknown>, name = 'Sprint 12') =>
    ctx.http().post(`/api/projects/${projectId}/runs`).set(actors.testerAuth).send({ name, build: 'v1.4', environment: 'staging', selection });

  it('creates a run snapshot of all active cases', async () => {
    const deleted = await seedCase(ctx.prisma, { projectId, moduleId: authId, userId: actors.admin.id, code: 'TC-AUTH-003' });
    await ctx.prisma.testCase.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

    const res = await createRun({ mode: 'ALL' }).expect(201);
    expect(res.body).toMatchObject({ name: 'Sprint 12', build: 'v1.4', environment: 'staging', type: 'MANUAL', status: 'IN_PROGRESS' });
    expect(res.body.summary).toMatchObject({ total: 3, notExecuted: 3, executed: 0 });

    // A case added after the run was created is not part of it.
    await seedCase(ctx.prisma, { projectId, moduleId: authId, userId: actors.admin.id, code: 'TC-AUTH-004' });
    const detail = await ctx.http().get(`/api/runs/${res.body.id}`).set(actors.testerAuth).expect(200);
    expect(detail.body.results.map((r: { testCase: { code: string } }) => r.testCase.code)).toEqual(['TC-AUTH-001', 'TC-AUTH-002', 'TC-CART-001']);
  });

  it('selects by module, priority or explicit cases', async () => {
    expect((await createRun({ mode: 'MODULES', moduleIds: [cartId] }).expect(201)).body.summary.total).toBe(1);
    expect((await createRun({ mode: 'PRIORITIES', priorities: ['HIGH'] }).expect(201)).body.summary.total).toBe(2);
    expect((await createRun({ mode: 'CASES', caseIds: [caseIds[0]] }).expect(201)).body.summary.total).toBe(1);
  });

  it('rejects empty or incomplete selections', async () => {
    const missing = await createRun({ mode: 'MODULES' }).expect(400);
    expect(missing.body.message).toBe('selection.moduleIds is required for mode MODULES');
    const none = await createRun({ mode: 'PRIORITIES', priorities: ['MEDIUM'] }).expect(400);
    expect(none.body.message).toBe('No test cases match the selection');
    await createRun({ mode: 'EVERYTHING' }).expect(400);
  });

  it('returns run detail with full case definitions', async () => {
    const run = (await createRun({ mode: 'CASES', caseIds: [caseIds[2]] }).expect(201)).body;
    const detail = await ctx.http().get(`/api/runs/${run.id}`).set(actors.testerAuth).expect(200);
    expect(detail.body.project).toMatchObject({ id: projectId, key: 'NINJA' });
    expect(detail.body.createdBy).toEqual({ id: actors.tester.id, name: 'Tess Tester' });
    expect(detail.body.results[0]).toMatchObject({
      status: 'NOT_EXECUTED',
      executedBy: null,
      testCase: { code: 'TC-CART-001', expectedResult: 'Works', priority: 'HIGH', module: { code: 'CART', name: 'Cart' } },
    });
    await ctx.http().get('/api/runs/7a1d0c5e-0000-4000-8000-000000000000').set(actors.testerAuth).expect(404);
  });

  it('lists runs newest first with progress summaries', async () => {
    const older = (await createRun({ mode: 'ALL' }, 'Sprint 11').expect(201)).body;
    await ctx.prisma.testRun.update({ where: { id: older.id }, data: { startedAt: new Date('2026-01-01') } });
    await ctx.prisma.testResult.updateMany({ where: { runId: older.id, testCaseId: caseIds[0] }, data: { status: ResultStatus.FAILED } });
    await createRun({ mode: 'ALL' }, 'Sprint 12').expect(201);

    const res = await ctx.http().get(`/api/projects/${projectId}/runs`).set(actors.testerAuth).expect(200);
    expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Sprint 12', 'Sprint 11']);
    expect(res.body[1].summary).toMatchObject({ total: 3, failed: 1, executed: 1, passRate: 0 });
    expect(res.body[0].createdBy).toEqual({ id: actors.tester.id, name: 'Tess Tester' });
  });

  it('renames and completes a run exactly once', async () => {
    const run = (await createRun({ mode: 'ALL' }).expect(201)).body;
    const renamed = await ctx.http().patch(`/api/runs/${run.id}`).set(actors.testerAuth).send({ name: 'Sprint 12 – RC1' }).expect(200);
    expect(renamed.body.name).toBe('Sprint 12 – RC1');

    const done = await ctx.http().patch(`/api/runs/${run.id}`).set(actors.testerAuth).send({ status: 'COMPLETED' }).expect(200);
    expect(done.body.status).toBe('COMPLETED');
    expect(done.body.completedAt).not.toBeNull();

    const again = await ctx.http().patch(`/api/runs/${run.id}`).set(actors.testerAuth).send({ status: 'COMPLETED' }).expect(409);
    expect(again.body.message).toBe('Run is already completed');
    await ctx.http().patch(`/api/runs/${run.id}`).set(actors.testerAuth).send({ status: 'IN_PROGRESS' }).expect(400);
  });
});
