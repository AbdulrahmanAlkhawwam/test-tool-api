import { Module } from '@nestjs/common';
import { AutomationModule } from '../automation/automation.module';
import { GitlabModule } from '../gitlab/gitlab.module';
import { RunsModule } from '../runs/runs.module';
import { AutomatedRunsController } from './automated-runs.controller';
import { AutomatedRunsService } from './automated-runs.service';
import { PipelinePollerService } from './pipeline-poller.service';
import { ResultImporterService } from './result-importer.service';

@Module({
  imports: [GitlabModule, AutomationModule, RunsModule],
  controllers: [AutomatedRunsController],
  providers: [AutomatedRunsService, ResultImporterService, PipelinePollerService],
})
export class AutomatedRunsModule {}
