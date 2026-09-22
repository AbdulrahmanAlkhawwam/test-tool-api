import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { GitlabEnabledGuard } from '../gitlab/gitlab-enabled.guard';
import { AutomationService } from './automation.service';
import { FileQueryDto, RefQueryDto } from './dto/automation-query.dto';
import { SaveFileDto } from './dto/save-file.dto';

@ApiTags('Automation')
@ApiBearerAuth()
@UseGuards(GitlabEnabledGuard)
@Controller('projects/:projectId/automation')
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}

  @Get('branches')
  branches(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthUser) {
    return this.automation.branches(projectId, user);
  }

  @Get('tree')
  tree(@Param('projectId', ParseUUIDPipe) projectId: string, @Query() query: RefQueryDto, @CurrentUser() user: AuthUser) {
    return this.automation.tree(projectId, query.ref, user);
  }

  @Get('file')
  readFile(@Param('projectId', ParseUUIDPipe) projectId: string, @Query() query: FileQueryDto, @CurrentUser() user: AuthUser) {
    return this.automation.readFile(projectId, query, user);
  }

  @Put('file')
  saveFile(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: SaveFileDto, @CurrentUser() user: AuthUser) {
    return this.automation.saveFile(projectId, dto, user);
  }
}
