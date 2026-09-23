import { Module } from '@nestjs/common';
import { ApiTokensModule } from '../api-tokens/api-tokens.module';
import { McpController } from './mcp.controller';
import { McpServerFactory } from './mcp-server.factory';

@Module({
  imports: [ApiTokensModule],
  controllers: [McpController],
  providers: [McpServerFactory],
})
export class McpModule {}
