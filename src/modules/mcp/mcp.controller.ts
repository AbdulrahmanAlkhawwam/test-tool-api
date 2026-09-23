import { All, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { McpAuthGuard } from '../api-tokens/mcp-auth.guard';
import { McpServerFactory } from './mcp-server.factory';

/**
 * Hosted MCP endpoint (spec §3). `@Public()` keeps the browser JWT guard away; McpAuthGuard is
 * the only authentication here and accepts personal access tokens only. The transport runs in
 * stateless mode: a fresh server and transport per request, no session store, so the single
 * container can be restarted or redeployed mid-conversation without breaking a client.
 */
@ApiTags('MCP')
@ApiBearerAuth()
@Public()
@UseGuards(McpAuthGuard)
@Controller('mcp')
export class McpController {
  constructor(private readonly factory: McpServerFactory) {}

  @ApiOperation({
    summary: 'MCP Streamable HTTP endpoint',
    description:
      'JSON-RPC over HTTP for MCP clients. Authenticate with a personal access token ' +
      '(Authorization: Bearer ejad_pat_…). Browser JWTs are rejected.',
  })
  @Post()
  async handle(@Req() req: Request, @Res() res: Response, @CurrentUser() user: AuthUser): Promise<void> {
    const server = this.factory.create(user);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session id, no server-side session store
      enableJsonResponse: true, // plain JSON replies instead of an SSE stream
    });
    // Without this the per-request server and transport stay referenced and Jest reports open handles.
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  /** GET (SSE stream) and DELETE (session teardown) only exist for stateful servers. */
  @ApiExcludeEndpoint()
  @All()
  notAllowed(@Res() res: Response): void {
    res
      .status(405)
      .json({ statusCode: 405, error: 'Method Not Allowed', message: 'The MCP endpoint is stateless: use POST' });
  }
}
