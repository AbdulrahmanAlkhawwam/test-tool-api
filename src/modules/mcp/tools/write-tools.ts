import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AuthUser } from '../../../common/types/auth-user';
import { CreateCaseInput, MAX_CASES_PER_CALL, McpWriteService } from '../mcp-write.service';
import { runTool } from '../tool-result';

/** Kept as a literal union rather than z.nativeEnum, same reasoning as read-tools.ts's PRIORITY. */
export const PRIORITY = z.enum(['HIGH', 'MEDIUM', 'LOW']);
const projectKey = z.string().min(1).max(20).describe('Project key, e.g. NINJA');

/**
 * Batch items stay loosely typed on purpose: spec §6 wants every case validated *individually*
 * with per-item errors, and a schema violation would fail the whole call instead. The service's
 * validateCase() enforces the real limits and reports them per item.
 */
const batchCase = z.object({
  moduleCode: z.string().describe('Module code the case belongs to, e.g. AUTH'),
  name: z.string().describe('Short test case name'),
  description: z.string().nullable().optional(),
  preconditions: z.string().nullable().optional(),
  steps: z.string().nullable().optional().describe('Numbered steps, one per line'),
  testData: z.string().nullable().optional(),
  expectedResult: z.string().nullable().optional(),
  priority: PRIORITY.optional(),
  notes: z.string().nullable().optional(),
});

/** A single edit, so the real limits belong in the schema: the AI gets one clear error. */
const changeFields = z.object({
  name: z.string().min(1).max(300).optional(),
  description: z.string().max(5000).nullable().optional(),
  preconditions: z.string().max(5000).nullable().optional(),
  steps: z.string().max(10_000).nullable().optional(),
  testData: z.string().max(5000).nullable().optional(),
  expectedResult: z.string().max(5000).nullable().optional(),
  priority: PRIORITY.optional(),
  notes: z.string().max(5000).nullable().optional(),
});

export function registerWriteTools(server: McpServer, write: McpWriteService, user: AuthUser): void {
  server.registerTool(
    'create_module',
    {
      title: 'Create a module',
      description: 'Adds a module (feature area) to a project. The code is derived from the name when you omit it.',
      inputSchema: {
        projectKey,
        name: z.string().min(1).max(100).describe('Module name, e.g. Forgot Password'),
        code: z.string().min(1).max(10).optional().describe('1–10 uppercase letters/digits used in case IDs, e.g. FP'),
      },
    },
    async ({ projectKey: key, name, code }) => runTool(() => write.createModule(key, name, code)),
  );

  server.registerTool(
    'create_test_cases',
    {
      title: 'Create test cases',
      description:
        `Creates up to ${MAX_CASES_PER_CALL} test cases as AI drafts a tester must approve. IDs are generated ` +
        '(TC-<MODULE>-NNN). Each case is checked on its own: the valid ones are created even if others fail.',
      inputSchema: {
        projectKey,
        cases: z.array(batchCase).min(1).max(MAX_CASES_PER_CALL),
      },
    },
    async ({ projectKey: key, cases }) =>
      runTool(() => write.createTestCases(key, cases as CreateCaseInput[], user)),
  );

  server.registerTool(
    'update_test_case',
    {
      title: 'Update a test case',
      description:
        'Changes template fields of one test case. Your own AI drafts are edited directly; an already approved ' +
        'case gets a pending suggestion for a tester to accept or reject. You cannot change a case’s ID, ' +
        'module or review state.',
      inputSchema: {
        projectKey,
        code: z.string().min(1).max(40).describe('Case code, e.g. TC-AUTH-001'),
        changes: changeFields.describe('Only the template fields you want to change'),
        rationale: z.string().max(1000).optional().describe('Why you propose this, shown to the tester'),
      },
    },
    async ({ projectKey: key, code, changes, rationale }) =>
      runTool(() => write.updateTestCase(key, code, changes, rationale, user)),
  );
}
