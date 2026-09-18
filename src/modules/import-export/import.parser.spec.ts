import { BadRequestException } from '@nestjs/common';
import { deriveModuleCode, mapPriority, mapStatus, parseImportRows, uniqueModuleCode } from './import.parser';

const HEADER = ['ID', 'Module', 'Test Case Name', 'Description', 'Preconditions', 'Test Steps', 'Test Data', 'Expected Result', 'Actual Result', 'Priority', 'Status ', 'Notes'];

describe('mapStatus', () => {
  it.each([
    ['Successed', 'PASSED'], ['passed', 'PASSED'], ['Pass', 'PASSED'], ['Succeeded', 'PASSED'],
    ['Failed', 'FAILED'], ['fail', 'FAILED'],
    ['Not Executed', 'NOT_EXECUTED'], ['not-executed', 'NOT_EXECUTED'], ['', 'NOT_EXECUTED'],
    ['Blocked', 'BLOCKED'], ['Skipped', 'SKIPPED'], ['skip', 'SKIPPED'],
  ])('%s → %s', (raw, expected) => {
    expect(mapStatus(raw)).toBe(expected);
  });

  it('returns null for unknown values', () => {
    expect(mapStatus('Maybe')).toBeNull();
  });
});

describe('mapPriority', () => {
  it('maps case-insensitively', () => {
    expect(mapPriority('High')).toBe('HIGH');
    expect(mapPriority(' medium ')).toBe('MEDIUM');
    expect(mapPriority('LOW')).toBe('LOW');
    expect(mapPriority('Urgent')).toBeNull();
  });
});

describe('deriveModuleCode', () => {
  it('uses the first 4 letters of a single word', () => {
    expect(deriveModuleCode('Authentication')).toBe('AUTH');
  });
  it('uses initials for multiple words', () => {
    expect(deriveModuleCode('User Management')).toBe('UM');
    expect(deriveModuleCode('shopping cart & checkout')).toBe('SCC');
  });
  it('falls back to MOD', () => {
    expect(deriveModuleCode('!!!')).toBe('MOD');
  });
});

describe('uniqueModuleCode', () => {
  it('returns the base code when free, else the smallest free numeric suffix', () => {
    expect(uniqueModuleCode('UM', () => false)).toBe('UM');
    const taken = new Set(['UM', 'UM2']);
    expect(uniqueModuleCode('UM', (c) => taken.has(c))).toBe('UM3');
  });

  it('keeps codes within 10 characters', () => {
    const taken = new Set(['ABCDEFGHIJ', 'ABCDEFGHI2']);
    expect(uniqueModuleCode('ABCDEFGHIJ', (c) => taken.has(c))).toBe('ABCDEFGHI3');
    const many = new Set(['ABCDEFGHIJ', ...Array.from({ length: 8 }, (_, i) => `ABCDEFGHI${i + 2}`)]);
    expect(uniqueModuleCode('ABCDEFGHIJ', (c) => many.has(c))).toBe('ABCDEFGH10');
  });
});

describe('parseImportRows', () => {
  it('parses the company template, including multi-line steps and "Successed"', () => {
    const rows = parseImportRows([
      ['Ejad – AUTH test cases'],
      HEADER,
      ['TC-AUTH-001', 'Authentication', 'Login with Realy user (Email)', 'Login with valid Email and password', 'User has a registered account',
        'Enter credentials → Login', 'Valid email/password', 'User reaches organization screen', 'Like Exp Result', 'High', 'Successed', ''],
      ['TC-AUTH-004', 'Authentication', 'Login with Magic Link (Success)', 'Verify magic link', 'Can access email',
        '1. Open Login\n2. Select Magic Link login', 'Registered email', 'User is authenticated', 'Opens a new tab', 'High', 'Successed', ''],
      ['TC-AUTH-007', 'Authentication', 'Magic Link – Unregistered Email', '', '', '', '', 'No unauthorized access', 'Registers the user', 'High', 'Failed', ''],
      ['TC-AUTH-011', 'Authentication', 'Register with Empty Required Fields', '', '', '', 'Empty', 'Validation shown', '', 'High', 'Not Executed', ''],
      ['', '', '', '', '', '', '', '', '', '', '', ''],
    ]);

    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      rowNumber: 3, code: 'TC-AUTH-001', moduleName: 'Authentication', moduleCode: 'AUTH',
      name: 'Login with Realy user (Email)', priority: 'HIGH', status: 'PASSED', actualResult: 'Like Exp Result',
      notes: null, errors: [], warnings: [],
    });
    expect(rows[1].steps).toBe('1. Open Login\n2. Select Magic Link login');
    expect(rows[2].status).toBe('FAILED');
    expect(rows[2].description).toBeNull();
    expect(rows[3]).toMatchObject({ status: 'NOT_EXECUTED', actualResult: null });
  });

  it('matches headers regardless of order, case and extra spaces', () => {
    const rows = parseImportRows([
      ['test case  name', 'MODULE', 'id', 'priority'],
      ['Add to cart', 'Cart', 'tc-cart-002', 'low'],
    ]);
    expect(rows[0]).toMatchObject({ code: 'TC-CART-002', moduleCode: 'CART', name: 'Add to cart', priority: 'LOW', status: 'NOT_EXECUTED' });
  });

  it('reports row errors and warnings', () => {
    const rows = parseImportRows([
      HEADER,
      ['TC-AUTH-001', 'Authentication', '', '', '', '', '', '', '', 'High', '', ''],
      ['AUTH-2', 'Authentication', 'Bad id', '', '', '', '', '', '', 'High', '', ''],
      ['TC-AUTH-003', '', 'No module', '', '', '', '', '', '', 'High', '', ''],
      ['TC-AUTH-004', 'Authentication', 'Dup A', '', '', '', '', '', '', '', 'Maybe', ''],
      ['TC-AUTH-004', 'Authentication', 'Dup B', '', '', '', '', '', '', 'Urgent', '', ''],
      ['', 'Authentication', 'No id', '', '', '', '', '', '', 'Low', '', ''],
    ]);

    expect(rows[0].errors).toEqual(['Test Case Name is required']);
    expect(rows[1].errors).toEqual(['Invalid ID "AUTH-2" (expected format TC-MODULE-001)']);
    expect(rows[2].errors).toEqual(['Module is required']);
    expect(rows[3].errors).toEqual([]);
    expect(rows[3].warnings).toEqual(['Priority is empty – set to Medium', 'Unknown status "Maybe" – treated as Not Executed']);
    expect(rows[4].errors).toEqual(['Duplicate ID "TC-AUTH-004" in file']);
    expect(rows[4].warnings).toEqual(['Unknown priority "Urgent" – set to Medium']);
    expect(rows[5]).toMatchObject({ code: null, moduleCode: 'AUTH', warnings: ['ID is empty – one will be generated'] });
  });

  it('keeps one code per module name and warns on conflicting prefixes', () => {
    const rows = parseImportRows([
      HEADER,
      ['TC-LOGIN-001', 'Authentication', 'A', '', '', '', '', '', '', 'High', '', ''],
      ['TC-AUTH-002', 'Authentication', 'B', '', '', '', '', '', '', 'High', '', ''],
    ]);
    expect(rows[1].moduleCode).toBe('LOGIN');
    expect(rows[1].warnings).toEqual(['ID prefix "AUTH" differs from module code "LOGIN" – module "Authentication" will use "LOGIN"']);
  });

  it('gives different module names with the same derived code a numeric suffix and warns', () => {
    const rows = parseImportRows([
      HEADER,
      ['', 'User Management', 'A', '', '', '', '', '', '', 'High', '', ''],
      ['', 'Unit Measure', 'B', '', '', '', '', '', '', 'High', '', ''],
      ['', 'unit measure', 'C', '', '', '', '', '', '', 'High', '', ''],
      ['', 'Upload Manager', 'D', '', '', '', '', '', '', 'High', '', ''],
    ]);
    expect(rows.map((r) => r.moduleCode)).toEqual(['UM', 'UM2', 'UM2', 'UM3']);
    expect(rows.every((r) => r.moduleCodeDerived)).toBe(true);
    expect(rows[0].warnings).toEqual(['ID is empty – one will be generated']);
    expect(rows[1].warnings).toContain('Module code "UM" is used by "User Management" – "Unit Measure" will use "UM2"');
    expect(rows[2].warnings).toEqual(['ID is empty – one will be generated']);
    expect(rows[3].warnings).toContain('Module code "UM" is used by "User Management" – "Upload Manager" will use "UM3"');
  });

  it('does not merge non-Latin module names that all fall back to MOD', () => {
    const rows = parseImportRows([
      HEADER,
      ['', 'المصادقة', 'A', '', '', '', '', '', '', 'High', '', ''],
      ['', 'سلة التسوق', 'B', '', '', '', '', '', '', 'High', '', ''],
      ['', 'المصادقة', 'C', '', '', '', '', '', '', 'High', '', ''],
    ]);
    expect(rows.map((r) => r.moduleCode)).toEqual(['MOD', 'MOD2', 'MOD']);
    expect(rows[1].warnings).toContain('Module code "MOD" is used by "المصادقة" – "سلة التسوق" will use "MOD2"');
  });

  it('avoids codes already claimed by ID prefixes and keeps prefixed codes unchanged', () => {
    const rows = parseImportRows([
      HEADER,
      ['TC-UM-001', 'User Management', 'A', '', '', '', '', '', '', 'High', '', ''],
      ['', 'Unit Measure', 'B', '', '', '', '', '', '', 'High', '', ''],
    ]);
    expect(rows[0]).toMatchObject({ moduleCode: 'UM', moduleCodeDerived: false });
    expect(rows[1]).toMatchObject({ moduleCode: 'UM2', moduleCodeDerived: true });
  });

  it('throws when no header row is found', () => {
    expect(() => parseImportRows([['foo', 'bar'], ['1', '2']])).toThrow(BadRequestException);
  });
});
