import { Module } from '@nestjs/common';
import { AutomationModule } from '../automation/automation.module';
import { GitlabModule } from '../gitlab/gitlab.module';
import { RunsModule } from '../runs/runs.module';
import { TestCasesModule } from '../test-cases/test-cases.module';
import { AutomatedRunsController } from './automated-runs.controller';
import { AutomatedRunsService } from './automated-runs.service';
import { PipelinePollerService } from './pipeline-poller.service';
import { ResultImporterService } from './result-importer.service';
import { UnlinkedResultsService } from './unlinked-results.service';

@Module({
  imports: [GitlabModule, AutomationModule, RunsModule, TestCasesModule],
  controllers: [AutomatedRunsController],
  providers: [AutomatedRunsService, ResultImporterService, PipelinePollerService, UnlinkedResultsService],
})
export class AutomatedRunsModule {}
