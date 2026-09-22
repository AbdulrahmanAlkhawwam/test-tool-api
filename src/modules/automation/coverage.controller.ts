import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { GitlabEnabledGuard } from '../gitlab/gitlab-enabled.guard';
import { CoverageService } from './coverage.service';
import { RefQueryDto } from './dto/automation-query.dto';

@ApiTags('Automation')
@ApiBearerAuth()
@UseGuards(GitlabEnabledGuard)
@Controller('projects/:projectId/automation')
export class CoverageController {
  constructor(private readonly coverage: CoverageService) {}

  @Get('coverage')
  get(@Param('projectId', ParseUUIDPipe) projectId: string, @Query() query: RefQueryDto, @CurrentUser() user: AuthUser) {
    return this.coverage.coverage(projectId, query.ref, user);
  }
}
