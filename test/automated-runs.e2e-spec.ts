import { FakeGitlab, FakeUser } from './utils/fake-gitlab';
import { seedActors, seedCase, seedModule } from './utils/factories';
import { createGitlabTestApp, GITLAB_PROJECT_ID as P, seedGitlabConnection, seedLinkedProject } from './utils/gitlab';
import { resetDb, TestContext } from './utils/test-app';

describe('Automated runs (e2e)', () => {
  let ctx: TestContext;
  let fake: FakeGitlab;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let tess: FakeUser;
  let projectId: string;
  let caseIds: string[];

  beforeAll(async () => {
    ({ ctx, fake } = await createGitlabTestApp());
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    fake.reset();
    actors = await seedActors(ctx);
    tess = (await seedGitlabConnection(ctx, fake, actors.tester.id, { username: 'tess' })).gitlabUser;
    projectId = (await seedLinkedProject(ctx, fake, actors.admin.id, [tess])).project.id;
    const moduleId = (await seedModule(ctx.prisma, projectId)).id;
    caseIds = [
      (await seedCase(ctx.prisma, { projectId, moduleId, userId: actors.admin.id, code: 'TC-AUTH-001' })).id,
      (await seedCase(ctx.prisma, { projectId, moduleId, userId: actors.admin.id, code: 'TC-AUTH-002' })).id,
    ];
  });
  afterAll(async () => {
    await ctx.app.close();
    await fake.close();
  });

  const trigger = (body: Record<string, unknown>, auth = actors.testerAuth) =>
    ctx.http().post(`/api/projects/${projectId}/runs/automated`).set(auth).send(body);

  it('starts a pipeline as the user for all tests', async () => {
    const res = await trigger({ branch: 'main', scope: { mode: 'ALL' } }).expect(201);
    const [pipeline] = fake.pipelines;
    expect(res.body).toMatchObject({
      type: 'AUTOMATED',
      status: 'IN_PROGRESS',
      branch: 'main',
      triggeredById: actors.tester.id,
      triggeredBy: { id: actors.tester.id, name: 'Tess Tester' },
      pipelineId: pipeline.id,
      pipelineWebUrl: `${fake.url}/mobile/ninja-store/-/pipelines/${pipeline.id}`,
      pipelineStatus: 'created',
      note: null,
      results: [],
    });
    expect(res.body.name).toMatch(/^Automated · main · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(pipeline).toMatchObject({ project_id: P, ref: 'main', userId: tess.id, variables: { EJAD_RUN_ID: res.body.id } });
  });

  it('scopes a run to a folder or file inside the tests folder', async () => {
    const res = await trigger({ branch: 'main', name: 'Auth only', scope: { mode: 'PATH', path: 'e2e/auth' } }).expect(201);
    expect(res.body.name).toBe('Auth only');
    expect(fake.pipelines[0].variables).toEqual({ EJAD_RUN_ID: res.body.id, EJAD_TEST_PATH: 'e2e/auth' });

    const outside = await trigger({ branch: 'main', scope: { mode: 'PATH', path: 'src' } }).expect(400);
    expect(outside.body.message).toBe('Path must be inside the tests folder "e2e"');
    const missing = await trigger({ branch: 'main', scope: { mode: 'PATH' } }).expect(400);
    expect(missing.body.message).toBe('scope.path is required for mode PATH');
    expect(await ctx.prisma.testRun.count()).toBe(1);
  });

  it('scopes a run to selected cases with a grep and pre-created results', async () => {
    const res = await trigger({ branch: 'main', scope: { mode: 'CASES', caseIds: [caseIds[1], caseIds[0]] } }).expect(201);
    expect(fake.pipelines[0].variables).toEqual({ EJAD_RUN_ID: res.body.id, EJAD_TEST_GREP: '@TC-AUTH-001\\b|@TC-AUTH-002\\b' });
    expect(res.body.summary).toMatchObject({ total: 2, notExecuted: 2 });
    expect(res.body.results.map((r: { testCase: { code: string } }) => r.testCase.code)).toEqual(['TC-AUTH-001', 'TC-AUTH-002']);

    const missing = await trigger({ branch: 'main', scope: { mode: 'CASES' } }).expect(400);
    expect(missing.body.message).toBe('scope.caseIds is required for mode CASES');
    const foreign = await trigger({ branch: 'main', scope: { mode: 'CASES', caseIds: ['7a1d0c5e-0000-4000-8000-000000000000'] } }).expect(400);
    expect(foreign.body.message).toBe('Some selected test cases do not exist in this project');
    await trigger({ branch: 'bad branch', scope: { mode: 'ALL' } }).expect(400);
  });

  it("closes the run with GitLab's message when the pipeline cannot be created", async () => {
    fake.projects.get(P)!.ciEnabled = false;
    const res = await trigger({ branch: 'main', scope: { mode: 'ALL' } }).expect(201);
    expect(res.body).toMatchObject({
      status: 'COMPLETED',
      pipelineId: null,
      note: 'GitLab could not start the pipeline: Pipeline will not run for the selected trigger. The rules configuration prevented any jobs from being added to the pipeline.',
    });
    expect(res.body.completedAt).not.toBeNull();
  });

  it('requires a GitLab connection before creating a run', async () => {
    const res = await trigger({ branch: 'main', scope: { mode: 'ALL' } }, actors.adminAuth).expect(403);
    expect(res.body.details).toEqual({ code: 'GITLAB_NOT_CONNECTED' });
    expect(await ctx.prisma.testRun.count()).toBe(0);
    expect(fake.pipelines).toHaveLength(0);
  });
});
