import { HttpException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GitlabConnectionState, RunStatus, RunType } from '@prisma/client';
import { GitlabConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { GitlabApiService } from '../gitlab/gitlab-api.service';
import { GitlabConnectionService } from '../gitlab/gitlab-connection.service';
import { EJAD_PLAYWRIGHT_JOB_NAME, FINAL_PIPELINE_STATUSES, GitlabPipeline } from '../gitlab/gitlab.types';
import { ResultImporterService } from './result-importer.service';

/**
 * How long an AUTOMATED run may sit IN_PROGRESS with no pipelineId before the sweep gives up on
 * it (e.g. the process crashed between creating the run and calling createPipeline).
 */
const STUCK_RUN_GRACE_MS = 2 * 60_000;

interface PolledRun {
  id: string;
  startedAt: Date;
  pipelineId: number | null;
  pipelineStatus: string | null;
  triggeredById: string | null;
  project: { gitlabProjectId: number | null };
}

/**
 * Polls GitLab for every unfinished automated run's pipeline, on a plain `setInterval` (no
 * `@nestjs/schedule`: one timer, started on bootstrap and always cleared on module destroy, is all
 * this needs). `pollOnce` is exported for tests to call directly instead of waiting on the timer.
 *
 * The interval is cleared, and any in-flight pass awaited, in `onModuleDestroy` rather than
 * `onApplicationShutdown` — Nest runs every `onModuleDestroy` (including `PrismaService`'s, which
 * disconnects the pool) *before* any `onApplicationShutdown`, and destroy hooks run in the reverse
 * of module-initialization order, so this module's hook naturally runs before Prisma's as long as
 * it stays an `onModuleDestroy`. That ordering is what keeps a query from ever running on an
 * already-closed pool during shutdown.
 */
@Injectable()
export class PipelinePollerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PipelinePollerService.name);
  private running = false;
  private interval: NodeJS.Timeout | null = null;
  /** The currently in-flight `pollOnce()` call, if any; `onModuleDestroy` awaits this before letting shutdown continue. */
  private currentPoll: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly gitlab: GitlabConnectionService,
    private readonly api: GitlabApiService,
    private readonly importer: ResultImporterService,
  ) {}

  private get cfg(): GitlabConfig {
    return this.config.getOrThrow<GitlabConfig>('gitlab');
  }

  onApplicationBootstrap(): void {
    if (!this.cfg.enabled || this.cfg.pollIntervalMs <= 0) return;
    this.interval = setInterval(() => void this.pollOnce(), this.cfg.pollIntervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.currentPoll) await this.currentPoll;
  }

  /** Whether the polling interval is currently running (tests only). */
  isPolling(): boolean {
    return this.interval !== null;
  }

  /**
   * One pass over all unfinished automated runs (the interval calls this; tests call it directly).
   * Never rejects: a DB/GitLab problem here is logged and retried on the next pass rather than left
   * to become an unhandled rejection (the interval calls this with `void`, so nothing else observes
   * its result).
   */
  async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.currentPoll = this.runOnePass();
    try {
      await this.currentPoll;
    } finally {
      this.running = false;
      this.currentPoll = null;
    }
  }

  private async runOnePass(): Promise<void> {
    try {
      const runs: PolledRun[] = await this.prisma.testRun.findMany({
        where: { type: RunType.AUTOMATED, status: RunStatus.IN_PROGRESS },
        orderBy: { startedAt: 'asc' },
        select: {
          id: true,
          startedAt: true,
          pipelineId: true,
          pipelineStatus: true,
          triggeredById: true,
          project: { select: { gitlabProjectId: true } },
        },
      });
      for (const run of runs) {
        try {
          await this.pollRun(run);
        } catch (e) {
          // Per-user GitLab problems (reconnect needed, 403/other 4xx, GitLab down) are retried on
          // the next pass; a one-line warning is enough, they're expected occasionally.
          if (e instanceof HttpException) {
            this.logger.warn(`Polling run ${run.id}: ${e.message}`);
          } else {
            this.logger.error(`Polling run ${run.id} failed: ${e instanceof Error ? e.stack : String(e)}`);
          }
        }
      }
    } catch (e) {
      // The run query itself failed (e.g. a DB blip) — never let this escape as an unhandled
      // rejection; just log and let the next pass try again.
      this.logger.warn(`Pipeline poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async pollRun(run: PolledRun): Promise<void> {
    if (run.pipelineId === null) {
      // Never got a pipeline id (a crash between run creation and createPipeline, most likely):
      // give it a couple of minutes in case that call is simply still in flight, then give up.
      if (Date.now() - run.startedAt.getTime() > STUCK_RUN_GRACE_MS) {
        await this.importer.close(run.id, 'The pipeline could not be confirmed as started');
      }
      return;
    }
    const gitlabProjectId = run.project.gitlabProjectId;
    const userId = run.triggeredById;
    if (userId === null || gitlabProjectId === null) {
      await this.importer.close(run.id, 'The repository link or the triggering user was removed');
      return;
    }
    const pipelineId = run.pipelineId;
    const connection = await this.prisma.gitlabConnection.findUnique({ where: { userId }, select: { state: true } });
    if (connection?.state !== GitlabConnectionState.ACTIVE) return; // paused until the user reconnects, or there is no connection at all

    // Always ask GitLab first, even past the run timeout: a pipeline that already finished must be
    // imported, not discarded as timed out just because the poll happened to lag behind it.
    let pipeline: GitlabPipeline;
    try {
      pipeline = await this.gitlab.withToken(userId, (token) => this.api.getPipeline(token, gitlabProjectId, pipelineId));
    } catch (e) {
      if (e instanceof HttpException && e.getStatus() === 404) {
        await this.importer.close(run.id, 'The pipeline no longer exists in GitLab');
        return;
      }
      throw e;
    }

    if (!(await this.isFinal(userId, gitlabProjectId, pipeline))) {
      if (Date.now() - run.startedAt.getTime() > this.cfg.runTimeoutMs) {
        await this.importer.close(run.id, 'Timed out waiting for GitLab');
        return;
      }
      if (pipeline.status !== run.pipelineStatus) {
        await this.prisma.testRun.update({ where: { id: run.id }, data: { pipelineStatus: pipeline.status }, select: { id: true } });
      }
      return;
    }
    await this.gitlab.withToken(userId, (token) => this.importer.importPipeline(token, run.id, pipeline));
  }

  /**
   * Whether the pipeline is done. A trailing manual/blocked gate job (e.g. a deploy step) can leave
   * the pipeline itself not-yet-final even though the test job has already finished, so the
   * ejad-playwright job's own status is checked too — the run's tests are done either way.
   */
  private async isFinal(userId: string, gitlabProjectId: number, pipeline: GitlabPipeline): Promise<boolean> {
    if (FINAL_PIPELINE_STATUSES.has(pipeline.status)) return true;
    const jobs = await this.gitlab.withToken(userId, (token) => this.api.listPipelineJobs(token, gitlabProjectId, pipeline.id));
    const job = jobs.find((j) => j.name === EJAD_PLAYWRIGHT_JOB_NAME) ?? jobs[0];
    return !!job && FINAL_PIPELINE_STATUSES.has(job.status);
  }
}
