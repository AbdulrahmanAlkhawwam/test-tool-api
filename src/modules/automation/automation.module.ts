import { Module } from '@nestjs/common';
import { GitlabModule } from '../gitlab/gitlab.module';
import { ProjectsModule } from '../projects/projects.module';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
import { CiSnippetController } from './ci-snippet.controller';
import { CoverageCache } from './coverage-cache';
import { CoverageController } from './coverage.controller';
import { CoverageService } from './coverage.service';
import { RepositoryController } from './repository.controller';
import { RepositoryService } from './repository.service';

@Module({
  imports: [GitlabModule, ProjectsModule],
  controllers: [RepositoryController, AutomationController, CoverageController, CiSnippetController],
  providers: [RepositoryService, AutomationService, CoverageService, CoverageCache],
  exports: [AutomationService],
})
export class AutomationModule {}
