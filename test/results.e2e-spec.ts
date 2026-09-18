import { RunStatus } from '@prisma/client';
import { seedActors, seedCase, seedModule, seedProject } from './utils/factories';
import { createTestApp, resetDb, TestContext } from './utils/test-app';

describe('Results instant save (e2e)', () => {
  let ctx: TestContext;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let runId: string;
  let resultId: string;
  let url: string;
  let projectId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    actors = await seedActors(ctx);
    projectId = (await seedProject(ctx.prisma, actors.admin.id)).id;
    const moduleId = (await seedModule(ctx.prisma, projectId)).id;
    await seedCase(ctx.prisma, { projectId, moduleId, userId: actors.admin.id, code: 'TC-AUTH-001' });
    const run = await ctx.http().post(`/api/projects/${projectId}/runs`).set(actors.testerAuth)
      .send({ name: 'Sprint 12', selection: { mode: 'ALL' } }).expect(201);
    runId = run.body.id;
    resultId = (await ctx.prisma.testResult.findFirstOrThrow({ where: { runId } })).id;
    url = `/api/runs/${runId}/results/${resultId}`;
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('saves a status with actual result and records who executed it', async () => {
    const res = await ctx.http().patch(url).set(actors.testerAuth)
      .send({ status: 'FAILED', actualResult: 'It opens a new tab instead of redirecting' }).expect(200);
    expect(res.body).toMatchObject({
      status: 'FAILED',
      actualResult: 'It opens a new tab instead of redirecting',
      executedBy: { id: actors.tester.id, name: 'Tess Tester' },
    });
    expect(new Date(res.body.executedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('saves a single field without touching the others', async () => {
    await ctx.http().patch(url).set(actors.testerAuth).send({ status: 'PASSED', actualResult: 'Like expected' }).expect(200);
    const res = await ctx.http().patch(url).set(actors.adminAuth).send({ notes: 'Checked on Android too' }).expect(200);
    expect(res.body).toMatchObject({ status: 'PASSED', actualResult: 'Like expected', notes: 'Checked on Android too' });
    expect(res.body.executedBy.name).toBe('Admin');
  });

  it('clears executor when reset to NOT_EXECUTED', async () => {
    await ctx.http().patch(url).set(actors.testerAuth).send({ status: 'BLOCKED' }).expect(200);
    const res = await ctx.http().patch(url).set(actors.testerAuth).send({ status: 'NOT_EXECUTED' }).expect(200);
    expect(res.body).toMatchObject({ status: 'NOT_EXECUTED', executedBy: null, executedAt: null });
  });

  it('validates the status value', async () => {
    await ctx.http().patch(url).set(actors.testerAuth).send({ status: 'SUCCESSED' }).expect(400);
    await ctx.http().patch(url).set(actors.testerAuth).send({ status: null }).expect(400);
  });

  it('clears actual result and notes when sent null', async () => {
    await ctx.http().patch(url).set(actors.testerAuth).send({ status: 'FAILED', actualResult: 'Crashed', notes: 'Flaky?' }).expect(200);
    const res = await ctx.http().patch(url).set(actors.testerAuth).send({ actualResult: null, notes: null }).expect(200);
    expect(res.body).toMatchObject({ status: 'FAILED', actualResult: null, notes: null });
  });

  it('returns 404 for a result from another run', async () => {
    await ctx.http().patch(`/api/runs/7a1d0c5e-0000-4000-8000-000000000000/results/${resultId}`)
      .set(actors.testerAuth).send({ status: 'PASSED' }).expect(404);
  });

  it('makes results read-only once the run is completed', async () => {
    await ctx.prisma.testRun.update({ where: { id: runId }, data: { status: RunStatus.COMPLETED, completedAt: new Date() } });
    const res = await ctx.http().patch(url).set(actors.testerAuth).send({ status: 'PASSED' }).expect(409);
    expect(res.body.message).toBe('Run is completed – results are read-only');
  });

  it('never lets a result save land after the run is completed (concurrent save vs. completion)', async () => {
    const outcomes = { saved: 0, rejected: 0 };
    for (let i = 0; i < 10; i++) {
      const run = await ctx.http().post(`/api/projects/${projectId}/runs`).set(actors.testerAuth)
        .send({ name: `Race ${i}`, selection: { mode: 'ALL' } }).expect(201);
      const result = await ctx.prisma.testResult.findFirstOrThrow({ where: { runId: run.body.id } });

      const [save, complete] = await Promise.all([
        ctx.http().patch(`/api/runs/${run.body.id}/results/${result.id}`).set(actors.testerAuth).send({ status: 'PASSED' }),
        ctx.http().patch(`/api/runs/${run.body.id}`).set(actors.adminAuth).send({ status: 'COMPLETED' }),
      ]);

      expect(complete.status).toBe(200);
      const { completedAt } = await ctx.prisma.testRun.findUniqueOrThrow({ where: { id: run.body.id } });
      const stored = await ctx.prisma.testResult.findUniqueOrThrow({ where: { id: result.id } });
      if (save.status === 200) {
        outcomes.saved++;
        expect(new Date(save.body.executedAt).getTime()).toBeLessThanOrEqual(completedAt!.getTime());
        expect(stored.status).toBe('PASSED');
      } else {
        outcomes.rejected++;
        expect(save.status).toBe(409);
        expect(stored).toMatchObject({ status: 'NOT_EXECUTED', executedAt: null });
      }
    }
    expect(outcomes.saved + outcomes.rejected).toBe(10);
  });
});
