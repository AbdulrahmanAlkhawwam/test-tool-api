import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReviewState } from '@prisma/client';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';

const USER_REF = { select: { id: true, name: true } } as const;
const CASE_INCLUDE = {
  module: { select: { id: true, name: true, code: true } },
  createdBy: USER_REF,
  updatedBy: USER_REF,
  approvedBy: USER_REF,
} satisfies Prisma.TestCaseInclude;

const NOT_FOUND = 'Test case not found';
const ALREADY_APPROVED = 'Test case is already approved';

export interface BulkApproveResult {
  approved: string[];
  failed: { id: string; message: string }[];
}

/**
 * Human review of AI drafts (spec §6). Any signed-in tester or admin may approve — the same
 * people who may write cases by hand. Rejecting is the ordinary soft delete on
 * DELETE /api/test-cases/:id, which keeps the code reserved forever.
 */
@Injectable()
export class CaseReviewService {
  constructor(private readonly prisma: PrismaService) {}

  /** Single approve: 404 for a missing or rejected case, 409 for one that is already approved. */
  async approve(id: string, user: AuthUser) {
    const existing = await this.prisma.testCase.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, reviewState: true },
    });
    if (!existing) throw new NotFoundException(NOT_FOUND);
    if (existing.reviewState === ReviewState.APPROVED) throw new ConflictException(ALREADY_APPROVED);

    await this.prisma.testCase.update({
      where: { id },
      data: { reviewState: ReviewState.APPROVED, approvedById: user.id, approvedAt: new Date(), updatedById: user.id },
      select: { id: true },
    });
    return this.prisma.testCase.findUniqueOrThrow({ where: { id }, include: CASE_INCLUDE });
  }

  /**
   * Bulk approve is partially successful (contract with the web app): every draft in `ids` is
   * approved and every other id is reported in `failed` with a reason, because the web approves a
   * checkbox selection that someone else may have changed in the meantime — failing the whole
   * batch over one stale row would make the button unusable. A batch that spans more than one
   * project is the one whole-request error: the spec scopes bulk approve to a single project, so
   * this means the caller selected across projects by mistake.
   * `approved` and `failed` both keep the caller's own id order.
   */
  async approveMany(ids: string[], user: AuthUser): Promise<BulkApproveResult> {
    const unique = [...new Set(ids)];
    const cases = await this.prisma.testCase.findMany({
      where: { id: { in: unique } },
      select: { id: true, projectId: true, reviewState: true, deletedAt: true },
    });
    const byId = new Map(cases.map((c) => [c.id, c]));
    // Deleted cases still count towards the project check: a rejected draft belongs to its project.
    if (new Set(cases.map((c) => c.projectId)).size > 1) {
      throw new BadRequestException('All test cases must belong to the same project');
    }

    const approved: string[] = [];
    const failed: { id: string; message: string }[] = [];
    for (const id of unique) {
      const found = byId.get(id);
      if (!found || found.deletedAt !== null) failed.push({ id, message: NOT_FOUND });
      else if (found.reviewState === ReviewState.APPROVED) failed.push({ id, message: ALREADY_APPROVED });
      else approved.push(id);
    }

    if (approved.length) {
      await this.prisma.testCase.updateMany({
        where: { id: { in: approved }, reviewState: ReviewState.AI_DRAFT, deletedAt: null },
        data: { reviewState: ReviewState.APPROVED, approvedById: user.id, approvedAt: new Date(), updatedById: user.id },
      });
    }
    return { approved, failed };
  }
}
