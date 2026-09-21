import { Body, Controller, Delete, HttpCode, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { GitlabEnabledGuard } from '../gitlab/gitlab-enabled.guard';
import { LinkRepositoryDto } from './dto/link-repository.dto';
import { RepositoryService } from './repository.service';

@ApiTags('Automation')
@ApiBearerAuth()
@UseGuards(GitlabEnabledGuard)
@Roles(Role.ADMIN)
@Controller('projects/:projectId/repository')
export class RepositoryController {
  constructor(private readonly repository: RepositoryService) {}

  @Put()
  link(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: LinkRepositoryDto, @CurrentUser() user: AuthUser) {
    return this.repository.link(projectId, dto, user);
  }

  @Delete()
  @HttpCode(204)
  unlink(@Param('projectId', ParseUUIDPipe) projectId: string): Promise<void> {
    return this.repository.unlink(projectId);
  }
}
