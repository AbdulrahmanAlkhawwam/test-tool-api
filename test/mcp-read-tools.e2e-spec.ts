import { CreatedVia, Priority, ResultStatus, ReviewState } from '@prisma/client';
import { seedActors, seedApiToken, seedCase, seedModule, seedProject, seedSuggestion } from './utils/factories';
import { callTool, callToolRaw, connectMcp, createMcpTestApp, McpTestContext } from './utils/mcp';
import { resetDb } from './utils/test-app';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

interface CaseRow {
  code: string;
  name: string;
  module: string;
  priority: string;
  reviewState: string;
  latestStatus: string;
}

describe('MCP read tools (e2e)', () => {
  let ctx: McpTestContext;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let client: Client;
  let projectId: string;
  let authId: string;
  let cartId: string;
  let ids: Record<string, string>;

  beforeAll(async () => {
    ctx = await createMcpTestApp();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    actors = await seedActors(ctx);
    projectId = (await seedProject(ctx.prisma, actors.admin.id)).id;
    authId = (await seedModule(ctx.prisma, projectId, { code: 'AUTH' })).id;
    cartId = (await seedModule(ctx.prisma, projectId, { code: 'CART', name: 'Cart' })).id;
    ids = {};
    for (const [moduleId, code, priority] of [
      [authId, 'TC-AUTH-001', Priority.HIGH],
      [authId, 'TC-AUTH-002', Priority.LOW],
      [cartId, 'TC-CART-001', Priority.MEDIUM],
    ] as const) {
      ids[code] = (await seedCase(ctx.prisma, { projectId, moduleId, userId: actors.admin.id, code, priority })).id;
    }
    ids['TC-AUTH-003'] = (
      await seedCase(ctx.prisma, {
        projectId, moduleId: authId, userId: actors.admin.id, code: 'TC-AUTH-003', name: 'Machine wrote this',
        reviewState: ReviewState.AI_DRAFT, createdVia: CreatedVia.AI,
      })
    ).id;
    const { token } = await seedApiToken(ctx.prisma, actors.tester.id);
    client = await connectMcp(ctx, token);
  });
  afterEach(async () => {
    await client.close();
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  const seedRun = async (statuses: Partial<Record<string, ResultStatus>>, name = 'Sprint 1', startedAt = new Date('2026-02-01')) => {
    const run = await ctx.prisma.testRun.create({ data: { projectId, name, createdById: actors.admin.id, startedAt } });
    for (const [code, status] of Object.entries(statuses)) {
      await ctx.prisma.testResult.create({
        data: {
          runId: run.id, testCaseId: ids[code], status: status!, actualResult: status === 'FAILED' ? 'Boom' : null,
          executedById: actors.tester.id, executedAt: startedAt,
        },
      });
    }
    return run;
  };

  it('list_projects reports approved case counts, the latest run and archived projects on request', async () => {
    await seedRun({ 'TC-AUTH-001': ResultStatus.PASSED, 'TC-AUTH-002': ResultStatus.FAILED });
    const archived = await seedProject(ctx.prisma, actors.admin.id, { key: 'OLD', name: 'Old thing' });
    await ctx.prisma.project.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });

    const active = await callTool<{ projects: { key: string; caseCount: number; latestRun: { name: string; summary: { passed: number } } | null }[] }>(
      client, 'list_projects',
    );
    expect(active.projects.map((p) => p.key)).toEqual(['NINJA']);
    expect(active.projects[0].caseCount).toBe(3); // the AI draft is not counted
    expect(active.projects[0].latestRun).toMatchObject({ name: 'Sprint 1', summary: expect.objectContaining({ passed: 1, failed: 1 }) });
    expect(JSON.stringify(active)).not.toContain(projectId);

    const all = await callTool<{ projects: { key: string; archived: boolean }[] }>(client, 'list_projects', { includeArchived: true });
    expect(all.projects.map((p) => p.key).sort()).toEqual(['NINJA', 'OLD']);
    expect(all.projects.find((p) => p.key === 'OLD')!.archived).toBe(true);
  });

  it('get_project lists modules with approved counts and errors for an unknown key', async () => {
    const project = await callTool<{ key: string; modules: { name: string; code: string; caseCount: number }[] }>(
      client, 'get_project', { projectKey: 'ninja' },
    );
    expect(project.key).toBe('NINJA');
    expect(project.modules).toEqual([
      { name: 'Authentication', code: 'AUTH', caseCount: 2 },
      { name: 'Cart', code: 'CART', caseCount: 1 },
    ]);

    const missing = await callToolRaw(client, 'get_project', { projectKey: 'NOPE' });
    expect(missing).toEqual({ isError: true, text: 'Project not found' });
  });

  it('list_test_cases filters, pages and can hide drafts', async () => {
    await seedRun({ 'TC-AUTH-001': ResultStatus.PASSED, 'TC-AUTH-002': ResultStatus.FAILED });
    const codes = async (args: Record<string, unknown>) =>
      (await callTool<{ items: CaseRow[] }>(client, 'list_test_cases', { projectKey: 'NINJA', ...args })).items.map((i) => i.code);

    expect(await codes({})).toEqual(['TC-AUTH-001', 'TC-AUTH-002', 'TC-AUTH-003', 'TC-CART-001']);
    expect(await codes({ includeDrafts: false })).toEqual(['TC-AUTH-001', 'TC-AUTH-002', 'TC-CART-001']);
    expect(await codes({ moduleCode: 'cart' })).toEqual(['TC-CART-001']);
    expect(await codes({ priority: 'LOW' })).toEqual(['TC-AUTH-002']);
    expect(await codes({ status: 'FAILED' })).toEqual(['TC-AUTH-002']);
    expect(await codes({ q: 'machine' })).toEqual(['TC-AUTH-003']);

    const page = await callTool<{ items: CaseRow[]; total: number; page: number; pageSize: number }>(
      client, 'list_test_cases', { projectKey: 'NINJA', page: 2, pageSize: 2 },
    );
    expect(page).toMatchObject({ total: 4, page: 2, pageSize: 2 });
    expect(page.items.map((i) => i.code)).toEqual(['TC-AUTH-003', 'TC-CART-001']);
    expect(page.items[0]).toEqual({
      code: 'TC-AUTH-003', name: 'Machine wrote this', module: 'AUTH', priority: 'MEDIUM',
      reviewState: 'AI_DRAFT', latestStatus: 'NOT_EXECUTED', latestExecutedAt: null,
    });

    const unknownModule = await callToolRaw(client, 'list_test_cases', { projectKey: 'NINJA', moduleCode: 'NOPE' });
    expect(unknownModule).toEqual({ isError: true, text: 'Module "NOPE" was not found in project NINJA' });
  });

  it('list_test_cases refuses an oversized page and a missing project key', async () => {
    await expect(callTool(client, 'list_test_cases', { projectKey: 'NINJA', pageSize: 500 })).rejects.toThrow();
    await expect(callTool(client, 'list_test_cases', {})).rejects.toThrow();
  });

  it('list_test_cases refuses a zero or negative pageSize', async () => {
    await expect(callTool(client, 'list_test_cases', { projectKey: 'NINJA', pageSize: 0 })).rejects.toThrow();
    await expect(callTool(client, 'list_test_cases', { projectKey: 'NINJA', pageSize: -5 })).rejects.toThrow();
  });

  it('get_test_case returns the full template, the pending suggestion and the last 10 results', async () => {
    await ctx.prisma.testCase.update({
      where: { id: ids['TC-AUTH-001'] },
      data: {
        description: 'Login with a valid email', preconditions: 'A registered account',
        steps: '1. Open Login\n2. Submit', testData: 'tester@ejad.test', notes: null,
      },
    });
    await seedSuggestion(ctx.prisma, {
      testCaseId: ids['TC-AUTH-001'], userId: actors.admin.id,
      changes: { notes: { from: null, to: 'Flaky on Safari' } }, rationale: 'Observed twice',
    });
    for (let i = 0; i < 12; i++) {
      await seedRun({ 'TC-AUTH-001': i % 2 ? ResultStatus.PASSED : ResultStatus.FAILED }, `Run ${i}`, new Date(2026, 0, i + 1));
    }

    const detail = await callTool<Record<string, unknown> & { results: unknown[]; pendingSuggestion: Record<string, unknown> }>(
      client, 'get_test_case', { projectKey: 'NINJA', code: 'tc-auth-001' },
    );
    expect(detail).toMatchObject({
      code: 'TC-AUTH-001', module: { code: 'AUTH', name: 'Authentication' }, priority: 'HIGH',
      description: 'Login with a valid email', preconditions: 'A registered account',
      steps: '1. Open Login\n2. Submit', testData: 'tester@ejad.test', notes: null,
      reviewState: 'APPROVED', createdVia: 'WEB',
    });
    expect(detail.pendingSuggestion).toMatchObject({
      changes: { notes: { from: null, to: 'Flaky on Safari' } },
      rationale: 'Observed twice',
    });
    expect(detail.results).toHaveLength(10);
    expect(detail.results[0]).toMatchObject({ run: 'Run 11', status: 'PASSED' });

    const missing = await callToolRaw(client, 'get_test_case', { projectKey: 'NINJA', code: 'TC-AUTH-404' });
    expect(missing).toEqual({ isError: true, text: 'Test case "TC-AUTH-404" was not found in project NINJA' });
  });

  it('get_failing_cases reports the latest failures with their actual result', async () => {
    await seedRun({ 'TC-AUTH-001': ResultStatus.FAILED, 'TC-CART-001': ResultStatus.PASSED }, 'Sprint 1', new Date('2026-01-01'));
    await seedRun({ 'TC-AUTH-002': ResultStatus.FAILED }, 'Sprint 2', new Date('2026-02-01'));

    const failing = await callTool<{ cases: { code: string; actualResult: string | null; run: string }[] }>(
      client, 'get_failing_cases', { projectKey: 'NINJA' },
    );
    expect(failing.cases.map((c) => c.code)).toEqual(['TC-AUTH-001', 'TC-AUTH-002']);
    expect(failing.cases[1]).toMatchObject({ code: 'TC-AUTH-002', module: 'AUTH', actualResult: 'Boom', run: 'Sprint 2' });
  });

  it('get_test_cases_for_automation returns approved cases only, in code order', async () => {
    const all = await callTool<{ cases: { code: string; expectedResult: string | null }[] }>(
      client, 'get_test_cases_for_automation', { projectKey: 'NINJA' },
    );
    expect(all.cases.map((c) => c.code)).toEqual(['TC-AUTH-001', 'TC-AUTH-002', 'TC-CART-001']);
    expect(all.cases[0]).toMatchObject({ code: 'TC-AUTH-001', module: { code: 'AUTH', name: 'Authentication' }, expectedResult: 'Works', priority: 'HIGH' });

    const byModule = await callTool<{ cases: { code: string }[] }>(client, 'get_test_cases_for_automation', { projectKey: 'NINJA', moduleCode: 'AUTH' });
    expect(byModule.cases.map((c) => c.code)).toEqual(['TC-AUTH-001', 'TC-AUTH-002']);

    const byCodes = await callTool<{ cases: { code: string }[] }>(
      client, 'get_test_cases_for_automation', { projectKey: 'NINJA', codes: ['TC-CART-001', 'TC-AUTH-003', 'TC-AUTH-404'] },
    );
    expect(byCodes.cases.map((c) => c.code)).toEqual(['TC-CART-001']); // the draft and the unknown code are simply absent
  });
});
