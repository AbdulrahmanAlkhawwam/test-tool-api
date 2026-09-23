import { Module } from '@nestjs/common';
import { ApiTokensController } from './api-tokens.controller';
import { ApiTokensService } from './api-tokens.service';
import { McpAuthGuard } from './mcp-auth.guard';
import { TokenRateLimiter } from './token-rate-limiter';

@Module({
  controllers: [ApiTokensController],
  providers: [ApiTokensService, TokenRateLimiter, McpAuthGuard],
  exports: [ApiTokensService, TokenRateLimiter, McpAuthGuard],
})
export class ApiTokensModule {}
