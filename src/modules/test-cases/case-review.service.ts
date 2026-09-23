import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReviewState } from '@prisma/client';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { CASE_INCLUDE } from './case-include';

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

    // Guarded write: the read above only rules out the common case. Between that read and this
    // write the row can still be soft-deleted or approved by someone else, so the WHERE clause
    // repeats both conditions and a zero-count write is resolved by re-reading the row, never by
    // trusting the stale state we already have.
    const { count } = await this.prisma.testCase.updateMany({
      where: { id, reviewState: ReviewState.AI_DRAFT, deletedAt: null },
      data: { reviewState: ReviewState.APPROVED, approvedById: user.id, approvedAt: new Date(), updatedById: user.id },
    });
    if (count === 0) {
      const now = await this.prisma.testCase.findFirst({ where: { id }, select: { deletedAt: true } });
      if (!now || now.deletedAt !== null) throw new NotFoundException(NOT_FOUND);
      throw new ConflictException(ALREADY_APPROVED);
    }
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

    // `message` holds the reason for every id that will end up in `failed`; anything left out of
    // it by the end is one this call actually wrote. Built as a map keyed by id (not two arrays
    // built as we go) so a race caught only after the guarded write below can still be reported
    // in the caller's original id order together with the ids rejected by the state we read here.
    const message = new Map<string, string>();
    for (const id of unique) {
      const found = byId.get(id);
      if (!found || found.deletedAt !== null) message.set(id, NOT_FOUND);
      else if (found.reviewState === ReviewState.APPROVED) message.set(id, ALREADY_APPROVED);
    }
    const candidates = unique.filter((id) => !message.has(id));

    // Guarded write, same reasoning as approve(): a candidate can still be soft-deleted or
    // approved by someone else between the read above and this write, so the WHERE clause repeats
    // both conditions and RETURNING tells us exactly which ids this call itself approved — a
    // count alone can't distinguish "this call wrote N rows" from "N rows happened to already be
    // in the target state".
    const writtenIds = new Set<string>();
    if (candidates.length) {
      const written = await this.prisma.$queryRaw<{ id: string }[]>`
        UPDATE "TestCase"
        SET "reviewState" = 'APPROVED', "approvedById" = ${user.id}, "approvedAt" = NOW(), "updatedById" = ${user.id}
        WHERE id IN (${Prisma.join(candidates)}) AND "reviewState" = 'AI_DRAFT' AND "deletedAt" IS NULL
        RETURNING id`;
      for (const row of written) writtenIds.add(row.id);

      const raced = candidates.filter((id) => !writtenIds.has(id));
      if (raced.length) {
        const now = await this.prisma.testCase.findMany({
          where: { id: { in: raced } },
          select: { id: true, deletedAt: true },
        });
        const byRaced = new Map(now.map((c) => [c.id, c]));
        for (const id of raced) {
          const row = byRaced.get(id);
          message.set(id, !row || row.deletedAt !== null ? NOT_FOUND : ALREADY_APPROVED);
        }
      }
    }

    return {
      approved: unique.filter((id) => writtenIds.has(id)),
      failed: unique.filter((id) => message.has(id)).map((id) => ({ id, message: message.get(id)! })),
    };
  }
}
