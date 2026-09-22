import { Body, Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { GitlabEnabledGuard } from '../gitlab/gitlab-enabled.guard';
import { AutomatedRunsService } from './automated-runs.service';
import { CreateAutomatedRunDto } from './dto/create-automated-run.dto';

@ApiTags('Automation')
@ApiBearerAuth()
@UseGuards(GitlabEnabledGuard)
@Controller()
export class AutomatedRunsController {
  constructor(private readonly automatedRuns: AutomatedRunsService) {}

  @Post('projects/:projectId/runs/automated')
  trigger(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: CreateAutomatedRunDto, @CurrentUser() user: AuthUser) {
    return this.automatedRuns.trigger(projectId, dto, user);
  }
}
