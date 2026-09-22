import { Priority, ResultStatus } from '@prisma/client';
import { seedActors, seedCase, seedModule, seedProject } from './utils/factories';
import { createTestApp, resetDb, TestContext } from './utils/test-app';

describe('Test cases (e2e)', () => {
  let ctx: TestContext;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let projectId: string;
  let authModuleId: string;

  const body = (overrides: Record<string, unknown> = {}) => ({
    moduleId: authModuleId,
    name: 'Login with valid email',
    description: 'Login with valid Email and password',
    preconditions: 'User has a registered account',
    steps: '1. Open Login\n2. Enter credentials\n3. Tap Login',
    testData: 'Valid email/password',
    expectedResult: 'User reaches organization screen',
    priority: 'HIGH',
    ...overrides,
  });

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    actors = await seedActors(ctx);
    projectId = (await seedProject(ctx.prisma, actors.admin.id)).id;
    authModuleId = (await seedModule(ctx.prisma, projectId, { code: 'AUTH' })).id;
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('creates cases with generated sequential IDs and keeps multi-line steps', async () => {
    const first = await ctx.http().post(`/api/projects/${projectId}/test-cases`).set(actors.testerAuth).send(body()).expect(201);
    const second = await ctx.http().post(`/api/projects/${projectId}/test-cases`).set(actors.testerAuth)
      .send(body({ name: 'Login with wrong password' })).expect(201);

    expect(first.body).toMatchObject({ code: 'TC-AUTH-001', priority: 'HIGH', steps: '1. Open Login\n2. Enter credentials\n3. Tap Login' });
    expect(first.body.module).toEqual({ id: authModuleId, name: 'Authentication', code: 'AUTH' });
    expect(second.body.code).toBe('TC-AUTH-002');
  });

  it('allocates distinct IDs for concurrent creates', async () => {
    const responses = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => ctx.http().post(`/api/projects/${projectId}/test-cases`).set(actors.testerAuth).send(body({ name: `Case ${n}` }))),
    );
    const codes = responses.map((r) => r.body.code).sort();
    expect(codes).toEqual(['TC-AUTH-001', 'TC-AUTH-002', 'TC-AUTH-003', 'TC-AUTH-004', 'TC-AUTH-005']);
  });

  it('rejects a module from another project and a missing name', async () => {
    const other = await seedProject(ctx.prisma, actors.admin.id, { key: 'DINAR' });
    const foreign = await seedModule(ctx.prisma, other.id, { code: 'AUTH' });
    const res = await ctx.http().post(`/api/projects/${projectId}/test-cases`).set(actors.testerAuth)
      .send(body({ moduleId: foreign.id })).expect(400);
    expect(res.body.message).toBe('moduleId does not belong to this project');

    await ctx.http().post(`/api/projects/${projectId}/test-cases`).set(actors.testerAuth).send(body({ name: '' })).expect(400);
  });

  it('lists with module, priority, search and latest-status filters plus pagination', async () => {
    const cart = await seedModule(ctx.prisma, projectId, { code: 'CART', name: 'Cart' });
    const c1 = await seedCase(ctx.prisma, { projectId, moduleId: authModuleId, userId: actors.admin.id, code: 'TC-AUTH-001', name: 'Login ok', priority: Priority.HIGH });
    const c2 = await seedCase(ctx.prisma, { projectId, moduleId: authModuleId, userId: actors.admin.id, code: 'TC-AUTH-002', name: 'Magic link', priority: Priority.LOW });
    await seedCase(ctx.prisma, { projectId, moduleId: cart.id, userId: actors.admin.id, code: 'TC-CART-001', name: 'Add to cart' });

    // Older run: c1 failed. Newer run: c1 passed, c2 untouched (NOT_EXECUTED must not override history).
    const old = await ctx.prisma.testRun.create({ data: { projectId, name: 'Sprint 1', createdById: actors.admin.id, startedAt: new Date('2026-01-01') } });
    const recent = await ctx.prisma.testRun.create({ data: { projectId, name: 'Sprint 2', createdById: actors.admin.id, startedAt: new Date('2026-02-01') } });
    await ctx.prisma.testResult.createMany({
      data: [
        { runId: old.id, testCaseId: c1.id, status: ResultStatus.FAILED, executedAt: new Date('2026-01-02') },
        { runId: old.id, testCaseId: c2.id, status: ResultStatus.FAILED, actualResult: 'Email not received', executedAt: new Date('2026-01-02') },
        { runId: recent.id, testCaseId: c1.id, status: ResultStatus.PASSED, executedAt: new Date('2026-02-02') },
        { runId: recent.id, testCaseId: c2.id },
      ],
    });

    const url = `/api/projects/${projectId}/test-cases`;
    const all = await ctx.http().get(url).set(actors.testerAuth).expect(200);
    expect(all.body.total).toBe(3);
    expect(all.body.items.map((i: { code: string }) => i.code)).toEqual(['TC-AUTH-001', 'TC-AUTH-002', 'TC-CART-001']);
    expect(all.body.items[0].latestResult).toMatchObject({ status: 'PASSED', runName: 'Sprint 2' });
    expect(all.body.items[1].latestResult).toMatchObject({ status: 'FAILED', actualResult: 'Email not received' });
    expect(all.body.items[2].latestResult).toBeNull();

    const codes = async (qs: string) =>
      (await ctx.http().get(`${url}?${qs}`).set(actors.testerAuth).expect(200)).body.items.map((i: { code: string }) => i.code);
    expect(await codes(`moduleId=${cart.id}`)).toEqual(['TC-CART-001']);
    expect(await codes('priority=LOW')).toEqual(['TC-AUTH-002']);
    expect(await codes('q=magic')).toEqual(['TC-AUTH-002']);
    expect(await codes('status=FAILED')).toEqual(['TC-AUTH-002']);
    expect(await codes('status=PASSED')).toEqual(['TC-AUTH-001']);
    expect(await codes('status=NOT_EXECUTED')).toEqual(['TC-CART-001']);

    const page2 = await ctx.http().get(`${url}?page=2&pageSize=2`).set(actors.testerAuth).expect(200);
    expect(page2.body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(page2.body.items).toHaveLength(1);

    await ctx.http().get(`${url}?pageSize=500`).set(actors.testerAuth).expect(400);
  });

  it('returns detail with history newest first and updates with updatedBy', async () => {
    const created = await ctx.http().post(`/api/projects/${projectId}/test-cases`).set(actors.adminAuth).send(body()).expect(201);
    const id = created.body.id;
    const run1 = await ctx.prisma.testRun.create({ data: { projectId, name: 'R1', createdById: actors.admin.id, startedAt: new Date('2026-01-01') } });
    const run2 = await ctx.prisma.testRun.create({ data: { projectId, name: 'R2', createdById: actors.admin.id, startedAt: new Date('2026-03-01') } });
    await ctx.prisma.testResult.createMany({
      data: [
        { runId: run1.id, testCaseId: id, status: ResultStatus.FAILED, executedById: actors.tester.id, executedAt: new Date() },
        { runId: run2.id, testCaseId: id, status: ResultStatus.PASSED, executedById: actors.tester.id, executedAt: new Date() },
      ],
    });

    const detail = await ctx.http().get(`/api/test-cases/${id}`).set(actors.testerAuth).expect(200);
    expect(detail.body.history.map((h: { run: { name: string } }) => h.run.name)).toEqual(['R2', 'R1']);
    expect(detail.body.history[0].executedBy).toEqual({ id: actors.tester.id, name: 'Tess Tester' });
    expect(detail.body.createdBy).toEqual({ id: actors.admin.id, name: 'Admin' });

    const updated = await ctx.http().patch(`/api/test-cases/${id}`).set(actors.testerAuth)
      .send({ expectedResult: 'Dashboard opens', priority: 'MEDIUM' }).expect(200);
    expect(updated.body).toMatchObject({ expectedResult: 'Dashboard opens', priority: 'MEDIUM', code: 'TC-AUTH-001' });
    expect(updated.body.updatedBy).toEqual({ id: actors.tester.id, name: 'Tess Tester' });
  });

  it('rejects null for required fields but lets null clear optional text', async () => {
    const { body: created } = await ctx.http().post(`/api/projects/${projectId}/test-cases`).set(actors.testerAuth)
      .send({ ...body(), notes: 'temp' }).expect(201);
    for (const field of ['name', 'moduleId', 'priority']) {
      const res = await ctx.http().patch(`/api/test-cases/${created.id}`).set(actors.testerAuth).send({ [field]: null }).expect(400);
      expect(res.body.message).toBe('Validation failed');
    }
    const cleared = await ctx.http().patch(`/api/test-cases/${created.id}`).set(actors.testerAuth).send({ notes: null }).expect(200);
    expect(cleared.body).toMatchObject({ notes: null, name: created.name });
  });

  it('soft-deletes: hidden from lists, still readable, not editable, code never reused', async () => {
    const a = await ctx.http().post(`/api/projects/${projectId}/test-cases`).set(actors.testerAuth).send(body()).expect(201);
    const b = await ctx.http().post(`/api/projects/${projectId}/test-cases`).set(actors.testerAuth).send(body()).expect(201);

    await ctx.http().delete(`/api/test-cases/${b.body.id}`).set(actors.testerAuth).expect(204);
    const list = await ctx.http().get(`/api/projects/${projectId}/test-cases`).set(actors.testerAuth).expect(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([a.body.id]);

    const detail = await ctx.http().get(`/api/test-cases/${b.body.id}`).set(actors.testerAuth).expect(200);
    expect(detail.body.deletedAt).not.toBeNull();
    await ctx.http().patch(`/api/test-cases/${b.body.id}`).set(actors.testerAuth).send({ name: 'x' }).expect(404);
    await ctx.http().delete(`/api/test-cases/${b.body.id}`).set(actors.testerAuth).expect(404);

    const c = await ctx.http().post(`/api/projects/${projectId}/test-cases`).set(actors.testerAuth).send(body()).expect(201);
    expect(c.body.code).toBe('TC-AUTH-003');
  });

  it('creates cases as approved and web-authored by default', async () => {
    const created = await ctx.http().post(`/api/projects/${projectId}/test-cases`).set(actors.testerAuth).send(body()).expect(201);
    expect(created.body).toMatchObject({ reviewState: 'APPROVED', createdVia: 'WEB', approvedById: null, approvedAt: null });

    const draft = await seedCase(ctx.prisma, {
      projectId, moduleId: authModuleId, userId: actors.admin.id, code: 'TC-AUTH-900',
      reviewState: 'AI_DRAFT', createdVia: 'AI',
    });
    const detail = await ctx.http().get(`/api/test-cases/${draft.id}`).set(actors.testerAuth).expect(200);
    expect(detail.body).toMatchObject({ reviewState: 'AI_DRAFT', createdVia: 'AI' });
  });
});
