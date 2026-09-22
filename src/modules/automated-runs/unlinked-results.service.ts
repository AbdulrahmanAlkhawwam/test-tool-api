import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { TestCasesService } from '../test-cases/test-cases.service';
import { CreateCaseFromResultDto } from './dto/create-case-from-result.dto';

const ALREADY_LINKED = 'This result is already linked to a test case';

/** "cart/cart.spec.ts › Cart › adds an item @smoke" → "adds an item". */
export function suggestCaseName(title: string | null): string | null {
  if (!title) return null;
  const last = title.split(' › ').pop() ?? title;
  const name = last.replace(/@\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return name || null;
}

@Injectable()
export class UnlinkedResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly testCases: TestCasesService,
  ) {}

  /** Turns an unlinked automated result into a new test case (same rules as the web form) and links it. */
  async createCase(runId: string, resultId: string, dto: CreateCaseFromResultDto, user: AuthUser) {
    const result = await this.prisma.testResult.findFirst({
      where: { id: resultId, runId },
      include: { run: { select: { projectId: true } } },
    });
    if (!result) throw new NotFoundException('Result not found in this run');
    if (result.testCaseId) throw new ConflictException(ALREADY_LINKED);

    const name = dto.name ?? suggestCaseName(result.title);
    if (!name) throw new BadRequestException('name is required for results without a title');
    const notes = result.title ? `Created from automated test "${result.title}"${result.file ? ` in ${result.file}` : ''}` : undefined;
    const testCase = await this.testCases.create(result.run.projectId, { moduleId: dto.moduleId, name, priority: dto.priority, notes }, user);

    // Link only if nobody linked it meanwhile; otherwise retire the case we just created.
    const linked = await this.prisma.testResult.updateMany({ where: { id: resultId, testCaseId: null }, data: { testCaseId: testCase.id } });
    if (linked.count !== 1) {
      await this.prisma.testCase.update({ where: { id: testCase.id }, data: { deletedAt: new Date() }, select: { id: true } });
      throw new ConflictException(ALREADY_LINKED);
    }
    return { testCase, resultId, tag: `@${testCase.code}` };
  }
}
