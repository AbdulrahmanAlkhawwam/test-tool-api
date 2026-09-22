export const DEFAULT_PLAYWRIGHT_CONFIG = 'playwright.config.ts';

/**
 * The .gitlab-ci.yml job the tool's pipelines rely on. It only runs when EJAD_RUN_ID is set
 * (pipelines started from the tool) and publishes the JUnit report GitLab turns into test_report.
 */
export function ciSnippet(playwrightConfigPath: string = DEFAULT_PLAYWRIGHT_CONFIG): string {
  const config = playwrightConfigPath === DEFAULT_PLAYWRIGHT_CONFIG ? '' : ` --config ${playwrightConfigPath}`;
  return [
    'ejad-playwright:',
    "  image: mcr.microsoft.com/playwright:v1.47.0-jammy   # match the repo's @playwright/test version",
    '  rules:',
    "    - if: '$EJAD_RUN_ID'",
    '  script:',
    '    - npm ci',
    `    - npx playwright test${config} \${EJAD_TEST_PATH} \${EJAD_TEST_GREP:+--grep "$EJAD_TEST_GREP"} --reporter=junit,html`,
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
  ].join('\n');
}
