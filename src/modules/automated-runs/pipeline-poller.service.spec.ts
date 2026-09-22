import { BadGatewayException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { PipelinePollerService } from './pipeline-poller.service';

const CFG = { enabled: true, pollIntervalMs: 20_000, runTimeoutMs: 7_200_000 };

interface Fakes {
  prisma: {
    testRun: { findMany: jest.Mock; update: jest.Mock };
    gitlabConnection: { findUnique: jest.Mock };
  };
  config: { getOrThrow: () => typeof CFG };
  gitlab: { withToken: jest.Mock };
  api: { getPipeline: jest.Mock; listPipelineJobs: jest.Mock };
  importer: { close: jest.Mock; importPipeline: jest.Mock };
}

function makeRun(overrides: Partial<{ id: string; startedAt: Date; pipelineId: number | null; pipelineStatus: string | null; triggeredById: string | null; gitlabProjectId: number | null }> = {}) {
  // `?? ` would treat an explicit `null` (e.g. pipelineId: null, the stuck-run case) as "not given"
  // and replace it with the default, so every field is spread from a defaults object instead.
  return {
    id: 'r1',
    startedAt: new Date(),
    pipelineId: 42,
    pipelineStatus: 'running',
    triggeredById: 'u1',
    ...overrides,
    project: { gitlabProjectId: 'gitlabProjectId' in overrides ? overrides.gitlabProjectId! : 7 },
  };
}

function makePipeline(overrides: Partial<{ id: number; status: string; finishedAt: string | null }> = {}) {
  return { id: overrides.id ?? 42, status: overrides.status ?? 'running', ref: 'main', webUrl: 'https://git.test/x', finishedAt: overrides.finishedAt ?? null };
}

function makeService(overrides: Partial<Fakes> = {}): { service: PipelinePollerService } & Fakes {
  const prisma = overrides.prisma ?? {
    testRun: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
    gitlabConnection: { findUnique: jest.fn().mockResolvedValue({ state: 'ACTIVE' }) },
  };
  const config = overrides.config ?? { getOrThrow: () => CFG };
  const gitlab = overrides.gitlab ?? { withToken: jest.fn((_userId: string, fn: (token: string) => unknown) => fn('tok')) };
  const api = overrides.api ?? { getPipeline: jest.fn().mockResolvedValue(makePipeline()), listPipelineJobs: jest.fn().mockResolvedValue([]) };
  const importer = overrides.importer ?? { close: jest.fn(), importPipeline: jest.fn() };
  const service = new PipelinePollerService(prisma as never, config as never, gitlab as never, api as never, importer as never);
  return { service, prisma, config, gitlab, api, importer };
}

describe('PipelinePollerService', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('resolves cleanly and logs a one-line warning when the run query fails, and still polls on the next call', async () => {
    const findMany = jest.fn().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce([]);
    const { service } = makeService({ prisma: { testRun: { findMany, update: jest.fn() }, gitlabConnection: { findUnique: jest.fn() } } });

    await expect(service.pollOnce()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('connection lost'));
    expect(errorSpy).not.toHaveBeenCalled();

    await expect(service.pollOnce()).resolves.toBeUndefined();
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('does not start a second pass while one is already running', async () => {
    let release!: (v: unknown[]) => void;
    const findMany = jest.fn(() => new Promise((resolve) => (release = resolve)));
    const { service } = makeService({ prisma: { testRun: { findMany, update: jest.fn() }, gitlabConnection: { findUnique: jest.fn() } } });

    const first = service.pollOnce();
    const second = service.pollOnce();
    release([]);
    await Promise.all([first, second]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('keeps polling the remaining runs when one of them throws', async () => {
    const runs = [makeRun({ id: 'r1' }), makeRun({ id: 'r2' })];
    const findMany = jest.fn().mockResolvedValue(runs);
    const getPipeline = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(makePipeline());
    const { service } = makeService({
      prisma: { testRun: { findMany, update: jest.fn() }, gitlabConnection: { findUnique: jest.fn().mockResolvedValue({ state: 'ACTIVE' }) } },
      api: { getPipeline, listPipelineJobs: jest.fn().mockResolvedValue([]) },
    });

    await service.pollOnce();
    expect(getPipeline).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('r1'));
  });

  it('skips a run whose triggering user has no GitLab connection row at all', async () => {
    const findMany = jest.fn().mockResolvedValue([makeRun({})]);
    const findUnique = jest.fn().mockResolvedValue(null);
    const getPipeline = jest.fn();
    const close = jest.fn();
    const { service } = makeService({
      prisma: { testRun: { findMany, update: jest.fn() }, gitlabConnection: { findUnique } },
      api: { getPipeline, listPipelineJobs: jest.fn() },
      importer: { close, importPipeline: jest.fn() },
    });

    await service.pollOnce();
    expect(getPipeline).not.toHaveBeenCalled();
    // Not past the run timeout yet: still just paused, not closed.
    expect(close).not.toHaveBeenCalled();
  });

  it('closes a disconnected user’s run once it is past the run timeout, instead of leaving it stuck forever', async () => {
    const findMany = jest.fn().mockResolvedValue([makeRun({ startedAt: new Date(Date.now() - 999_999_999) })]);
    const findUnique = jest.fn().mockResolvedValue(null);
    const getPipeline = jest.fn();
    const close = jest.fn();
    const { service } = makeService({
      prisma: { testRun: { findMany, update: jest.fn() }, gitlabConnection: { findUnique } },
      api: { getPipeline, listPipelineJobs: jest.fn() },
      importer: { close, importPipeline: jest.fn() },
    });

    await service.pollOnce();
    expect(getPipeline).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith('r1', "Timed out waiting for GitLab (the tester's GitLab connection needs to be reconnected)");
  });

  it('closes a NEEDS_RECONNECT run once it is past the run timeout', async () => {
    const findMany = jest.fn().mockResolvedValue([makeRun({ startedAt: new Date(Date.now() - 999_999_999) })]);
    const findUnique = jest.fn().mockResolvedValue({ state: 'NEEDS_RECONNECT' });
    const getPipeline = jest.fn();
    const close = jest.fn();
    const { service } = makeService({
      prisma: { testRun: { findMany, update: jest.fn() }, gitlabConnection: { findUnique } },
      api: { getPipeline, listPipelineJobs: jest.fn() },
      importer: { close, importPipeline: jest.fn() },
    });

    await service.pollOnce();
    expect(getPipeline).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith('r1', "Timed out waiting for GitLab (the tester's GitLab connection needs to be reconnected)");
  });

  it('closes a run once it is past the run timeout after a persistent 403 from GitLab', async () => {
    const findMany = jest.fn().mockResolvedValue([makeRun({ startedAt: new Date(Date.now() - 999_999_999) })]);
    const getPipeline = jest.fn().mockRejectedValue(new ForbiddenException('reconnect'));
    const close = jest.fn();
    const { service } = makeService({
      prisma: { testRun: { findMany, update: jest.fn() }, gitlabConnection: { findUnique: jest.fn().mockResolvedValue({ state: 'ACTIVE' }) } },
      api: { getPipeline, listPipelineJobs: jest.fn() },
      importer: { close, importPipeline: jest.fn() },
    });

    await service.pollOnce();
    // Once past the timeout, the failure itself closes the run (with the generic timeout note)
    // instead of being rethrown to just log a warning and try again next pass.
    expect(close).toHaveBeenCalledWith('r1', 'Timed out waiting for GitLab');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('leaves a run with a persistent 403 merely paused (not closed) while still under the run timeout', async () => {
    const findMany = jest.fn().mockResolvedValue([makeRun({})]);
    const getPipeline = jest.fn().mockRejectedValue(new ForbiddenException('reconnect'));
    const close = jest.fn();
    const { service } = makeService({
      prisma: { testRun: { findMany, update: jest.fn() }, gitlabConnection: { findUnique: jest.fn().mockResolvedValue({ state: 'ACTIVE' }) } },
      api: { getPipeline, listPipelineJobs: jest.fn() },
      importer: { close, importPipeline: jest.fn() },
    });

    await service.pollOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it.each(['success', 'failed', 'canceled', 'skipped'])('imports once the pipeline reaches a final status (%s)', async (status) => {
    const findMany = jest.fn().mockResolvedValue([makeRun({})]);
    const getPipeline = jest.fn().mockResolvedValue(makePipeline({ status }));
    const importPipeline = jest.fn();
    const { service } = makeService({
      prisma: { testRun: { findMany, update: jest.fn() }, gitlabConnection: { findUnique: jest.fn().mockResolvedValue({ state: 'ACTIVE' }) } },
      api: { getPipeline, listPipelineJobs: jest.fn().mockResolvedValue([]) },
      importer: { close: jest.fn(), importPipeline },
    });

    await service.pollOnce();
    expect(importPipeline).toHaveBeenCalledWith('tok', 'r1', expect.objectContaining({ status }));
  });

  it('treats the run as final once the ejad-playwright job itself finishes, even if the pipeline is still manual/blocked', async () => {
    const findMany = jest.fn().mockResolvedValue([makeRun({})]);
    const getPipeline = jest.fn().mockResolvedValue(makePipeline({ status: 'manual' }));
    const listPipelineJobs = jest.fn().mockResolvedValue([
      { id: 1, name: 'deploy', status: 'manual', webUrl: 'x' },
      { id: 2, name: 'ejad-playwright', status: 'success', webUrl: 'x' },
    ]);
    const importPipeline = jest.fn();
    const { service } = makeService({
      prisma: { testRun: { findMany, update: jest.fn() }, gitlabConnection: { findUnique: jest.fn().mockResolvedValue({ state: 'ACTIVE' }) } },
      api: { getPipeline, listPipelineJobs },
      importer: { close: jest.fn(), importPipeline },
    });

    await service.pollOnce();
    // Stores the job's own final status ('success'), not the pipeline's still-manual one.
    expect(importPipeline).toHaveBeenCalledWith('tok', 'r1', expect.objectContaining({ status: 'success' }));
  });

  it('treats the run as not-yet-final when there is no ejad-playwright job at all, instead of guessing from some other job', async () => {
    const findMany = jest.fn().mockResolvedValue([makeRun({ pipelineStatus: 'manual' })]);
    const getPipeline = jest.fn().mockResolvedValue(makePipeline({ status: 'manual' }));
    // Only unrelated jobs, all of them final — a naive "first job" fallback would wrongly treat
    // this pipeline as done.
    const listPipelineJobs = jest.fn().mockResolvedValue([{ id: 1, name: 'deploy', status: 'success', webUrl: 'x' }]);
    const importPipeline = jest.fn();
    const update = jest.fn();
    const { service } = makeService({
      prisma: { testRun: { findMany, update }, gitlabConnection: { findUnique: jest.fn().mockResolvedValue({ state: 'ACTIVE' }) } },
      api: { getPipeline, listPipelineJobs },
      importer: { close: jest.fn(), importPipeline },
    });

    await service.pollOnce();
    expect(importPipeline).not.toHaveBeenCalled();
  });

  it('does not treat the run as final while the ejad-playwright job is still running and the pipeline is manual/blocked', async () => {
    const findMany = jest.fn().mockResolvedValue([makeRun({ pipelineStatus: 'manual' })]);
    const getPipeline = jest.fn().mockResolvedValue(makePipeline({ status: 'manual' }));
    const listPipelineJobs = jest.fn().mockResolvedValue([{ id: 2, name: 'ejad-playwright', status: 'running', webUrl: 'x' }]);
    const importPipeline = jest.fn();
    const update = jest.fn();
    const { service } = makeService({
      prisma: { testRun: { findMany, update }, gitlabConnection: { findUnique: jest.fn().mockResolvedValue({ state: 'ACTIVE' }) } },
      api: { getPipeline, listPipelineJobs },
      importer: { close: jest.fn(), importPipeline },
    });

    await service.pollOnce();
    expect(importPipeline).not.toHaveBeenCalled();
  });

  it('closes the run when GitLab no longer has the pipeline (404)', async () => {
    const findMany = jest.fn().mockResolvedValue([makeRun({})]);
    const getPipeline = jest.fn().mockRejectedValue(new NotFoundException('404 Not found'));
    const close = jest.fn();
    const { service } = makeService({
      prisma: { testRun: { findMany, update: jest.fn() }, gitlabConnection: { findUnique: jest.fn().mockResolvedValue({ state: 'ACTIVE' }) } },
      api: { getPipeline, listPipelineJobs: jest.fn() },
      importer: { close, importPipeline: jest.fn() },
    });

    await service.pollOnce();
    expect(close).toHaveBeenCalledWith('r1', 'The pipeline no longer exists in GitLab');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs a one-line warning (not an error) for a non-404 HttpException while polling a run', async () => {
    const findMany = jest.fn().mockResolvedValue([makeRun({})]);
    const getPipeline = jest.fn().mockRejectedValue(new ForbiddenException('reconnect'));
    const { service } = makeService({
      prisma: { testRun: { findMany, update: jest.fn() }, gitlabConnection: { findUnique: jest.fn().mockResolvedValue({ state: 'ACTIVE' }) } },
      api: { getPipeline, listPipelineJobs: jest.fn() },
    });

    await service.pollOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reconnect'));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('still only warns (not errors) for a 5xx HttpException such as BadGatewayException', async () => {
    const findMany = jest.fn().mockResolvedValue([makeRun({})]);
    const getPipeline = jest.fn().mockRejectedValue(new BadGatewayException('GitLab request failed'));
    const { service } = makeService({
      prisma: { testRun: { findMany, update: jest.fn() }, gitlabConnection: { findUnique: jest.fn().mockResolvedValue({ state: 'ACTIVE' }) } },
      api: { getPipeline, listPipelineJobs: jest.fn() },
    });

    await service.pollOnce();
    // BadGatewayException is still an HttpException, so it's a warning, not an error.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GitLab request failed'));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('imports a pipeline that already finished, even past the run timeout', async () => {
    const findMany = jest.fn().mockResolvedValue([makeRun({ startedAt: new Date(Date.now() - 999_999_999) })]);
    const getPipeline = jest.fn().mockResolvedValue(makePipeline({ status: 'success' }));
    const importPipeline = jest.fn();
    const close = jest.fn();
    const { service } = makeService({
      prisma: { testRun: { findMany, update: jest.fn() }, gitlabConnection: { findUnique: jest.fn().mockResolvedValue({ state: 'ACTIVE' }) } },
      api: { getPipeline, listPipelineJobs: jest.fn().mockResolvedValue([]) },
      importer: { close, importPipeline },
    });

    await service.pollOnce();
    expect(importPipeline).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('closes as timed out only when the pipeline is still not final past the run timeout', async () => {
    const findMany = jest.fn().mockResolvedValue([makeRun({ startedAt: new Date(Date.now() - 999_999_999) })]);
    const getPipeline = jest.fn().mockResolvedValue(makePipeline({ status: 'running' }));
    const close = jest.fn();
    const { service } = makeService({
      prisma: { testRun: { findMany, update: jest.fn() }, gitlabConnection: { findUnique: jest.fn().mockResolvedValue({ state: 'ACTIVE' }) } },
      api: { getPipeline, listPipelineJobs: jest.fn().mockResolvedValue([]) },
      importer: { close, importPipeline: jest.fn() },
    });

    await service.pollOnce();
    expect(close).toHaveBeenCalledWith('r1', 'Timed out waiting for GitLab');
  });

  it('closes a run stuck with no pipeline id after the grace period, and leaves a fresher one alone', async () => {
    const stuckOld = makeRun({ id: 'old', pipelineId: null, startedAt: new Date(Date.now() - 3 * 60_000) });
    const stuckFresh = makeRun({ id: 'fresh', pipelineId: null, startedAt: new Date(Date.now() - 5_000) });
    const findMany = jest.fn().mockResolvedValue([stuckOld, stuckFresh]);
    const getPipeline = jest.fn();
    const close = jest.fn();
    const { service } = makeService({
      prisma: { testRun: { findMany, update: jest.fn() }, gitlabConnection: { findUnique: jest.fn() } },
      api: { getPipeline, listPipelineJobs: jest.fn() },
      importer: { close, importPipeline: jest.fn() },
    });

    await service.pollOnce();
    expect(getPipeline).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith('old', 'The pipeline could not be confirmed as started');
  });

  it('onModuleDestroy clears the interval and awaits any in-flight pollOnce before resolving', async () => {
    let releaseFindMany!: (v: unknown[]) => void;
    const findMany = jest.fn(() => new Promise((resolve) => (releaseFindMany = resolve)));
    const { service } = makeService({ prisma: { testRun: { findMany, update: jest.fn() }, gitlabConnection: { findUnique: jest.fn() } } });

    service.onApplicationBootstrap();
    expect(service.isPolling()).toBe(true);

    const inFlight = service.pollOnce();
    let destroyed = false;
    const destroy = service.onModuleDestroy().then(() => {
      destroyed = true;
    });

    // The interval is cleared immediately, without waiting for the in-flight tick.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(service.isPolling()).toBe(false);
    expect(destroyed).toBe(false);

    releaseFindMany([]);
    await Promise.all([inFlight, destroy]);
    expect(destroyed).toBe(true);
  });

  it('onModuleDestroy resolves immediately when nothing is in flight', async () => {
    const { service } = makeService();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});
