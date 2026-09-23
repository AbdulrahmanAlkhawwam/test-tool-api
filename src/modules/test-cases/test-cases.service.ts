import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ResultStatus, ReviewState } from '@prisma/client';
import { getLatestExecutedResults } from '../../common/latest-results';
import { isUniqueViolation } from '../../common/prisma-errors';
import { ACTIVE_CASE } from '../../common/review-state';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { nextCaseCode } from './case-code';
import { CreateTestCaseDto } from './dto/create-test-case.dto';
import { ListTestCasesQuery } from './dto/list-test-cases.query';
import { UpdateTestCaseDto } from './dto/update-test-case.dto';

const USER_REF = { select: { id: true, name: true } } as const;
const CASE_INCLUDE = {
  module: { select: { id: true, name: true, code: true } },
  createdBy: USER_REF,
  updatedBy: USER_REF,
  approvedBy: USER_REF,
} satisfies Prisma.TestCaseInclude;

@Injectable()
export class TestCasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  async list(projectId: string, query: ListTestCasesQuery) {
    await this.projects.requireProject(projectId);
    const latest = await getLatestExecutedResults(this.prisma, projectId);

    const where: Prisma.TestCaseWhereInput = { projectId, ...ACTIVE_CASE };
    if (query.moduleId) where.moduleId = query.moduleId;
    if (query.priority) where.priority = query.priority;
    if (query.reviewState) where.reviewState = query.reviewState;
    if (query.q) {
      where.OR = [
        { name: { contains: query.q, mode: 'insensitive' } },
        { code: { contains: query.q, mode: 'insensitive' } },
        { description: { contains: query.q, mode: 'insensitive' } },
      ];
    }
    if (query.status === ResultStatus.NOT_EXECUTED) {
      where.id = { notIn: [...latest.keys()] };
    } else if (query.status) {
      where.id = { in: [...latest.values()].filter((r) => r.status === query.status).map((r) => r.testCaseId) };
    }
    if (query.status) {
      // A latest-status filter is about executed work. Drafts never enter a run, so a draft can
      // never legitimately match one — least of all NOT_EXECUTED, which would otherwise list
      // every unreviewed draft as a case nobody has tested yet. Appended (not assigned) to
      // where.AND so a future filter that also needs where.AND doesn't silently drop this
      // exclusion, and so an explicit reviewState=AI_DRAFT still narrows (to nothing) instead of
      // being overwritten.
      const existingAnd = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
      where.AND = [...existingAnd, { reviewState: ReviewState.APPROVED }];
    }

    const [total, items] = await Promise.all([
      this.prisma.testCase.count({ where }),
      this.prisma.testCase.findMany({
        where,
        include: { module: CASE_INCLUDE.module },
        orderBy: { code: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: items.map((c) => ({ ...c, latestResult: latest.get(c.id) ?? null })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * `db` defaults to the top-level client but accepts a `Prisma.TransactionClient` so a caller
   * (e.g. creating a case from an unlinked automated result) can create the case and use it in the
   * same surrounding transaction.
   */
  async create(
    projectId: string,
    dto: CreateTestCaseDto,
    user: AuthUser,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    await this.projects.requireProject(projectId);
    const module = await this.requireModuleInProject(projectId, dto.moduleId);
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const existing = await db.testCase.findMany({
        where: { projectId, code: { startsWith: `TC-${module.code}-` } },
        select: { code: true },
      });
      const code = nextCaseCode(module.code, existing.map((c) => c.code));
      try {
        // Write with a minimal select, then read relations back outside Prisma's implicit
        // write transaction: an include here would load the relations in parallel on the
        // transaction's single pinned pg client (pg concurrent-query deprecation).
        const { id } = await db.testCase.create({
          data: { ...dto, code, projectId, createdById: user.id, updatedById: user.id },
          select: { id: true },
        });
        return this.findWithRelations(id, db);
      } catch (e) {
        if (!isUniqueViolation(e) || attempt === maxAttempts) throw e;
      }
    }
    throw new ConflictException('Could not allocate a test case ID, please retry');
  }

  async findOne(id: string) {
    const testCase = await this.prisma.testCase.findUnique({
      where: { id },
      include: {
        ...CASE_INCLUDE,
        results: {
          include: {
            run: { select: { id: true, name: true, type: true, status: true, startedAt: true } },
            executedBy: USER_REF,
          },
          orderBy: { run: { startedAt: 'desc' } },
        },
      },
    });
    if (!testCase) throw new NotFoundException('Test case not found');
    const { results, ...rest } = testCase;
    return {
      ...rest,
      history: results.map((r) => ({
        id: r.id,
        status: r.status,
        actualResult: r.actualResult,
        notes: r.notes,
        executedAt: r.executedAt,
        executedBy: r.executedBy,
        run: r.run,
      })),
    };
  }

  async update(id: string, dto: UpdateTestCaseDto, user: AuthUser) {
    const existing = await this.requireActiveCase(id);
    if (dto.moduleId) await this.requireModuleInProject(existing.projectId, dto.moduleId);
    await this.prisma.testCase.update({
      where: { id },
      data: { ...dto, updatedById: user.id },
      select: { id: true },
    });
    return this.findWithRelations(id);
  }

  private findWithRelations(id: string, db: PrismaService | Prisma.TransactionClient = this.prisma) {
    return db.testCase.findUniqueOrThrow({ where: { id }, include: CASE_INCLUDE });
  }

  async remove(id: string, user: AuthUser): Promise<void> {
    await this.requireActiveCase(id);
    await this.prisma.testCase.update({ where: { id }, data: { deletedAt: new Date(), updatedById: user.id } });
  }

  private async requireActiveCase(id: string) {
    const testCase = await this.prisma.testCase.findFirst({ where: { id, deletedAt: null } });
    if (!testCase) throw new NotFoundException('Test case not found');
    return testCase;
  }

  private async requireModuleInProject(projectId: string, moduleId: string) {
    const module = await this.prisma.projectModule.findFirst({ where: { id: moduleId, projectId } });
    if (!module) throw new BadRequestException('moduleId does not belong to this project');
    return module;
  }
}
