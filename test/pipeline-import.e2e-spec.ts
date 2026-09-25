import { Logger } from '@nestjs/common';
import { ReviewState } from '@prisma/client';
import { PipelinePollerService } from '../src/modules/automated-runs/pipeline-poller.service';
import { FakeGitlab, FakeTestReport } from './utils/fake-gitlab';
import { seedActors, seedCase, seedModule } from './utils/factories';
import { createGitlabTestApp, seedGitlabConnection, seedLinkedProject, waitForRequests } from './utils/gitlab';
import { createTestApp, resetDb, TestContext } from './utils/test-app';

const REPORT: FakeTestReport = {
  total_count: 5,
  test_suites: [
    {
      name: 'chromium',
      test_cases: [
        {
          status: 'success',
          name: 'auth/login.spec.ts › logs in with valid credentials @TC-AUTH-001',
          classname: 'auth/login.spec.ts',
          file: 'e2e/auth/login.spec.ts',
          execution_time: 1.234,
        },
        {
          status: 'failed',
          name: 'auth/login.spec.ts › shows an error for a wrong password @TC-AUTH-002',
          classname: 'auth/login.spec.ts',
          file: 'e2e/auth/login.spec.ts',
          execution_time: 1,
          system_output: 'Error: expect(received).toBeVisible()',
          stack_trace: 'at e2e/auth/login.spec.ts:9:5',
        },
        {
          status: 'success',
          name: 'auth/login.spec.ts › remembers the user @TC-AUTH-002',
          classname: 'auth/login.spec.ts',
          file: 'e2e/auth/login.spec.ts',
          execution_time: 0.5,
        },
        {
          status: 'success',
          name: 'cart/cart.spec.ts › adds an item to the cart',
          classname: 'cart/cart.spec.ts',
          file: 'e2e/cart/cart.spec.ts',
          execution_time: 2,
        },
        { status: 'skipped', name: 'legacy › old checkout @TC-OLD-001', classname: 'legacy.spec.ts', file: null, execution_time: 0 },
      ],
    },
  ],
};

interface RunResult {
  id: string;
  title: string | null;
  testCaseId: string | null;
  testCase: { code: string } | null;
}

describe('Pipeline polling and result import (e2e)', () => {
  let ctx: TestContext;
  let fake: FakeGitlab;
  let actors: Awaited<ReturnType<typeof seedActors>>;
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
    const tess = await seedGitlabConnection(ctx, fake, actors.tester.id, { username: 'tess' });
    tessToken = tess.accessToken;
    projectId = (await seedLinkedProject(ctx, fake, actors.admin.id, [tess.gitlabUser])).project.id;
    const moduleId = (await seedModule(ctx.prisma, projectId)).id;
    caseIds = [];
    for (const code of ['TC-AUTH-001', 'TC-AUTH-002', 'TC-AUTH-003']) {
      caseIds.push((await seedCase(ctx.prisma, { projectId, moduleId, userId: actors.admin.id, code })).id);
    }
  });
  afterAll(async () => {
    await ctx.app.close();
    await fake.close();
  });

  const poll = () => ctx.app.get(PipelinePollerService).pollOnce();
  const trigger = async (scope: Record<string, unknown>) =>
    (await ctx.http().post(`/api/projects/${projectId}/runs/automated`).set(actors.testerAuth).send({ branch: 'main', scope }).expect(201))
      .body as { id: string; pipelineId: number };
  const detail = async (runId: string) => (await ctx.http().get(`/api/runs/${runId}`).set(actors.testerAuth).expect(200)).body;

  it('tracks the pipeline status with the triggering user token', async () => {
    const run = await trigger({ mode: 'ALL' });
    fake.setPipelineStatus(run.pipelineId, 'running');
    await poll();
    expect(await detail(run.id)).toMatchObject({ status: 'IN_PROGRESS', pipelineStatus: 'running' });
    expect(fake.requestsTo(`/pipelines/${run.pipelineId}`, 'GET')[0].token).toBe(tessToken);
  });

  it('imports the finished test report into results and completes the run', async () => {
    const run = await trigger({ mode: 'CASES', caseIds });
    fake.finishPipeline(run.pipelineId, 'failed', REPORT);
    await poll();

    const body = await detail(run.id);
    const artifacts = `${fake.url}/mobile/ninja-store/-/jobs/${500 + run.pipelineId}/artifacts/browse`;
    expect(body).toMatchObject({ status: 'COMPLETED', pipelineStatus: 'failed', note: null });
    expect(body.completedAt).not.toBeNull();
    expect(body.summary).toMatchObject({ total: 5, passed: 2, failed: 1, skipped: 1, notExecuted: 1 });

    const results = Object.fromEntries((body.results as RunResult[]).map((r) => [r.testCase?.code ?? r.title, r]));
    expect(results['TC-AUTH-001']).toMatchObject({
      status: 'PASSED',
      durationMs: 1234,
      file: 'e2e/auth/login.spec.ts',
      artifactsUrl: null,
      executedAt: '2026-09-18T10:00:00.000Z',
      executedBy: { id: actors.tester.id, name: 'Tess Tester' },
    });
    expect(results['TC-AUTH-002']).toMatchObject({
      status: 'FAILED',
      durationMs: 1500,
      errorMessage: 'Error: expect(received).toBeVisible()',
      errorStack: 'at e2e/auth/login.spec.ts:9:5',
      artifactsUrl: artifacts,
    });
    expect(results['TC-AUTH-003']).toMatchObject({ status: 'NOT_EXECUTED', notes: 'No automated test found', executedBy: null });
    expect(results['cart/cart.spec.ts › adds an item to the cart']).toMatchObject({
      testCaseId: null,
      testCase: null,
      status: 'PASSED',
      file: 'e2e/cart/cart.spec.ts',
    });
    expect(results['legacy › old checkout @TC-OLD-001']).toMatchObject({ testCaseId: null, status: 'SKIPPED', file: 'legacy.spec.ts' });

    // Imported runs are read-only and are not imported twice.
    await ctx.http().patch(`/api/runs/${run.id}/results/${results['TC-AUTH-003'].id}`).set(actors.testerAuth).send({ status: 'PASSED' }).expect(409);
    await poll();
    expect(await ctx.prisma.testResult.count({ where: { runId: run.id } })).toBe(5);
    expect(fake.requestsTo('/test_report')).toHaveLength(1);
  });

  it("does not map a draft case's @TC-… tag to a result: a draft has no tests and matches nothing on import", async () => {
    const draftCode = 'TC-AUTH-004';
    await seedCase(ctx.prisma, {
      projectId,
      moduleId: (await ctx.prisma.testCase.findUniqueOrThrow({ where: { id: caseIds[0] } })).moduleId,
      userId: actors.admin.id,
      code: draftCode,
      reviewState: ReviewState.AI_DRAFT,
    });
    const draftReport: FakeTestReport = {
      total_count: 1,
      test_suites: [
        {
          name: 'chromium',
          test_cases: [
            {
              status: 'success',
              name: `auth/login.spec.ts › a draft-only scenario @${draftCode}`,
              classname: 'auth/login.spec.ts',
              file: 'e2e/auth/login.spec.ts',
              execution_time: 1,
            },
          ],
        },
      ],
    };

    const run = await trigger({ mode: 'ALL' });
    fake.finishPipeline(run.pipelineId, 'success', draftReport);
    await poll();

    const body = await detail(run.id);
    expect(body.results).toHaveLength(1);
    // The tag resolves against APPROVED_CASE only, so the draft's code is never in the lookup
    // map: the result comes back unlinked (by its full test title) instead of attached to the
    // draft's id.
    expect(body.results[0]).toMatchObject({
      testCaseId: null,
      testCase: null,
      title: `auth/login.spec.ts › a draft-only scenario @${draftCode}`,
      status: 'PASSED',
    });
  });

  it('completes the run with a note when the pipeline has no test report', async () => {
    const run = await trigger({ mode: 'ALL' });
    fake.finishPipeline(run.pipelineId, 'failed', null);
    await poll();
    expect(await detail(run.id)).toMatchObject({
      status: 'COMPLETED',
      pipelineStatus: 'failed',
      note: `Pipeline finished without a test report – ${fake.url}/mobile/ninja-store/-/jobs/${500 + run.pipelineId}`,
      results: [],
    });
  });

  it('times out runs that GitLab never finishes', async () => {
    const run = await trigger({ mode: 'ALL' });
    fake.setPipelineStatus(run.pipelineId, 'running');
    await ctx.prisma.testRun.update({ where: { id: run.id }, data: { startedAt: new Date(Date.now() - 3 * 3_600_000) } });
    await poll();
    expect(await detail(run.id)).toMatchObject({ status: 'COMPLETED', note: 'Timed out waiting for GitLab' });
    // The pipeline is fetched even past the timeout (so a finished one is still imported); it's
    // only actually treated as timed out once GitLab confirms it is still not final.
    expect(fake.requestsTo(`/pipelines/${run.pipelineId}`, 'GET').length).toBeGreaterThan(0);
  });

  it('imports a pipeline that already finished, even past the run timeout', async () => {
    const run = await trigger({ mode: 'ALL' });
    fake.finishPipeline(run.pipelineId, 'success', REPORT);
    await ctx.prisma.testRun.update({ where: { id: run.id }, data: { startedAt: new Date(Date.now() - 3 * 3_600_000) } });
    await poll();
    const body = await detail(run.id);
    expect(body).toMatchObject({ status: 'COMPLETED', pipelineStatus: 'success' });
    expect(body.note).toBeNull();
  });

  it('closes the run when GitLab no longer has the pipeline', async () => {
    const run = await trigger({ mode: 'ALL' });
    fake.pipelines = fake.pipelines.filter((p) => p.id !== run.pipelineId);
    await poll();
    expect(await detail(run.id)).toMatchObject({ status: 'COMPLETED', note: 'The pipeline no longer exists in GitLab' });
  });

  it('closes a run stuck with no pipeline id after a couple of minutes, but gives it a grace period first', async () => {
    const stuck = await ctx.prisma.testRun.create({
      data: {
        projectId,
        name: 'Automated · stuck',
        type: 'AUTOMATED',
        branch: 'main',
        triggeredById: actors.tester.id,
        createdById: actors.tester.id,
        startedAt: new Date(Date.now() - 30_000),
      },
    });
    await poll();
    // Too recent to give up on yet: still IN_PROGRESS, and GitLab was never even asked.
    expect((await detail(stuck.id)).status).toBe('IN_PROGRESS');
    expect(fake.requests).toHaveLength(0);

    await ctx.prisma.testRun.update({ where: { id: stuck.id }, data: { startedAt: new Date(Date.now() - 3 * 60_000) } });
    await poll();
    expect(await detail(stuck.id)).toMatchObject({ status: 'COMPLETED', note: 'The pipeline could not be confirmed as started' });
  });

  it('pauses polling while the triggering user must reconnect', async () => {
    const run = await trigger({ mode: 'ALL' });
    fake.finishPipeline(run.pipelineId, 'success', REPORT);
    await ctx.prisma.gitlabConnection.update({ where: { userId: actors.tester.id }, data: { state: 'NEEDS_RECONNECT' } });
    await poll();
    expect((await detail(run.id)).status).toBe('IN_PROGRESS');
    expect(fake.requestsTo(`/pipelines/${run.pipelineId}`, 'GET')).toHaveLength(0);

    await ctx.prisma.gitlabConnection.update({ where: { userId: actors.tester.id }, data: { state: 'ACTIVE' } });
    await poll();
    expect((await detail(run.id)).status).toBe('COMPLETED');
  });

  it('closes a run past the run timeout instead of pausing it forever when the tester needs to reconnect', async () => {
    const run = await trigger({ mode: 'ALL' });
    fake.finishPipeline(run.pipelineId, 'success', REPORT);
    await ctx.prisma.gitlabConnection.update({ where: { userId: actors.tester.id }, data: { state: 'NEEDS_RECONNECT' } });
    await ctx.prisma.testRun.update({ where: { id: run.id }, data: { startedAt: new Date(Date.now() - 3 * 3_600_000) } });
    await poll();
    expect(await detail(run.id)).toMatchObject({
      status: 'COMPLETED',
      note: "Timed out waiting for GitLab (the tester's GitLab connection needs to be reconnected)",
    });
    expect(fake.requestsTo(`/pipelines/${run.pipelineId}`, 'GET')).toHaveLength(0);
  });

  it('closing the app while a poll is in flight waits for it, without logging an error', async () => {
    const run = await trigger({ mode: 'ALL' });
    const release = fake.holdPipelineRequests();
    const second = await createTestApp({ GITLAB_URL: fake.url });
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const pollPromise = second.app.get(PipelinePollerService).pollOnce();
      await waitForRequests(fake, `/pipelines/${run.pipelineId}`, 1);

      let closed = false;
      const closePromise = second.app.close().then(() => {
        closed = true;
      });
      // Give close() a chance to run: it must still be waiting on the in-flight poll.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(closed).toBe(false);

      release();
      await Promise.all([pollPromise, closePromise]);
      expect(closed).toBe(true);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      release();
      errorSpy.mockRestore();
      await second.app.close().catch(() => {});
    }
  });

  it('runs the polling interval only when it is enabled, and stops it cleanly on shutdown', async () => {
    expect(ctx.app.get(PipelinePollerService).isPolling()).toBe(false);
    const polling = await createTestApp({ GITLAB_URL: fake.url, GITLAB_POLL_INTERVAL_MS: '20000' });
    try {
      expect(polling.app.get(PipelinePollerService).isPolling()).toBe(true);
    } finally {
      await polling.app.close();
      expect(polling.app.get(PipelinePollerService).isPolling()).toBe(false);
    }
  });
});
