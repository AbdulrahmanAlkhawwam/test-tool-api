import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ExportService } from './export.service';
import { ImportExportController, RunExportController } from './import-export.controller';
import { ImportService } from './import.service';
import { ImportStore } from './import.store';

@Module({
  imports: [ProjectsModule],
  controllers: [ImportExportController, RunExportController],
  providers: [ImportService, ImportStore, ExportService],
})
export class ImportExportModule {}
