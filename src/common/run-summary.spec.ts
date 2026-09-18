import { ResultStatus } from '@prisma/client';
import { countStatuses, summarize } from './run-summary';

describe('run summary', () => {
  it('summarizes counts and pass rate over executed results', () => {
    expect(summarize({ PASSED: 18, FAILED: 2, BLOCKED: 1, SKIPPED: 0, NOT_EXECUTED: 19 })).toEqual({
      total: 40, executed: 21, notExecuted: 19, passed: 18, failed: 2, blocked: 1, skipped: 0, passRate: 85.7,
    });
  });

  it('returns zeros for an empty run', () => {
    expect(summarize({})).toEqual({
      total: 0, executed: 0, notExecuted: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, passRate: 0,
    });
  });

  it('counts a list of statuses', () => {
    expect(countStatuses([ResultStatus.PASSED, ResultStatus.PASSED, ResultStatus.FAILED])).toEqual({ PASSED: 2, FAILED: 1 });
  });
});
