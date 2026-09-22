import { RunStatus, RunType } from '@prisma/client';
import { ciSnippet } from '../src/modules/automation/ci-snippet';
import { FakeGitlab } from './utils/fake-gitlab';
import { seedActors, seedCase, seedModule, seedProject } from './utils/factories';
import { createGitlabTestApp, seedGitlabConnection, seedLinkedProject } from './utils/gitlab';
import { resetDb, TestContext } from './utils/test-app';

describe('Automation extras (e2e)', () => {
  let ctx: TestContext;
  let fake: FakeGitlab;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let projectId: string;
  let moduleId: string;
  let caseId: string;
  let runId: string;

  beforeAll(async () => {
    ({ ctx, fake } = await createGitlabTestApp());
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    fake.reset();
    actors = await seedActors(ctx);
    const { gitlabUser } = await seedGitlabConnection(ctx, fake, actors.tester.id, { username: 'tess' });
    projectId = (await seedLinkedProject(ctx, fake, actors.admin.id, [gitlabUser])).project.id;
    moduleId = (await seedModule(ctx.prisma, projectId)).id;
    caseId = (await seedCase(ctx.prisma, { projectId, moduleId, userId: actors.admin.id, code: 'TC-AUTH-001' })).id;
    runId = (
      await ctx.prisma.testRun.create({
        data: {
          projectId,
          name: 'Automated · main',
          type: RunType.AUTOMATED,
          status: RunStatus.COMPLETED,
          completedAt: new Date(),
          branch: 'main',
          createdById: actors.tester.id,
          triggeredById: actors.tester.id,
        },
      })
    ).id;
  });
  afterAll(async () => {
    await ctx.app.close();
    await fake.close();
  });

  const unlinked = (title: string, file: string | null = 'e2e/cart/cart.spec.ts') =>
    ctx.prisma.testResult.create({ data: { runId, title, file, status: 'PASSED' } });
  const createCase = (resultId: string, body: Record<string, unknown>, run = runId) =>
    ctx.http().post(`/api/runs/${run}/results/${resultId}/create-case`).set(actors.testerAuth).send(body);

  it('returns the CI job snippet for the project', async () => {
    const res = await ctx.http().get(`/api/projects/${projectId}/automation/ci-snippet`).set(actors.testerAuth).expect(200);
    expect(res.body).toEqual({ playwrightConfigPath: 'playwright.config.ts', yaml: ciSnippet() });
    expect(res.body.yaml).toContain("- if: '$EJAD_RUN_ID'");
  });

  it('creates a test case from an unlinked result and links the result to it', async () => {
    const result = await unlinked('cart/cart.spec.ts › adds an item to the cart');
    const res = await createCase(result.id, { moduleId }).expect(201);
    expect(res.body).toMatchObject({
      resultId: result.id,
      tag: '@TC-AUTH-002',
      testCase: {
        code: 'TC-AUTH-002',
        name: 'adds an item to the cart',
        notes: 'Created from automated test "cart/cart.spec.ts › adds an item to the cart" in e2e/cart/cart.spec.ts',
        module: { code: 'AUTH' },
        createdBy: { id: actors.tester.id, name: 'Tess Tester' },
      },
    });
    expect((await ctx.prisma.testResult.findUniqueOrThrow({ where: { id: result.id } })).testCaseId).toBe(res.body.testCase.id);

    const tagged = await unlinked('legacy › old checkout @TC-OLD-001', null);
    const custom = await createCase(tagged.id, { moduleId, name: 'Checkout works', priority: 'HIGH' }).expect(201);
    expect(custom.body.testCase).toMatchObject({ code: 'TC-AUTH-003', name: 'Checkout works', priority: 'HIGH', notes: 'Created from automated test "legacy › old checkout @TC-OLD-001"' });
  });

  it('refuses linked results, results of other runs and modules of other projects', async () => {
    const linked = await ctx.prisma.testResult.create({ data: { runId, testCaseId: caseId, status: 'PASSED' } });
    const already = await createCase(linked.id, { moduleId }).expect(409);
    expect(already.body.message).toBe('This result is already linked to a test case');

    const result = await unlinked('cart › adds an item');
    const foreignRun = await createCase(result.id, { moduleId }, '7a1d0c5e-0000-4000-8000-000000000000').expect(404);
    expect(foreignRun.body.message).toBe('Result not found in this run');

    const other = await seedProject(ctx.prisma, actors.admin.id, { key: 'OTHER' });
    const otherModule = await seedModule(ctx.prisma, other.id, { code: 'PAY', name: 'Payments' });
    const wrongModule = await createCase(result.id, { moduleId: otherModule.id }).expect(400);
    expect(wrongModule.body.message).toBe('moduleId does not belong to this project');
    expect((await ctx.prisma.testResult.findUniqueOrThrow({ where: { id: result.id } })).testCaseId).toBeNull();
  });
});
