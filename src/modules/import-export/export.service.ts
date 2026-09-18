import { Injectable, NotFoundException } from '@nestjs/common';
import { Priority, ResultStatus } from '@prisma/client';
import { getLatestExecutedResults } from '../../common/latest-results';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { buildTemplateWorkbook, ExportRow } from './export.builder';

export interface ExportFile {
  filename: string;
  buffer: Buffer;
}

@Injectable()
export class ExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  async exportTestCases(projectId: string): Promise<ExportFile> {
    const project = await this.projects.requireProject(projectId);
    const [cases, latest] = await Promise.all([
      this.prisma.testCase.findMany({
        where: { projectId, deletedAt: null },
        include: { module: { select: { name: true } } },
        orderBy: { code: 'asc' },
      }),
      getLatestExecutedResults(this.prisma, projectId),
    ]);
    const rows: ExportRow[] = cases.map((c) => ({
      ...c,
      module: c.module.name,
      actualResult: latest.get(c.id)?.actualResult ?? null,
      status: latest.get(c.id)?.status ?? ResultStatus.NOT_EXECUTED,
    }));
    return { filename: `${project.key}-test-cases.xlsx`, buffer: await buildTemplateWorkbook(project.key, rows) };
  }

  async exportRun(runId: string): Promise<ExportFile> {
    const run = await this.prisma.testRun.findUnique({
      where: { id: runId },
      include: {
        project: { select: { key: true } },
        results: { include: { testCase: { include: { module: { select: { name: true } } } } } },
      },
    });
    if (!run) throw new NotFoundException('Run not found');

    const rows: ExportRow[] = run.results
      .map((r) => ({
        code: r.testCase?.code ?? '',
        module: r.testCase?.module.name ?? '',
        name: r.testCase?.name ?? r.title ?? '',
        description: r.testCase?.description ?? null,
        preconditions: r.testCase?.preconditions ?? null,
        steps: r.testCase?.steps ?? null,
        testData: r.testCase?.testData ?? null,
        expectedResult: r.testCase?.expectedResult ?? null,
        actualResult: r.actualResult,
        priority: r.testCase?.priority ?? Priority.MEDIUM,
        status: r.status,
        notes: r.notes,
      }))
      .sort((a, b) => a.code.localeCompare(b.code));

    const slug = run.name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
    return { filename: `${run.project.key}-run-${slug}.xlsx`, buffer: await buildTemplateWorkbook(run.name, rows) };
  }
}
