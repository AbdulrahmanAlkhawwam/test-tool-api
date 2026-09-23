import { Injectable, NotFoundException } from '@nestjs/common';
import { Priority, ResultStatus, ReviewState } from '@prisma/client';
import { APPROVED_CASE } from '../../common/review-state';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { ReportsService } from '../reports/reports.service';
import { SuggestionsService } from '../suggestions/suggestions.service';
import { ListTestCasesQuery } from '../test-cases/dto/list-test-cases.query';
import { TestCasesService } from '../test-cases/test-cases.service';

/** How much result history get_test_case shows (spec §7: last 10). */
const HISTORY_LIMIT = 10;

export interface ListTestCasesInput {
  projectKey: string;
  moduleCode?: string;
  priority?: Priority;
  status?: ResultStatus;
  q?: string;
  includeDrafts: boolean;
  page: number;
  pageSize: number;
}

/**
 * Data for the read-only MCP tools. Every method goes through the same services the web
 * controllers use, and the shapes are deliberately id-free: an AI works with project keys, module
 * codes and case codes, which are also what the user says out loud.
 */
@Injectable()
export class McpReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly testCases: TestCasesService,
    private readonly reports: ReportsService,
    private readonly suggestions: SuggestionsService,
  ) {}

  /** Project keys are stored upper-case; getByKey upper-cases and 404s for us. */
  async requireProjectByKey(key: string) {
    const project = await this.projects.getByKey(key);
    return { id: project.id, key: project.key };
  }

  async listProjects(includeArchived: boolean) {
    const projects = await this.projects.list(includeArchived);
    return {
      projects: projects.map((p) => ({
        key: p.key,
        name: p.name,
        description: p.description,
        archived: p.archivedAt !== null,
        caseCount: p.caseCount,
        lastTestedAt: p.lastTestedAt,
        latestRun: p.latestRun
          ? { name: p.latestRun.name, status: p.latestRun.status, startedAt: p.latestRun.startedAt, summary: p.latestRun.summary }
          : null,
      })),
    };
  }

  async getProject(projectKey: string) {
    const project = await this.projects.getByKey(projectKey);
    return {
      key: project.key,
      name: project.name,
      description: project.description,
      archived: project.archivedAt !== null,
      modules: project.modules.map((m) => ({ name: m.name, code: m.code, caseCount: m.caseCount })),
    };
  }

  async listTestCases(input: ListTestCasesInput) {
    const project = await this.requireProjectByKey(input.projectKey);
    const query = Object.assign(new ListTestCasesQuery(), {
      moduleId: input.moduleCode ? (await this.requireModule(project.id, project.key, input.moduleCode)).id : undefined,
      priority: input.priority,
      status: input.status,
      q: input.q,
      reviewState: input.includeDrafts ? undefined : ReviewState.APPROVED,
      page: input.page,
      pageSize: input.pageSize,
    });
    const page = await this.testCases.list(project.id, query);
    return {
      items: page.items.map((c) => ({
        code: c.code,
        name: c.name,
        module: c.module.code,
        priority: c.priority,
        reviewState: c.reviewState,
        latestStatus: c.latestResult?.status ?? ResultStatus.NOT_EXECUTED,
        latestExecutedAt: c.latestResult?.executedAt ?? null,
      })),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async getTestCase(projectKey: string, code: string) {
    const project = await this.requireProjectByKey(projectKey);
    const found = await this.requireCase(project.id, project.key, code);
    const detail = await this.testCases.findOne(found.id);
    const pending = await this.suggestions.pendingFor(found.id);
    return {
      code: detail.code,
      name: detail.name,
      module: { code: detail.module.code, name: detail.module.name },
      description: detail.description,
      preconditions: detail.preconditions,
      steps: detail.steps,
      testData: detail.testData,
      expectedResult: detail.expectedResult,
      priority: detail.priority,
      notes: detail.notes,
      reviewState: detail.reviewState,
      createdVia: detail.createdVia,
      createdBy: detail.createdBy.name,
      updatedBy: detail.updatedBy.name,
      approvedBy: detail.approvedBy?.name ?? null,
      pendingSuggestion: pending
        ? { id: pending.id, changes: pending.changes, rationale: pending.rationale, createdAt: pending.createdAt }
        : null,
      results: detail.history.slice(0, HISTORY_LIMIT).map((h) => ({
        status: h.status,
        actualResult: h.actualResult,
        notes: h.notes,
        executedAt: h.executedAt,
        run: h.run.name,
      })),
    };
  }

  async getFailingCases(projectKey: string) {
    const project = await this.requireProjectByKey(projectKey);
    const report = await this.reports.projectReport(project.id);
    return {
      cases: report.failing.map((c) => ({
        code: c.code,
        name: c.name,
        module: c.module.code,
        actualResult: c.actualResult,
        executedAt: c.executedAt,
        run: c.run.name,
      })),
    };
  }

  /** Approved cases only (spec §7): the AI must never automate something nobody reviewed. */
  async getCasesForAutomation(projectKey: string, moduleCode?: string, codes?: string[]) {
    const project = await this.requireProjectByKey(projectKey);
    const moduleId = moduleCode ? (await this.requireModule(project.id, project.key, moduleCode)).id : undefined;
    const cases = await this.prisma.testCase.findMany({
      where: {
        projectId: project.id,
        ...APPROVED_CASE,
        ...(moduleId ? { moduleId } : {}),
        ...(codes?.length ? { code: { in: codes.map((c) => c.toUpperCase()) } } : {}),
      },
      orderBy: { code: 'asc' },
      select: {
        code: true,
        name: true,
        preconditions: true,
        steps: true,
        testData: true,
        expectedResult: true,
        priority: true,
        module: { select: { code: true, name: true } },
      },
    });
    return { cases: cases.map(({ module, ...c }) => ({ ...c, module: { code: module.code, name: module.name } })) };
  }

  private async requireModule(projectId: string, projectKey: string, moduleCode: string) {
    const code = moduleCode.trim().toUpperCase();
    const module = await this.prisma.projectModule.findUnique({
      where: { projectId_code: { projectId, code } },
      select: { id: true, code: true },
    });
    if (!module) throw new NotFoundException(`Module "${code}" was not found in project ${projectKey}`);
    return module;
  }

  private async requireCase(projectId: string, projectKey: string, code: string) {
    const upper = code.trim().toUpperCase();
    const found = await this.prisma.testCase.findFirst({
      where: { projectId, code: upper, deletedAt: null },
      select: { id: true },
    });
    if (!found) throw new NotFoundException(`Test case "${upper}" was not found in project ${projectKey}`);
    return found;
  }
}
