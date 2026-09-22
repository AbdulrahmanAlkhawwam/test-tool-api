import { ciSnippet } from './ci-snippet';

describe('ciSnippet', () => {
  it('matches the job from the spec for the default Playwright config', () => {
    expect(ciSnippet()).toBe(
      [
        'ejad-playwright:',
        "  image: mcr.microsoft.com/playwright:v1.47.0-jammy   # match the repo's @playwright/test version",
        '  rules:',
        "    - if: '$EJAD_RUN_ID'",
        '  script:',
        '    - npm ci',
        '    - npx playwright test ${EJAD_TEST_PATH} ${EJAD_TEST_GREP:+--grep "$EJAD_TEST_GREP"} --reporter=junit,html',
        '  variables:',
        '    PLAYWRIGHT_JUNIT_OUTPUT_NAME: results/junit.xml',
        '  artifacts:',
        '    when: always',
        '    expire_in: 14 days',
        '    reports:',
        '      junit: results/junit.xml',
        '    paths:',
        '      - results/',
        '      - playwright-report/',
        '      - test-results/',
        '',
      ].join('\n'),
    );
  });

  it('passes a custom Playwright config path', () => {
    expect(ciSnippet('e2e/playwright.config.ts')).toContain(
      '    - npx playwright test --config e2e/playwright.config.ts ${EJAD_TEST_PATH} ${EJAD_TEST_GREP:+--grep "$EJAD_TEST_GREP"} --reporter=junit,html',
    );
  });
});
