import { Logger } from '@nestjs/common';
import { FakeGitlab, FakeUser } from './utils/fake-gitlab';
import { seedActors, seedCase, seedModule } from './utils/factories';
import { createGitlabTestApp, GITLAB_PROJECT_ID as P, seedGitlabConnection, seedLinkedProject } from './utils/gitlab';
import { createTestApp, resetDb, TestContext } from './utils/test-app';

describe('Automated runs (e2e)', () => {
  let ctx: TestContext;
  let fake: FakeGitlab;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let tess: FakeUser;
  let tessToken: string;
  let projectId: string;
  let caseIds: string[];

  beforeAll(async () => {
    ({ ctx, fake } = await createGitlabTestApp());
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    fake.reset();
    actors = await seedActors(ctx);
    const connection = await seedGitlabConnection(ctx, fake, actors.tester.id, { username: 'tess' });
    tess = connection.gitlabUser;
    tessToken = connection.accessToken;
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
    expect(pipeline).toMatchObject({ project_id: P, ref: 'main', userId: tess.id });
    expect(pipeline.variables).toEqual({ EJAD_RUN_ID: res.body.id });
  });

  it('scopes a run to a folder or file inside the tests folder', async () => {
    const res = await trigger({ branch: 'main', name: 'Auth only', scope: { mode: 'PATH', path: 'e2e/auth' } }).expect(201);
    expect(res.body.name).toBe('Auth only');
    expect(fake.pipelines[0].variables).toEqual({ EJAD_RUN_ID: res.body.id, EJAD_TEST_PATH: 'e2e/auth' });

    const outside = await trigger({ branch: 'main', scope: { mode: 'PATH', path: 'src' } }).expect(400);
    expect(outside.body.message).toBe('Path must be inside the tests folder "e2e"');
    const missing = await trigger({ branch: 'main', scope: { mode: 'PATH' } }).expect(400);
    expect(missing.body.message).toBe('scope.path is required for mode PATH');
    const unsafe = await trigger({ branch: 'main', scope: { mode: 'PATH', path: 'e2e/auth *.ts' } }).expect(400);
    expect(unsafe.body.message).toBe("Test paths can't contain spaces or special characters");
    expect(await ctx.prisma.testRun.count()).toBe(1);
  });

  it('scopes a run to selected cases with a grep and pre-created results', async () => {
    const res = await trigger({ branch: 'main', scope: { mode: 'CASES', caseIds: [caseIds[1], caseIds[0]] } }).expect(201);
    expect(fake.pipelines[0].variables).toEqual({
      EJAD_RUN_ID: res.body.id,
      EJAD_TEST_GREP: '@TC-AUTH-001(?![A-Za-z0-9])|@TC-AUTH-002(?![A-Za-z0-9])',
    });
    expect(res.body.summary).toMatchObject({ total: 2, notExecuted: 2 });
    expect(res.body.results.map((r: { testCase: { code: string } }) => r.testCase.code)).toEqual(['TC-AUTH-001', 'TC-AUTH-002']);

    const missing = await trigger({ branch: 'main', scope: { mode: 'CASES' } }).expect(400);
    expect(missing.body.message).toBe('scope.caseIds is required for mode CASES');
    const foreign = await trigger({ branch: 'main', scope: { mode: 'CASES', caseIds: ['7a1d0c5e-0000-4000-8000-000000000000'] } }).expect(400);
    expect(foreign.body.message).toBe('Some selected test cases do not exist in this project');
    await trigger({ branch: 'bad branch', scope: { mode: 'ALL' } }).expect(400);
  });

  it('deduplicates repeated case ids in a CASES scope', async () => {
    const res = await trigger({ branch: 'main', scope: { mode: 'CASES', caseIds: [caseIds[0], caseIds[0], caseIds[1]] } }).expect(201);
    expect(res.body.results).toHaveLength(2);
    expect(fake.pipelines[0].variables).toEqual({
      EJAD_RUN_ID: res.body.id,
      EJAD_TEST_GREP: '@TC-AUTH-001(?![A-Za-z0-9])|@TC-AUTH-002(?![A-Za-z0-9])',
    });
  });

  it('rejects a CASES scope that includes a soft-deleted case', async () => {
    await ctx.prisma.testCase.update({ where: { id: caseIds[0] }, data: { deletedAt: new Date() } });
    const res = await trigger({ branch: 'main', scope: { mode: 'CASES', caseIds: [caseIds[0], caseIds[1]] } }).expect(400);
    expect(res.body.message).toBe('Some selected test cases do not exist in this project');
    expect(await ctx.prisma.testRun.count()).toBe(0);
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

  it('closes the run and asks the user to reconnect when GitLab answers 401 while creating the pipeline', async () => {
    fake.tokens.delete(tessToken);

    const res = await trigger({ branch: 'main', scope: { mode: 'ALL' } }).expect(403);
    expect(res.body.details).toEqual({ code: 'GITLAB_NEEDS_RECONNECT' });
    expect(res.body.message).toBe('Your GitLab connection expired – reconnect GitLab to continue');

    const run = await ctx.prisma.testRun.findFirstOrThrow({ where: { projectId } });
    expect(run).toMatchObject({ status: 'COMPLETED', pipelineId: null });
    expect(run.note).toMatch(/^GitLab could not start the pipeline: /);
    const conn = await ctx.prisma.gitlabConnection.findUniqueOrThrow({ where: { userId: actors.tester.id } });
    expect(conn.state).toBe('NEEDS_RECONNECT');
  });

  it("notes that GitLab may still have started the pipeline on a 5xx from createPipeline", async () => {
    fake.breakNextPipelineCreate(503, { message: 'Undergoing maintenance' });
    const res = await trigger({ branch: 'main', scope: { mode: 'ALL' } }).expect(201);
    expect(res.body).toMatchObject({
      status: 'COMPLETED',
      pipelineId: null,
      note: "GitLab didn't confirm the pipeline (Undergoing maintenance) – it may still have started; check GitLab",
    });
  });

  it("notes that GitLab may still have started the pipeline when createPipeline times out (status 0)", async () => {
    const release = fake.holdPipelineCreateRequests();
    const shortTimeout = await createTestApp({ GITLAB_URL: fake.url, GITLAB_REQUEST_TIMEOUT_MS: '50' });
    try {
      const res = await shortTimeout
        .http()
        .post(`/api/projects/${projectId}/runs/automated`)
        .set(actors.testerAuth)
        .send({ branch: 'main', scope: { mode: 'ALL' } });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('COMPLETED');
      expect(res.body.pipelineId).toBeNull();
      expect(res.body.note).toMatch(/^GitLab didn't confirm the pipeline \(GitLab is unreachable/);
      expect(res.body.note).toMatch(/it may still have started; check GitLab$/);
    } finally {
      release();
      await shortTimeout.app.close();
    }
  });

  it('retries the pipeline-id save once and keeps the run IN_PROGRESS once it recovers', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const updateSpy = jest
      .spyOn(ctx.prisma.testRun, 'update')
      .mockImplementationOnce(() => Promise.reject(new Error('connection reset')) as never);
    try {
      const res = await trigger({ branch: 'main', scope: { mode: 'ALL' } }).expect(201);
      expect(res.body.status).toBe('IN_PROGRESS');
      expect(res.body.pipelineId).not.toBeNull();
      expect(res.body.pipelineWebUrl).not.toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('connection reset'));
      expect(updateSpy).toHaveBeenCalledTimes(2);
    } finally {
      updateSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('requires a GitLab connection before creating a run', async () => {
    const res = await trigger({ branch: 'main', scope: { mode: 'ALL' } }, actors.adminAuth).expect(403);
    expect(res.body.details).toEqual({ code: 'GITLAB_NOT_CONNECTED' });
    expect(await ctx.prisma.testRun.count()).toBe(0);
    expect(fake.pipelines).toHaveLength(0);
  });

  it('requires the project to be linked to GitLab', async () => {
    const unlinked = await ctx.prisma.project.create({ data: { key: 'UNL', name: 'Unlinked', createdById: actors.admin.id } });
    const res = await ctx
      .http()
      .post(`/api/projects/${unlinked.id}/runs/automated`)
      .set(actors.testerAuth)
      .send({ branch: 'main', scope: { mode: 'ALL' } });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Project is not linked to a GitLab repository');
  });
});
