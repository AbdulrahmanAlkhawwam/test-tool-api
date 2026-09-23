import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Priority, ResultStatus } from '@prisma/client';
import { z } from 'zod';
import { McpReadService } from '../mcp-read.service';
import { runTool } from '../tool-result';

/** Kept as literal unions rather than z.nativeEnum so the schema is identical on zod 3 and 4. */
const PRIORITY = z.enum(['HIGH', 'MEDIUM', 'LOW']);
const STATUS = z.enum(['NOT_EXECUTED', 'PASSED', 'FAILED', 'BLOCKED', 'SKIPPED']);

const projectKey = z.string().min(1).max(20).describe('Project key, e.g. NINJA');
const moduleCode = z.string().min(1).max(10).describe('Module code, e.g. AUTH');
/** Spec §7: at most 100 cases per page. */
export const MAX_PAGE_SIZE = 100;

export function registerReadTools(server: McpServer, read: McpReadService): void {
  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'Projects in the Ejad test case tool, with approved case counts and the latest test run.',
      inputSchema: { includeArchived: z.boolean().optional().describe('Include archived projects (default false)') },
    },
    async ({ includeArchived }) => runTool(() => read.listProjects(includeArchived ?? false)),
  );

  server.registerTool(
    'get_project',
    {
      title: 'Get a project',
      description: 'One project with its modules and how many approved test cases each module has.',
      inputSchema: { projectKey },
    },
    async ({ projectKey: key }) => runTool(() => read.getProject(key)),
  );

  server.registerTool(
    'list_test_cases',
    {
      title: 'List test cases',
      description:
        'Test cases in a project. AI drafts are included by default and marked reviewState=AI_DRAFT; ' +
        'set includeDrafts=false for the approved cases only.',
      inputSchema: {
        projectKey,
        moduleCode: moduleCode.optional(),
        priority: PRIORITY.optional(),
        status: STATUS.optional().describe('Filter by the latest executed result'),
        q: z.string().min(1).max(200).optional().describe('Search in the name, code and description'),
        includeDrafts: z.boolean().optional().describe('Include AI drafts (default true)'),
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
      },
    },
    async (input) =>
      runTool(() =>
        read.listTestCases({
          projectKey: input.projectKey,
          moduleCode: input.moduleCode,
          priority: input.priority as Priority | undefined,
          status: input.status as ResultStatus | undefined,
          q: input.q,
          includeDrafts: input.includeDrafts ?? true,
          page: input.page ?? 1,
          pageSize: input.pageSize ?? 50,
        }),
      ),
  );

  server.registerTool(
    'get_test_case',
    {
      title: 'Get a test case',
      description: 'Every template field of one test case, plus its review state, any pending AI suggestion and its last 10 results.',
      inputSchema: { projectKey, code: z.string().min(1).max(40).describe('Case code, e.g. TC-AUTH-001') },
    },
    async ({ projectKey: key, code }) => runTool(() => read.getTestCase(key, code)),
  );

  server.registerTool(
    'get_failing_cases',
    {
      title: 'Get failing test cases',
      description: 'Test cases whose most recent executed result is Failed, with the actual result and the run it came from.',
      inputSchema: { projectKey },
    },
    async ({ projectKey: key }) => runTool(() => read.getFailingCases(key)),
  );

  server.registerTool(
    'get_test_cases_for_automation',
    {
      title: 'Get test cases for automation',
      description:
        'Approved test cases as an automation spec, in code order. Use this before writing Playwright tests; ' +
        'AI drafts are never included because nobody has reviewed them yet.',
      inputSchema: {
        projectKey,
        moduleCode: moduleCode.optional(),
        codes: z.array(z.string().min(1).max(40)).max(200).optional().describe('Only these case codes'),
      },
    },
    async ({ projectKey: key, moduleCode: code, codes }) => runTool(() => read.getCasesForAutomation(key, code, codes)),
  );
}
