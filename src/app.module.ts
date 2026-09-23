import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { HealthController } from './health.controller';
import { ApiTokensModule } from './modules/api-tokens/api-tokens.module';
import { AuthModule } from './modules/auth/auth.module';
import { AutomatedRunsModule } from './modules/automated-runs/automated-runs.module';
import { AutomationModule } from './modules/automation/automation.module';
import { GitlabModule } from './modules/gitlab/gitlab.module';
import { ImportExportModule } from './modules/import-export/import-export.module';
import { McpModule } from './modules/mcp/mcp.module';
import { ProjectModulesModule } from './modules/project-modules/project-modules.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { ReportsModule } from './modules/reports/reports.module';
import { RunsModule } from './modules/runs/runs.module';
import { SuggestionsModule } from './modules/suggestions/suggestions.module';
import { TestCasesModule } from './modules/test-cases/test-cases.module';
import { UsersModule } from './modules/users/users.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    PrismaModule,
    AuthModule,
    UsersModule,
    ApiTokensModule,
    ProjectsModule,
    ProjectModulesModule,
    TestCasesModule,
    SuggestionsModule,
    RunsModule,
    ImportExportModule,
    ReportsModule,
    GitlabModule,
    AutomationModule,
    AutomatedRunsModule,
    McpModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
