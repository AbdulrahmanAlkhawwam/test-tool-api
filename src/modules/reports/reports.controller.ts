import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ReportsService } from './reports.service';

@ApiTags('Reports')
@ApiBearerAuth()
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('projects/:projectId/reports')
  projectReport(@Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.reports.projectReport(projectId);
  }

  @Get('dashboard')
  dashboard() {
    return this.reports.dashboard();
  }
}
