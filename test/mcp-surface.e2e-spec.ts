import { seedActors, seedApiToken, seedModule, seedProject } from './utils/factories';
import { callTool, connectMcp, createMcpTestApp, McpTestContext } from './utils/mcp';
import { resetDb } from './utils/test-app';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

const EXPECTED_TOOLS = [
  'create_module',
  'create_test_cases',
  'get_failing_cases',
  'get_project',
  'get_test_case',
  'get_test_cases_for_automation',
  'list_projects',
  'list_test_cases',
  'update_test_case',
];

describe('MCP surface (e2e)', () => {
  let ctx: McpTestContext;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let client: Client;
  let projectId: string;

  beforeAll(async () => {
    ctx = await createMcpTestApp();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    actors = await seedActors(ctx);
    projectId = (await seedProject(ctx.prisma, actors.admin.id)).id;
    await seedModule(ctx.prisma, projectId, { code: 'AUTH' });
    const { token } = await seedApiToken(ctx.prisma, actors.tester.id);
    client = await connectMcp(ctx, token);
  });
  afterEach(async () => {
    await client.close();
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('offers exactly nine tools, none of which can destroy or approve anything', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.name).not.toMatch(/delete|remove|archive|approve|accept|reject|run|result|user|token|import|export/);
    }
  });

  it('lists the one prompt with its arguments', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['write_playwright_tests']);
    expect(prompts[0].arguments?.map((a) => ({ name: a.name, required: a.required }))).toEqual([
      { name: 'projectKey', required: true },
      { name: 'moduleCode', required: false },
    ]);
  });

  it('the prompt tells the AI how to turn cases into tagged Playwright tests', async () => {
    const result = await client.getPrompt({ name: 'write_playwright_tests', arguments: { projectKey: 'NINJA' } });
    expect(result.messages).toHaveLength(1);
    const text = result.messages[0].content.type === 'text' ? result.messages[0].content.text : '';
    expect(text).toContain('get_test_cases_for_automation');
    expect(text).toContain('NINJA');
    expect(text).toContain("'<name> @<code>'");
    expect(text).toContain('describe');
    expect(text).toMatch(/do not invent|never invent/i);
    expect(text).not.toContain('moduleCode:');

    const scoped = await client.getPrompt({
      name: 'write_playwright_tests',
      arguments: { projectKey: 'NINJA', moduleCode: 'AUTH' },
    });
    const scopedText = scoped.messages[0].content.type === 'text' ? scoped.messages[0].content.text : '';
    expect(scopedText).toContain('AUTH');
  });

  it('gives an admin and a tester the same tools, and both may write', async () => {
    const adminToken = (await seedApiToken(ctx.prisma, actors.admin.id)).token;
    const adminClient = await connectMcp(ctx, adminToken);
    try {
      const adminTools = (await adminClient.listTools()).tools.map((t) => t.name).sort();
      expect(adminTools).toEqual(EXPECTED_TOOLS);

      for (const [c, moduleName] of [
        [client, 'Tester module'],
        [adminClient, 'Admin module'],
      ] as const) {
        const created = await callTool<{ code: string }>(c, 'create_module', { projectKey: 'NINJA', name: moduleName });
        expect(created.code).toMatch(/^[A-Z][A-Z0-9]{0,9}$/);
      }
      const drafts = await callTool<{ created: number }>(adminClient, 'create_test_cases', {
        projectKey: 'NINJA',
        cases: [{ moduleCode: 'AUTH', name: 'Admin-authored draft' }],
      });
      expect(drafts.created).toBe(1);
      const stored = await ctx.prisma.testCase.findFirstOrThrow({ where: { projectId } });
      expect(stored).toMatchObject({ reviewState: 'AI_DRAFT', createdVia: 'AI', createdById: actors.admin.id });
    } finally {
      await adminClient.close();
    }
  });
});
