import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import { countStatuses, loadRunSummaries, summarize } from '../../common/run-summary';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { CreateRunDto, RunSelectionDto } from './dto/create-run.dto';
import { UpdateRunDto } from './dto/update-run.dto';

const USER_REF = { select: { id: true, name: true } } as const;

@Injectable()
export class RunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  async create(projectId: string, dto: CreateRunDto, user: AuthUser) {
    await this.projects.requireProject(projectId);
    const cases = await this.prisma.testCase.findMany({
      where: this.selectionWhere(projectId, dto.selection),
      select: { id: true },
    });
    if (!cases.length) throw new BadRequestException('No test cases match the selection');

    const run = await this.prisma.$transaction(async (tx) => {
      const created = await tx.testRun.create({
        data: { projectId, name: dto.name, build: dto.build, environment: dto.environment, createdById: user.id },
      });
      await tx.testResult.createMany({ data: cases.map((c) => ({ runId: created.id, testCaseId: c.id })) });
      return created;
    });
    return { ...run, summary: summarize({ NOT_EXECUTED: cases.length }) };
  }

  async list(projectId: string) {
    await this.projects.requireProject(projectId);
    const runs = await this.prisma.testRun.findMany({
      where: { projectId },
      orderBy: { startedAt: 'desc' },
      include: { createdBy: USER_REF },
    });
    const summaries = await loadRunSummaries(this.prisma, runs.map((r) => r.id));
    return runs.map((r) => ({ ...r, summary: summaries.get(r.id) }));
  }

  async findOne(id: string) {
    const run = await this.prisma.testRun.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, key: true, name: true } },
        createdBy: USER_REF,
        results: {
          include: {
            executedBy: USER_REF,
            testCase: {
              select: {
                id: true, code: true, name: true, description: true, preconditions: true, steps: true,
                testData: true, expectedResult: true, priority: true, notes: true, deletedAt: true,
                module: { select: { id: true, name: true, code: true } },
              },
            },
          },
        },
      },
    });
    if (!run) throw new NotFoundException('Run not found');
    const sortKey = (r: (typeof run.results)[number]) => r.testCase?.code ?? `~${r.title ?? ''}`;
    const results = [...run.results].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    return { ...run, results, summary: summarize(countStatuses(results.map((r) => r.status))) };
  }

  async update(id: string, dto: UpdateRunDto) {
    const run = await this.prisma.testRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Run not found');

    if (dto.status === RunStatus.COMPLETED) {
      // Atomic compare-and-swap: only succeeds if the run is still IN_PROGRESS, so two
      // concurrent completion requests can't both report success (TOCTOU).
      const { count } = await this.prisma.testRun.updateMany({
        where: { id, status: RunStatus.IN_PROGRESS },
        data: {
          name: dto.name,
          build: dto.build,
          environment: dto.environment,
          status: RunStatus.COMPLETED,
          completedAt: new Date(),
        },
      });
      if (count === 0) throw new ConflictException('Run is already completed');
      return this.prisma.testRun.findUniqueOrThrow({ where: { id } });
    }

    return this.prisma.testRun.update({
      where: { id },
      data: {
        name: dto.name,
        build: dto.build,
        environment: dto.environment,
      },
    });
  }

  private selectionWhere(projectId: string, selection: RunSelectionDto): Prisma.TestCaseWhereInput {
    const where: Prisma.TestCaseWhereInput = { projectId, deletedAt: null };
    const require = <T>(values: T[] | undefined, field: string): T[] => {
      if (!values?.length) throw new BadRequestException(`selection.${field} is required for mode ${selection.mode}`);
      return values;
    };
    switch (selection.mode) {
      case 'MODULES':
        where.moduleId = { in: require(selection.moduleIds, 'moduleIds') };
        break;
      case 'PRIORITIES':
        where.priority = { in: require(selection.priorities, 'priorities') };
        break;
      case 'CASES':
        where.id = { in: require(selection.caseIds, 'caseIds') };
        break;
    }
    return where;
  }
}
