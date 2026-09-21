import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GitlabConfig } from '../../config/configuration';

/** GitLab features are hidden (404) when GITLAB_URL is not configured. */
@Injectable()
export class GitlabEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (!this.config.getOrThrow<GitlabConfig>('gitlab').enabled) {
      throw new NotFoundException('GitLab integration is not configured');
    }
    return true;
  }
}
