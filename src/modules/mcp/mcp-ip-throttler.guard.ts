import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/** Well above any real client's request rate (the per-token limit is 120/min); this is only here to cap abuse. */
export const MCP_IP_RATE_LIMIT = 300;
export const MCP_IP_RATE_WINDOW_MS = 60_000;

/**
 * IP-keyed throttle for `/api/mcp`, applied before `McpAuthGuard` (see the controller). The
 * per-token limit in `McpAuthGuard` only kicks in once a request authenticates, so without this a
 * flood of requests carrying invalid or missing tokens from one IP would never be capped — each
 * one would still pay the cost of a token lookup before being rejected. `ThrottlerGuard` already
 * keys by IP by default (via its `getTracker`); the only thing overridden here is the error body,
 * so a caller sees the same uniform 429 shape as the per-token limit instead of the library's
 * generic `ThrottlerException` message.
 */
@Injectable()
export class McpIpThrottlerGuard extends ThrottlerGuard {
  protected async throwThrottlingException(): Promise<void> {
    throw new HttpException(
      { statusCode: 429, error: 'Too Many Requests', message: 'Too many MCP requests, please slow down' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
