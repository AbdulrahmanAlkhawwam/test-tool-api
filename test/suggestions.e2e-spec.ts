import { randomUUID } from 'crypto';
import { seedActors, seedCase, seedModule, seedProject, seedSuggestion } from './utils/factories';
import { createTestApp, resetDb, TestContext } from './utils/test-app';

describe('AI change suggestions (e2e)', () => {
  let ctx: TestContext;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let projectId: string;
  let moduleId: string;
  let caseId: string;

  const CHANGES = {
    steps: { from: '1. Open Login', to: '1. Open Login\n2. Submit' },
    notes: { from: null, to: 'Covers the new submit button' },
  };

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    actors = await seedActors(ctx);
    projectId = (await seedProject(ctx.prisma, actors.admin.id)).id;
    moduleId = (await seedModule(ctx.prisma, projectId, { code: 'AUTH' })).id;
    const created = await seedCase(ctx.prisma, { projectId, moduleId, userId: actors.admin.id, code: 'TC-AUTH-001' });
    await ctx.prisma.testCase.update({ where: { id: created.id }, data: { steps: '1. Open Login' } });
    caseId = created.id;
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('answers an explicit JSON null (not an empty body) when a case has no pending suggestion', async () => {
    const res = await ctx.http().get(`/api/test-cases/${caseId}/suggestion`).set(actors.testerAuth).expect(200);
    // Assert on the raw body text, not just supertest's parsed res.body: an empty body would
    // also parse to `undefined`/falsy, so this is the assertion that actually fails if the
    // handler ever regresses to Nest's default (empty-body) handling of a returned `null`.
    expect(res.text).toBe('null');
    expect(res.body).toBeNull();

    await ctx.http().get(`/api/test-cases/${randomUUID()}/suggestion`).set(actors.testerAuth).expect(404);
    await ctx.http().get(`/api/test-cases/${caseId}/suggestion`).expect(401);
  });

  it('returns the pending suggestion with its author and rationale', async () => {
    const suggestion = await seedSuggestion(ctx.prisma, { testCaseId: caseId, userId: actors.admin.id, changes: CHANGES });
    const res = await ctx.http().get(`/api/test-cases/${caseId}/suggestion`).set(actors.testerAuth).expect(200);
    expect(res.body).toMatchObject({
      id: suggestion.id,
      testCaseId: caseId,
      status: 'PENDING',
      changes: CHANGES,
      rationale: 'The steps were missing the submit action',
      createdBy: { id: actors.admin.id, name: 'Admin' },
    });
    expect(res.body.createdAt).toBeDefined();
  });

  it('accepting applies every listed change and records who accepted it', async () => {
    const suggestion = await seedSuggestion(ctx.prisma, { testCaseId: caseId, userId: actors.admin.id, changes: CHANGES });
    const res = await ctx.http().post(`/api/suggestions/${suggestion.id}/accept`).set(actors.testerAuth).expect(200);
    expect(res.body).toMatchObject({ code: 'TC-AUTH-001', steps: '1. Open Login\n2. Submit', notes: 'Covers the new submit button' });
    expect(res.body.updatedBy).toEqual({ id: actors.tester.id, name: 'Tess Tester' });

    const stored = await ctx.prisma.testCaseSuggestion.findUniqueOrThrow({ where: { id: suggestion.id } });
    expect(stored).toMatchObject({ status: 'ACCEPTED', resolvedById: actors.tester.id });
    expect(stored.resolvedAt).not.toBeNull();

    // No pending suggestion is left behind.
    const after = await ctx.http().get(`/api/test-cases/${caseId}/suggestion`).set(actors.testerAuth).expect(200);
    expect(after.text).toBe('null');
  });

  it('refuses to accept a suggestion whose case changed in a field it touches', async () => {
    const suggestion = await seedSuggestion(ctx.prisma, { testCaseId: caseId, userId: actors.admin.id, changes: CHANGES });
    await ctx.http().patch(`/api/test-cases/${caseId}`).set(actors.testerAuth)
      .send({ steps: '1. Open Login\n2. A human rewrote this' }).expect(200);

    const res = await ctx.http().post(`/api/suggestions/${suggestion.id}/accept`).set(actors.testerAuth).expect(409);
    expect(res.body.message).toBe('The test case changed since this suggestion – review it again');
    expect((await ctx.prisma.testCaseSuggestion.findUniqueOrThrow({ where: { id: suggestion.id } })).status).toBe('PENDING');
    expect((await ctx.prisma.testCase.findUniqueOrThrow({ where: { id: caseId } })).steps).toBe('1. Open Login\n2. A human rewrote this');
  });

  it('accepts a suggestion when an untouched field changed, and refuses a second accept', async () => {
    const suggestion = await seedSuggestion(ctx.prisma, { testCaseId: caseId, userId: actors.admin.id, changes: CHANGES });
    await ctx.http().patch(`/api/test-cases/${caseId}`).set(actors.testerAuth).send({ priority: 'HIGH' }).expect(200);

    await ctx.http().post(`/api/suggestions/${suggestion.id}/accept`).set(actors.testerAuth).expect(200);
    const again = await ctx.http().post(`/api/suggestions/${suggestion.id}/accept`).set(actors.testerAuth).expect(409);
    expect(again.body.message).toBe('This suggestion has already been resolved');
    await ctx.http().post(`/api/suggestions/${randomUUID()}/accept`).set(actors.testerAuth).expect(404);
  });

  it('rejecting leaves the case untouched and cannot be undone', async () => {
    const suggestion = await seedSuggestion(ctx.prisma, { testCaseId: caseId, userId: actors.admin.id, changes: CHANGES });
    const res = await ctx.http().post(`/api/suggestions/${suggestion.id}/reject`).set(actors.testerAuth).expect(200);
    expect(res.body).toEqual({ id: suggestion.id, status: 'REJECTED' });

    expect((await ctx.prisma.testCase.findUniqueOrThrow({ where: { id: caseId } })).steps).toBe('1. Open Login');
    const stored = await ctx.prisma.testCaseSuggestion.findUniqueOrThrow({ where: { id: suggestion.id } });
    expect(stored).toMatchObject({ status: 'REJECTED', resolvedById: actors.tester.id });

    await ctx.http().post(`/api/suggestions/${suggestion.id}/reject`).set(actors.testerAuth).expect(409);
    await ctx.http().post(`/api/suggestions/${suggestion.id}/accept`).set(actors.testerAuth).expect(409);
  });

  it('ignores stored changes that are not template fields, and 404s for a deleted case', async () => {
    const overreaching = await seedSuggestion(ctx.prisma, {
      testCaseId: caseId,
      userId: actors.admin.id,
      changes: {
        notes: { from: null, to: 'Fine' },
        reviewState: { from: 'APPROVED', to: 'AI_DRAFT' },
        code: { from: 'TC-AUTH-001', to: 'TC-AUTH-777' },
      } as never,
    });
    const res = await ctx.http().post(`/api/suggestions/${overreaching.id}/accept`).set(actors.testerAuth).expect(200);
    expect(res.body).toMatchObject({ code: 'TC-AUTH-001', reviewState: 'APPROVED', notes: 'Fine' });

    const deletedCase = await seedCase(ctx.prisma, { projectId, moduleId, userId: actors.admin.id, code: 'TC-AUTH-002' });
    const orphan = await seedSuggestion(ctx.prisma, { testCaseId: deletedCase.id, userId: actors.admin.id, changes: CHANGES });
    await ctx.http().delete(`/api/test-cases/${deletedCase.id}`).set(actors.testerAuth).expect(204);
    await ctx.http().post(`/api/suggestions/${orphan.id}/accept`).set(actors.testerAuth).expect(404);
    await ctx.http().get(`/api/test-cases/${deletedCase.id}/suggestion`).set(actors.testerAuth).expect(404);
  });
});
