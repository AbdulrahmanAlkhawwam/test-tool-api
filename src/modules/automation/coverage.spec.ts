import { computeCoverage, CoverageCase } from './coverage';

const CASES: CoverageCase[] = [
  { id: 'c1', code: 'TC-AUTH-001', name: 'Login', module: { code: 'AUTH', name: 'Authentication' } },
  { id: 'c2', code: 'TC-AUTH-002', name: 'Wrong password', module: { code: 'AUTH', name: 'Authentication' } },
  { id: 'c3', code: 'TC-CART-001', name: 'Add item', module: { code: 'CART', name: 'Cart' } },
];

describe('computeCoverage', () => {
  it('maps tags to cases per file and keeps unknown codes apart', () => {
    const result = computeCoverage([{ path: 'e2e/login.spec.ts', codes: ['TC-AUTH-001', 'TC-AUTH-999'] }], CASES);
    expect(result.files).toEqual([
      { path: 'e2e/login.spec.ts', cases: [{ id: 'c1', code: 'TC-AUTH-001', name: 'Login' }], unknownCodes: ['TC-AUTH-999'] },
    ]);
  });

  it('lists cases without any tag as not automated', () => {
    const result = computeCoverage(
      [
        { path: 'e2e/a.spec.ts', codes: ['TC-AUTH-001'] },
        { path: 'e2e/b.spec.ts', codes: ['TC-AUTH-001'] },
      ],
      CASES,
    );
    expect(result.notAutomated.map((c) => c.code)).toEqual(['TC-AUTH-002', 'TC-CART-001']);
    expect(result.notAutomated[1]).toEqual(CASES[2]);
  });

  it('sorts files by path and keeps files without tags', () => {
    const result = computeCoverage(
      [
        { path: 'e2e/z.spec.ts', codes: [] },
        { path: 'e2e/a.spec.ts', codes: ['TC-CART-001'] },
      ],
      CASES,
    );
    expect(result.files.map((f) => f.path)).toEqual(['e2e/a.spec.ts', 'e2e/z.spec.ts']);
    expect(result.files[1]).toEqual({ path: 'e2e/z.spec.ts', cases: [], unknownCodes: [] });
  });
});
