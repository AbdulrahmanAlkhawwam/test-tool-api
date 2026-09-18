import { Priority, ResultStatus } from '@prisma/client';

export const PRIORITY_LABELS: Record<Priority, string> = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };

export const STATUS_LABELS: Record<ResultStatus, string> = {
  NOT_EXECUTED: 'Not Executed',
  PASSED: 'Passed',
  FAILED: 'Failed',
  BLOCKED: 'Blocked',
  SKIPPED: 'Skipped',
};
