import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { RunStatus, RunType } from '@prisma/client';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationService, LinkedProject } from '../automation/automation.service';
import { resolveInTestsPath } from '../automation/paths';
import { GitlabApiService } from '../gitlab/gitlab-api.service';
import { GitlabConnectionService, needsReconnect } from '../gitlab/gitlab-connection.service';
import { GitlabHttpError } from '../gitlab/gitlab-http-error';
import { GitlabPipeline } from '../gitlab/gitlab.types';
import { RunsService } from '../runs/runs.service';
import { AutomatedScopeDto, CreateAutomatedRunDto } from './dto/create-automated-run.dto';
import { assertSafeScopePath, automatedRunName, pipelineVariables } from './run-scope';

interface ResolvedScope {
  path?: string;
  cases: { id: string; code: string }[];
}

@Injectable()
export class AutomatedRunsService {
  private readonly logger = new Logger(AutomatedRunsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly automation: AutomationService,
    private readonly gitlab: GitlabConnectionService,
    private readonly api: GitlabApiService,
    private readonly runs: RunsService,
  ) {}

  /** Creates an AUTOMATED run and starts a GitLab pipeline for it with the caller's token. */
  async trigger(projectId: string, dto: CreateAutomatedRunDto, user: AuthUser) {
    const project = await this.automation.requireLinked(projectId);
    const scope = await this.resolveScope(project, dto.scope);
    // 403 before any run exists when the user has no usable GitLab connection.
    const token = await this.gitlab.accessToken(user.id);

    const run = await this.prisma.$transaction(async (tx) => {
      const created = await tx.testRun.create({
        data: {
          projectId,
          name: dto.name ?? automatedRunName(dto.branch, new Date()),
          type: RunType.AUTOMATED,
          branch: dto.branch,
          triggeredById: user.id,
          createdById: user.id,
        },
        select: { id: true },
      });
      if (scope.cases.length) {
        await tx.testResult.createMany({ data: scope.cases.map((c) => ({ runId: created.id, testCaseId: c.id })) });
      }
      return created;
    });

    let pipeline: GitlabPipeline;
    try {
      pipeline = await this.api.createPipeline(
        token,
        project.gitlabProjectId,
        dto.branch,
        pipelineVariables(run.id, { path: scope.path, codes: scope.cases.map((c) => c.code) }),
      );
    } catch (e) {
      await this.closeAfterTriggerFailure(run.id, e);
      if (e instanceof GitlabHttpError && e.status === 401) {
        // The run is already closed above; the client still gets the same 403 the web recognizes
        // to show its reconnect prompt (not a 201 with a note buried in the body).
        await this.gitlab.markNeedsReconnect(user.id);
        throw needsReconnect();
      }
      if (!(e instanceof GitlabHttpError)) throw e;
      return this.runs.findOne(run.id);
    }

    try {
      await this.savePipeline(run.id, pipeline);
    } catch (e) {
      // The pipeline was created in GitLab, so the run must not be closed as failed here. Retry
      // the save once; if it still fails, leave the run IN_PROGRESS with no pipelineId stored – the
      // poller's stuck-run sweep closes it after a couple of minutes if this never recovers.
      this.logger.error(
        `Saving pipeline ${pipeline.id} for run ${run.id} failed, retrying once: ${e instanceof Error ? e.message : String(e)}`,
      );
      await this.savePipeline(run.id, pipeline);
    }
    return this.runs.findOne(run.id);
  }

  private savePipeline(runId: string, pipeline: GitlabPipeline) {
    return this.prisma.testRun.update({
      where: { id: runId },
      data: { pipelineId: pipeline.id, pipelineWebUrl: pipeline.webUrl, pipelineStatus: pipeline.status },
      select: { id: true },
    });
  }

  /** Closes a run whose pipeline could not be confirmed as created, wording the note by how uncertain that is. */
  private async closeAfterTriggerFailure(runId: string, e: unknown): Promise<void> {
    const message = e instanceof GitlabHttpError ? e.message : 'Unexpected error';
    // status 0 (unreachable/timeout) or 5xx means GitLab may have started the pipeline anyway;
    // any other status (400, 401, 404, ...) means it did not.
    const unconfirmed = e instanceof GitlabHttpError && (e.status === 0 || e.status >= 500);
    const note = unconfirmed
      ? `GitLab didn't confirm the pipeline (${message}) – it may still have started; check GitLab`
      : `GitLab could not start the pipeline: ${message}`;
    await this.prisma.testRun.update({
      where: { id: runId },
      data: { status: RunStatus.COMPLETED, completedAt: new Date(), note },
      select: { id: true },
    });
  }

  private async resolveScope(project: LinkedProject, scope: AutomatedScopeDto): Promise<ResolvedScope> {
    switch (scope.mode) {
      case 'PATH':
        if (!scope.path) throw new BadRequestException('scope.path is required for mode PATH');
        assertSafeScopePath(scope.path);
        return { path: resolveInTestsPath(project.testsPath, scope.path), cases: [] };
      case 'CASES': {
        const ids = [...new Set(scope.caseIds ?? [])];
        if (!ids.length) throw new BadRequestException('scope.caseIds is required for mode CASES');
        const cases = await this.prisma.testCase.findMany({
          where: { id: { in: ids }, projectId: project.id, deletedAt: null },
          select: { id: true, code: true },
          orderBy: { code: 'asc' },
        });
        if (cases.length !== ids.length) throw new BadRequestException('Some selected test cases do not exist in this project');
        return { cases };
      }
      default:
        return { cases: [] };
    }
  }
}
