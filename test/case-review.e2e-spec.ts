import { CreatedVia, ReviewState } from '@prisma/client';
import { randomUUID } from 'crypto';
import { seedActors, seedCase, seedModule, seedProject } from './utils/factories';
import { createTestApp, resetDb, TestContext } from './utils/test-app';

describe('Draft review: approve and reject (e2e)', () => {
  let ctx: TestContext;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let projectId: string;
  let moduleId: string;

  const seedDraft = (code: string, project = projectId, module = moduleId) =>
    seedCase(ctx.prisma, {
      projectId: project, moduleId: module, userId: actors.admin.id, code,
      reviewState: ReviewState.AI_DRAFT, createdVia: CreatedVia.AI,
    });

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    actors = await seedActors(ctx);
    projectId = (await seedProject(ctx.prisma, actors.admin.id)).id;
    moduleId = (await seedModule(ctx.prisma, projectId, { code: 'AUTH' })).id;
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('approves a draft, records who approved it, and lets it into the next run', async () => {
    const draft = await seedDraft('TC-AUTH-001');
    const res = await ctx.http().post(`/api/test-cases/${draft.id}/approve`).set(actors.testerAuth).expect(200);
    expect(res.body).toMatchObject({ code: 'TC-AUTH-001', reviewState: 'APPROVED', createdVia: 'AI' });
    expect(res.body.approvedBy).toEqual({ id: actors.tester.id, name: 'Tess Tester' });
    expect(res.body.approvedAt).not.toBeNull();

    // Every test-case response carries the review fields the web app renders.
    const detail = await ctx.http().get(`/api/test-cases/${draft.id}`).set(actors.testerAuth).expect(200);
    expect(detail.body).toMatchObject({
      reviewState: 'APPROVED',
      createdVia: 'AI',
      createdBy: { id: actors.admin.id, name: 'Admin' },
      approvedBy: { id: actors.tester.id, name: 'Tess Tester' },
    });
    expect(detail.body.approvedAt).not.toBeNull();

    const fresh = await ctx.http().post(`/api/projects/${projectId}/test-cases`).set(actors.testerAuth)
      .send({ moduleId, name: 'Human case' }).expect(201);
    expect(fresh.body).toMatchObject({ reviewState: 'APPROVED', createdVia: 'WEB', approvedBy: null, approvedAt: null });

    const run = await ctx.http().post(`/api/projects/${projectId}/runs`).set(actors.testerAuth)
      .send({ name: 'Sprint 1', selection: { mode: 'CASES', caseIds: [draft.id] } }).expect(201);
    expect(run.body.summary.total).toBe(1);
  });

  it('refuses to approve a case that is already approved, missing or deleted', async () => {
    const approved = await seedCase(ctx.prisma, { projectId, moduleId, userId: actors.admin.id, code: 'TC-AUTH-001' });
    const already = await ctx.http().post(`/api/test-cases/${approved.id}/approve`).set(actors.testerAuth).expect(409);
    expect(already.body.message).toBe('Test case is already approved');

    const deleted = await seedDraft('TC-AUTH-002');
    await ctx.http().delete(`/api/test-cases/${deleted.id}`).set(actors.testerAuth).expect(204);
    const gone = await ctx.http().post(`/api/test-cases/${deleted.id}/approve`).set(actors.testerAuth).expect(404);
    expect(gone.body.message).toBe('Test case not found');

    await ctx.http().post(`/api/test-cases/${randomUUID()}/approve`).set(actors.testerAuth).expect(404);
    await ctx.http().post('/api/test-cases/not-a-uuid/approve').set(actors.testerAuth).expect(400);
  });

  it('bulk approve partially succeeds: the drafts go through, the rest come back in failed', async () => {
    const a = await seedDraft('TC-AUTH-001');
    const b = await seedDraft('TC-AUTH-002');
    const alreadyApproved = await seedCase(ctx.prisma, { projectId, moduleId, userId: actors.admin.id, code: 'TC-AUTH-003' });
    const rejected = await seedDraft('TC-AUTH-004');
    await ctx.http().delete(`/api/test-cases/${rejected.id}`).set(actors.testerAuth).expect(204);
    const unknownId = randomUUID();

    const res = await ctx.http().post('/api/test-cases/approve').set(actors.testerAuth)
      .send({ ids: [a.id, alreadyApproved.id, b.id, rejected.id, unknownId] }).expect(200);
    expect(res.body).toEqual({
      approved: [a.id, b.id],
      failed: [
        { id: alreadyApproved.id, message: 'Test case is already approved' },
        { id: rejected.id, message: 'Test case not found' },
        { id: unknownId, message: 'Test case not found' },
      ],
    });

    const states = await ctx.prisma.testCase.findMany({
      where: { projectId }, select: { code: true, reviewState: true, approvedById: true }, orderBy: { code: 'asc' },
    });
    expect(states).toEqual([
      { code: 'TC-AUTH-001', reviewState: 'APPROVED', approvedById: actors.tester.id },
      { code: 'TC-AUTH-002', reviewState: 'APPROVED', approvedById: actors.tester.id },
      { code: 'TC-AUTH-003', reviewState: 'APPROVED', approvedById: null },
      { code: 'TC-AUTH-004', reviewState: 'AI_DRAFT', approvedById: null },
    ]);

    // Both keys are always present, even when nothing could be approved.
    const none = await ctx.http().post('/api/test-cases/approve').set(actors.testerAuth).send({ ids: [a.id] }).expect(200);
    expect(none.body).toEqual({ approved: [], failed: [{ id: a.id, message: 'Test case is already approved' }] });
  });

  it('rejects a bulk approve that crosses projects, is empty or is too big', async () => {
    const mine = await seedDraft('TC-AUTH-001');
    const other = await seedProject(ctx.prisma, actors.admin.id, { key: 'DINAR' });
    const otherModule = await seedModule(ctx.prisma, other.id, { code: 'AUTH' });
    const theirs = await seedDraft('TC-AUTH-001', other.id, otherModule.id);

    const mixed = await ctx.http().post('/api/test-cases/approve').set(actors.testerAuth)
      .send({ ids: [mine.id, theirs.id] }).expect(400);
    expect(mixed.body.message).toBe('All test cases must belong to the same project');
    expect((await ctx.prisma.testCase.findUniqueOrThrow({ where: { id: mine.id } })).reviewState).toBe('AI_DRAFT');

    await ctx.http().post('/api/test-cases/approve').set(actors.testerAuth).send({ ids: [] }).expect(400);
    await ctx.http().post('/api/test-cases/approve').set(actors.testerAuth)
      .send({ ids: Array.from({ length: 51 }, () => randomUUID()) }).expect(400);
    await ctx.http().post('/api/test-cases/approve').set(actors.testerAuth).send({ ids: ['nope'] }).expect(400);
  });

  it('rejecting a draft soft-deletes it and never reuses its code', async () => {
    const draft = await seedDraft('TC-AUTH-001');
    await ctx.http().delete(`/api/test-cases/${draft.id}`).set(actors.testerAuth).expect(204);

    const list = await ctx.http().get(`/api/projects/${projectId}/test-cases?reviewState=AI_DRAFT`).set(actors.testerAuth).expect(200);
    expect(list.body.items).toEqual([]);

    const created = await ctx.http().post(`/api/projects/${projectId}/test-cases`).set(actors.testerAuth)
      .send({ moduleId, name: 'Human case' }).expect(201);
    expect(created.body.code).toBe('TC-AUTH-002');

    await ctx.http().post(`/api/test-cases/${draft.id}/approve`).expect(401);
  });
});
