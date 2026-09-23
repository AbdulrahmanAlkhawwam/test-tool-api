import { CanActivate, ExecutionContext, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ApiTokensService } from './api-tokens.service';
import { TokenRateLimiter } from './token-rate-limiter';

const BAD_TOKEN = 'Invalid or expired access token';

/**
 * The only authentication for /api/mcp. It accepts a personal access token and nothing else:
 * a browser JWT is refused here, and a PAT is refused everywhere else (the global JwtAuthGuard
 * cannot verify it). No cookie is read, so no CSRF surface exists on this route.
 */
@Injectable()
export class McpAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: ApiTokensService,
    private readonly limiter: TokenRateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const [scheme, raw] = String(req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !raw) throw new UnauthorizedException(BAD_TOKEN);

    // verify() throws 401 with the same message for unknown, revoked, expired and inactive.
    const { tokenId, lastUsedAt, user } = await this.tokens.verify(raw);

    if (!this.limiter.hit(tokenId)) {
      throw new HttpException(
        { statusCode: 429, error: 'Too Many Requests', message: 'Too many MCP requests, please slow down' },
        429,
      );
    }
    await this.tokens.touch(tokenId, lastUsedAt);

    req.user = user;
    req.apiTokenId = tokenId;
    return true;
  }
}
