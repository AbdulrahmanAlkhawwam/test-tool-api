import { Body, Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { GitlabEnabledGuard } from '../gitlab/gitlab-enabled.guard';
import { AutomatedRunsService } from './automated-runs.service';
import { CreateAutomatedRunDto } from './dto/create-automated-run.dto';
import { CreateCaseFromResultDto } from './dto/create-case-from-result.dto';
import { UnlinkedResultsService } from './unlinked-results.service';

@ApiTags('Automation')
@ApiBearerAuth()
@UseGuards(GitlabEnabledGuard)
@Controller()
export class AutomatedRunsController {
  constructor(
    private readonly automatedRuns: AutomatedRunsService,
    private readonly unlinked: UnlinkedResultsService,
  ) {}

  @Post('projects/:projectId/runs/automated')
  trigger(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: CreateAutomatedRunDto, @CurrentUser() user: AuthUser) {
    return this.automatedRuns.trigger(projectId, dto, user);
  }

  @Post('runs/:runId/results/:resultId/create-case')
  createCase(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('resultId', ParseUUIDPipe) resultId: string,
    @Body() dto: CreateCaseFromResultDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.unlinked.createCase(runId, resultId, dto, user);
  }
}
