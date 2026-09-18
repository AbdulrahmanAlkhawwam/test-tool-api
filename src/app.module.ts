import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { HealthController } from './health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { ImportExportModule } from './modules/import-export/import-export.module';
import { ProjectModulesModule } from './modules/project-modules/project-modules.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { ReportsModule } from './modules/reports/reports.module';
import { RunsModule } from './modules/runs/runs.module';
import { TestCasesModule } from './modules/test-cases/test-cases.module';
import { UsersModule } from './modules/users/users.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    PrismaModule,
    AuthModule,
    UsersModule,
    ProjectsModule,
    ProjectModulesModule,
    TestCasesModule,
    RunsModule,
    ImportExportModule,
    ReportsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
