import { ResultStatus } from '@prisma/client';
import { GitlabTestCase, GitlabTestSuite } from '../gitlab/gitlab.types';
import { mapTestReport, mapTestStatus } from './report-mapper';

const CODES = new Map([
  ['TC-AUTH-001', 'c1'],
  ['TC-AUTH-002', 'c2'],
]);

const tc = (data: Partial<GitlabTestCase>): GitlabTestCase => ({
  status: 'success',
  name: 't',
  classname: 'auth/login.spec.ts',
  file: 'e2e/auth/login.spec.ts',
  executionTime: 1.5,
  systemOutput: null,
  stackTrace: null,
  ...data,
});
const suites = (...cases: GitlabTestCase[]): GitlabTestSuite[] => [{ name: 'chromium', cases }];

describe('mapTestReport', () => {
  it('fills the tagged case from a passing test', () => {
    const report = mapTestReport(suites(tc({ name: 'login › logs in @TC-AUTH-001', executionTime: 1.234 })), CODES);
    expect(report).toEqual({
      linked: [
        {
          testCaseId: 'c1',
          code: 'TC-AUTH-001',
          status: ResultStatus.PASSED,
          title: 'login › logs in @TC-AUTH-001',
          file: 'e2e/auth/login.spec.ts',
          durationMs: 1234,
          errorMessage: null,
          errorStack: null,
        },
      ],
      unlinked: [],
    });
  });

  it('maps failed and error tests to FAILED with a truncated message', () => {
    const report = mapTestReport(
      suites(
        tc({ status: 'failed', name: 'a @TC-AUTH-001', systemOutput: 'x'.repeat(20_000), stackTrace: 'at a.spec.ts:3' }),
        tc({ status: 'error', name: 'b @TC-AUTH-002', stackTrace: 'boom' }),
      ),
      CODES,
    );
    const [first, second] = report.linked;
    expect(first.status).toBe(ResultStatus.FAILED);
    expect(first.errorMessage).toHaveLength(10_000);
    expect(first.errorMessage!.endsWith('…')).toBe(true);
    expect(first.errorStack).toBe('at a.spec.ts:3');
    expect(second).toMatchObject({ status: ResultStatus.FAILED, errorMessage: 'boom' });
    expect(mapTestStatus('success')).toBe(ResultStatus.PASSED);
    expect(mapTestStatus('skipped')).toBe(ResultStatus.SKIPPED);
  });

  it('maps skipped tests to SKIPPED without an error', () => {
    const report = mapTestReport(suites(tc({ status: 'skipped', name: 's @TC-AUTH-001', systemOutput: 'skipped because' })), CODES);
    expect(report.linked[0]).toMatchObject({ status: ResultStatus.SKIPPED, errorMessage: null, errorStack: null });
  });

  it('combines several tests of one case: FAILED if any failed, else PASSED if any passed', () => {
    const report = mapTestReport(
      suites(
        tc({ name: 'p @TC-AUTH-001', executionTime: 0.5 }),
        tc({ status: 'failed', name: 'f @TC-AUTH-001', executionTime: 1, systemOutput: 'expected 1' }),
        tc({ status: 'skipped', name: 's @TC-AUTH-002' }),
        tc({ name: 'p2 @TC-AUTH-002' }),
      ),
      CODES,
    );
    expect(report.linked).toEqual([
      expect.objectContaining({ testCaseId: 'c1', status: ResultStatus.FAILED, durationMs: 1500, errorMessage: 'expected 1', title: 'p @TC-AUTH-001 | f @TC-AUTH-001' }),
      expect.objectContaining({ testCaseId: 'c2', status: ResultStatus.PASSED }),
    ]);
    const skippedOnly = mapTestReport(suites(tc({ status: 'skipped', name: 'a @TC-AUTH-001' }), tc({ status: 'skipped', name: 'b @TC-AUTH-001' })), CODES);
    expect(skippedOnly.linked[0].status).toBe(ResultStatus.SKIPPED);
  });

  it('keeps untagged tests and unknown codes as unlinked results', () => {
    const report = mapTestReport(
      suites(
        tc({ name: 'cart › adds an item', file: null, classname: 'cart/cart.spec.ts' }),
        tc({ status: 'skipped', name: 'legacy @TC-OLD-001' }),
      ),
      CODES,
    );
    expect(report.linked).toEqual([]);
    expect(report.unlinked).toEqual([
      { status: ResultStatus.PASSED, title: 'cart › adds an item', file: 'cart/cart.spec.ts', durationMs: 1500, errorMessage: null, errorStack: null },
      { status: ResultStatus.SKIPPED, title: 'legacy @TC-OLD-001', file: 'e2e/auth/login.spec.ts', durationMs: 1500, errorMessage: null, errorStack: null },
    ]);
  });

  it('fills every case a test is tagged with', () => {
    const report = mapTestReport(suites(tc({ name: 'login and error @TC-AUTH-001 @TC-AUTH-002' })), CODES);
    expect(report.linked.map((l) => [l.code, l.status])).toEqual([
      ['TC-AUTH-001', ResultStatus.PASSED],
      ['TC-AUTH-002', ResultStatus.PASSED],
    ]);
  });

  it('never throws on a non-string name/classname, and defaults an unresolvable file to an empty string', () => {
    const bad = { status: 'success', name: null, classname: undefined, file: undefined, executionTime: 1, systemOutput: null, stackTrace: null } as unknown as GitlabTestCase;
    const noNameSuite = (...cases: GitlabTestCase[]): GitlabTestSuite[] => [{ name: '', cases }];
    expect(() => mapTestReport(noNameSuite(bad), CODES)).not.toThrow();
    expect(mapTestReport(noNameSuite(bad), CODES).unlinked).toEqual([
      { status: ResultStatus.PASSED, title: '', file: '', durationMs: 1000, errorMessage: null, errorStack: null },
    ]);
  });

  it('clamps a negative, infinite or non-numeric execution time to a non-negative duration', () => {
    const report = mapTestReport(
      suites(
        tc({ name: 'a', executionTime: -5 }),
        tc({ name: 'b', executionTime: Infinity }),
        tc({ name: 'c', executionTime: Number.NaN }),
        tc({ name: 'd', executionTime: 'oops' as unknown as number }),
      ),
      CODES,
    );
    expect(report.unlinked.map((r) => r.durationMs)).toEqual([0, 0, 0, 0]);
  });

  it('bounds a very long file path and an aggregated file list to 1000 characters', () => {
    const longFile = 'e2e/'.repeat(400) + 'a.spec.ts';
    const [single] = mapTestReport(suites(tc({ name: 'x @TC-AUTH-001', file: longFile })), CODES).linked;
    expect(single.file!.length).toBe(1000);

    const manyFiles = Array.from({ length: 30 }, (_, i) => tc({ name: `t${i} @TC-AUTH-002`, file: `e2e/module-${i}/very-long-descriptive-name-${i}.spec.ts` }));
    const [aggregated] = mapTestReport(suites(...manyFiles), CODES).linked;
    expect(aggregated.file!.length).toBeLessThanOrEqual(1000);
  });

  it('clamps an aggregated duration sum to fit a Postgres Int column', () => {
    const manyLongTests = Array.from({ length: 5 }, (_, i) => tc({ name: `t${i} @TC-AUTH-001`, executionTime: 1_000_000 }));
    const [aggregated] = mapTestReport(suites(...manyLongTests), CODES).linked;
    expect(aggregated.durationMs).toBe(2_147_483_647);
  });
});
