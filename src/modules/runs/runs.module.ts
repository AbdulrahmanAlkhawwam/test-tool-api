import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ResultsController } from './results.controller';
import { ResultsService } from './results.service';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';

@Module({
  imports: [ProjectsModule],
  controllers: [RunsController, ResultsController],
  providers: [RunsService, ResultsService],
})
export class RunsModule {}
