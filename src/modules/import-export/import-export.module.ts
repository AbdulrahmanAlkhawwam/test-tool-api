import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ImportExportController } from './import-export.controller';
import { ImportService } from './import.service';
import { ImportStore } from './import.store';

@Module({
  imports: [ProjectsModule],
  controllers: [ImportExportController],
  providers: [ImportService, ImportStore],
})
export class ImportExportModule {}
