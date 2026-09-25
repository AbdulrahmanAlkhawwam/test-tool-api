import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const WRITE_PLAYWRIGHT_TESTS = 'write_playwright_tests';

/**
 * Spec §7. The `@<code>` tag in the title is what the GitLab result import matches back to the
 * case (see the GitLab automation spec), so the tag format is load-bearing, not decoration.
 */
export function buildWritePlaywrightTestsPrompt(projectKey: string, moduleCode?: string): string {
  const scope = moduleCode
    ? `module ${moduleCode} of project ${projectKey}`
    : `every module of project ${projectKey}`;
  return [
    `Write Playwright tests for ${scope} in this repository.`,
    '',
    'Steps:',
    `1. Call get_test_cases_for_automation with projectKey "${projectKey}"${moduleCode ? ` and moduleCode "${moduleCode}"` : ''} to fetch the approved test cases.`,
    '2. Write one Playwright `test()` per case. Title it exactly \'<name> @<code>\' — the name from the case, then a space, then an "@" and the case code (for example \'Login with a valid email @TC-AUTH-001\'). The tag is how test results are linked back to the case, so never change or drop it.',
    '3. Group the tests by module in `describe` blocks named after the module.',
    '4. Follow the case: use its preconditions for setup, its steps in order for the actions, its test data for the inputs, and assert its expected result.',
    '5. Put the files where this repository already keeps its Playwright tests, following the conventions of the existing tests (fixtures, page objects, base URL, helpers).',
    '',
    'Rules:',
    '- Do not invent behaviour, selectors, URLs or data that the test case does not describe. If a step is ambiguous, ask the user instead of guessing.',
    '- Do not change the test cases in the tool, and do not write tests for cases that are still AI drafts — get_test_cases_for_automation only returns approved ones.',
    '- If a case cannot be automated as written, say so and explain what is missing rather than writing a test that always passes.',
  ].join('\n');
}

export function registerWritePlaywrightTestsPrompt(server: McpServer): void {
  server.registerPrompt(
    WRITE_PLAYWRIGHT_TESTS,
    {
      title: 'Write Playwright tests',
      description: 'Turn a project’s approved test cases into Playwright tests tagged with their case codes.',
      argsSchema: {
        projectKey: z.string().min(1).max(20).describe('Project key, e.g. NINJA'),
        moduleCode: z.string().min(1).max(10).optional().describe('Limit to one module, e.g. AUTH'),
      },
    },
    ({ projectKey, moduleCode }) => ({
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: buildWritePlaywrightTestsPrompt(projectKey, moduleCode) },
        },
      ],
    }),
  );
}
