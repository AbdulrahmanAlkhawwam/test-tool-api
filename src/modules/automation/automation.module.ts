import { Module } from '@nestjs/common';
import { GitlabModule } from '../gitlab/gitlab.module';
import { ProjectsModule } from '../projects/projects.module';
import { RepositoryController } from './repository.controller';
import { RepositoryService } from './repository.service';

@Module({
  imports: [GitlabModule, ProjectsModule],
  controllers: [RepositoryController],
  providers: [RepositoryService],
})
export class AutomationModule {}
