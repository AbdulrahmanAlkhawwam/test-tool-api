import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ProjectModulesController } from './project-modules.controller';
import { ProjectModulesService } from './project-modules.service';

@Module({
  imports: [ProjectsModule],
  controllers: [ProjectModulesController],
  providers: [ProjectModulesService],
  exports: [ProjectModulesService],
})
export class ProjectModulesModule {}
