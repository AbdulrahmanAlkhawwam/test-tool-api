import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { GitlabEnabledGuard } from '../gitlab/gitlab-enabled.guard';
import { AutomationService } from './automation.service';
import { ciSnippet } from './ci-snippet';

@ApiTags('Automation')
@ApiBearerAuth()
@UseGuards(GitlabEnabledGuard)
@Controller('projects/:projectId/automation')
export class CiSnippetController {
  constructor(private readonly automation: AutomationService) {}

  @Get('ci-snippet')
  async get(@Param('projectId', ParseUUIDPipe) projectId: string) {
    const project = await this.automation.requireLinked(projectId);
    return { playwrightConfigPath: project.playwrightConfigPath, yaml: ciSnippet(project.playwrightConfigPath) };
  }
}
