import { ResultStatus } from '@prisma/client';
import { readTabular } from '../src/modules/import-export/tabular-reader';
import { seedActors, seedCase, seedModule, seedProject } from './utils/factories';
import { binaryParser, createTestApp, resetDb, TestContext } from './utils/test-app';

describe('Export (e2e)', () => {
  let ctx: TestContext;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let projectId: string;
  let caseIds: string[];

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    actors = await seedActors(ctx);
    projectId = (await seedProject(ctx.prisma, actors.admin.id)).id;
    const moduleId = (await seedModule(ctx.prisma, projectId)).id;
    caseIds = [
      (await seedCase(ctx.prisma, { projectId, moduleId, userId: actors.admin.id, code: 'TC-AUTH-001', name: 'Login ok' })).id,
      (await seedCase(ctx.prisma, { projectId, moduleId, userId: actors.admin.id, code: 'TC-AUTH-002', name: 'Wrong password' })).id,
    ];
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  const download = (url: string) =>
    ctx.http().get(url).set(actors.testerAuth).buffer(true).parse(binaryParser).expect(200);

  it('exports project test cases with their latest results', async () => {
    const run = await ctx.prisma.testRun.create({ data: { projectId, name: 'Sprint 1', createdById: actors.admin.id } });
    await ctx.prisma.testResult.create({
      data: { runId: run.id, testCaseId: caseIds[1], status: ResultStatus.FAILED, actualResult: 'No message shown', executedAt: new Date() },
    });

    const res = await download(`/api/projects/${projectId}/test-cases/export`);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toBe('attachment; filename="NINJA-test-cases.xlsx"');

    const table = await readTabular(res.body as Buffer, 'x.xlsx');
    expect(table[0][0]).toBe('ID');
    expect(table.slice(1).map((r) => [r[0], r[2], r[8] ?? '', r[10]])).toEqual([
      ['TC-AUTH-001', 'Login ok', '', 'Not Executed'],
      ['TC-AUTH-002', 'Wrong password', 'No message shown', 'Failed'],
    ]);
  });

  it('exports a run with that run\'s results', async () => {
    const created = await ctx.http().post(`/api/projects/${projectId}/runs`).set(actors.testerAuth)
      .send({ name: 'Sprint 12 / RC1', selection: { mode: 'ALL' } }).expect(201);
    const result = await ctx.prisma.testResult.findFirstOrThrow({ where: { runId: created.body.id, testCaseId: caseIds[0] } });
    await ctx.http().patch(`/api/runs/${created.body.id}/results/${result.id}`).set(actors.testerAuth)
      .send({ status: 'PASSED', actualResult: 'Like Exp Result', notes: 'Chrome' }).expect(200);

    const res = await download(`/api/runs/${created.body.id}/export`);
    expect(res.headers['content-disposition']).toBe('attachment; filename="NINJA-run-Sprint-12-RC1.xlsx"');
    const table = await readTabular(res.body as Buffer, 'x.xlsx');
    expect(table[1]).toEqual(expect.arrayContaining(['TC-AUTH-001', 'Like Exp Result', 'Passed', 'Chrome']));
    expect(table[2][10]).toBe('Not Executed');
  });

  it('returns 404 for unknown project or run', async () => {
    await ctx.http().get('/api/projects/7a1d0c5e-0000-4000-8000-000000000000/test-cases/export').set(actors.testerAuth).expect(404);
    await ctx.http().get('/api/runs/7a1d0c5e-0000-4000-8000-000000000000/export').set(actors.testerAuth).expect(404);
  });

  it('exposes the Content-Disposition header for cross-origin downloads', async () => {
    const res = await ctx.http().get(`/api/projects/${projectId}/test-cases/export`)
      .set(actors.testerAuth).set('Origin', 'http://localhost:3001')
      .buffer(true).parse(binaryParser).expect(200);
    expect(res.headers['access-control-expose-headers']).toContain('Content-Disposition');
  });
});
