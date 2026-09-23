import { All, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { McpAuthGuard } from '../api-tokens/mcp-auth.guard';
import { closeOnResponseEnd } from './close-on-response-end';
import { McpIpThrottlerGuard } from './mcp-ip-throttler.guard';
import { McpServerFactory } from './mcp-server.factory';

/**
 * Hosted MCP endpoint (spec §3). `@Public()` keeps the browser JWT guard away; McpAuthGuard is
 * the only authentication here and accepts personal access tokens only. The transport runs in
 * stateless mode: a fresh server and transport per request, no session store, so the single
 * container can be restarted or redeployed mid-conversation without breaking a client.
 *
 * `McpIpThrottlerGuard` runs first, ahead of authentication: the per-token limit inside
 * `McpAuthGuard` only applies once a token verifies, so an IP sending nothing but invalid tokens
 * would otherwise never be capped. It only stops a real flood (300/min) — see the guard.
 */
@ApiTags('MCP')
@ApiBearerAuth()
@Public()
@UseGuards(McpIpThrottlerGuard, McpAuthGuard)
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
    // Without this the per-request server and transport stay referenced and Jest reports open
    // handles. See close-on-response-end.ts for why both closes are allowed to reject silently.
    closeOnResponseEnd(res, transport, server);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  /** GET (SSE stream) and DELETE (session teardown) only exist for stateful servers. */
  @ApiExcludeEndpoint()
  @All()
  notAllowed(@Res() res: Response): void {
    // RFC 9110 §15.5.6: a 405 response must include an Allow header listing the supported methods.
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ statusCode: 405, error: 'Method Not Allowed', message: 'The MCP endpoint is stateless: use POST' });
  }
}
