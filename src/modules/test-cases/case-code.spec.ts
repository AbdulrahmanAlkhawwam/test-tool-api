import { CASE_CODE_RE, nextCaseCode } from './case-code';

describe('nextCaseCode', () => {
  it('starts at 001', () => {
    expect(nextCaseCode('AUTH', [])).toBe('TC-AUTH-001');
  });

  it('continues after the highest number, not the count', () => {
    expect(nextCaseCode('AUTH', ['TC-AUTH-001', 'TC-AUTH-007', 'TC-AUTH-003'])).toBe('TC-AUTH-008');
  });

  it('ignores other modules even when one prefix starts with the other', () => {
    expect(nextCaseCode('AUTH', ['TC-AUTHX-050', 'TC-CART-010'])).toBe('TC-AUTH-001');
  });

  it('ignores codes with non-numeric suffixes', () => {
    expect(nextCaseCode('AUTH', ['TC-AUTH-ABC', 'TC-AUTH-002'])).toBe('TC-AUTH-003');
  });

  it('grows beyond three digits', () => {
    expect(nextCaseCode('AUTH', ['TC-AUTH-999'])).toBe('TC-AUTH-1000');
  });

  it('CASE_CODE_RE captures module code and number', () => {
    expect('TC-AUTH-040'.match(CASE_CODE_RE)?.slice(1)).toEqual(['AUTH', '040']);
    expect(CASE_CODE_RE.test('AUTH-040')).toBe(false);
  });
});
