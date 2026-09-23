import { Module } from '@nestjs/common';
import { getOptionsToken, getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import { ApiTokensModule } from '../api-tokens/api-tokens.module';
import { ProjectsModule } from '../projects/projects.module';
import { ReportsModule } from '../reports/reports.module';
import { SuggestionsModule } from '../suggestions/suggestions.module';
import { TestCasesModule } from '../test-cases/test-cases.module';
import { MCP_IP_RATE_LIMIT, MCP_IP_RATE_WINDOW_MS, McpIpThrottlerGuard } from './mcp-ip-throttler.guard';
import { McpReadService } from './mcp-read.service';
import { McpController } from './mcp.controller';
import { McpServerFactory } from './mcp-server.factory';

@Module({
  imports: [ApiTokensModule, ProjectsModule, TestCasesModule, ReportsModule, SuggestionsModule],
  controllers: [McpController],
  providers: [
    McpServerFactory,
    McpReadService,
    McpIpThrottlerGuard,
    // `ThrottlerModule.forRoot()`/`forRootAsync()` is `@Global()` (decorated on the class itself,
    // regardless of how it's called), so importing it here too would collide with AuthModule's
    // own global registration — both would provide the same DI tokens, one silently overwriting
    // the other, and this guard could end up throttling at AuthModule's login rate limit instead
    // of 300/min. Providing the two tokens `ThrottlerGuard` needs directly, scoped to this module
    // only, gives this guard its own independent options and storage without that collision.
    { provide: getOptionsToken(), useValue: [{ ttl: MCP_IP_RATE_WINDOW_MS, limit: MCP_IP_RATE_LIMIT }] },
    { provide: getStorageToken(), useClass: ThrottlerStorageService },
  ],
})
export class McpModule {}
