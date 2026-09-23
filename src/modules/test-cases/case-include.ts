import { Prisma } from '@prisma/client';

/**
 * Shared by every service that reads back a full test case (TestCasesService, CaseReviewService,
 * ...): one definition avoids three copies drifting apart on which user fields or relations a
 * case response carries.
 */
export const USER_REF = { select: { id: true, name: true } } as const;

export const CASE_INCLUDE = {
  module: { select: { id: true, name: true, code: true } },
  createdBy: USER_REF,
  updatedBy: USER_REF,
  approvedBy: USER_REF,
} satisfies Prisma.TestCaseInclude;
