import { ReviewState } from '@prisma/client';
import { ACTIVE_CASE, APPROVED_CASE } from './review-state';

describe('review-state', () => {
  it('ACTIVE_CASE and APPROVED_CASE are frozen where-fragments', () => {
    expect(Object.isFrozen(ACTIVE_CASE)).toBe(true);
    expect(Object.isFrozen(APPROVED_CASE)).toBe(true);

    // A mutation attempt must not silently change a shared reference several services pass
    // straight into a Prisma `where` clause. Freeze either throws (strict mode) or is a silent
    // no-op; either way the value itself must be unchanged afterwards.
    try {
      (ACTIVE_CASE as Record<string, unknown>).deletedAt = 'mutated';
    } catch {
      /* strict mode: expected */
    }
    try {
      (APPROVED_CASE as Record<string, unknown>).reviewState = 'mutated';
    } catch {
      /* strict mode: expected */
    }
    expect(ACTIVE_CASE).toEqual({ deletedAt: null });
    expect(APPROVED_CASE).toEqual({ deletedAt: null, reviewState: ReviewState.APPROVED });
  });
});
