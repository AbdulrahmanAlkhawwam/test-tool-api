import { HttpException, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GitlabConnectionState, RunStatus, RunType } from '@prisma/client';
import { GitlabConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { GitlabApiService } from '../gitlab/gitlab-api.service';
import { GitlabConnectionService } from '../gitlab/gitlab-connection.service';
import { FINAL_PIPELINE_STATUSES } from '../gitlab/gitlab.types';
import { ResultImporterService } from './result-importer.service';

export const PIPELINE_POLLER = 'gitlab-pipeline-poller';

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
 * `@nestjs/schedule`: one timer, started on bootstrap and always cleared on shutdown, is all this
 * needs). `pollOnce` is exported for tests to call directly instead of waiting on the timer.
 */
@Injectable()
export class PipelinePollerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PipelinePollerService.name);
  private running = false;
  private interval: NodeJS.Timeout | null = null;

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

  onApplicationShutdown(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Whether the polling interval is currently running (tests only). */
  isPolling(): boolean {
    return this.interval !== null;
  }

  /** One pass over all unfinished automated runs (the interval calls this; tests call it directly). */
  async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
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
          // Per-user GitLab problems (reconnect needed, 403/404, GitLab down) are retried on the next pass.
          if (!(e instanceof HttpException)) {
            this.logger.error(`Polling run ${run.id} failed: ${e instanceof Error ? e.stack : String(e)}`);
          }
        }
      }
    } finally {
      this.running = false;
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
    if (Date.now() - run.startedAt.getTime() > this.cfg.runTimeoutMs) {
      await this.importer.close(run.id, 'Timed out waiting for GitLab');
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
    if (connection?.state !== GitlabConnectionState.ACTIVE) return; // paused until the user reconnects

    const pipeline = await this.gitlab.withToken(userId, (token) => this.api.getPipeline(token, gitlabProjectId, pipelineId));
    if (!FINAL_PIPELINE_STATUSES.has(pipeline.status)) {
      if (pipeline.status !== run.pipelineStatus) {
        await this.prisma.testRun.update({ where: { id: run.id }, data: { pipelineStatus: pipeline.status }, select: { id: true } });
      }
      return;
    }
    await this.gitlab.withToken(userId, (token) => this.importer.importPipeline(token, run.id, pipeline));
  }
}
