import { CreatedVia, Priority, ResultStatus, ReviewState } from '@prisma/client';
import ExcelJS from 'exceljs';
import { seedActors, seedCase, seedModule, seedProject } from './utils/factories';
import { binaryParser, createTestApp, resetDb, TestContext } from './utils/test-app';

describe('Review rules: drafts stay out of everything (e2e)', () => {
  let ctx: TestContext;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let projectId: string;
  let authModuleId: string;
  let approvedId: string;
  let draftId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    actors = await seedActors(ctx);
    projectId = (await seedProject(ctx.prisma, actors.admin.id)).id;
    authModuleId = (await seedModule(ctx.prisma, projectId, { code: 'AUTH' })).id;
    approvedId = (
      await seedCase(ctx.prisma, { projectId, moduleId: authModuleId, userId: actors.admin.id, code: 'TC-AUTH-001', name: 'Login ok' })
    ).id;
    draftId = (
      await seedCase(ctx.prisma, {
        projectId, moduleId: authModuleId, userId: actors.admin.id, code: 'TC-AUTH-002', name: 'AI wrote this',
        reviewState: ReviewState.AI_DRAFT, createdVia: CreatedVia.AI, priority: Priority.LOW,
      })
    ).id;
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('never puts a draft into a run snapshot', async () => {
    const run = await ctx.http().post(`/api/projects/${projectId}/runs`).set(actors.testerAuth)
      .send({ name: 'Sprint 1', selection: { mode: 'ALL' } }).expect(201);
    expect(run.body.summary.total).toBe(1);

    const detail = await ctx.http().get(`/api/runs/${run.body.id}`).set(actors.testerAuth).expect(200);
    expect(detail.body.results.map((r: { testCase: { code: string } }) => r.testCase.code)).toEqual(['TC-AUTH-001']);

    // A selection that only matches drafts is empty, not a run full of unreviewed cases.
    const empty = await ctx.http().post(`/api/projects/${projectId}/runs`).set(actors.testerAuth)
      .send({ name: 'Drafts only', selection: { mode: 'CASES', caseIds: [draftId] } }).expect(400);
    expect(empty.body.message).toBe('No test cases match the selection');
  });

  it('keeps drafts out of project and module case counts', async () => {
    const projects = await ctx.http().get('/api/projects').set(actors.testerAuth).expect(200);
    expect(projects.body[0]).toMatchObject({ key: 'NINJA', caseCount: 1 });

    const byKey = await ctx.http().get('/api/projects/NINJA').set(actors.testerAuth).expect(200);
    expect(byKey.body.modules).toEqual([{ id: authModuleId, name: 'Authentication', code: 'AUTH', caseCount: 1 }]);

    const modules = await ctx.http().get(`/api/projects/${projectId}/modules`).set(actors.testerAuth).expect(200);
    expect(modules.body).toEqual([{ id: authModuleId, name: 'Authentication', code: 'AUTH', caseCount: 1 }]);
  });

  it('keeps drafts out of the project report and the dashboard', async () => {
    const report = await ctx.http().get(`/api/projects/${projectId}/reports`).set(actors.testerAuth).expect(200);
    expect(report.body.byModule).toEqual([
      { moduleId: authModuleId, name: 'Authentication', code: 'AUTH', summary: expect.objectContaining({ total: 1 }) },
    ]);
    expect(report.body.byPriority.map((p: { priority: string }) => p.priority)).toEqual(['MEDIUM']);

    const dashboard = await ctx.http().get('/api/dashboard').set(actors.testerAuth).expect(200);
    expect(dashboard.body.testCaseCount).toBe(1);
  });

  it('keeps drafts out of the Excel export', async () => {
    const res = await ctx.http().get(`/api/projects/${projectId}/test-cases/export`).set(actors.testerAuth)
      .buffer().parse(binaryParser).expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ExcelJS.Buffer);
    const ids = (wb.worksheets[0].getColumn(1).values as (string | undefined)[]).filter((v) => typeof v === 'string');
    expect(ids).toEqual(['ID', 'TC-AUTH-001']);
  });

  it('lists drafts only under the AI drafts filter and never under a status filter', async () => {
    const run = await ctx.http().post(`/api/projects/${projectId}/runs`).set(actors.testerAuth)
      .send({ name: 'Sprint 1', selection: { mode: 'ALL' } }).expect(201);
    const detail = await ctx.http().get(`/api/runs/${run.body.id}`).set(actors.testerAuth).expect(200);
    await ctx.http().patch(`/api/runs/${run.body.id}/results/${detail.body.results[0].id}`).set(actors.testerAuth)
      .send({ status: ResultStatus.PASSED }).expect(200);

    const url = `/api/projects/${projectId}/test-cases`;
    const codes = async (qs = '') =>
      (await ctx.http().get(`${url}${qs}`).set(actors.testerAuth).expect(200)).body.items.map((i: { code: string }) => i.code);

    expect(await codes()).toEqual(['TC-AUTH-001', 'TC-AUTH-002']);
    expect(await codes('?reviewState=AI_DRAFT')).toEqual(['TC-AUTH-002']);
    expect(await codes('?reviewState=APPROVED')).toEqual(['TC-AUTH-001']);
    expect(await codes('?status=PASSED')).toEqual(['TC-AUTH-001']);
    expect(await codes('?status=NOT_EXECUTED')).toEqual([]);
    expect(await codes('?status=NOT_EXECUTED&reviewState=AI_DRAFT')).toEqual([]);

    const drafts = await ctx.http().get(`${url}?reviewState=AI_DRAFT`).set(actors.testerAuth).expect(200);
    expect(drafts.body.total).toBe(1);
    expect(drafts.body.items[0]).toMatchObject({ reviewState: 'AI_DRAFT', createdVia: 'AI' });

    await ctx.http().get(`${url}?reviewState=NOPE`).set(actors.testerAuth).expect(400);
    expect(approvedId).toBeDefined();
  });
});
