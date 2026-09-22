import { BRANCH_NAME_RE, normalizeRepoPath, resolveEditablePath, resolveInTestsPath, workBranchName, workBranchPrefix } from './paths';

describe('repository path rules', () => {
  it('normalizes separators and surrounding slashes', () => {
    expect(normalizeRepoPath(' /e2e\\auth//login.spec.ts/ ')).toBe('e2e/auth/login.spec.ts');
  });

  it('rejects dot segments and empty paths', () => {
    expect(() => normalizeRepoPath('../etc/passwd')).toThrow('Path must not contain "." or ".." segments');
    expect(() => normalizeRepoPath('e2e/./x.ts')).toThrow('Path must not contain "." or ".." segments');
    expect(() => normalizeRepoPath('  / ')).toThrow('Path is required');
  });

  it('rejects a dot/dot-dot segment hidden behind leading or trailing whitespace', () => {
    expect(() => normalizeRepoPath('e2e/ ../x.ts')).toThrow('Path must not contain "." or ".." segments');
    expect(() => normalizeRepoPath('e2e/.. /x.ts')).toThrow('Path must not contain "." or ".." segments');
    expect(() => normalizeRepoPath('e2e/ . /x.ts')).toThrow('Path must not contain "." or ".." segments');
  });

  it('rejects segments with leading or trailing whitespace that are not dot segments', () => {
    expect(() => normalizeRepoPath('e2e/ auth/login.spec.ts')).toThrow('Path contains invalid characters');
    expect(() => normalizeRepoPath('e2e/auth /login.spec.ts')).toThrow('Path contains invalid characters');
  });

  it('rejects Unicode bidi/format control characters', () => {
    expect(() => normalizeRepoPath('e2e/\u202euser.spec.ts')).toThrow('Path contains invalid characters');
    expect(() => normalizeRepoPath('e2e/\u200e\u200fauth/login.spec.ts')).toThrow('Path contains invalid characters');
    expect(() => normalizeRepoPath('e2e/\u2066auth\u2069/login.spec.ts')).toThrow('Path contains invalid characters');
  });

  it('rejects the Arabic Letter Mark and zero-width/invisible characters', () => {
    expect(() => normalizeRepoPath('e2e/\u061cauth/login.spec.ts')).toThrow('Path contains invalid characters');
    expect(() => normalizeRepoPath('e2e/auth\u200b/login.spec.ts')).toThrow('Path contains invalid characters');
    expect(() => normalizeRepoPath('e2e/auth\u200c\u200d/login.spec.ts')).toThrow('Path contains invalid characters');
    expect(() => normalizeRepoPath('e2e/\ufeffauth/login.spec.ts')).toThrow('Path contains invalid characters');
  });

  it('rejects line/paragraph separators, DEL and C1 control characters', () => {
    expect(() => normalizeRepoPath('e2e/auth\u2028/login.spec.ts')).toThrow('Path contains invalid characters');
    expect(() => normalizeRepoPath('e2e/auth\u2029/login.spec.ts')).toThrow('Path contains invalid characters');
    expect(() => normalizeRepoPath('e2e/auth\x7f/login.spec.ts')).toThrow('Path contains invalid characters');
    expect(() => normalizeRepoPath('e2e/auth\x80\x9f/login.spec.ts')).toThrow('Path contains invalid characters');
  });

  it('rejects a backtick, which would break out of the MR description code span', () => {
    expect(() => normalizeRepoPath('e2e/auth/`login`.spec.ts')).toThrow('Path contains invalid characters');
  });

  it('accepts the tests folder itself and anything below it', () => {
    expect(resolveInTestsPath('e2e', 'e2e')).toBe('e2e');
    expect(resolveInTestsPath('e2e', '/e2e/auth/login.spec.ts')).toBe('e2e/auth/login.spec.ts');
  });

  it('rejects paths outside the tests folder', () => {
    expect(() => resolveInTestsPath('e2e', 'src/app.ts')).toThrow('Path must be inside the tests folder "e2e"');
    expect(() => resolveInTestsPath('e2e', 'e2e-other/x.spec.ts')).toThrow('Path must be inside the tests folder "e2e"');
    expect(() => resolveInTestsPath('e2e', 'e2e/../src/app.ts')).toThrow('Path must not contain "." or ".." segments');
  });

  it('only allows editing .ts and .js files', () => {
    for (const ok of ['e2e/a.spec.ts', 'e2e/a.test.ts', 'e2e/helpers.ts', 'e2e/legacy.js']) {
      expect(resolveEditablePath('e2e', ok)).toBe(ok);
    }
    expect(() => resolveEditablePath('e2e', 'e2e/README.md')).toThrow('Only .ts and .js files can be edited (for example login.spec.ts)');
  });

  it('builds work branch names from the GitLab username and a work name', () => {
    expect(workBranchName('Tess.Dev', 'Login fixes!')).toBe('tests/tess.dev/login-fixes');
    expect(workBranchName('tess', 'Café  Checkout')).toBe('tests/tess/cafe-checkout');
    expect(workBranchPrefix('Tess.Dev')).toBe('tests/tess.dev/');
  });

  it('limits the slug to 40 characters', () => {
    expect(workBranchName('tess', `${'a'.repeat(30)} ${'b'.repeat(30)}`)).toBe(`tests/tess/${'a'.repeat(30)}-${'b'.repeat(9)}`);
  });

  it('rejects work names without letters or digits and invalid branch names', () => {
    expect(() => workBranchName('tess', 'تحسينات')).toThrow('The work name must contain letters or digits');
    expect(BRANCH_NAME_RE.test('tests/tess/login-fixes')).toBe(true);
    expect(BRANCH_NAME_RE.test('main')).toBe(true);
    expect(BRANCH_NAME_RE.test('bad branch')).toBe(false);
    expect(BRANCH_NAME_RE.test('a..b')).toBe(false);
    expect(BRANCH_NAME_RE.test('/abs')).toBe(false);
  });

  it("does not let one user's prefix match another user's branches (slash-separated, not dash-separated)", () => {
    expect(workBranchPrefix('tess')).toBe('tests/tess/');
    expect('tests/tess-dev/foo'.startsWith(workBranchPrefix('tess'))).toBe(false);
    expect(workBranchName('tess', 'foo')).toBe('tests/tess/foo');
  });
});
