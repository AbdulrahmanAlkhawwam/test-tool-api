import { Injectable } from '@nestjs/common';
import { Priority, ResultStatus, RunStatus } from '@prisma/client';
import { getLatestExecutedResults } from '../../common/latest-results';
import { loadRunSummaries, StatusCounts, summarize } from '../../common/run-summary';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';

const PRIORITY_ORDER: Priority[] = [Priority.HIGH, Priority.MEDIUM, Priority.LOW];

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  async projectReport(projectId: string) {
    await this.projects.requireProject(projectId);

    const runs = await this.prisma.testRun.findMany({
      where: { projectId },
      orderBy: { startedAt: 'desc' },
      take: 20,
      select: { id: true, name: true, type: true, status: true, startedAt: true },
    });
    const summaries = await loadRunSummaries(this.prisma, runs.map((r) => r.id));
    const trend = [...runs].reverse().map((r) => ({ ...r, summary: summaries.get(r.id)! }));

    const [cases, latest] = await Promise.all([
      this.prisma.testCase.findMany({
        where: { projectId, deletedAt: null },
        select: { id: true, code: true, name: true, priority: true, module: { select: { id: true, name: true, code: true } } },
        orderBy: { code: 'asc' },
      }),
      getLatestExecutedResults(this.prisma, projectId),
    ]);

    const moduleCounts = new Map<string, { moduleId: string; name: string; code: string; counts: StatusCounts }>();
    const priorityCounts = new Map<Priority, StatusCounts>();
    for (const c of cases) {
      const status = latest.get(c.id)?.status ?? ResultStatus.NOT_EXECUTED;
      const m = moduleCounts.get(c.module.id) ?? { moduleId: c.module.id, name: c.module.name, code: c.module.code, counts: {} };
      m.counts[status] = (m.counts[status] ?? 0) + 1;
      moduleCounts.set(c.module.id, m);
      const p = priorityCounts.get(c.priority) ?? {};
      p[status] = (p[status] ?? 0) + 1;
      priorityCounts.set(c.priority, p);
    }

    return {
      trend,
      byModule: [...moduleCounts.values()]
        .sort((a, b) => a.code.localeCompare(b.code))
        .map(({ counts, ...m }) => ({ ...m, summary: summarize(counts) })),
      byPriority: PRIORITY_ORDER.filter((p) => priorityCounts.has(p)).map((priority) => ({
        priority,
        summary: summarize(priorityCounts.get(priority)!),
      })),
      failing: cases
        .filter((c) => latest.get(c.id)?.status === ResultStatus.FAILED)
        .map((c) => {
          const r = latest.get(c.id)!;
          return {
            id: c.id,
            code: c.code,
            name: c.name,
            module: c.module,
            actualResult: r.actualResult,
            executedAt: r.executedAt,
            run: { id: r.runId, name: r.runName },
          };
        }),
    };
  }

  async dashboard() {
    // Archived projects are hidden from the home page, so none of the figures include them.
    const activeProject = { archivedAt: null };
    const [projectCount, testCaseCount, runsInProgress, recent] = await Promise.all([
      this.prisma.project.count({ where: activeProject }),
      this.prisma.testCase.count({ where: { deletedAt: null, project: activeProject } }),
      this.prisma.testRun.count({ where: { status: RunStatus.IN_PROGRESS, project: activeProject } }),
      this.prisma.testRun.findMany({
        where: { project: activeProject },
        orderBy: { startedAt: 'desc' },
        take: 5,
        select: {
          id: true, name: true, type: true, status: true, startedAt: true,
          project: { select: { id: true, key: true, name: true } },
        },
      }),
    ]);
    const summaries = await loadRunSummaries(this.prisma, recent.map((r) => r.id));
    return {
      projectCount,
      testCaseCount,
      runsInProgress,
      recentRuns: recent.map((r) => ({ ...r, summary: summaries.get(r.id)! })),
    };
  }
}
