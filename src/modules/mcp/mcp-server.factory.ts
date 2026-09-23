import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AuthUser } from '../../common/types/auth-user';

export const MCP_SERVER_INFO = { name: 'ejad-test-cases', version: '1.0.0' } as const;

const INSTRUCTIONS = [
  'Ejad test case tool. Work with projects by their key (e.g. NINJA) and test cases by their code (e.g. TC-AUTH-001).',
  'Test cases you create are AI drafts: a human tester reviews and approves them before they count.',
  'Edits to an already approved case become a suggestion for a tester to accept, not a direct change.',
  'You cannot delete cases, approve drafts, accept suggestions, create runs or record results — ask the user to do that in the web app.',
].join(' ');

/**
 * One MCP server per request (stateless Streamable HTTP). Tools are registered per user, so
 * every call runs with that token owner's identity and role — exactly like the web app.
 */
@Injectable()
export class McpServerFactory {
  create(user: AuthUser): McpServer {
    const server = new McpServer(MCP_SERVER_INFO, {
      capabilities: { tools: {}, prompts: {} },
      instructions: INSTRUCTIONS,
    });
    // Tools and the prompt are registered in Tasks 7–9; `user` is the acting identity for all of them.
    void user;
    return server;
  }
}
