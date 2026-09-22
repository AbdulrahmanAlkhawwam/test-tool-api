import { Body, Controller, Delete, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { CompleteOAuthDto } from './dto/complete-oauth.dto';
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

  /**
   * The web app calls this after GitLab redirects it to its own `/gitlab/callback`. This route is
   * authenticated (not public): binding completion to the signed-in user is what stops one user
   * from linking another's GitLab tokens to their own account by replaying that user's authorizeUrl.
   */
  @UseGuards(GitlabEnabledGuard)
  @Post('oauth/complete')
  @HttpCode(200)
  complete(@Body() dto: CompleteOAuthDto, @CurrentUser() user: AuthUser) {
    return this.connections.completeOAuth(user.id, dto);
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
