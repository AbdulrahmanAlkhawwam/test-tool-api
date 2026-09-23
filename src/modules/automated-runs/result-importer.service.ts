import { Injectable } from '@nestjs/common';
import { ResultStatus, RunStatus } from '@prisma/client';
import { APPROVED_CASE } from '../../common/review-state';
import { PrismaService } from '../../prisma/prisma.service';
import { GitlabApiService } from '../gitlab/gitlab-api.service';
import { EJAD_PLAYWRIGHT_JOB_NAME, GitlabPipeline } from '../gitlab/gitlab.types';
import { mapTestReport, MappedResult } from './report-mapper';

export const NO_TEST_FOUND_NOTE = 'No automated test found';

@Injectable()
export class ResultImporterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly api: GitlabApiService,
  ) {}

  /** Completes a still-running automated run with a note (timeouts, missing reports, removed links). */
  async close(runId: string, note: string, pipelineStatus?: string): Promise<void> {
    await this.prisma.testRun.updateMany({
      where: { id: runId, status: RunStatus.IN_PROGRESS },
      data: { status: RunStatus.COMPLETED, completedAt: new Date(), note, ...(pipelineStatus ? { pipelineStatus } : {}) },
    });
  }

  /** Reads a finished pipeline's test report (as the triggering user) and completes the run with its results. */
  async importPipeline(token: string, runId: string, pipeline: GitlabPipeline): Promise<void> {
    const run = await this.prisma.testRun.findUniqueOrThrow({
      where: { id: runId },
      select: { projectId: true, triggeredById: true, project: { select: { gitlabProjectId: true, gitlabWebUrl: true } } },
    });
    const gitlabProjectId = run.project.gitlabProjectId;
    if (gitlabProjectId === null) {
      await this.close(runId, 'The repository link was removed', pipeline.status);
      return;
    }
    const suites = await this.api.getTestReport(token, gitlabProjectId, pipeline.id);
    const jobs = await this.api.listPipelineJobs(token, gitlabProjectId, pipeline.id);
    const job = jobs.find((j) => j.name === EJAD_PLAYWRIGHT_JOB_NAME) ?? jobs[0];
    if (!suites.some((s) => s.cases.length)) {
      await this.close(runId, `Pipeline finished without a test report – ${job?.webUrl ?? pipeline.webUrl}`, pipeline.status);
      return;
    }

    const artifactsUrl = job && run.project.gitlabWebUrl ? `${run.project.gitlabWebUrl}/-/jobs/${job.id}/artifacts/browse` : null;
    const executedAt = pipeline.finishedAt ? new Date(pipeline.finishedAt) : new Date();
    const cases = await this.prisma.testCase.findMany({ where: { projectId: run.projectId, ...APPROVED_CASE }, select: { id: true, code: true } });
    const report = mapTestReport(suites, new Map(cases.map((c) => [c.code, c.id])));
    const fields = (r: MappedResult) => ({
      status: r.status,
      title: r.title,
      file: r.file,
      durationMs: r.durationMs,
      errorMessage: r.errorMessage,
      errorStack: r.errorStack,
      artifactsUrl: r.status === ResultStatus.FAILED ? artifactsUrl : null,
      executedAt,
      executedById: run.triggeredById,
    });

    // Sequential writes only: parallel queries inside a transaction trigger the pg deprecation warning.
    await this.prisma.$transaction(
      async (tx) => {
        const [locked] = await tx.$queryRaw<{ status: RunStatus }[]>`
          SELECT status FROM "TestRun" WHERE id = ${runId} FOR UPDATE`;
        if (locked?.status !== RunStatus.IN_PROGRESS) return;

        const existing = await tx.testResult.findMany({ where: { runId, testCaseId: { not: null } }, select: { id: true, testCaseId: true } });
        const resultByCase = new Map(existing.map((r) => [r.testCaseId!, r.id]));
        for (const linked of report.linked) {
          const id = resultByCase.get(linked.testCaseId);
          if (id) await tx.testResult.update({ where: { id }, data: fields(linked), select: { id: true } });
          else await tx.testResult.create({ data: { runId, testCaseId: linked.testCaseId, ...fields(linked) }, select: { id: true } });
        }
        if (report.unlinked.length) {
          await tx.testResult.createMany({ data: report.unlinked.map((u) => ({ runId, testCaseId: null, ...fields(u) })) });
        }
        const linkedIds = new Set(report.linked.map((l) => l.testCaseId));
        const missing = existing.filter((r) => !linkedIds.has(r.testCaseId!)).map((r) => r.id);
        if (missing.length) {
          await tx.testResult.updateMany({ where: { id: { in: missing } }, data: { notes: NO_TEST_FOUND_NOTE } });
        }
        await tx.testRun.update({
          where: { id: runId },
          data: { status: RunStatus.COMPLETED, completedAt: new Date(), pipelineStatus: pipeline.status },
          select: { id: true },
        });
      },
      { timeout: 60_000 },
    );
  }
}
