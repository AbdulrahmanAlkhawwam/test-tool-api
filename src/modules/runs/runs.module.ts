import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';

@Module({
  imports: [ProjectsModule],
  controllers: [RunsController],
  providers: [RunsService],
})
export class RunsModule {}
