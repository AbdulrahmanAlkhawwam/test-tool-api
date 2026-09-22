import { BadRequestException, Injectable } from '@nestjs/common';
import { RunStatus, RunType } from '@prisma/client';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationService, LinkedProject } from '../automation/automation.service';
import { resolveInTestsPath } from '../automation/paths';
import { GitlabApiService } from '../gitlab/gitlab-api.service';
import { GitlabConnectionService } from '../gitlab/gitlab-connection.service';
import { GitlabHttpError } from '../gitlab/gitlab-http-error';
import { RunsService } from '../runs/runs.service';
import { AutomatedScopeDto, CreateAutomatedRunDto } from './dto/create-automated-run.dto';
import { automatedRunName, pipelineVariables } from './run-scope';

interface ResolvedScope {
  path?: string;
  cases: { id: string; code: string }[];
}

@Injectable()
export class AutomatedRunsService {
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

    try {
      const pipeline = await this.api.createPipeline(
        token,
        project.gitlabProjectId,
        dto.branch,
        pipelineVariables(run.id, { path: scope.path, codes: scope.cases.map((c) => c.code) }),
      );
      await this.prisma.testRun.update({
        where: { id: run.id },
        data: { pipelineId: pipeline.id, pipelineWebUrl: pipeline.webUrl, pipelineStatus: pipeline.status },
        select: { id: true },
      });
    } catch (e) {
      if (e instanceof GitlabHttpError && e.status === 401) await this.gitlab.markNeedsReconnect(user.id);
      const message = e instanceof GitlabHttpError ? e.message : 'Unexpected error';
      await this.prisma.testRun.update({
        where: { id: run.id },
        data: { status: RunStatus.COMPLETED, completedAt: new Date(), note: `GitLab could not start the pipeline: ${message}` },
        select: { id: true },
      });
      if (!(e instanceof GitlabHttpError)) throw e;
    }
    return this.runs.findOne(run.id);
  }

  private async resolveScope(project: LinkedProject, scope: AutomatedScopeDto): Promise<ResolvedScope> {
    switch (scope.mode) {
      case 'PATH':
        if (!scope.path) throw new BadRequestException('scope.path is required for mode PATH');
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
