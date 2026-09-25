import { ReviewState } from '@prisma/client';
import { seedActors, seedApiToken, seedCase, seedModule, seedProject } from './utils/factories';
import { callTool, callToolRaw, connectMcp, createMcpTestApp, McpTestContext } from './utils/mcp';
import { resetDb } from './utils/test-app';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

interface BatchResult {
  created: number;
  failed: number;
  results: { ok: boolean; code?: string; error?: string }[];
}

describe('MCP write tools (e2e)', () => {
  let ctx: McpTestContext;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let client: Client;
  let projectId: string;
  let authModuleId: string;

  const oneCase = (overrides: Record<string, unknown> = {}) => ({
    moduleCode: 'AUTH',
    name: 'Login with a valid email',
    description: 'Happy path',
    preconditions: 'A registered account',
    steps: '1. Open Login\n2. Enter credentials\n3. Tap Login',
    testData: 'tester@ejad.test / Passw0rd!',
    expectedResult: 'The dashboard opens',
    priority: 'HIGH',
    ...overrides,
  });

  beforeAll(async () => {
    ctx = await createMcpTestApp();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    actors = await seedActors(ctx);
    projectId = (await seedProject(ctx.prisma, actors.admin.id)).id;
    authModuleId = (await seedModule(ctx.prisma, projectId, { code: 'AUTH' })).id;
    const { token } = await seedApiToken(ctx.prisma, actors.tester.id);
    client = await connectMcp(ctx, token);
  });
  afterEach(async () => {
    await client.close();
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('create_module creates a module, derives the code, and reports a duplicate', async () => {
    const explicit = await callTool<{ name: string; code: string }>(client, 'create_module', {
      projectKey: 'NINJA', name: 'Shopping cart', code: 'cart',
    });
    expect(explicit).toEqual({ name: 'Shopping cart', code: 'CART' });

    const derived = await callTool<{ name: string; code: string }>(client, 'create_module', {
      projectKey: 'NINJA', name: 'Forgot Password',
    });
    expect(derived).toEqual({ name: 'Forgot Password', code: 'FP' });

    const collision = await callTool<{ name: string; code: string }>(client, 'create_module', {
      projectKey: 'NINJA', name: 'Fast Payments',
    });
    expect(collision).toEqual({ name: 'Fast Payments', code: 'FP2' });

    const duplicate = await callToolRaw(client, 'create_module', { projectKey: 'NINJA', name: 'Another cart', code: 'CART' });
    expect(duplicate).toEqual({ isError: true, text: 'Module code "CART" already exists in this project' });

    const bad = await callToolRaw(client, 'create_module', { projectKey: 'NINJA', name: 'Nope', code: '9bad' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('code must be 1–10 uppercase letters/digits, starting with a letter');
  });

  it('create_test_cases creates AI drafts with generated codes', async () => {
    const batch = await callTool<BatchResult>(client, 'create_test_cases', {
      projectKey: 'NINJA',
      cases: [oneCase(), oneCase({ name: 'Login with a wrong password', priority: 'MEDIUM' })],
    });
    expect(batch).toMatchObject({ created: 2, failed: 0 });
    expect(batch.results).toEqual([
      { ok: true, code: 'TC-AUTH-001' },
      { ok: true, code: 'TC-AUTH-002' },
    ]);

    const stored = await ctx.prisma.testCase.findMany({ where: { projectId }, orderBy: { code: 'asc' } });
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      code: 'TC-AUTH-001', name: 'Login with a valid email', priority: 'HIGH',
      steps: '1. Open Login\n2. Enter credentials\n3. Tap Login',
      reviewState: 'AI_DRAFT', createdVia: 'AI', createdById: actors.tester.id, approvedById: null, approvedAt: null,
    });
  });

  it('create_test_cases keeps the valid items when some fail', async () => {
    const batch = await callTool<BatchResult>(client, 'create_test_cases', {
      projectKey: 'NINJA',
      cases: [
        oneCase(),
        oneCase({ moduleCode: 'NOPE' }),
        oneCase({ name: '' }),
        oneCase({ name: 'Too long steps', steps: 'x'.repeat(10_001) }),
        oneCase({ name: 'Last good one' }),
      ],
    });
    expect(batch).toMatchObject({ created: 2, failed: 3 });
    expect(batch.results[0]).toEqual({ ok: true, code: 'TC-AUTH-001' });
    expect(batch.results[1]).toEqual({ ok: false, error: 'Module "NOPE" was not found in project NINJA' });
    expect(batch.results[2]).toEqual({ ok: false, error: 'name must be between 1 and 300 characters' });
    expect(batch.results[3]).toEqual({ ok: false, error: 'steps must be at most 10000 characters' });
    expect(batch.results[4]).toEqual({ ok: true, code: 'TC-AUTH-002' });

    const codes = (await ctx.prisma.testCase.findMany({ where: { projectId }, select: { code: true }, orderBy: { code: 'asc' } })).map((c) => c.code);
    expect(codes).toEqual(['TC-AUTH-001', 'TC-AUTH-002']);
  });

  it('create_test_cases refuses more than 50 cases and an empty batch', async () => {
    await expect(
      callTool(client, 'create_test_cases', { projectKey: 'NINJA', cases: Array.from({ length: 51 }, () => oneCase()) }),
    ).rejects.toThrow();
    await expect(callTool(client, 'create_test_cases', { projectKey: 'NINJA', cases: [] })).rejects.toThrow();
    expect(await ctx.prisma.testCase.count()).toBe(0);
  });

  it('drafts the AI created stay out of runs and reports until a tester approves them', async () => {
    await callTool<BatchResult>(client, 'create_test_cases', { projectKey: 'NINJA', cases: [oneCase()] });

    const noCases = await ctx.http().post(`/api/projects/${projectId}/runs`).set(actors.testerAuth)
      .send({ name: 'Sprint 1', selection: { mode: 'ALL' } }).expect(400);
    expect(noCases.body.message).toBe('No test cases match the selection');
    expect((await ctx.http().get('/api/dashboard').set(actors.testerAuth).expect(200)).body.testCaseCount).toBe(0);

    const draft = await ctx.prisma.testCase.findFirstOrThrow({ where: { projectId } });
    await ctx.http().post(`/api/test-cases/${draft.id}/approve`).set(actors.testerAuth).expect(200);

    const run = await ctx.http().post(`/api/projects/${projectId}/runs`).set(actors.testerAuth)
      .send({ name: 'Sprint 1', selection: { mode: 'ALL' } }).expect(201);
    expect(run.body.summary.total).toBe(1);
  });

  it('update_test_case applies directly to a draft', async () => {
    const draft = await seedCase(ctx.prisma, {
      projectId, moduleId: authModuleId, userId: actors.admin.id, code: 'TC-AUTH-001',
      reviewState: ReviewState.AI_DRAFT, createdVia: 'AI',
    });

    const applied = await callTool<{ applied: boolean; changed: string[] }>(client, 'update_test_case', {
      projectKey: 'NINJA', code: 'TC-AUTH-001',
      changes: { steps: '1. Open Login\n2. Submit', notes: 'Rewritten' },
      rationale: 'The submit step was missing',
    });
    expect(applied).toMatchObject({ applied: true, changed: ['steps', 'notes'] });

    const stored = await ctx.prisma.testCase.findUniqueOrThrow({ where: { id: draft.id } });
    expect(stored).toMatchObject({ steps: '1. Open Login\n2. Submit', notes: 'Rewritten', reviewState: 'AI_DRAFT' });
    expect(stored.updatedById).toBe(actors.tester.id);
    expect(await ctx.prisma.testCaseSuggestion.count()).toBe(0);
  });

  it('update_test_case on an approved case suggests, replaces the pending one, and cannot overreach', async () => {
    const approved = await seedCase(ctx.prisma, { projectId, moduleId: authModuleId, userId: actors.admin.id, code: 'TC-AUTH-001' });
    await ctx.prisma.testCase.update({ where: { id: approved.id }, data: { steps: '1. Open Login' } });

    const first = await callTool<{ suggestionId: string; applied: boolean }>(client, 'update_test_case', {
      projectKey: 'NINJA', code: 'TC-AUTH-001', changes: { steps: '1. Open Login\n2. Submit' }, rationale: 'Missing step',
    });
    expect(first).toMatchObject({ applied: false, suggestionId: expect.any(String), changed: ['steps'] });
    expect((await ctx.prisma.testCase.findUniqueOrThrow({ where: { id: approved.id } })).steps).toBe('1. Open Login');

    const second = await callTool<{ suggestionId: string }>(client, 'update_test_case', {
      projectKey: 'NINJA', code: 'TC-AUTH-001', changes: { notes: 'Also flaky' },
    });
    expect(second.suggestionId).not.toBe(first.suggestionId);
    expect(await ctx.prisma.testCaseSuggestion.count({ where: { status: 'PENDING' } })).toBe(1);

    // No change at all is not a suggestion.
    const nothing = await callTool<{ applied: boolean; reason: string }>(client, 'update_test_case', {
      projectKey: 'NINJA', code: 'TC-AUTH-001', changes: { steps: '1. Open Login' },
    });
    expect(nothing).toEqual({ applied: false, reason: 'The test case already matches the requested values' });

    // Fields outside the template are ignored, and the case never moves or changes state.
    const overreach = await callTool<{ applied: boolean; reason?: string }>(client, 'update_test_case', {
      projectKey: 'NINJA', code: 'TC-AUTH-001',
      changes: { code: 'TC-AUTH-777', moduleCode: 'CART', reviewState: 'AI_DRAFT', projectId: 'x' },
    });
    expect(overreach.applied).toBe(false);
    const unchanged = await ctx.prisma.testCase.findUniqueOrThrow({ where: { id: approved.id } });
    expect(unchanged).toMatchObject({ code: 'TC-AUTH-001', moduleId: authModuleId, reviewState: 'APPROVED', projectId });

    const missing = await callToolRaw(client, 'update_test_case', { projectKey: 'NINJA', code: 'TC-AUTH-404', changes: { notes: 'x' } });
    expect(missing).toEqual({ isError: true, text: 'Test case "TC-AUTH-404" was not found in project NINJA' });
    await expect(
      callTool(client, 'update_test_case', { projectKey: 'NINJA', code: 'TC-AUTH-001', changes: { name: 'x'.repeat(301) } }),
    ).rejects.toThrow();
  });
});
