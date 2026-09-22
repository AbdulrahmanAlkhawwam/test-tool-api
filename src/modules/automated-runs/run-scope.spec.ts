import { assertSafeScopePath, automatedRunName, pipelineVariables } from './run-scope';

describe('pipeline scope', () => {
  it('builds the CI variables for each scope', () => {
    expect(pipelineVariables('r1', {})).toEqual({ EJAD_RUN_ID: 'r1' });
    expect(pipelineVariables('r1', { path: 'e2e/auth' })).toEqual({ EJAD_RUN_ID: 'r1', EJAD_TEST_PATH: 'e2e/auth' });
    const vars = pipelineVariables('r1', { codes: ['TC-AUTH-001', 'TC-AUTH-002'] });
    expect(vars).toEqual({ EJAD_RUN_ID: 'r1', EJAD_TEST_GREP: '@TC-AUTH-001(?![A-Za-z0-9])|@TC-AUTH-002(?![A-Za-z0-9])' });
    // Playwright applies --grep as a JavaScript RegExp to the test title.
    expect(new RegExp(vars.EJAD_TEST_GREP).test('logs in @TC-AUTH-001')).toBe(true);
    expect(new RegExp(vars.EJAD_TEST_GREP).test('other @TC-AUTH-0010')).toBe(false);
    // Same boundary as CASE_TAG_RE, which extractCaseTags() uses to link the test report back: a
    // suffix like "_smoke" doesn't stop either one from recognizing the tag.
    expect(new RegExp(vars.EJAD_TEST_GREP).test('smoke variant @TC-AUTH-001_smoke')).toBe(true);
  });

  it('names automated runs after the branch and time', () => {
    expect(automatedRunName('main', new Date('2026-09-18T09:05:30Z'))).toBe('Automated · main · 2026-09-18 09:05 UTC');
  });
});

describe('assertSafeScopePath', () => {
  it('accepts an ordinary repository path', () => {
    expect(() => assertSafeScopePath('e2e/auth/login.spec.ts')).not.toThrow();
  });

  it.each([
    'e2e/auth with space',
    'e2e/*.spec.ts',
    'e2e/[abc].ts',
    'e2e/{a,b}.ts',
    'e2e/$HOME',
    'e2e/`whoami`',
    "e2e/it's.ts",
    'e2e/"quoted".ts',
    'e2e\\backslash.ts',
    'e2e/a;rm -rf.ts',
    'e2e/a&b.ts',
    'e2e/a|b.ts',
    'e2e/a<b.ts',
    'e2e/a>b.ts',
  ])('rejects %p', (path) => {
    expect(() => assertSafeScopePath(path)).toThrow("Test paths can't contain spaces or special characters");
  });
});
