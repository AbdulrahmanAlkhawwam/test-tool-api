import { Module } from '@nestjs/common';
import { GitlabModule } from '../gitlab/gitlab.module';
import { ProjectsModule } from '../projects/projects.module';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
import { RepositoryController } from './repository.controller';
import { RepositoryService } from './repository.service';

@Module({
  imports: [GitlabModule, ProjectsModule],
  controllers: [RepositoryController, AutomationController],
  providers: [RepositoryService, AutomationService],
  exports: [AutomationService],
})
export class AutomationModule {}
