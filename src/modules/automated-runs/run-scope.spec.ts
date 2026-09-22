import { automatedRunName, pipelineVariables } from './run-scope';

describe('pipeline scope', () => {
  it('builds the CI variables for each scope', () => {
    expect(pipelineVariables('r1', {})).toEqual({ EJAD_RUN_ID: 'r1' });
    expect(pipelineVariables('r1', { path: 'e2e/auth' })).toEqual({ EJAD_RUN_ID: 'r1', EJAD_TEST_PATH: 'e2e/auth' });
    const vars = pipelineVariables('r1', { codes: ['TC-AUTH-001', 'TC-AUTH-002'] });
    expect(vars).toEqual({ EJAD_RUN_ID: 'r1', EJAD_TEST_GREP: '@TC-AUTH-001\\b|@TC-AUTH-002\\b' });
    // Playwright applies --grep as a JavaScript RegExp to the test title.
    expect(new RegExp(vars.EJAD_TEST_GREP).test('logs in @TC-AUTH-001')).toBe(true);
    expect(new RegExp(vars.EJAD_TEST_GREP).test('other @TC-AUTH-0010')).toBe(false);
  });

  it('names automated runs after the branch and time', () => {
    expect(automatedRunName('main', new Date('2026-09-18T09:05:30Z'))).toBe('Automated · main · 2026-09-18 09:05 UTC');
  });
});
