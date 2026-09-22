import { ResultStatus } from '@prisma/client';
import { extractCaseTags } from '../automation/case-tags';
import { GitlabTestCase, GitlabTestSuite } from '../gitlab/gitlab.types';

export const MAX_ERROR_LENGTH = 10_000;
const MAX_TITLE_LENGTH = 1000;
const MAX_FILE_LENGTH = 1000;
/** Postgres int4 max: durationMs is stored as a plain Int column. */
const MAX_DURATION_MS = 2_147_483_647;

/** GitLab's report is untrusted input: a non-string field must never throw, just fall back to ''. */
const safeString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A finite, non-negative duration in whole milliseconds, clamped to fit an Int column. */
function safeDurationMs(executionTimeSeconds: unknown): number {
  const seconds = typeof executionTimeSeconds === 'number' ? executionTimeSeconds : Number(executionTimeSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.min(MAX_DURATION_MS, Math.round(seconds * 1000));
}

export interface MappedResult {
  status: ResultStatus;
  title: string;
  file: string | null;
  durationMs: number;
  errorMessage: string | null;
  errorStack: string | null;
}

export interface LinkedResult extends MappedResult {
  testCaseId: string;
  code: string;
}

export function truncate(text: string | null, max: number): string | null {
  if (text === null) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function mapTestStatus(status: string): ResultStatus {
  switch (status) {
    case 'success':
      return ResultStatus.PASSED;
    case 'failed':
    case 'error':
      return ResultStatus.FAILED;
    default:
      return ResultStatus.SKIPPED;
  }
}

function mapCase(testCase: GitlabTestCase, suite: GitlabTestSuite): MappedResult {
  const status = mapTestStatus(testCase.status);
  const failed = status === ResultStatus.FAILED;
  const name = safeString(testCase.name);
  const classname = safeString(testCase.classname);
  const file = testCase.file ?? (classname || safeString(suite.name) || '');
  return {
    status,
    title: truncate(name, MAX_TITLE_LENGTH)!,
    file: truncate(file, MAX_FILE_LENGTH)!,
    durationMs: safeDurationMs(testCase.executionTime),
    errorMessage: failed ? truncate(testCase.systemOutput ?? testCase.stackTrace ?? 'Test failed', MAX_ERROR_LENGTH) : null,
    errorStack: failed ? truncate(testCase.stackTrace, MAX_ERROR_LENGTH) : null,
  };
}

/** Several tests for one case: FAILED if any failed, else PASSED if any passed, else SKIPPED. */
function aggregate(testCaseId: string, code: string, tests: MappedResult[]): LinkedResult {
  const failed = tests.filter((t) => t.status === ResultStatus.FAILED);
  const status = failed.length
    ? ResultStatus.FAILED
    : tests.some((t) => t.status === ResultStatus.PASSED)
      ? ResultStatus.PASSED
      : ResultStatus.SKIPPED;
  const files = [...new Set(tests.map((t) => t.file).filter((f): f is string => !!f))];
  const errorMessage =
    failed.length === 0
      ? null
      : failed.length === 1
        ? failed[0].errorMessage
        : truncate(failed.map((t) => `${t.title}: ${t.errorMessage ?? ''}`).join('\n\n'), MAX_ERROR_LENGTH);
  return {
    testCaseId,
    code,
    status,
    title: truncate(tests.map((t) => t.title).join(' | '), MAX_TITLE_LENGTH)!,
    file: files.length ? truncate(files.join(', '), MAX_FILE_LENGTH) : null,
    durationMs: Math.min(MAX_DURATION_MS, tests.reduce((sum, t) => sum + t.durationMs, 0)),
    errorMessage,
    errorStack: failed[0]?.errorStack ?? null,
  };
}

/**
 * Maps GitLab's pipeline test report to run results. A test whose name carries @TC-<CODE> of an
 * active case of the project fills that case; everything else becomes an unlinked result.
 */
export function mapTestReport(
  suites: GitlabTestSuite[],
  caseIdsByCode: Map<string, string>,
): { linked: LinkedResult[]; unlinked: MappedResult[] } {
  const groups = new Map<string, { code: string; tests: MappedResult[] }>();
  const unlinked: MappedResult[] = [];
  for (const suite of suites) {
    for (const testCase of suite.cases) {
      const mapped = mapCase(testCase, suite);
      const codes = extractCaseTags(safeString(testCase.name)).filter((code) => caseIdsByCode.has(code));
      if (!codes.length) {
        unlinked.push(mapped);
        continue;
      }
      for (const code of codes) {
        const testCaseId = caseIdsByCode.get(code)!;
        const group = groups.get(testCaseId) ?? { code, tests: [] };
        group.tests.push(mapped);
        groups.set(testCaseId, group);
      }
    }
  }
  return {
    linked: [...groups].map(([testCaseId, group]) => aggregate(testCaseId, group.code, group.tests)),
    unlinked,
  };
}
