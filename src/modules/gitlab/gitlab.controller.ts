import { Controller, Delete, Get, HttpCode, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { GitlabApiService } from './gitlab-api.service';
import { GitlabConnectionService } from './gitlab-connection.service';
import { GitlabEnabledGuard } from './gitlab-enabled.guard';

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

@ApiTags('GitLab')
@ApiBearerAuth()
@Controller('gitlab')
export class GitlabController {
  constructor(
    private readonly connections: GitlabConnectionService,
    private readonly api: GitlabApiService,
  ) {}

  /** Always available, so the web app can tell whether GitLab is enabled at all. */
  @Get('status')
  status(@CurrentUser() user: AuthUser) {
    return this.connections.status(user.id);
  }

  @UseGuards(GitlabEnabledGuard)
  @Get('oauth/start')
  start(@CurrentUser() user: AuthUser) {
    return this.connections.startOAuth(user.id);
  }

  @Public()
  @UseGuards(GitlabEnabledGuard)
  @Get('oauth/callback')
  async callback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Query('error') error: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const target = await this.connections.completeOAuth({ code: asString(code), state: asString(state), error: asString(error) });
    res.redirect(302, target);
  }

  @UseGuards(GitlabEnabledGuard)
  @Delete('connection')
  @HttpCode(204)
  disconnect(@CurrentUser() user: AuthUser): Promise<void> {
    return this.connections.disconnect(user.id);
  }

  @UseGuards(GitlabEnabledGuard)
  @Roles(Role.ADMIN)
  @ApiQuery({ name: 'search', required: false })
  @Get('projects')
  searchProjects(@Query('search') search: unknown, @CurrentUser() user: AuthUser) {
    return this.connections.withToken(user.id, (token) => this.api.searchProjects(token, (asString(search) ?? '').trim()));
  }
}
