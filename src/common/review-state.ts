import { Prisma, ReviewState } from '@prisma/client';

/** Every case that still exists — AI drafts included. Use for lists and detail reads. */
export const ACTIVE_CASE: Prisma.TestCaseWhereInput = { deletedAt: null };

/**
 * Every case that counts. Spec §6: AI drafts are excluded from run creation snapshots,
 * latest-status filters, reports and dashboard counts, project and module case counts and
 * export — and, by the same reasoning, from automation coverage, automated-run selection and
 * automated result tag mapping, because a draft has no tests and belongs in no run.
 * Anything a stakeholder reads must use this filter, not ACTIVE_CASE.
 */
export const APPROVED_CASE: Prisma.TestCaseWhereInput = { deletedAt: null, reviewState: ReviewState.APPROVED };
